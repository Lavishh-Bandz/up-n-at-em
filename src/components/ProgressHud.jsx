// ProgressHud.jsx
// -----------------------------------------------------------------------------
// The heads-up display shown DURING a workout. It tells the user everything
// they need at a glance:
//   - which exercise they are on and how many reps they have vs the target
//   - overall progress through a multi-step workout ("Step 1 of 2")
//   - an anti-cheat warning when the camera cannot see them clearly
//   - that the alarm is currently blaring
//
// It is a "dumb" presentational component: the parent (WorkoutSession) computes
// all the numbers and passes them in as props.

import { EXERCISES } from '../logic/exercises.js';
import { DEFAULT_HOLD_MS } from '../logic/positionGate.js';

// The countdown starts at this many whole seconds (derived from the gate's hold
// time so the HUD and the gate always agree). While the countdown still shows
// this number and is not paused, the user has not started getting into position
// yet, so we show the plain prompt instead of the big number.
const COUNTDOWN_START_SECONDS = Math.ceil(DEFAULT_HOLD_MS / 1000);

// Friendly SINGULAR names for the "Get into ___ position…" prompt. The regular
// `label` ("Push-ups") reads oddly in that sentence, so we keep a small map of
// nicer singular forms here.
const POSITION_LABELS = {
  pushup: 'push-up',
  situp: 'sit-up',
};

export default function ProgressHud({
  exerciseId,        // 'pushup' | 'situp'
  reps,              // reps completed on the current step
  targetReps,        // target for the current step
  stepIndex,         // zero-based index of the current step
  stepCount,         // total number of steps
  confident,         // is the current pose reading trustworthy?
  armed,             // has the current step confirmed your position (counting on)?
  countdownSeconds,  // whole seconds left on the get-into-position countdown (5..1)
  countdownPaused,   // is the countdown paused because you stepped out of position?
  alarmPlaying,      // is the alarm sounding right now?
}) {
  const label = EXERCISES[exerciseId]?.label ?? exerciseId;
  const positionLabel = POSITION_LABELS[exerciseId] ?? label;

  // The countdown is still at its very start (full time left and not paused)
  // when the user has not actually got into position yet. In that case we show
  // the plain "get into position" prompt. Once even a little time has ticked
  // down, OR the countdown is paused mid-way, we switch to the big number.
  const countdownStarted =
    !armed && (countdownPaused || countdownSeconds < COUNTDOWN_START_SECONDS);

  return (
    <div className="progress-hud">
      <div className="hud-row hud-step">
        Step {stepIndex + 1} of {stepCount}
      </div>

      <div className="hud-row hud-exercise">{label}</div>

      {/* ARMING SLOT: before counting starts we ask the user to get into
          position. The slot walks through three looks:
            1. "Get into position…" before any time has banked,
            2. a big 5-4-3-2-1 countdown that only runs while you ARE in position
               (it pauses with a hint if you step out), and
            3. "✓ Ready — GO!" once the countdown hits zero and counting begins.
          The alarm keeps blaring the whole time either way.

          LAYOUT NOTE: all three looks live inside ONE fixed-height slot
          (.hud-arming-slot) so switching between them never resizes the panel.
          Only the text inside the slot changes; the box stays put. */}
      <div className="hud-row hud-arming-slot">
        {armed ? (
          <div className="hud-armed" role="status">
            ✓ Ready — GO!
          </div>
        ) : countdownStarted ? (
          <div className="hud-countdown" role="status" aria-live="polite">
            <div className="hud-countdown-number">{countdownSeconds}</div>
            {countdownPaused ? (
              <div className="hud-countdown-hint">
                Paused — get back into {positionLabel} position…
              </div>
            ) : (
              <div className="hud-countdown-hint">Hold it… counting down!</div>
            )}
          </div>
        ) : (
          <div className="hud-arming" role="status">
            Get into {positionLabel} position…
          </div>
        )}
      </div>

      <div className="hud-row hud-reps">
        <span className="hud-reps-count">{reps}</span>
        <span className="hud-reps-sep"> / </span>
        <span className="hud-reps-target">{targetReps}</span>
      </div>

      {/* Anti-cheat feedback: if the pose is not confidently detected, reps are
          not being counted, so tell the user to get back in frame.

          LAYOUT NOTE: this row is ALWAYS rendered and simply hidden (made
          invisible but still taking up its space) when the pose is fine, so the
          warning appearing/disappearing never pushes the rest of the panel
          around. The `confident` value here is already DEBOUNCED by the parent,
          so it will not flicker on a single bad frame. */}
      <div
        className={
          'hud-row hud-warning' + (confident ? ' hud-row-hidden' : '')
        }
        role="status"
      >
        ⚠️ Pose not detected — make sure your whole body is in frame and
        well lit. Reps only count when the camera can see you clearly.
      </div>

      {/* The alarm row is likewise always present and just hidden when the
          alarm is not sounding, so the panel keeps a steady height. */}
      <div
        className={
          'hud-row hud-alarm' + (alarmPlaying ? '' : ' hud-row-hidden')
        }
        role="status"
      >
        🔔 Alarm is playing — finish your reps to silence it!
      </div>
    </div>
  );
}
