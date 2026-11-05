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
import { createWorkoutQueue } from '../logic/workoutQueue.js';
import { createRepCounter } from '../logic/repCounter.js';
import { getPreset, pickBetterSide, evaluateOrientation } from '../logic/exercises.js';
import { angleBetween, allConfident, createAngleSmoother } from '../logic/angles.js';
import { createPositionGate } from '../logic/positionGate.js';

// How many recent angle readings we average together to calm down detector
// jitter before the rep counter sees them. A small window keeps fast reps
// responsive while still smoothing single-frame wobbles.
const SMOOTHING_WINDOW = 5;

// Minimum keypoint score we trust for counting a rep (anti-cheat gate).
const MIN_CONFIDENCE = 0.3;

// How long (ms) the user must HOLD the correct position before a step "arms"
// and we start counting. ~1 second is long enough to reject a brief flicker or
// just passing through the position, but short enough to feel responsive.
const ARMING_HOLD_MS = 1000;

/**
 * Build a rep counter configured for a specific workout step.
 */
function makeCounterForStep(step) {
  const preset = getPreset(step.exercise, step.difficulty);
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

  // React state mirrors just what the HUD needs to render.
  const [stepIndex, setStepIndex] = useState(0);
  const [reps, setReps] = useState(0);
  const [confident, setConfident] = useState(false);
  // Is the current step armed (position confirmed, now counting)? Starts false
  // so the HUD shows the "get into position" prompt first.
  const [armed, setArmed] = useState(false);

  // The pose handler runs every animation frame. To avoid re-rendering the HUD
  // at frame rate, we remember the last value we pushed into each piece of
  // state and only call the setter when the value actually changed.
  const lastRepsRef = useRef(0);
  const lastConfidentRef = useRef(false);
  const lastArmedRef = useRef(false);

  // Small helpers: only update state when the value is different from last time.
  function updateConfident(value) {
    if (lastConfidentRef.current !== value) {
      lastConfidentRef.current = value;
      setConfident(value);
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

    // 3. Body-orientation gate (anti-cheat, part 2). For push-ups this requires
    //    your torso to be roughly horizontal, so standing up and just bending
    //    your elbows does NOT count. Exercises that do not care about
    //    orientation ('any') always pass this check.
    const orientationOk = evaluateOrientation(step.exercise, keypoints, side);

    // You only truly count when BOTH the joints are clearly visible AND the body
    // is in the right position.
    const isConfident = jointsConfident && orientationOk;
    updateConfident(isConfident);

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
    const nowMs =
      typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now();
    const { armed: isArmed } = positionGateRef.current.update(isConfident, nowMs);
    updateArmed(isArmed);
    if (!isArmed) {
      // Not armed yet: do not count reps. Keep showing the prompt and wait for
      // the user to hold the position long enough.
      return;
    }

    // 4. Compute the tracked joint angle (e.g. the elbow for a push-up) on the
    //    chosen side.
    let angle = null;
    const [aName, vName, cName] = angleJoints;
    const a = keypoints[aName];
    const v = keypoints[vName];
    const c = keypoints[cName];
    if (a && v && c) {
      angle = angleBetween(a, v, c);
    }

    // 5. If we could not compute an angle, there is nothing reliable to feed the
    //    rep counter, so treat the frame as not-confident and skip the rep
    //    update entirely. (A null-guarded early return is clearer and safer than
    //    passing a fake fallback angle: it can never nudge the counter, even if a
    //    future exercise's required keypoints differ from its angle joints.)
    if (angle == null) {
      updateConfident(false);
      return;
    }

    // 6. Smooth the angle over the last few frames before the counter sees it.
    //    This calms down detector jitter so the counting is steadier and a
    //    single bad frame cannot spike a fake threshold crossing. Smoothing is
    //    layered ON TOP of the hysteresis band and anti-cheat gate, not instead
    //    of them.
    const smoothedAngle = smootherRef.current.push(angle);

    // 7. Feed the smoothed reading into the rep counter. The counter still
    //    ignores the reading if it is not confident (anti-cheat + orientation).
    counter.update(smoothedAngle, isConfident);

    // 6. Sync the queue's tally with the counter and update the HUD.
    const stepReps = queue.setReps(counter.reps);
    updateReps(stepReps);

    // 7. Step finished? Advance to the next one (with a fresh counter).
    if (queue.isStepComplete()) {
      if (queue.isWorkoutComplete()) {
        // Whole workout done: THIS is the only normal way the alarm stops.
        alarm.stop();
        onComplete();
        return;
      }
      if (queue.advance()) {
        counterRef.current = makeCounterForStep(queue.current());
        smootherRef.current.reset(); // fresh smoothing for the new exercise
        // Re-arm from scratch: the next exercise needs a different start
        // position (e.g. push-up plank vs. lying down for sit-ups), so the user
        // must get into position again before counting resumes.
        positionGateRef.current.reset();
        updateArmed(false);
        setStepIndex(queue.currentIndex());
        updateReps(0);
      }
    }
  }

  // ---- Emergency escape ----------------------------------------------------
  function handleEmergencyCancel() {
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
        confident={confident}
        armed={armed}
        alarmPlaying={alarm.playing}
      />

      <EmergencyExit onCancel={handleEmergencyCancel} />
    </section>
  );
}
