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

import { useEffect, useMemo, useRef, useState } from 'react';
import CameraView from './CameraView.jsx';
import ProgressHud from './ProgressHud.jsx';
import EmergencyExit from './EmergencyExit.jsx';
import { createWorkoutQueue } from '../logic/workoutQueue.js';
import { createRepCounter } from '../logic/repCounter.js';
import { getExercise, getPreset } from '../logic/exercises.js';
import { angleBetween, allConfident } from '../logic/angles.js';

// Minimum keypoint score we trust for counting a rep (anti-cheat gate).
const MIN_CONFIDENCE = 0.3;

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

  // React state mirrors just what the HUD needs to render.
  const [stepIndex, setStepIndex] = useState(0);
  const [reps, setReps] = useState(0);
  const [confident, setConfident] = useState(false);

  const currentStep = steps[stepIndex];
  const exercise = useMemo(() => getExercise(currentStep.exercise), [currentStep]);

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

    const desc = getExercise(step.exercise);

    // 1. Gather the keypoints this exercise needs and check confidence.
    const needed = desc.requiredKeypoints.map((name) => keypoints[name]);
    const isConfident =
      needed.every(Boolean) && allConfident(needed, MIN_CONFIDENCE);
    setConfident(isConfident);

    // 2. Compute the tracked joint angle (e.g. the elbow for a push-up).
    let angle = null;
    const [aName, vName, cName] = desc.angleJoints;
    const a = keypoints[aName];
    const v = keypoints[vName];
    const c = keypoints[cName];
    if (a && v && c) {
      angle = angleBetween(a, v, c);
    }

    // 3. Feed the reading into the rep counter. The counter ignores the reading
    //    entirely if it is not confident (anti-cheat), so we pass a safe angle
    //    when we could not compute one.
    counter.update(angle == null ? desc.difficulties[step.difficulty].upAngle : angle, isConfident);

    // 4. Sync the queue's tally with the counter and update the HUD.
    const stepReps = queue.setReps(counter.reps);
    setReps(stepReps);

    // 5. Step finished? Advance to the next one (with a fresh counter).
    if (queue.isStepComplete()) {
      if (queue.isWorkoutComplete()) {
        // Whole workout done: THIS is the only normal way the alarm stops.
        alarm.stop();
        onComplete();
        return;
      }
      if (queue.advance()) {
        counterRef.current = makeCounterForStep(queue.current());
        setStepIndex(queue.currentIndex());
        setReps(0);
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
        alarmPlaying={alarm.playing}
      />

      <EmergencyExit onCancel={handleEmergencyCancel} />
    </section>
  );
}
