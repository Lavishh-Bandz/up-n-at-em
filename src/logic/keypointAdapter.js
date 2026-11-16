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
// UNITS — read this carefully, it matters for every bit of math downstream:
//   * 2D keypoints (pose.keypoints): x and y are in PIXELS of the video frame.
//     y grows DOWNWARD (top of the image is y=0, the floor is a bigger y).
//     Each one carries a `score` (0..1 confidence) and a `name`.
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
//         shows up as z DECREASING. (We only pass z through here; FEAT-003 is
//         where the push-up signal actually interprets this sign.)
//
// We keep this a pure function (no React, no DOM, no TFJS) so FEAT-004 can unit
// test it by handing it a plain fake pose object.

/**
 * Merge one BlazePose pose into a keypoints-by-name map.
 *
 * Each entry keeps the 2D keypoint's own fields (x, y, score, name — x/y in
 * PIXELS) and, when a matching 3D landmark exists for that joint name, also
 * gets:
 *   - z:   depth in METERS (see the units note above; smaller/more negative is
 *          closer to the camera). Left `undefined` when 3D is missing so
 *          downstream code can fall back to pure 2D math.
 *   - x3d, y3d, z3d: the full 3D position in METERS, in case a caller wants the
 *          other axes too (z3d is the same value as z, provided for symmetry).
 *
 * If `keypoints3D` is absent for a frame (some frames can lack it), the map
 * still carries every 2D joint and simply leaves z/x3d/y3d/z3d undefined.
 *
 * @param {{keypoints?: Array<{name?:string,x:number,y:number,score?:number}>,
 *          keypoints3D?: Array<{name?:string,x:number,y:number,z:number,score?:number}>}} [pose]
 * @returns {Object<string, {x:number,y:number,score:number,name:string,
 *          z?:number,x3d?:number,y3d?:number,z3d?:number}>}
 */
export function buildKeypointMap(pose) {
  const map = {};
  if (!pose || !Array.isArray(pose.keypoints)) {
    return map;
  }

  // First, index the 3D landmarks by name so we can look each one up quickly.
  // (keypoints3D may be undefined on a given frame — that's fine.)
  const byName3D = {};
  if (Array.isArray(pose.keypoints3D)) {
    for (const kp3d of pose.keypoints3D) {
      if (kp3d && kp3d.name) {
        byName3D[kp3d.name] = kp3d;
      }
    }
  }

  // Now walk the 2D keypoints (the ones with pixel x/y we draw and measure in)
  // and attach the matching depth from the 3D list when we have it.
  for (const kp of pose.keypoints) {
    if (!kp || !kp.name) continue;

    // Start from a shallow copy of the 2D keypoint so x/y/score/name are kept
    // exactly as the engine produced them (pixels, y-down).
    const entry = { ...kp };

    const kp3d = byName3D[kp.name];
    if (kp3d) {
      // Depth in meters. `z` is the headline value the push-up signal will use;
      // x3d/y3d/z3d expose the full 3D point for anything that wants it later.
      entry.z = kp3d.z;
      entry.x3d = kp3d.x;
      entry.y3d = kp3d.y;
      entry.z3d = kp3d.z;
    }

    map[kp.name] = entry;
  }

  return map;
}

export default buildKeypointMap;
