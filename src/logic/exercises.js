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
// 'left_hip', 'left_knee', etc. (and the matching 'right_*' names for the other
// side of the body). We keep the exact same strings so the names line up
// directly with the detector output later.
//
// WHY WE TRACK BOTH SIDES (left AND right):
//   A camera only ever sees one side of you clearly. If you lie down facing the
//   other way, your LEFT arm/hip might be hidden behind your body while your
//   RIGHT side is in full view. If we only ever looked at the left side, those
//   users would count zero reps with no explanation. So every exercise lists a
//   left joint triple AND a right joint triple, and each frame we pick whichever
//   side the camera can see more confidently (see pickBetterSide below).

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
 * For each exercise and each SIDE, `angleJoints` is [outerA, vertex, outerC] in
 * the order angleBetween() expects, and `requiredKeypoints` lists every joint
 * that must be confidently visible on that side for the rep to count. The two
 * sides live under `sides.left` and `sides.right`.
 */
export const EXERCISES = {
  pushup: {
    id: 'pushup',
    label: 'Push-ups',
    sides: {
      // Elbow angle: shoulder -> elbow (vertex) -> wrist.
      // All three are needed to measure the elbow; without them we cannot trust
      // a rep, so they double as the anti-cheat "required pose" for that side.
      left: {
        angleJoints: ['left_shoulder', 'left_elbow', 'left_wrist'],
        requiredKeypoints: ['left_shoulder', 'left_elbow', 'left_wrist'],
      },
      right: {
        angleJoints: ['right_shoulder', 'right_elbow', 'right_wrist'],
        requiredKeypoints: ['right_shoulder', 'right_elbow', 'right_wrist'],
      },
    },
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
    sides: {
      // Hip/torso angle: shoulder -> hip (vertex) -> knee.
      left: {
        angleJoints: ['left_shoulder', 'left_hip', 'left_knee'],
        requiredKeypoints: ['left_shoulder', 'left_hip', 'left_knee'],
      },
      right: {
        angleJoints: ['right_shoulder', 'right_hip', 'right_knee'],
        requiredKeypoints: ['right_shoulder', 'right_hip', 'right_knee'],
      },
    },
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

/**
 * Add up the confidence scores of a list of keypoints for one side of the body.
 *
 * A keypoint that is missing (the detector did not return it) or has no numeric
 * score counts as 0 here, so a side the camera cannot see scores low. This is a
 * pure helper: it takes the keypoints-by-name map and the joint names, and
 * returns a plain number.
 *
 * @param {Object<string,{score?:number}>} keypointsByName  Keypoints keyed by MoveNet name.
 * @param {string[]} jointNames                             The joints to total up.
 * @returns {number} the summed confidence (0 or more)
 */
export function sumSideConfidence(keypointsByName, jointNames) {
  if (!keypointsByName || !Array.isArray(jointNames)) {
    return 0;
  }
  let total = 0;
  for (const name of jointNames) {
    const kp = keypointsByName[name];
    if (kp && typeof kp.score === 'number') {
      total += kp.score;
    }
  }
  return total;
}

/**
 * Pick the side of the body ('left' or 'right') the camera can currently see
 * best for a given exercise, and return that side's joint configuration.
 *
 * WHY: the camera only sees one side of you clearly. We compare the summed
 * confidence of the LEFT required joints against the RIGHT required joints and
 * track whichever side is more visible, so a user facing either way still
 * counts reps. Ties go to the left side (an arbitrary but stable default).
 *
 * This is a PURE function (no React, no DOM) so it can be unit tested with
 * made-up keypoint maps.
 *
 * @param {('pushup'|'situp')} exerciseId
 * @param {Object<string,{score?:number}>} keypointsByName  Keypoints keyed by MoveNet name.
 * @returns {{
 *   side: ('left'|'right'),
 *   angleJoints: string[],
 *   requiredKeypoints: string[],
 *   leftScore: number,
 *   rightScore: number
 * }}
 */
export function pickBetterSide(exerciseId, keypointsByName) {
  const exercise = getExercise(exerciseId);
  const left = exercise.sides.left;
  const right = exercise.sides.right;

  const leftScore = sumSideConfidence(keypointsByName, left.requiredKeypoints);
  const rightScore = sumSideConfidence(keypointsByName, right.requiredKeypoints);

  // On a tie (including both sides invisible at 0) we default to the left side.
  const useRight = rightScore > leftScore;
  const chosen = useRight ? right : left;

  return {
    side: useRight ? 'right' : 'left',
    angleJoints: chosen.angleJoints,
    requiredKeypoints: chosen.requiredKeypoints,
    leftScore,
    rightScore,
  };
}
