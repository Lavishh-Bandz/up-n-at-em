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

// A fresh default step to seed the form with.
function makeDefaultStep() {
  return {
    exercise: 'pushup',
    difficulty: 'standard',
    // Prefill reps from the difficulty's suggested default.
    targetReps: getPreset('pushup', 'standard').defaultReps,
  };
}

// Human-friendly label, e.g. "45 push-ups".
function describeStep(step) {
  const label = EXERCISES[step.exercise].label.toLowerCase();
  return `${step.targetReps} ${label}`;
}

export default function SettingsPanel({ onStart }) {
  // The list of steps the user is building. Start with one push-up step.
  const [steps, setSteps] = useState(() => [makeDefaultStep()]);
  const [validationError, setValidationError] = useState('');

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
      targetReps: getPreset(exercise, difficulty).defaultReps,
    });
  }

  function handleDifficultyChange(index, difficulty) {
    const exercise = steps[index].exercise;
    updateStep(index, {
      difficulty,
      targetReps: getPreset(exercise, difficulty).defaultReps,
    });
  }

  function handleRepsChange(index, value) {
    // Allow the field to be cleared while typing; store a number otherwise.
    const n = value === '' ? '' : Math.max(0, Math.floor(Number(value) || 0));
    updateStep(index, { targetReps: n });
  }

  function addStep() {
    setSteps((prev) => [...prev, makeDefaultStep()]);
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
    </section>
  );
}
