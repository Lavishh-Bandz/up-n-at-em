// WorkoutSession.jsx
// -----------------------------------------------------------------------------
// The live workout screen. This is where everything comes together:
//
//   camera keypoints  ->  angle math  ->  rep counter  ->  workout queue  ->
//   (when the whole queue is done) stop the alarm & show success.
//
// It owns the FEAT-001 logic instances (workout queue + the current step's rep
// counter) and advances them as the camera reports poses.
//
// KEY RULES ENFORCED HERE:
//   - The alarm starts the moment the session begins (from the user's click
//     back in Settings, which satisfies the browser autoplay policy).
//   - The alarm's stop() is ONLY called when the workout queue says it is fully
//     complete, or when the emergency escape fires. No plain mute button.
//   - Reps only count when the exercise's required keypoints are confidently
//     visible (anti-cheat), using the pure repCounter + angle helpers.

import { useEffect, useRef, useState } from 'react';
import CameraView from './CameraView.jsx';
import ProgressHud from './ProgressHud.jsx';
import EmergencyExit from './EmergencyExit.jsx';
import DebugReadout from './DebugReadout.jsx';
import { createWorkoutQueue } from '../logic/workoutQueue.js';
import { createRepCounter } from '../logic/repCounter.js';
import { createVerticalRepCounter } from '../logic/verticalRepCounter.js';
import { getPreset, getExercise, pickBetterSide, evaluateOrientation } from '../logic/exercises.js';
import { angleBetween, allConfident, createAngleSmoother } from '../logic/angles.js';
import {
  measureBodyScale,
  measureUpperBodyY,
  createBodyScaleTracker,
  createPostureGuard,
} from '../logic/upperBodySignal.js';
import { createPositionGate } from '../logic/positionGate.js';
import { createStatusDebouncer } from '../logic/statusDebounce.js';
import { createPushupDiagnostics } from '../logic/pushupDiagnostics.js';

// How many recent angle readings we average together to calm down detector
// jitter before the rep counter sees them. A small window keeps fast reps
// responsive while still smoothing single-frame wobbles.
const SMOOTHING_WINDOW = 5;

// Minimum keypoint score we trust for counting a rep (anti-cheat gate).
const MIN_CONFIDENCE = 0.3;

// How long (ms) of IN-POSITION time the user must rack up before a step "arms"
// and we start counting. This drives the 5-second get-into-position countdown:
// the time only ticks down while you are actually in position (it pauses when
// you are not), so a brief flicker barely moves it.
const ARMING_HOLD_MS = 5000;

// How often (ms) the on-screen DEBUG READOUT and the diagnostics report are
// allowed to refresh. The pose handler runs every animation frame (~16ms), but
// re-rendering a text panel that fast would flicker and waste work, so we only
// push new debug state / record a report sample once this much time has passed
// since the last one (a few times per second). This is what keeps the readout
// steady and off the frame-rate re-render path.
const DEBUG_THROTTLE_MS = 200;

/**
 * Build a rep counter configured for a specific workout step.
 *
 * The two exercises are counted in DIFFERENT ways, so we pick the matching
 * counter here:
 *   - PUSH-UPS watch the VISIBLE UPPER BODY move DOWN toward the floor and back
 *     UP, so they use the position-based createVerticalRepCounter fed by the
 *     body-scale fractions (downFraction / upFraction) from the preset.
 *   - SIT-UPS watch the HIP/torso ANGLE open and close, so they keep using the
 *     angle-based createRepCounter fed by the preset's downAngle / upAngle.
 * getPreset already returns the right shape for each exercise (see exercises.js).
 */
function makeCounterForStep(step) {
  const preset = getPreset(step.exercise, step.difficulty);
  if (step.exercise === 'pushup') {
    return createVerticalRepCounter({
      downFraction: preset.downFraction,
      upFraction: preset.upFraction,
      minConfidence: MIN_CONFIDENCE,
    });
  }
  return createRepCounter({
    downAngle: preset.downAngle,
    upAngle: preset.upAngle,
    minConfidence: MIN_CONFIDENCE,
  });
}

/**
 * @param {object} props
 * @param {Array<{exercise,difficulty,targetReps}>} props.steps  The workout to perform.
 * @param {() => void} props.onComplete  Called when the whole workout is finished.
 * @param {() => void} props.onEmergencyCancel  Called when the user uses the escape.
 * @param {{start:Function, stop:Function, playing:boolean}} props.alarm  Alarm hook controls.
 */
export default function WorkoutSession({
  steps,
  onComplete,
  onEmergencyCancel,
  alarm,
}) {
  // The workout queue + per-step rep counter live in refs: they are mutable
  // logic objects we poke every frame, not React state.
  const queueRef = useRef(null);
  if (queueRef.current === null) {
    queueRef.current = createWorkoutQueue(steps);
  }
  const counterRef = useRef(null);
  if (counterRef.current === null) {
    counterRef.current = makeCounterForStep(steps[0]);
  }
  // Smooths the tracked angle over the last few frames so detector jitter does
  // not flicker the counter. Reset whenever we move to a new step.
  const smootherRef = useRef(null);
  if (smootherRef.current === null) {
    smootherRef.current = createAngleSmoother({ windowSize: SMOOTHING_WINDOW });
  }
  // The "get into position first" gate for the CURRENT step. While it is not
  // armed we do not count reps; the user must hold the correct position for
  // ARMING_HOLD_MS before counting begins. Reset at the start of each step.
  const positionGateRef = useRef(null);
  if (positionGateRef.current === null) {
    positionGateRef.current = createPositionGate({ holdMs: ARMING_HOLD_MS });
  }
  // Calms the "Pose not detected" WARNING so a single bad frame does not blink
  // it on and off. This is DISPLAY-ONLY: it never touches rep counting or the
  // position gate, which keep using the raw per-frame confidence below.
  const statusDebouncerRef = useRef(null);
  if (statusDebouncerRef.current === null) {
    statusDebouncerRef.current = createStatusDebouncer();
  }
  // PUSH-UP ONLY: the STABLE body-scale ruler. We feed it the live body-scale
  // each confident frame while the step is arming, then lock() it the moment
  // the step arms, and reuse that locked value for the rest of the set so a
  // front-facing shoulder width that swings through the rep cannot distort the
  // excursion. Reset per step. (Sit-ups never touch this.)
  const bodyScaleTrackerRef = useRef(null);
  if (bodyScaleTrackerRef.current === null) {
    bodyScaleTrackerRef.current = createBodyScaleTracker();
  }
  // PUSH-UP ONLY: the upper-body ANTI-STANDING guard. Its per-frame update()
  // result is passed to the counter as postureOk so a standing / walking bob
  // cannot enter the 'down' phase. Reset per step.
  const postureGuardRef = useRef(null);
  if (postureGuardRef.current === null) {
    postureGuardRef.current = createPostureGuard(
      getExercise('pushup').postureGuard
    );
  }
  // PUSH-UP ONLY: the "click Begin -> leave a report" diagnostics recorder. It
  // starts recording when a push-up step arms and is read back via the debug
  // panel + logged to the console on Begin and on completion/exit. Pure data.
  const diagnosticsRef = useRef(null);
  if (diagnosticsRef.current === null) {
    diagnosticsRef.current = createPushupDiagnostics();
  }

  // React state mirrors just what the HUD needs to render.
  const [stepIndex, setStepIndex] = useState(0);
  const [reps, setReps] = useState(0);
  // The DEBOUNCED "pose detected" value used only to show/hide the HUD warning.
  // Starts true (optimistic) so no warning flashes before the first frame. Rep
  // counting and the position gate never read this; they use raw isConfident.
  const [displayConfident, setDisplayConfident] = useState(true);
  // Is the current step armed (position confirmed, now counting)? Starts false
  // so the HUD shows the "get into position" prompt first.
  const [armed, setArmed] = useState(false);
  // Whole seconds left on the get-into-position countdown (5 -> 1). The HUD
  // shows this as a big number while the step is still arming.
  const [countdownSeconds, setCountdownSeconds] = useState(
    Math.ceil(ARMING_HOLD_MS / 1000)
  );
  // Is the countdown PAUSED mid-way (some time banked, but currently out of
  // position)? The HUD uses this to show a "get back into position" hint.
  const [countdownPaused, setCountdownPaused] = useState(false);
  // The THROTTLED debug readout values (push-up steps only; null otherwise).
  // Updated at most a few times a second (see DEBUG_THROTTLE_MS) so the panel
  // never re-renders at frame rate. Holds the SAME numbers the detector used.
  const [debugReadout, setDebugReadout] = useState(null);
  // The THROTTLED diagnostics report snapshot shown in the expandable block.
  const [debugReport, setDebugReport] = useState(null);

  // The pose handler runs every animation frame. To avoid re-rendering the HUD
  // at frame rate, we remember the last value we pushed into each piece of
  // state and only call the setter when the value actually changed.
  const lastRepsRef = useRef(0);
  const lastDisplayConfidentRef = useRef(true);
  const lastArmedRef = useRef(false);
  const lastCountdownRef = useRef(Math.ceil(ARMING_HOLD_MS / 1000));
  const lastPausedRef = useRef(false);
  // Timestamp (ms) of the last debug-state push. Used to THROTTLE the readout
  // and the report sampling to DEBUG_THROTTLE_MS so they never re-render at
  // frame rate. Starts at -Infinity so the very first frame updates.
  const lastDebugAtRef = useRef(-Infinity);

  // Small helpers: only update state when the value is different from last time.
  // This mirrors the debounced "pose detected" value into the HUD, and only
  // re-renders when it actually changes (the debouncer already smooths it, so
  // this does not flicker at frame rate).
  function updateDisplayConfident(value) {
    if (lastDisplayConfidentRef.current !== value) {
      lastDisplayConfidentRef.current = value;
      setDisplayConfident(value);
    }
  }
  function updateReps(value) {
    if (lastRepsRef.current !== value) {
      lastRepsRef.current = value;
      setReps(value);
    }
  }
  function updateArmed(value) {
    if (lastArmedRef.current !== value) {
      lastArmedRef.current = value;
      setArmed(value);
    }
  }
  // Only re-render when the WHOLE second changes, so micro-jitter in the
  // millisecond countdown never flickers the on-screen number.
  function updateCountdownSeconds(value) {
    if (lastCountdownRef.current !== value) {
      lastCountdownRef.current = value;
      setCountdownSeconds(value);
    }
  }
  function updatePaused(value) {
    if (lastPausedRef.current !== value) {
      lastPausedRef.current = value;
      setCountdownPaused(value);
    }
  }
  // THROTTLED debug updater. Unlike the guards above (which compare values),
  // the detector numbers change almost every frame, so instead of a value
  // change-check we gate on ELAPSED TIME: we only push new debug state (and
  // only record a report sample) once DEBUG_THROTTLE_MS has passed since the
  // last one. Returns true when it actually fired, so the caller can also
  // record a report sample on the same throttled beat. `nowMs` is the single
  // timestamp already computed for this frame.
  function maybeUpdateDebug(nowMs, readout, report) {
    if (nowMs - lastDebugAtRef.current < DEBUG_THROTTLE_MS) {
      return false;
    }
    lastDebugAtRef.current = nowMs;
    setDebugReadout(readout);
    if (report !== undefined) {
      setDebugReport(report);
    }
    return true;
  }

  const currentStep = steps[stepIndex];

  // ---- Start the alarm when the session mounts -----------------------------
  // The click that led here was a user gesture, so audio is allowed.
  useEffect(() => {
    alarm.start();
    // We intentionally do NOT stop the alarm in this effect's cleanup: stopping
    // is driven purely by completion or the emergency escape, handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- The per-frame pose handler ------------------------------------------
  // CameraView calls this every animation frame with the latest keypoints
  // keyed by MoveNet name. We turn that into a rep, and possibly a completed
  // step or a finished workout.
  function handlePose(keypoints) {
    const queue = queueRef.current;
    const counter = counterRef.current;
    const step = queue.current();
    if (!step) return;

    // 1. Pick whichever side of the body (left or right) the camera can see
    //    best right now, so a user facing either way still counts reps.
    const { side, angleJoints, requiredKeypoints } = pickBetterSide(
      step.exercise,
      keypoints
    );

    // 2. Gather the keypoints that side needs and check their confidence.
    const needed = requiredKeypoints.map((name) => keypoints[name]);
    const jointsConfident =
      needed.every(Boolean) && allConfident(needed, MIN_CONFIDENCE);

    // 3. Body-orientation gate (anti-cheat, part 2). For SIT-UPS this applies a
    //    lenient "roughly horizontal" sanity check so an obviously standing body
    //    is rejected. PUSH-UPS now use orientation 'any', so this check never
    //    blocks them (it would need the hip, which is exactly the keypoint a
    //    webcam cannot fit during a floor push-up). A standing push-up "bob" is
    //    instead rejected by the body-relative vertical excursion + hysteresis
    //    in createVerticalRepCounter plus the 5s arming countdown below.
    const orientationOk = evaluateOrientation(step.exercise, keypoints, side);

    // You only truly count when BOTH the required joints are clearly visible AND
    // the body meets the exercise's orientation expectation (always true for
    // push-ups, a lenient horizontal check for sit-ups).
    const isConfident = jointsConfident && orientationOk;

    // A single frame timestamp used by both the arming gate and the warning
    // debouncer below. Prefer performance.now(); fall back to Date.now().
    const nowMs =
      typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now();

    // Debounce the value used for the HUD WARNING ONLY. Good news (detected)
    // shows instantly; the "not detected" warning only appears after the pose
    // has been unclear for a short grace period, so a single bad frame does not
    // blink the warning on and off. This does NOT affect counting or arming.
    updateDisplayConfident(statusDebouncerRef.current.update(isConfident, nowMs));

    // 3b. ARMING GATE ("get into position first"). Before we count ANY reps for
    //     this step, the user must hold the exercise's expected position for a
    //     short moment (ARMING_HOLD_MS). We feed the gate whether the body is in
    //     position right now (joints visible AND orientation OK) along with a
    //     frame timestamp, so a brief flicker through the position does not arm.
    //     While not armed, the HUD shows "Get into position…" and we skip rep
    //     counting entirely.
    //
    //     Mid-set note: once armed we stay armed for the rest of the step, even
    //     if the user briefly leaves position. The per-rep orientation gate above
    //     already rejects bad reps, so there is no need to disarm. We only ever
    //     re-arm from scratch when a NEW step begins (see step advance below).
    const wasArmed = lastArmedRef.current;
    const { armed: isArmed, heldMs, remainingSeconds } =
      positionGateRef.current.update(isConfident, nowMs);

    // PUSH-UP ONLY: while the step is still arming, feed the STABLE ruler the
    // live body-scale each CONFIDENT frame so it builds a steady baseline from
    // the user holding the top position during the 5s countdown. We do this
    // BEFORE the not-armed early-return so the ruler is ready to lock the
    // instant the step arms. (This does not change the gate timing at all.)
    if (step.exercise === 'pushup' && !isArmed && isConfident) {
      const armingScale = measureBodyScale(keypoints);
      if (armingScale != null) {
        bodyScaleTrackerRef.current.push(armingScale, true);
      }
    }

    // Detect the ARM transition (Begin / "GO!"). For push-ups this is where we
    // LOCK the ruler and START the diagnostics report.
    if (step.exercise === 'pushup' && isArmed && !wasArmed) {
      bodyScaleTrackerRef.current.lock();
      const preset = getPreset(step.exercise, step.difficulty);
      diagnosticsRef.current.start(
        {
          exercise: step.exercise,
          difficulty: step.difficulty,
          targetReps: step.targetReps,
          downFraction: preset.downFraction,
          upFraction: preset.upFraction,
          side,
          bodyScalePx: bodyScaleTrackerRef.current.scale,
          bodyScaleLocked: bodyScaleTrackerRef.current.locked,
        },
        nowMs
      );
      // Log the report on Begin so it is in the console as JSON from the start,
      // even before any sample is recorded.
      logReport('begin', diagnosticsRef.current.report);
    }

    updateArmed(isArmed);
    if (!isArmed) {
      // Not armed yet: do not count reps. Drive the get-into-position countdown
      // instead. Feed the HUD the whole-seconds number (guarded so it only
      // re-renders when the integer second changes) and a "paused" flag for
      // when the countdown has started (some time banked) but the user is
      // currently OUT of position, so the HUD can tell them to get back.
      updateCountdownSeconds(remainingSeconds);
      updatePaused(heldMs > 0 && !isConfident);
      return;
    }

    // 4. Compute the tracked signal for THIS exercise and feed the counter.
    //    The two exercises track different things, so the pipeline forks here:
    //      - PUSH-UPS: the VISIBLE UPPER BODY's vertical position (shoulder,
    //        averaged with the nose when present) plus a body-scale ruler, so a
    //        down-then-up dip counts even with the legs/hips out of frame.
    //      - SIT-UPS: the HIP/torso ANGLE (shoulder -> hip -> knee), exactly as
    //        before — nothing about sit-ups changed.
    //    In BOTH cases the raw reading is smoothed over the last few frames
    //    (the smoother just averages numbers, so it smooths a y position just as
    //    well as an angle) before the counter sees it, so detector jitter cannot
    //    spike a fake threshold crossing. Smoothing is layered ON TOP of the
    //    hysteresis band + anti-cheat gate, not instead of them. If we cannot
    //    read a reliable signal this frame, we treat it like a not-detected
    //    frame for the warning (still debounced) and early-return WITHOUT
    //    advancing — a null-guarded skip can never nudge the counter.
    if (step.exercise === 'pushup') {
      // --- PUSH-UP: upper-body vertical movement ---
      const currentY = measureUpperBodyY(keypoints, side);
      // Use the LOCKED stable ruler captured during arming. If the lock failed
      // (e.g. no confident frame during the hold), fall back to the live
      // measurement for this frame so counting is not stranded.
      const liveScale = measureBodyScale(keypoints);
      const bodyScalePx = bodyScaleTrackerRef.current.locked
        ? bodyScaleTrackerRef.current.scale
        : liveScale;
      if (currentY == null || bodyScalePx == null) {
        updateDisplayConfident(statusDebouncerRef.current.update(false, nowMs));
        return;
      }
      // ANTI-STANDING GUARD: does the posture look like a push-up (not a
      // standing / walking bob)? This is passed to the counter as postureOk so
      // a standing dip can never ENTER the 'down' phase. We use the same ruler
      // the counter uses so the guard and the excursion agree.
      const postureOk = postureGuardRef.current.update(
        keypoints,
        side,
        bodyScalePx
      );
      const smoothedY = smootherRef.current.push(currentY);
      counter.update(smoothedY, bodyScalePx, isConfident, postureOk);

      // --- DEBUG READOUT + DIAGNOSTICS REPORT (throttled) ---
      // Pull the SAME numbers the FSM just used from counter.debug, pair them
      // with the ruler + posture result, and push them to the on-screen panel
      // and the report AT MOST a few times a second. The raw (pre-smoothing)
      // excursion is computed the same way the FSM computes the smoothed one,
      // using the counter's own baseline, so "raw vs smoothed" is apples to
      // apples. All of this is gated by maybeUpdateDebug's elapsed-time check,
      // so it never re-renders the HUD/overlay at frame rate.
      const dbg = counter.debug;
      const rawExcursion =
        dbg.baseline != null && bodyScalePx > 0
          ? (currentY - dbg.baseline) / bodyScalePx
          : null;
      const readout = {
        excursion: dbg.lastExcursion,
        rawExcursion,
        downFraction: dbg.downFraction,
        upFraction: dbg.upFraction,
        bodyScalePx,
        bodyScaleLocked: bodyScaleTrackerRef.current.locked,
        upperBodyY: currentY,
        confident: isConfident,
        armed: isArmed,
        phase: dbg.phase,
        postureOk,
        reps: dbg.reps,
      };
      if (maybeUpdateDebug(nowMs, readout, diagnosticsRef.current.report)) {
        // Record a report sample on the same throttled beat (plus the UI just
        // read a fresh report snapshot above).
        diagnosticsRef.current.sample(
          {
            excursion: dbg.lastExcursion,
            downFraction: dbg.downFraction,
            upFraction: dbg.upFraction,
            bodyScalePx,
            bodyScaleLocked: bodyScaleTrackerRef.current.locked,
            upperBodyY: currentY,
            confident: isConfident,
            armed: isArmed,
            phase: dbg.phase,
            postureOk,
            reps: dbg.reps,
          },
          nowMs
        );
      }
    } else {
      // --- SIT-UP: hip/torso angle (unchanged path) ---
      let angle = null;
      const [aName, vName, cName] = angleJoints;
      const a = keypoints[aName];
      const v = keypoints[vName];
      const c = keypoints[cName];
      if (a && v && c) {
        angle = angleBetween(a, v, c);
      }
      if (angle == null) {
        updateDisplayConfident(statusDebouncerRef.current.update(false, nowMs));
        return;
      }
      const smoothedAngle = smootherRef.current.push(angle);
      counter.update(smoothedAngle, isConfident);
    }

    // 5. Sync the queue's tally with the counter and update the HUD.
    const stepReps = queue.setReps(counter.reps);
    updateReps(stepReps);

    // 6. Step finished? Advance to the next one (with a fresh counter).
    if (queue.isStepComplete()) {
      if (queue.isWorkoutComplete()) {
        // Whole workout done: THIS is the only normal way the alarm stops.
        // Close out and log the diagnostics report (if a push-up set was being
        // recorded) so the completed numbers are in the console as JSON.
        diagnosticsRef.current.finish('completed', nowMs);
        logReport('completed', diagnosticsRef.current.report);
        setDebugReport(diagnosticsRef.current.report);
        alarm.stop();
        onComplete();
        return;
      }
      if (queue.advance()) {
        // A push-up step just finished counting and we are moving on: close its
        // report and log it before resetting for the next step.
        diagnosticsRef.current.finish('step-complete', nowMs);
        logReport('step-complete', diagnosticsRef.current.report);
        counterRef.current = makeCounterForStep(queue.current());
        smootherRef.current.reset(); // fresh smoothing for the new exercise
        // Re-arm from scratch: the next exercise needs a different start
        // position (e.g. push-up plank vs. lying down for sit-ups), so the user
        // must get into position again before counting resumes.
        positionGateRef.current.reset();
        statusDebouncerRef.current.reset(); // fresh optimistic warning state
        // Fresh stable ruler, posture guard and diagnostics for the new step.
        bodyScaleTrackerRef.current.reset();
        postureGuardRef.current.reset();
        diagnosticsRef.current.reset();
        lastDebugAtRef.current = -Infinity;
        setDebugReadout(null);
        setDebugReport(null);
        updateArmed(false);
        // Fresh countdown for the new step: back to the full 5 and not paused.
        updateCountdownSeconds(Math.ceil(ARMING_HOLD_MS / 1000));
        updatePaused(false);
        setStepIndex(queue.currentIndex());
        updateReps(0);
      }
    }
  }

  // Log the diagnostics report to the browser console as JSON. This is one of
  // the two ways the user can hand the report back to us (the other is the
  // on-screen expandable text block). Pure data; no disk or network. Wrapped so
  // a console-less environment (tests/headless) never throws.
  function logReport(reason, report) {
    if (typeof console !== 'undefined' && console.log) {
      // eslint-disable-next-line no-console
      console.log(
        `[UP N AT EM] push-up diagnostics (${reason}):`,
        JSON.stringify(report)
      );
    }
  }

  // ---- Emergency escape ----------------------------------------------------
  function handleEmergencyCancel() {
    // Close out and log the diagnostics report so the numbers up to the exit
    // are captured, then stop the alarm and leave (the alarm only ever stops on
    // full completion or this emergency hold-to-exit).
    const nowMs =
      typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now();
    diagnosticsRef.current.finish('emergency-exit', nowMs);
    logReport('emergency-exit', diagnosticsRef.current.report);
    alarm.stop();
    onEmergencyCancel();
  }

  return (
    <section className="workout-session">
      <CameraView active onPose={handlePose} />

      <ProgressHud
        exerciseId={currentStep.exercise}
        reps={reps}
        targetReps={currentStep.targetReps}
        stepIndex={stepIndex}
        stepCount={steps.length}
        confident={displayConfident}
        armed={armed}
        countdownSeconds={countdownSeconds}
        countdownPaused={countdownPaused}
        alarmPlaying={alarm.playing}
      />

      <DebugReadout debug={debugReadout} report={debugReport} />

      <EmergencyExit onCancel={handleEmergencyCancel} />
    </section>
  );
}
