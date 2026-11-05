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

// Friendly SINGULAR names for the "Get into ___ position…" prompt. The regular
// `label` ("Push-ups") reads oddly in that sentence, so we keep a small map of
// nicer singular forms here.
const POSITION_LABELS = {
  pushup: 'push-up',
  situp: 'sit-up',
};

export default function ProgressHud({
  exerciseId,     // 'pushup' | 'situp'
  reps,           // reps completed on the current step
  targetReps,     // target for the current step
  stepIndex,      // zero-based index of the current step
  stepCount,      // total number of steps
  confident,      // is the current pose reading trustworthy?
  armed,          // has the current step confirmed your position (counting on)?
  alarmPlaying,   // is the alarm sounding right now?
}) {
  const label = EXERCISES[exerciseId]?.label ?? exerciseId;
  const positionLabel = POSITION_LABELS[exerciseId] ?? label;

  return (
    <div className="progress-hud">
      <div className="hud-row hud-step">
        Step {stepIndex + 1} of {stepCount}
      </div>

      <div className="hud-row hud-exercise">{label}</div>

      {/* ARMING: before counting starts we ask the user to get into position and
          hold it for a moment. Once the position is confirmed we flip to a clear
          "Ready — GO!" and show the live rep count. The alarm keeps blaring the
          whole time either way. */}
      {!armed ? (
        <div className="hud-row hud-arming" role="status">
          Get into {positionLabel} position…
        </div>
      ) : (
        <div className="hud-row hud-armed" role="status">
          ✓ Ready — GO!
        </div>
      )}

      <div className="hud-row hud-reps">
        <span className="hud-reps-count">{reps}</span>
        <span className="hud-reps-sep"> / </span>
        <span className="hud-reps-target">{targetReps}</span>
      </div>

      {/* Anti-cheat feedback: if the pose is not confidently detected, reps are
          not being counted, so tell the user to get back in frame. */}
      {!confident && (
        <div className="hud-row hud-warning" role="status">
          ⚠️ Pose not detected — make sure your whole body is in frame and
          well lit. Reps only count when the camera can see you clearly.
        </div>
      )}

      {alarmPlaying && (
        <div className="hud-row hud-alarm" role="status">
          🔔 Alarm is playing — finish your reps to silence it!
        </div>
      )}
    </div>
  );
}
