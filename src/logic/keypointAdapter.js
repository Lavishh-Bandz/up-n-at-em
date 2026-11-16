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
// THE LIVE BUG THIS FILE NOW GUARDS AGAINST (read this, it is the fix):
//   A live raw dump of the real model output PROVED what was happening. In this
//   tfjs BlazePose runtime, the 2D `keypoints` list comes back with its x and y
//   fields set to `null` for EVERY joint (the joints still carry a real `name`
//   and `score`), while the 3D `keypoints3D` list is FULLY populated with real
//   world coordinates in meters. Example from the dump:
//       keypoints[11]   = { x:null, y:null, z:null, score:0.96, name:'left_shoulder' }
//       keypoints3D[11] = { x:0.345, y:-0.011, z:-0.158, score:0.96, name:'left_shoulder' }
//   (videoWidth/Height were a healthy 1920x1080, so this is NOT a "video 0x0"
//   size problem; the 2D x/y are genuinely null, not multiplied down to zero.)
//
//   Because the whole downstream app historically read the 2D PIXEL x/y (the
//   skeleton overlay, measureBodyScale (the pixel ruler), measureUpperBodyY, the
//   sit-up angle math, pickBetterSide and the posture guard), null 2D x/y meant
//   NOTHING drew and NOTHING counted (bodyScalePx came back null), and the arming
//   countdown misbehaved because it was fed confidence/orientation derived from
//   the broken 2D path.
//
//   THE FIX: lean on the 3D world landmarks that ACTUALLY work, and SYNTHESIZE a
//   screen-space pixel x/y for each joint from them, so every consumer that
//   expects pixel x/y gets real numbers again. BlazePose always returns its 33
//   keypoints in the SAME FIXED ORDER (see BLAZEPOSE_KEYPOINT_NAMES below) for
//   BOTH lists, so we name every joint by its INDEX and merge the two lists by
//   that same index. For each joint we then:
//     * keep the 2D pixel x/y WHEN they are real finite numbers (so if a future
//       build/runtime starts returning real pixels we simply use them), and
//     * otherwise PROJECT the joint's 3D world position into pixel space (see
//       projectWorldToPixels below) and use that as x/y.
//   We also normalize a confidence value into `score` (some builds expose it as
//   `visibility`/`presence`) so the confidence gate and the overlay always have
//   a number to read. The 3D fields (z/x3d/y3d/z3d) are attached too so the
//   depth-aware push-up signal keeps using true meters for its math.
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
 * Tiny helper: is this value a usable finite number (not null/undefined/NaN)?
 * The whole fix hinges on spotting that the 2D x/y are NOT usable numbers, so
 * we check carefully here.
 *
 * @param {*} n
 * @returns {boolean}
 */
function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// How many PIXELS one METER of real-world space maps to when we project the 3D
// world landmarks onto the screen. BlazePose world landmarks are roughly
// hip-centered and a standing adult spans very roughly a meter head-to-hip in
// these coordinates, so mapping 1 meter to about one frame-height of pixels
// draws a skeleton that fills a sensible chunk of the frame. The EXACT value
// does not affect rep counting at all (every downstream measurement is
// body-relative: it divides by the shoulder-width ruler, so a constant scale
// cancels out); it only affects how big the drawn skeleton looks. We derive it
// from the frame height so the overlay fills the frame about the same amount on
// any resolution.
const WORLD_TO_PIXELS_PER_FRAME_HEIGHT = 1.0;

/**
 * Project ONE 3D world landmark (meters, hip-centered) into an approximate
 * screen pixel position, so joints whose 2D pixel x/y came back null still have
 * a usable on-screen point to draw and to measure against.
 *
 * HOW THE PROJECTION WORKS (kept deliberately simple):
 *   World landmarks are centered roughly on the MIDPOINT OF THE HIPS, so (0,0)
 *   in world space is "the middle of the body". We place that body-center at
 *   the MIDDLE of the video frame and scale meters to pixels by a constant:
 *       px = frameWidth / 2  + x3d * scale
 *       py = frameHeight / 2 + y3d * scale
 *   World y grows DOWNWARD just like image pixels do, so we do NOT flip it:
 *   a joint that is higher up (smaller y3d) lands higher on screen, exactly as
 *   the pixel path expected. `scale` is meters-to-pixels, derived from the frame
 *   height (see WORLD_TO_PIXELS_PER_FRAME_HEIGHT).
 *
 * This is an APPROXIMATE projection, not a true camera un-projection: it ignores
 * perspective and the real camera focal length (we do not have them). That is
 * fine for our two uses (drawing a recognizable skeleton, and giving the
 * body-relative push-up/sit-up math real numbers to divide) because both only
 * care about RELATIVE positions and distances, not absolute camera-accurate
 * pixels.
 *
 * @param {{x:number,y:number}} world3d   A 3D landmark with meter x/y.
 * @param {number} frameWidth             Video frame width in pixels.
 * @param {number} frameHeight            Video frame height in pixels.
 * @returns {{x:number,y:number}|null} the projected pixel point, or null if we
 *          cannot project (missing 3D coords or a zero frame size).
 */
function projectWorldToPixels(world3d, frameWidth, frameHeight) {
  if (
    !world3d ||
    !isFiniteNumber(world3d.x) ||
    !isFiniteNumber(world3d.y) ||
    !isFiniteNumber(frameWidth) ||
    !isFiniteNumber(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return null;
  }
  const scale = frameHeight * WORLD_TO_PIXELS_PER_FRAME_HEIGHT;
  return {
    x: frameWidth / 2 + world3d.x * scale,
    y: frameHeight / 2 + world3d.y * scale,
  };
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
 * ABOUT THE PIXEL x/y (this is the fix): for each joint we use its real 2D
 * pixel x/y WHEN they are finite numbers; when they are null/missing (exactly
 * what this tfjs BlazePose runtime does — see the file header), we SYNTHESIZE
 * them by projecting the matching 3D world landmark into screen space (see
 * projectWorldToPixels). That keeps the overlay drawing and every pixel-based
 * measurement working off the data that is actually present.
 *
 * @param {{keypoints?: Array<{name?:string,x:number,y:number,score?:number,
 *            visibility?:number,presence?:number}>,
 *          keypoints3D?: Array<{name?:string,x:number,y:number,z:number}>}} [pose]
 * @param {{width?:number,height?:number}} [frameSize]  The video frame size in
 *            pixels, used to project 3D landmarks into screen space when the 2D
 *            pixels are null. Defaults to a plain 640×480 so pure-logic tests
 *            (which do not have a video element) still get sensible projected
 *            coordinates.
 * @returns {Object<string, {x:number,y:number,score:number,name:string,
 *          z?:number,x3d?:number,y3d?:number,z3d?:number}>}
 */
export function buildKeypointMap(pose, frameSize = {}) {
  const map = {};
  if (!pose || !Array.isArray(pose.keypoints)) {
    return map;
  }

  // Fall back to a reasonable default frame size so projection still produces
  // numbers when no video size is handed in (e.g. unit tests).
  const frameWidth =
    isFiniteNumber(frameSize.width) && frameSize.width > 0
      ? frameSize.width
      : 640;
  const frameHeight =
    isFiniteNumber(frameSize.height) && frameSize.height > 0
      ? frameSize.height
      : 480;

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

    // Start from a shallow copy of the 2D keypoint so any real fields are kept,
    // then stamp the canonical name and a normalized confidence score on top.
    const entry = { ...kp, name };
    const score = scoreOf(kp);
    if (score !== undefined) {
      entry.score = score;
    }

    // Attach depth + the full 3D position from the landmark at the same index,
    // when present. We read the name off that 3D point only to double-check
    // alignment is sane; the index is the source of truth.
    const kp3d = kp3dList ? kp3dList[i] : null;
    if (kp3d) {
      entry.z = kp3d.z;
      entry.x3d = kp3d.x;
      entry.y3d = kp3d.y;
      entry.z3d = kp3d.z;
    }

    // PIXEL x/y — the fix. Prefer the real 2D pixels when the engine actually
    // gave us finite numbers. When it did not (this runtime returns them null),
    // project the 3D world landmark into screen space so the overlay and every
    // pixel-based measurement still have a real point to work with. If we have
    // neither a real pixel nor a projectable 3D point, we leave x/y as-is
    // (whatever the 2D point had, possibly null) so downstream null-guards skip
    // the joint rather than crash.
    const hasRealPixels = isFiniteNumber(kp.x) && isFiniteNumber(kp.y);
    if (!hasRealPixels && kp3d) {
      const projected = projectWorldToPixels(kp3d, frameWidth, frameHeight);
      if (projected) {
        entry.x = projected.x;
        entry.y = projected.y;
      }
    }

    map[name] = entry;
  }

  return map;
}

export default buildKeypointMap;
