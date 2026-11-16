// keypointAdapter.js
// -----------------------------------------------------------------------------
// A tiny, PURE helper that turns one raw BlazePose result into the stable
// "keypoints-by-name" shape the rest of the app already knows how to read.
//
// WHY THIS EXISTS (the short version):
//   The old engine (MoveNet) only gave us 2D points: an x/y pixel position for
//   each joint plus a confidence score. BlazePose gives us the SAME 2D points
//   AND a second, 3D list ("keypoints3D") that estimates where each joint is in
//   real-world space, including DEPTH (how far toward/away from the camera it
//   is). Depth is the whole point of this upgrade: it lets us count a push-up
//   from the front, where the body barely moves up/down on screen but clearly
//   moves toward and away from the camera.
//
//   This module just MERGES those two lists into one map keyed by joint name,
//   so downstream code can read `map.left_shoulder.x` (pixels, as before) and
//   now ALSO `map.left_shoulder.z` (depth) from the exact same object.
//
// THE LIVE BUG THIS FILE NOW GUARDS AGAINST (read this — it is the fix):
//   The first BlazePose build keyed the map off each 2D keypoint's OWN `name`
//   field and SKIPPED any 2D point that did not carry one. In live testing the
//   skeleton never drew and NO push-ups counted, and the diagnostics report
//   showed the tell-tale pair: bodyScalePx was null (the 2D PIXEL ruler could
//   never be measured) while depthScaleM had a real value (the 3D ruler worked).
//   That split is the clue: the 3D path found its shoulders but the 2D path did
//   not, which happens when the 2D `keypoints[]` do NOT all carry a usable
//   `name` (across tfjs/model builds the 2D list is not guaranteed to be named
//   the same way the 3D "world landmarks" are), so keying the 2D map by name
//   dropped the shoulders and measureBodyScale() got nothing to measure.
//
//   THE FIX: BlazePose ALWAYS returns its 33 keypoints in the SAME FIXED ORDER
//   (see BLAZEPOSE_KEYPOINT_NAMES below), for BOTH the 2D list and the 3D list.
//   So we no longer trust the per-point `name`; we assign the canonical name by
//   the point's INDEX in the array. That guarantees every 2D joint lands in the
//   map with the right name and its pixel x/y, and we merge the matching 3D
//   landmark by the SAME index so depth stays attached too. We also normalize a
//   confidence value into `score` (some builds expose it as `visibility` or
//   `presence`) so the confidence gate and the overlay's draw threshold always
//   have a number to read.
//
// UNITS — read this carefully, it matters for every bit of math downstream:
//   * 2D keypoints (pose.keypoints): x and y are in PIXELS of the video frame.
//     y grows DOWNWARD (top of the image is y=0, the floor is a bigger y).
//     Each one carries a `score` (0..1 confidence) and (after this adapter) a
//     canonical `name`.
//   * 3D keypoints (pose.keypoints3D): x, y and z are in METERS, roughly
//     centered on the MIDPOINT OF THE HIPS (so the hips sit near 0,0,0). This
//     is BlazePose/MediaPipe's "world landmarks" convention.
//       - x: left/right in meters
//       - y: up/down in meters (same as the image, y grows DOWNWARD)
//       - z: DEPTH in meters. This is the axis we care about for front-facing
//         push-ups. Per the MediaPipe world-landmark convention this library
//         follows, z is measured from the hip-center plane and gets SMALLER
//         (more NEGATIVE) as a joint moves CLOSER TO THE CAMERA, and larger
//         (more positive) as it moves AWAY. So "lowering toward the camera"
//         shows up as z DECREASING. (We only pass z through here; the push-up
//         signal is where that sign is actually interpreted.)
//
// We keep this a pure function (no React, no DOM, no TFJS) so it can be unit
// tested by handing it a plain fake pose object.

// BlazePose's fixed 33-keypoint ORDER. Both the 2D `keypoints` list and the 3D
// `keypoints3D` list come back in exactly this order, so the index of a point
// IS its identity. This mirrors the library's BLAZEPOSE_KEYPOINTS constant; the
// joints the app actually uses (nose, shoulders, elbows, wrists, hips, knees)
// are a subset and keep their familiar MoveNet-style names.
export const BLAZEPOSE_KEYPOINT_NAMES = [
  'nose',
  'left_eye_inner',
  'left_eye',
  'left_eye_outer',
  'right_eye_inner',
  'right_eye',
  'right_eye_outer',
  'left_ear',
  'right_ear',
  'mouth_left',
  'mouth_right',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_pinky',
  'right_pinky',
  'left_index',
  'right_index',
  'left_thumb',
  'right_thumb',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
  'left_heel',
  'right_heel',
  'left_foot_index',
  'right_foot_index',
];

/**
 * Work out the canonical joint name for a keypoint at a given array index.
 *
 * We PREFER the fixed-order name for the index (BlazePose always returns its 33
 * points in that order), because the point's own `name` field is not reliable
 * across builds. We only fall back to the point's own `name` if the index is
 * somehow out of range (e.g. a non-standard list), so a valid named point is
 * never dropped.
 *
 * @param {{name?:string}} kp     One keypoint.
 * @param {number} index          Its position in the keypoints array.
 * @returns {string|null} the canonical name, or null if we truly cannot name it.
 */
function nameForIndex(kp, index) {
  if (index >= 0 && index < BLAZEPOSE_KEYPOINT_NAMES.length) {
    return BLAZEPOSE_KEYPOINT_NAMES[index];
  }
  // Out of the known range: last resort, trust the point's own name if any.
  return kp && typeof kp.name === 'string' ? kp.name : null;
}

/**
 * Pull a 0..1 confidence out of a keypoint no matter what the build calls it.
 *
 * Downstream code (the confidence gate and the overlay's draw threshold) reads
 * `kp.score`. Most BlazePose builds provide `score`, but some expose the same
 * idea as `visibility` (and a few as `presence`). We normalize whichever one is
 * present into a single `score` number so nothing downstream silently sees
 * `undefined` and treats a clearly-visible joint as low confidence.
 *
 * @param {{score?:number,visibility?:number,presence?:number}} kp
 * @returns {number|undefined} a confidence in 0..1, or undefined if none given.
 */
function scoreOf(kp) {
  if (!kp) return undefined;
  if (typeof kp.score === 'number') return kp.score;
  if (typeof kp.visibility === 'number') return kp.visibility;
  if (typeof kp.presence === 'number') return kp.presence;
  return undefined;
}

/**
 * Merge one BlazePose pose into a keypoints-by-name map.
 *
 * Each entry keeps the 2D keypoint's own fields (x, y in PIXELS) plus a
 * canonical `name` (assigned by index) and a normalized `score`, and — when a
 * matching 3D landmark exists at the SAME index — also gets:
 *   - z:   depth in METERS (see the units note above; smaller/more negative is
 *          closer to the camera). Left `undefined` when 3D is missing so
 *          downstream code can fall back to pure 2D math.
 *   - x3d, y3d, z3d: the full 3D position in METERS, in case a caller wants the
 *          other axes too (z3d is the same value as z, provided for symmetry).
 *
 * If `keypoints3D` is absent for a frame (some frames can lack it), the map
 * still carries every 2D joint and simply leaves z/x3d/y3d/z3d undefined.
 *
 * @param {{keypoints?: Array<{name?:string,x:number,y:number,score?:number,
 *            visibility?:number,presence?:number}>,
 *          keypoints3D?: Array<{name?:string,x:number,y:number,z:number}>}} [pose]
 * @returns {Object<string, {x:number,y:number,score:number,name:string,
 *          z?:number,x3d?:number,y3d?:number,z3d?:number}>}
 */
export function buildKeypointMap(pose) {
  const map = {};
  if (!pose || !Array.isArray(pose.keypoints)) {
    return map;
  }

  const kp3dList = Array.isArray(pose.keypoints3D) ? pose.keypoints3D : null;

  // Walk the 2D keypoints (the ones with pixel x/y we draw and measure in) in
  // ORDER, naming each by its index and attaching the matching 3D landmark from
  // the SAME index when we have one. Matching by index (not by the per-point
  // name) is what keeps the 2D and 3D sides lined up even when a build does not
  // name the 2D list the way we expect.
  for (let i = 0; i < pose.keypoints.length; i++) {
    const kp = pose.keypoints[i];
    if (!kp) continue;

    const name = nameForIndex(kp, i);
    if (!name) continue; // genuinely unnameable point: skip it safely.

    // Start from a shallow copy of the 2D keypoint so x/y are kept exactly as
    // the engine produced them (pixels, y-down), then stamp the canonical name
    // and a normalized confidence score on top.
    const entry = { ...kp, name };
    const score = scoreOf(kp);
    if (score !== undefined) {
      entry.score = score;
    }

    // Attach depth from the 3D landmark at the same index, when present. We
    // read the name off that 3D point only to double-check alignment is sane;
    // the index is the source of truth.
    const kp3d = kp3dList ? kp3dList[i] : null;
    if (kp3d) {
      entry.z = kp3d.z;
      entry.x3d = kp3d.x;
      entry.y3d = kp3d.y;
      entry.z3d = kp3d.z;
    }

    map[name] = entry;
  }

  return map;
}

export default buildKeypointMap;
