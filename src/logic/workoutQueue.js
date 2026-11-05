// workoutQueue.js
// -----------------------------------------------------------------------------
// Manages an ORDERED list of workout steps and tracks your progress through
// them. This is what ultimately gates the alarm: the alarm is only allowed to
// stop once EVERY step has reached its target reps, in order.
//
// A "step" looks like:
//   { exercise: 'pushup', difficulty: 'hard', targetReps: 45 }
//
// Example workout: 45 push-ups, THEN 30 sit-ups. You must finish the push-ups
// before you can advance to the sit-ups, and the whole workout is only complete
// when both targets are met.
//
// Pure module: no React, no DOM, no timers. You call recordRep() (or setReps)
// as the camera counts reps, and ask isStepComplete() / isWorkoutComplete().

/**
 * Create a workout queue from an ordered list of steps.
 *
 * @param {Array<{exercise:string, difficulty:string, targetReps:number}>} steps
 * @returns {object} the queue API (see methods below)
 */
export function createWorkoutQueue(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('createWorkoutQueue requires a non-empty array of steps');
  }

  // Make a private, defensive copy so callers cannot mutate our internals, and
  // attach a `completedReps` tally to each step (starts at 0).
  const queue = steps.map((step) => ({
    exercise: step.exercise,
    difficulty: step.difficulty,
    targetReps: step.targetReps,
    completedReps: 0,
  }));

  // Index of the step we are currently working on.
  let index = 0;

  return {
    /** The step currently being performed (or null if we walked off the end). */
    current() {
      return queue[index] || null;
    },

    /** Zero-based index of the current step. */
    currentIndex() {
      return index;
    },

    /** How many steps are in this workout. */
    get length() {
      return queue.length;
    },

    /**
     * Add one rep to the current step. Call this each time the camera confirms
     * a rep. Reps are capped at the step's target so we never overshoot.
     * @returns {number} the current step's rep count after recording.
     */
    recordRep() {
      const step = queue[index];
      if (!step) return 0;
      if (step.completedReps < step.targetReps) {
        step.completedReps += 1;
      }
      return step.completedReps;
    },

    /**
     * Set the current step's rep count directly (e.g. to sync with a rep
     * counter's running total). Clamped to the 0..targetReps range.
     * @param {number} n
     * @returns {number} the current step's rep count after setting.
     */
    setReps(n) {
      const step = queue[index];
      if (!step) return 0;
      const clamped = Math.max(0, Math.min(n, step.targetReps));
      step.completedReps = clamped;
      return step.completedReps;
    },

    /** Is the CURRENT step finished (reached its target reps)? */
    isStepComplete() {
      const step = queue[index];
      if (!step) return true;
      return step.completedReps >= step.targetReps;
    },

    /**
     * Move on to the next step. Only advances if the current step is actually
     * complete and there is a next step to go to, so you cannot skip ahead.
     * @returns {boolean} true if we advanced, false otherwise.
     */
    advance() {
      if (!this.isStepComplete()) {
        return false;
      }
      if (index < queue.length - 1) {
        index += 1;
        return true;
      }
      return false;
    },

    /**
     * Is the WHOLE workout complete? True only when every step has met its
     * target reps. This is the single source of truth for "can the alarm stop".
     */
    isWorkoutComplete() {
      return queue.every((step) => step.completedReps >= step.targetReps);
    },

    /** A read-only snapshot of all steps (for progress displays). */
    snapshot() {
      return queue.map((step) => ({ ...step }));
    },
  };
}
