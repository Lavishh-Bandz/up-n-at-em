// exercises.js
// -----------------------------------------------------------------------------
// Descriptions of the exercises UP N AT EM can count, plus difficulty presets.
//
// This is pure data + small pure helpers. No React, no DOM. It tells the rest
// of the app:
//   - which three joints form the angle we track for each exercise
//   - which joints MUST be visible for a pose to count (anti-cheat)
//   - what the "down" and "up" angle thresholds are at each difficulty
//   - a sensible default number of reps per difficulty
//
// JOINT NAMES come from MoveNet, the pose-detection model we use. MoveNet names
// its 17 keypoints like: 'left_shoulder', 'left_elbow', 'left_wrist',
// 'left_hip', 'left_knee', etc. We keep the exact same strings so the names
// line up directly with the detector output later.

/**
 * PUSH-UP
 *   Tracked angle: the ELBOW angle (shoulder -> elbow -> wrist).
 *     top of a push-up    = arm straight  = large angle (~170)
 *     bottom of a push-up = elbow bent    = small angle (~90)
 *
 * SIT-UP
 *   Tracked angle: the HIP / torso angle (shoulder -> hip -> knee).
 *     lying down flat = torso open   = large angle (~150+)
 *     sitting up      = torso folded = small angle (~80)
 *
 * For each exercise, `angleJoints` is [outerA, vertex, outerC] in the order
 * angleBetween() expects, and `requiredKeypoints` lists every joint that must
 * be confidently visible for the rep to count.
 */
export const EXERCISES = {
  pushup: {
    id: 'pushup',
    label: 'Push-ups',
    // Elbow angle: shoulder -> elbow (vertex) -> wrist.
    angleJoints: ['left_shoulder', 'left_elbow', 'left_wrist'],
    // All three are needed to measure the elbow; without them we cannot trust
    // a rep, so they double as the anti-cheat "required pose".
    requiredKeypoints: ['left_shoulder', 'left_elbow', 'left_wrist'],
    difficulties: {
      // Easier = shallower range of motion (less bend required) and fewer reps.
      easy: { downAngle: 100, upAngle: 150, defaultReps: 10 },
      standard: { downAngle: 90, upAngle: 160, defaultReps: 20 },
      // Harder = stricter angles (deeper bend + straighter lockout) + more reps.
      hard: { downAngle: 80, upAngle: 170, defaultReps: 45 },
    },
  },

  situp: {
    id: 'situp',
    label: 'Sit-ups',
    // Hip/torso angle: shoulder -> hip (vertex) -> knee.
    angleJoints: ['left_shoulder', 'left_hip', 'left_knee'],
    requiredKeypoints: ['left_shoulder', 'left_hip', 'left_knee'],
    difficulties: {
      easy: { downAngle: 100, upAngle: 140, defaultReps: 10 },
      standard: { downAngle: 90, upAngle: 150, defaultReps: 20 },
      hard: { downAngle: 70, upAngle: 160, defaultReps: 30 },
    },
  },
};

/** The difficulty levels, ordered from easiest to hardest. */
export const DIFFICULTIES = ['easy', 'standard', 'hard'];

/**
 * Look up an exercise descriptor by id.
 * @param {('pushup'|'situp')} exerciseId
 * @returns {object} the exercise descriptor
 */
export function getExercise(exerciseId) {
  const exercise = EXERCISES[exerciseId];
  if (!exercise) {
    throw new Error(`Unknown exercise: ${exerciseId}`);
  }
  return exercise;
}

/**
 * Get the threshold preset ({ downAngle, upAngle, defaultReps }) for an
 * exercise at a given difficulty. These values are meant to be fed straight
 * into createRepCounter().
 *
 * @param {('pushup'|'situp')} exerciseId
 * @param {('easy'|'standard'|'hard')} difficulty
 * @returns {{downAngle:number, upAngle:number, defaultReps:number}}
 */
export function getPreset(exerciseId, difficulty) {
  const exercise = getExercise(exerciseId);
  const preset = exercise.difficulties[difficulty];
  if (!preset) {
    throw new Error(`Unknown difficulty "${difficulty}" for exercise "${exerciseId}"`);
  }
  return preset;
}
