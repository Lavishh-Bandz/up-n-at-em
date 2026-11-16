// SettingsPanel.jsx
// -----------------------------------------------------------------------------
// The "set your alarm" screen. Here the user builds a workout: one or more
// steps, each one an exercise + difficulty + target reps. For example:
//   "45 push-ups then 30 sit-ups".
//
// When they press Start, we hand the finished list of steps up to App, which
// launches the workout session (camera + alarm).
//
// All the exercise/difficulty data comes from the pure FEAT-001 logic module
// (exercises.js) so the UI and the rep-counting stay perfectly in sync.

import { useState } from 'react';
import { EXERCISES, DIFFICULTIES, getPreset } from '../logic/exercises.js';
import HoldButton from './HoldButton.jsx';

// A fresh default step to seed the form with. If we know a persisted current
// target for the default exercise/difficulty, we prefill the reps from THAT
// (so a user who has been progressing sees today's real target) and otherwise
// fall back to the difficulty's suggested default reps.
function makeDefaultStep(progressState) {
  const exercise = 'pushup';
  const difficulty = 'standard';
  return {
    exercise,
    difficulty,
    targetReps: prefilledReps(progressState, exercise, difficulty),
  };
}

// Work out the reps to prefill for an exercise/difficulty: prefer the persisted
// currentTarget for that exercise when we have one, otherwise the preset's
// suggested default reps.
function prefilledReps(progressState, exercise, difficulty) {
  const saved =
    progressState &&
    progressState.settings &&
    progressState.settings[exercise];
  if (saved && typeof saved.currentTarget === 'number') {
    return saved.currentTarget;
  }
  return getPreset(exercise, difficulty).defaultReps;
}

// Human-friendly label, e.g. "45 push-ups".
function describeStep(step) {
  const label = EXERCISES[step.exercise].label.toLowerCase();
  return `${step.targetReps} ${label}`;
}

/**
 * @param {object} props
 * @param {(steps:Array) => void} props.onStart  Launch the workout with these steps.
 * @param {object} props.progress  The useProgress bridge (state + action wrappers).
 * @param {() => void} props.onOpenTracker  Open the progress tracker screen.
 */
export default function SettingsPanel({ onStart, progress, onOpenTracker }) {
  // The persisted progress state (may be null for a single frame on first load).
  const progressState = progress ? progress.state : null;

  // The list of steps the user is building. Start with one push-up step,
  // prefilled from the persisted target when we have it.
  const [steps, setSteps] = useState(() => [makeDefaultStep(progressState)]);
  const [validationError, setValidationError] = useState('');
  // A friendly confirmation shown after a deliberate Skip-today hold completes.
  const [skipConfirmed, setSkipConfirmed] = useState(false);

  // ---- Helpers to edit the steps array immutably --------------------------

  function updateStep(index, changes) {
    setSteps((prev) =>
      prev.map((step, i) => (i === index ? { ...step, ...changes } : step))
    );
  }

  // When exercise or difficulty changes, re-seed the rep count with that
  // combination's default so the number stays sensible (still editable).
  function handleExerciseChange(index, exercise) {
    const difficulty = steps[index].difficulty;
    updateStep(index, {
      exercise,
      // Prefill from the persisted current target for this exercise when we
      // have it, else the preset default.
      targetReps: prefilledReps(progressState, exercise, difficulty),
    });
  }

  function handleDifficultyChange(index, difficulty) {
    const exercise = steps[index].exercise;
    updateStep(index, {
      difficulty,
      targetReps: prefilledReps(progressState, exercise, difficulty),
    });
  }

  function handleRepsChange(index, value) {
    // Allow the field to be cleared while typing; store a number otherwise.
    const n = value === '' ? '' : Math.max(0, Math.floor(Number(value) || 0));
    updateStep(index, { targetReps: n });
  }

  function addStep() {
    setSteps((prev) => [...prev, makeDefaultStep(progressState)]);
  }

  function removeStep(index) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }

  // Reorder by swapping a step with its neighbour (simple up/down controls).
  function moveStep(index, direction) {
    const target = index + direction;
    setSteps((prev) => {
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  // ---- Deliberate "Skip today" -------------------------------------------
  // Fired only after a completed press-and-HOLD (see the HoldButton below).
  // Marks today as a rest/skip day via the pure core: behaves like missing
  // exactly one day (target holds, streak continues). See the big comment on
  // the control in the JSX for WHY this is a separate, deliberate gesture.
  function handleSkipToday() {
    if (progress) {
      progress.skipDay();
    }
    setSkipConfirmed(true);
  }

  // ---- Start the workout ---------------------------------------------------

  function handleStart() {
    // Validate: we need at least one step, and every step must have reps >= 1.
    const cleaned = steps
      .map((s) => ({ ...s, targetReps: Number(s.targetReps) }))
      .filter((s) => Number.isFinite(s.targetReps));

    if (cleaned.length === 0 || cleaned.some((s) => s.targetReps < 1)) {
      setValidationError(
        'Add at least one exercise and make sure every step has 1 or more reps.'
      );
      return;
    }

    setValidationError('');
    onStart(cleaned);
  }

  // A plain-English summary like "45 push-ups then 30 sit-ups".
  const chainSummary = steps
    .filter((s) => Number(s.targetReps) >= 1)
    .map(describeStep)
    .join(' then ');

  // The PRIMARY exercise whose progression we surface controls for: the first
  // step's exercise. Its persisted settings (difficulty, current + starting
  // target, auto-increase) come straight from the saved progress state.
  const primaryExercise = steps.length > 0 ? steps[0].exercise : 'pushup';
  const primarySettings =
    progressState && progressState.settings
      ? progressState.settings[primaryExercise]
      : null;
  // The manual-decrease button is disabled once we are already sitting on the
  // starting target (the floor it can never go below).
  const atStartingTarget =
    primarySettings != null &&
    primarySettings.currentTarget <= primarySettings.startingTarget;

  return (
    <section className="settings-panel">
      <h1 className="app-title">UP N AT EM</h1>
      <p className="tagline">
        Set your alarm. It won&apos;t turn off until you finish your reps on
        camera.
      </p>

      <h2>Build your workout</h2>

      <ol className="step-list">
        {steps.map((step, index) => (
          <li key={index} className="step-row">
            <span className="step-number">Step {index + 1}</span>

            <label>
              Exercise
              <select
                value={step.exercise}
                onChange={(e) => handleExerciseChange(index, e.target.value)}
              >
                {Object.values(EXERCISES).map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Difficulty
              <select
                value={step.difficulty}
                onChange={(e) => handleDifficultyChange(index, e.target.value)}
              >
                {DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Reps
              <input
                type="number"
                min="1"
                value={step.targetReps}
                onChange={(e) => handleRepsChange(index, e.target.value)}
              />
            </label>

            <div className="step-controls">
              <button
                type="button"
                onClick={() => moveStep(index, -1)}
                disabled={index === 0}
                title="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveStep(index, 1)}
                disabled={index === steps.length - 1}
                title="Move down"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => removeStep(index)}
                disabled={steps.length === 1}
                title="Remove step"
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ol>

      <button type="button" className="add-step" onClick={addStep}>
        + Add another exercise
      </button>

      {chainSummary && (
        <p className="chain-summary">
          Your workout: <strong>{chainSummary}</strong>
        </p>
      )}

      {validationError && (
        <p className="validation-error" role="alert">
          {validationError}
        </p>
      )}

      <button type="button" className="start-button" onClick={handleStart}>
        Set alarm &amp; Start
      </button>

      <p className="emergency-note">
        Safety note: once the alarm starts it will only stop when you finish
        every rep. There is also a clearly-labelled hold-to-cancel emergency
        exit on the workout screen if you ever truly need out.
      </p>

      {/* ---- Progression controls for the primary exercise ---------------- */}
      {/* These are backed by the persisted progress state (useProgress). They
          let the user steer the progressive-overload system: turn the daily
          auto-increase on/off, manually dial the number DOWN if it got too
          hard (never below their starting target), and set the starting target
          (the baseline AND the floor). The difficulty picker above already
          includes 'extreme' automatically because it is driven by the
          DIFFICULTIES list, not hard-coded here. */}
      {primarySettings && (
        <div className="progression-controls">
          <h2>Daily progression — {EXERCISES[primaryExercise].label}</h2>

          <p className="progression-targets">
            Today&apos;s target: <strong>{primarySettings.currentTarget}</strong>{' '}
            reps
            <span className="progression-starting">
              {' '}
              (starting target {primarySettings.startingTarget},{' '}
              {primarySettings.difficulty})
            </span>
          </p>

          <label className="progression-toggle">
            <input
              type="checkbox"
              checked={Boolean(primarySettings.autoIncrease)}
              onChange={(e) =>
                progress.setAutoIncrease(primaryExercise, e.target.checked)
              }
            />{' '}
            Automatically increase my reps each day
          </label>

          <div className="progression-row">
            <button
              type="button"
              className="decrease-button"
              onClick={() => progress.decreaseTarget(primaryExercise, 1)}
              disabled={atStartingTarget}
              title={
                atStartingTarget
                  ? 'Already at your starting target'
                  : 'Lower today\u2019s target by one rep'
              }
            >
              Make it easier (-1)
            </button>

            <label className="starting-target-field">
              Starting target
              <input
                type="number"
                min="1"
                value={primarySettings.startingTarget}
                onChange={(e) => {
                  const n = Math.max(1, Math.floor(Number(e.target.value) || 1));
                  progress.setStartingTarget(primaryExercise, n);
                }}
              />
            </label>
          </div>
        </div>
      )}

      {/* ---- DELIBERATE "Skip today" (press and HOLD) --------------------- */}
      {/* UX DECISION (why this lives HERE and is a HOLD):
          Missing a day on purpose is a REAL outcome (it preserves your streak
          and holds your target), so it must be a DELIBERATE action — never an
          accident. We deliberately keep it SEPARATE from the mid-workout
          emergency exit: that emergency hold on the workout screen is a safety
          hatch that records NOTHING, so a panicked bail-out can never be
          mistaken for an intentional skip. Making "Skip today" its own clearly
          labelled press-and-hold on the calm settings screen means the only way
          to log a skip is to calmly, intentionally choose it. A completed hold
          behaves exactly like missing one day (target holds, streak continues). */}
      {progress && (
        <div className="skip-today">
          <h2>Taking a rest day?</h2>
          <p className="skip-caption">
            Hold the button to mark today as a deliberate rest/skip day. Your
            streak is preserved and your target holds (just like missing a
            single day). This is separate from the emergency exit so an
            accidental mid-workout stop is never logged as a skip.
          </p>
          <HoldButton
            label="Skip today"
            holdMs={2500}
            className="skip-hold-button"
            onHoldComplete={handleSkipToday}
          />
          {skipConfirmed && (
            <p className="skip-confirmation" role="status">
              Marked today as a rest/skip day — streak preserved, target held.
            </p>
          )}
        </div>
      )}

      {/* ---- Open the progress / consistency tracker ---------------------- */}
      {onOpenTracker && (
        <button
          type="button"
          className="tracker-link"
          onClick={onOpenTracker}
        >
          View your progress
        </button>
      )}
    </section>
  );
}
