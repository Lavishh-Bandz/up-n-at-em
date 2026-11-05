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

export default function ProgressHud({
  exerciseId,     // 'pushup' | 'situp'
  reps,           // reps completed on the current step
  targetReps,     // target for the current step
  stepIndex,      // zero-based index of the current step
  stepCount,      // total number of steps
  confident,      // is the current pose reading trustworthy?
  alarmPlaying,   // is the alarm sounding right now?
}) {
  const label = EXERCISES[exerciseId]?.label ?? exerciseId;

  return (
    <div className="progress-hud">
      <div className="hud-row hud-step">
        Step {stepIndex + 1} of {stepCount}
      </div>

      <div className="hud-row hud-exercise">{label}</div>

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
