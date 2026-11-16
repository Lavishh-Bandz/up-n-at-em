// exercises.js
// -----------------------------------------------------------------------------
// Descriptions of the exercises UP N AT EM can count, plus difficulty presets.
//
// This is pure data + small pure helpers. No React, no DOM. It tells the rest
// of the app:
//   - which joints we track for each exercise (an angle for sit-ups, an
//     upper-body vertical POSITION for push-ups)
//   - which joints MUST be visible for a pose to count (anti-cheat)
//   - what the "down" and "up" thresholds are at each difficulty
//   - a sensible default number of reps per difficulty
//
// TWO DIFFERENT DETECTION STYLES (read this first):
//   SIT-UPS are counted from a JOINT ANGLE (shoulder->hip->knee) using the
//   angle-based createRepCounter. Nothing about sit-ups changed in this pass.
//
//   PUSH-UPS are now ALSO counted from a JOINT ANGLE — the ELBOW angle
//   (shoulder -> elbow -> wrist) — using the SAME angle-based createRepCounter.
//   This is how essentially every working push-up counter does it: watch the
//   elbow bend down and straighten back up, with an up/down state machine.
//   The KEY difference from a naive elbow-angle counter is that we measure the
//   angle in the 3D world-landmark space (x3d/y3d/z3d, in meters) that this
//   BlazePose runtime actually populates, NOT the 2D pixels (which come back
//   null live). A 3D angle is both SCALE-invariant (it does not matter how big
//   you look in frame) and far less VIEWPOINT-dependent (side-on, angled, and —
//   best effort — front-on all read a bent elbow as bent), so it sidesteps the
//   whole null-2D-pixel / body-scale-ruler problem the old position method hit.
//
// WHY WE DROPPED THE OLD POSITION METHOD:
//   The previous push-up path watched the upper body's vertical PIXEL position
//   dip as a fraction of a pixel body-scale ruler. In this runtime the 2D
//   pixels are null and only rebuilt from 3D, so that ruler and the y-dip went
//   unreliable and real users counted zero. An elbow angle computed straight
//   from the 3D landmarks never touches a pixel, so it just works.
//
// BODY ORIENTATION (anti-cheat, part 2):
//   Counting a rep from an elbow angle alone is not enough. Standing up and
//   just bending your elbows makes the elbow angle go down then up exactly like
//   a real push-up, so it would count a fake rep. To stop that, each exercise
//   also says what body POSTURE it expects:
//     'horizontal'   = your torso should be roughly level with the floor (you
//                      are actually down in a push-up / plank, not standing).
//                      Used by SIT-UPS via the 2D isBodyHorizontal check.
//     'pushup3d'     = a coarse 3D push-up-posture gate (see isPushupPosture3D
//                      below): the torso must be plausibly horizontal in the
//                      real-world landmarks. Used by PUSH-UPS.
//     'any'          = we do not gate on orientation for this exercise.
//   The 3D gate is what stops a standing body from ever arming the 5-second
//   countdown or counting a rep (root-cause #4: before, push-ups used 'any', so
//   merely seeing one shoulder armed the countdown). It is deliberately a COARSE
//   gate and FAILS OPEN only when it genuinely cannot tell (missing 3D), so a
//   dropped keypoint never silently blocks a real rep — the confidence gate
//   handles "we cannot see you".
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

import { isBodyHorizontal } from './angles.js';

/**
 * PUSH-UP (angle-based, 3D; see header)
 *   Tracked angle: the ELBOW angle (shoulder -> elbow -> wrist), measured in
 *   the 3D world landmarks (meters) via angleBetween3D.
 *     top of a push-up    = arms extended = LARGE angle (~150-160+)
 *     bottom of a push-up = elbow bent    = SMALL angle (~90-110)
 *   All three joints on the chosen side (shoulder, elbow, wrist) must be
 *   confidently visible for the rep to count — that is what the angle needs.
 *
 * SIT-UP (angle-based; unchanged this pass)
 *   Tracked angle: the HIP / torso angle (shoulder -> hip -> knee).
 *     lying down flat = torso open   = large angle (~150+)
 *     sitting up      = torso folded = small angle (~80)
 *
 * For BOTH exercises now, each SIDE's `angleJoints` is [outerA, vertex, outerC]
 * in the order the angle helper expects (the middle joint is the vertex we
 * measure). `requiredKeypoints` always lists every joint that must be
 * confidently visible on that side for the rep to count. The two sides live
 * under `sides.left` and `sides.right`.
 */
export const EXERCISES = {
  pushup: {
    id: 'pushup',
    label: 'Push-ups',
    // '3d' push-up posture gate (see isPushupPosture3D + evaluateOrientation
    // below). The torso must be plausibly HORIZONTAL in the real-world 3D
    // landmarks for the body to be "in position". This is the fix for the
    // countdown advancing when the user was NOT in position: before, push-ups
    // used 'any' (always true), so merely seeing one shoulder armed the 5s
    // countdown. The 3D gate needs no pixels, so it survives the null-2D runtime.
    orientation: 'pushup3d',
    // How far (in degrees) the 3D torso line (shoulders -> hips) may tilt away
    // from flat/horizontal and still count as a push-up / plank posture. A real
    // push-up torso is roughly level with the floor (small tilt); a standing
    // body is near-vertical (large tilt). Generous on purpose so a low or
    // slightly-angled webcam still passes a genuine plank. Starting value meant
    // to be nudged live via the debug readout.
    postureMaxTiltDegrees: 50,
    sides: {
      // Push-ups now need the chosen side's SHOULDER, ELBOW and WRIST — the
      // three joints the elbow angle is measured from. pickBetterSide therefore
      // picks whichever side shows those three most confidently (its
      // sumSideConfidence reads kp.score, which the adapter populates for the
      // 3D-derived keypoints). `angleJoints` lists them in [shoulder, elbow,
      // wrist] order so the elbow is the vertex angleBetween3D measures.
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
      // Push-up presets are now ELBOW ANGLES (degrees) consumed by
      // createRepCounter, exactly like sit-ups:
      //   downAngle = bend the elbow PAST this (angle <= downAngle) to reach the
      //               bottom of the push-up. The SMALLER number of the pair.
      //   upAngle   = straighten the elbow PAST this (angle >= upAngle) to
      //               complete the rep. The LARGER number of the pair.
      // createRepCounter requires downAngle < upAngle, and the gap between them
      // is the hysteresis band that swallows resting jitter.
      //
      // These are FIELD-STANDARD STARTING VALUES (a bent elbow is ~90-110 deg
      // at the bottom, an extended arm is ~150-160 deg at the top). They are
      // meant to be felt out live in a real browser and nudged to taste via the
      // debug readout. HARDER = a DEEPER bend (a SMALLER downAngle) + a
      // STRAIGHTER lockout (a BIGGER upAngle) + more reps; EASIER = a shallower
      // bend and fewer reps.
      easy: { downAngle: 110, upAngle: 150, defaultReps: 10 },
      standard: { downAngle: 100, upAngle: 155, defaultReps: 20 },
      // Harder = deeper bend (smaller downAngle) + straighter lockout + more reps.
      hard: { downAngle: 90, upAngle: 160, defaultReps: 45 },
    },
  },

  situp: {
    id: 'situp',
    label: 'Sit-ups',
    // A sit-up also starts from lying down, so we apply a light horizontal
    // sanity check. BUT at the top of a sit-up your torso tilts well up off the
    // floor, so we use a much more forgiving tilt threshold here (75 degrees)
    // than push-ups do. The goal is only to reject an obviously fully-standing
    // body, not to reject a normal sit-up. The user did not report sit-up
    // miscounts, so this is a gentle safety net, not a tight gate.
    orientation: 'horizontal',
    orientationMaxTiltDegrees: 75,
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
 * Get the difficulty preset for an exercise. BOTH exercises are now counted
 * from a joint ANGLE, so both return the same shape:
 *   { downAngle, upAngle, defaultReps } (fed to createRepCounter)
 * where downAngle < upAngle. defaultReps is just the suggested rep count. This
 * helper only looks the object up and hands it back.
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
 * For PUSH-UPS the required joints are now the shoulder/elbow/wrist that the
 * elbow angle is measured from, so the side pick directly reflects which arm's
 * elbow the camera can see most confidently. For SIT-UPS they are the
 * shoulder/hip/knee of the torso angle. Either way this is just a confidence
 * sum over whatever requiredKeypoints the descriptor lists — nothing special
 * per exercise.
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

// MoveNet shoulder/hip keypoint names per side, used for the orientation check.
const ORIENTATION_JOINTS = {
  left: { shoulder: 'left_shoulder', hip: 'left_hip' },
  right: { shoulder: 'right_shoulder', hip: 'right_hip' },
};

// How far (degrees) the 3D torso line may tilt from flat and still read as a
// push-up / plank posture, when a descriptor does not state its own value.
const DEFAULT_PUSHUP_MAX_TILT_DEGREES = 50;

/**
 * Coarse 3D PUSH-UP posture gate: is the body plausibly DOWN in a push-up /
 * plank right now, judged from the real-world 3D landmarks (meters)?
 *
 * WHY 3D AND NOT THE OLD 2D CHECK (root-cause #4):
 *   The push-up arming gate used to effectively be "is one shoulder visible?"
 *   (orientation 'any'), so the 5-second get-into-position countdown advanced
 *   even when the user was standing up. We need a real posture test, but we
 *   cannot use the 2D pixels (they come back null in this runtime). The 3D
 *   world landmarks ARE populated, so we measure posture there instead.
 *
 * HOW IT WORKS (plain language):
 *   During a real push-up your whole torso is stretched out roughly LEVEL with
 *   the floor, so the line from your shoulders down to your hips is nearly
 *   HORIZONTAL in the real world. When you are standing, that same line is
 *   nearly VERTICAL. We build a torso line from the 3D shoulder-center to the
 *   3D hip-center and measure how far it tilts away from flat:
 *     ~0 degrees  = lying flat / plank (horizontal)  -> in position
 *     ~90 degrees = standing upright (vertical)        -> NOT in position
 *   World y grows DOWNWARD and z is depth; we combine the vertical drop (y) and
 *   the depth run (z) into the "along the floor" distance so the test works
 *   whether the camera is to the side or in front. If the tilt is within
 *   `maxTiltDegrees` of flat we call it a push-up posture.
 *
 * HONEST LIMITS (read this):
 *   - This is a COARSE gate, not a precise plank detector. Its one job is to
 *     clearly separate "standing tall" from "down on the floor".
 *   - It FAILS OPEN (returns true) only when it genuinely cannot tell — i.e.
 *     the 3D shoulder/hip landmarks needed for the torso line are missing — so
 *     a dropped keypoint never silently blocks a real rep. The confidence gate
 *     handles "we cannot see you". When the 3D IS present, a clearly upright
 *     body is rejected.
 *   - FRONT-FACING is best-effort: the elbow angle is the real backbone of
 *     counting; this gate just keeps a standing body from arming / counting.
 *
 * Pure function: hand it the keypoint map and the chosen side; get true/false.
 *
 * @param {Object<string,{x3d?:number,y3d?:number,z3d?:number}>} keypointsByName
 * @param {('left'|'right')} side  The side pickBetterSide chose (preferred).
 * @param {object} [options]
 * @param {number} [options.maxTiltDegrees=DEFAULT_PUSHUP_MAX_TILT_DEGREES]
 * @returns {boolean} true if the body plausibly looks like a push-up posture.
 */
export function isPushupPosture3D(
  keypointsByName,
  side,
  { maxTiltDegrees = DEFAULT_PUSHUP_MAX_TILT_DEGREES } = {}
) {
  if (!keypointsByName) {
    return true; // nothing to judge -> fail open
  }

  // Tiny helper: does this point carry finite 3D meter coordinates?
  const has3D = (p) =>
    p &&
    Number.isFinite(p.x3d) &&
    Number.isFinite(p.y3d) &&
    Number.isFinite(p.z3d);

  // Build a shoulder point and a hip point. Prefer BOTH sides' midpoint for a
  // steadier torso line, but fall back to the chosen side alone (then the other
  // side) so the gate still works when only one side has 3D.
  const ls = keypointsByName.left_shoulder;
  const rs = keypointsByName.right_shoulder;
  const lh = keypointsByName.left_hip;
  const rh = keypointsByName.right_hip;

  const mid = (p1, p2) => ({
    x3d: (p1.x3d + p2.x3d) / 2,
    y3d: (p1.y3d + p2.y3d) / 2,
    z3d: (p1.z3d + p2.z3d) / 2,
  });

  // Choose a shoulder reference.
  let shoulder = null;
  if (has3D(ls) && has3D(rs)) shoulder = mid(ls, rs);
  else if (side === 'right' && has3D(rs)) shoulder = rs;
  else if (side === 'left' && has3D(ls)) shoulder = ls;
  else if (has3D(ls)) shoulder = ls;
  else if (has3D(rs)) shoulder = rs;

  // Choose a hip reference the same way.
  let hip = null;
  if (has3D(lh) && has3D(rh)) hip = mid(lh, rh);
  else if (side === 'right' && has3D(rh)) hip = rh;
  else if (side === 'left' && has3D(lh)) hip = lh;
  else if (has3D(lh)) hip = lh;
  else if (has3D(rh)) hip = rh;

  // Without a 3D shoulder AND hip we cannot measure the torso line: fail open.
  if (!shoulder || !hip) {
    return true;
  }

  // Torso line in 3D. y is the real-world VERTICAL drop; x and z together are
  // the "along the floor" run. A flat plank has a big horizontal run and almost
  // no vertical drop; a standing body is the reverse.
  const dyVertical = Math.abs(hip.y3d - shoulder.y3d);
  const dxFloor = hip.x3d - shoulder.x3d;
  const dzFloor = hip.z3d - shoulder.z3d;
  const horizontalRun = Math.sqrt(dxFloor * dxFloor + dzFloor * dzFloor);

  // A zero-length torso line tells us nothing -> fail open.
  if (dyVertical === 0 && horizontalRun === 0) {
    return true;
  }

  // Tilt away from flat: 0 deg = perfectly level, 90 deg = straight up/down.
  const tiltDegrees =
    Math.atan2(dyVertical, horizontalRun) * (180 / Math.PI);

  return tiltDegrees <= maxTiltDegrees;
}

/**
 * Decide whether the body is in the orientation this exercise expects, using
 * the chosen (more visible) side.
 *
 * Sit-ups use a lenient 2D 'horizontal' sanity check here (reject an obviously
 * fully-standing body from the shoulder->hip pixel tilt). Push-ups now use the
 * 3D 'pushup3d' gate (isPushupPosture3D), which judges the torso tilt from the
 * real-world landmarks instead of the null 2D pixels — this is what stops the
 * 5s countdown advancing when the user is standing.
 *
 * It is lenient on purpose:
 *   - If the exercise does not care about orientation ('any' / unknown), we
 *     return true — nothing to gate on.
 *   - If the points a check needs are missing, the check fails open (returns
 *     true) so a missing keypoint never blocks counting on its own. The
 *     separate confidence (anti-cheat) gate handles "we cannot see you".
 *
 * Pure function: give it the exercise id, a keypoints-by-name map, and the side
 * to use, and it returns true/false.
 *
 * @param {('pushup'|'situp')} exerciseId
 * @param {Object<string,object>} keypointsByName
 * @param {('left'|'right')} side  The side pickBetterSide chose.
 * @returns {boolean} true if the body meets the exercise's orientation expectation.
 */
export function evaluateOrientation(exerciseId, keypointsByName, side) {
  const exercise = getExercise(exerciseId);

  // No orientation requirement (or an unknown one) -> nothing to gate on.
  if (!exercise.orientation || exercise.orientation === 'any') {
    return true;
  }

  // PUSH-UP: the 3D posture gate (torso roughly horizontal in world space).
  if (exercise.orientation === 'pushup3d') {
    const options = {};
    if (typeof exercise.postureMaxTiltDegrees === 'number') {
      options.maxTiltDegrees = exercise.postureMaxTiltDegrees;
    }
    return isPushupPosture3D(keypointsByName, side, options);
  }

  // SIT-UP: the 2D shoulder->hip horizontal sanity check.
  const names = ORIENTATION_JOINTS[side] || ORIENTATION_JOINTS.left;
  const shoulder = keypointsByName ? keypointsByName[names.shoulder] : null;
  const hip = keypointsByName ? keypointsByName[names.hip] : null;

  // If either point is missing, do not block on orientation alone.
  if (!shoulder || !hip) {
    return true;
  }

  if (exercise.orientation === 'horizontal') {
    const options = {};
    if (typeof exercise.orientationMaxTiltDegrees === 'number') {
      options.maxTiltDegrees = exercise.orientationMaxTiltDegrees;
    }
    return isBodyHorizontal(shoulder, hip, options);
  }

  // Unknown orientation value: fail open (do not block counting).
  return true;
}
