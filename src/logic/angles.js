// angles.js
// -----------------------------------------------------------------------------
// Pure geometry helpers. No React, no DOM, no webcam. Everything here takes
// plain numbers/objects in and returns plain numbers/booleans out, which makes
// it easy to unit test and reuse anywhere.
//
// A "keypoint" is just a point the pose detector gives us for a body joint.
// It looks like: { x: number, y: number, score: number }
//   - x, y   : the pixel position of the joint in the camera image
//   - score  : how confident the detector is (0 = no idea, 1 = very sure)

/**
 * Compute the angle (in DEGREES) at a vertex joint, formed by three points.
 *
 * Think of your arm during a push-up:
 *   a      = shoulder
 *   vertex = elbow   <-- this is the corner we measure
 *   c      = wrist
 *
 * The angle tells us how bent the elbow is:
 *   ~180 degrees = arm straight (top of a push-up)
 *   ~90  degrees = elbow bent to a right angle (bottom of a push-up)
 *
 * HOW THE MATH WORKS (in plain language):
 *   1. Make two "arrows" (vectors) that both start at the vertex:
 *        v1 points from the vertex toward a
 *        v2 points from the vertex toward c
 *   2. atan2(y, x) gives the direction (angle) of an arrow.
 *      We take the direction of each arrow and subtract them to get the
 *      angle BETWEEN the two arrows.
 *   3. That raw result can land outside 0..180 (it can be negative or go the
 *      "long way around"), so we normalize it into the 0..180 range, because a
 *      joint angle only makes sense as a value between 0 and 180 degrees.
 *
 * @param {{x:number,y:number}} a      First outer point (e.g. shoulder)
 * @param {{x:number,y:number}} vertex The corner joint we measure (e.g. elbow)
 * @param {{x:number,y:number}} c      Second outer point (e.g. wrist)
 * @returns {number} angle at the vertex in degrees, from 0 to 180
 */
export function angleBetween(a, vertex, c) {
  // Direction of the arrow from the vertex to each outer point.
  const angleToA = Math.atan2(a.y - vertex.y, a.x - vertex.x);
  const angleToC = Math.atan2(c.y - vertex.y, c.x - vertex.x);

  // Difference between the two directions, converted radians -> degrees.
  let degrees = (angleToA - angleToC) * (180 / Math.PI);

  // Fold the value into 0..180. A negative angle is the same opening measured
  // the other way, and anything over 180 is the "reflex" (outside) angle, so
  // we flip it back to the inside angle a human would actually read off.
  degrees = Math.abs(degrees);
  if (degrees > 180) {
    degrees = 360 - degrees;
  }
  return degrees;
}

/**
 * Compute the angle (in DEGREES) at a vertex joint, using REAL-WORLD 3D points.
 *
 * This is the 3D sibling of angleBetween above. It is the EXACT same "angle at
 * a corner" idea — shoulder/elbow/wrist during a push-up — but instead of the
 * camera's flat pixel x/y it uses the 3D world position of each joint in
 * METERS, which the keypoint adapter attaches as x3d/y3d/z3d (hip-centered,
 * roughly -1..1 on each axis).
 *
 * WHY MEASURE IN 3D METERS INSTEAD OF PIXELS:
 *   The 2D pixel angle depends on how the camera is pointed: an elbow seen from
 *   straight on reads differently than the same elbow seen at an angle, and in
 *   this runtime the 2D pixels are not even real (they are rebuilt from 3D). A
 *   3D angle measured in meters is SCALE-invariant (it does not matter how big
 *   you look in frame) and VIEWPOINT-invariant (it does not matter which way
 *   the camera faces), so a bent elbow reads the same whether you are side-on,
 *   angled, or roughly facing the camera. That is why the push-up and sit-up
 *   rebuilds lean on this instead of the pixel angle.
 *
 * HOW THE MATH WORKS (plain language):
 *   1. Make two "arrows" (vectors) that both start at the vertex, in 3D:
 *        v1 points from the vertex toward a   (component-wise on x3d/y3d/z3d)
 *        v2 points from the vertex toward c
 *   2. The dot product of the two arrows, divided by their lengths, gives the
 *      cosine of the angle between them. acos() turns that cosine back into the
 *      angle, which we convert from radians to degrees.
 *   3. We CLAMP the cosine into [-1, 1] before acos, because tiny
 *      floating-point drift can nudge it a hair past +/-1 and acos of anything
 *      outside [-1, 1] is NaN. Clamping keeps the result a real number.
 *
 * DEGENERATE / MISSING INPUT:
 *   If any of the three points is missing, any x3d/y3d/z3d is not a finite
 *   number, or either arrow has zero length (two points sit on top of each
 *   other, so there is no direction to measure), we return the sentinel `null`
 *   rather than NaN. Callers can treat null as "no usable angle this frame" and
 *   skip it, exactly like the confidence gate skips a low-score joint. We never
 *   return NaN.
 *
 * @param {{x3d:number,y3d:number,z3d:number}} a      First outer point (shoulder)
 * @param {{x3d:number,y3d:number,z3d:number}} vertex The corner joint (elbow)
 * @param {{x3d:number,y3d:number,z3d:number}} c      Second outer point (wrist)
 * @returns {number|null} angle at the vertex in degrees (0..180), or null for
 *          degenerate/missing input (never NaN).
 */
export function angleBetween3D(a, vertex, c) {
  // Every point must exist and carry finite 3D meter coordinates. If any is
  // missing or not a real number, we cannot measure an angle: bail with null.
  const points = [a, vertex, c];
  for (const p of points) {
    if (
      !p ||
      !Number.isFinite(p.x3d) ||
      !Number.isFinite(p.y3d) ||
      !Number.isFinite(p.z3d)
    ) {
      return null;
    }
  }

  // Two 3D arrows starting at the vertex, one toward each outer point.
  const v1 = {
    x: a.x3d - vertex.x3d,
    y: a.y3d - vertex.y3d,
    z: a.z3d - vertex.z3d,
  };
  const v2 = {
    x: c.x3d - vertex.x3d,
    y: c.y3d - vertex.y3d,
    z: c.z3d - vertex.z3d,
  };

  // Length of each arrow. A zero-length arrow means two points are identical,
  // so there is no direction to compare: bail with null to avoid dividing by 0.
  const len1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y + v1.z * v1.z);
  const len2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y + v2.z * v2.z);
  if (len1 === 0 || len2 === 0) {
    return null;
  }

  // dot(v1, v2) / (|v1| |v2|) is the cosine of the angle between the arrows.
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  let cosine = dot / (len1 * len2);

  // Clamp into [-1, 1] so floating-point drift can never push acos into NaN.
  if (cosine > 1) cosine = 1;
  if (cosine < -1) cosine = -1;

  // acos gives radians in 0..PI; convert to the 0..180 degrees a human reads.
  return Math.acos(cosine) * (180 / Math.PI);
}

/**
 * Is this keypoint confident enough to trust?
 *
 * The pose detector sometimes "guesses" a joint it cannot really see (an arm
 * off-screen, bad lighting, etc.). Those guesses come with a low score. We use
 * this helper as an anti-cheat gate: if a joint we need is not clearly visible,
 * we refuse to count the movement.
 *
 * @param {{score?:number}} keypoint   A keypoint (may be missing or scoreless)
 * @param {number} minConfidence       Minimum score to accept (default 0.3)
 * @returns {boolean} true if the keypoint exists and meets the threshold
 */
export function isConfident(keypoint, minConfidence = 0.3) {
  if (!keypoint || typeof keypoint.score !== 'number') {
    return false;
  }
  return keypoint.score >= minConfidence;
}

/**
 * Convenience: are ALL of the given keypoints confident?
 *
 * We need every joint in a measurement (e.g. shoulder, elbow, wrist for a
 * push-up) to be trustworthy before we count a rep.
 *
 * @param {Array<{score?:number}>} keypoints   The keypoints to check
 * @param {number} minConfidence               Minimum score for each
 * @returns {boolean} true only if every keypoint clears the threshold
 */
export function allConfident(keypoints, minConfidence = 0.3) {
  if (!Array.isArray(keypoints) || keypoints.length === 0) {
    return false;
  }
  return keypoints.every((kp) => isConfident(kp, minConfidence));
}

/**
 * Is the body roughly HORIZONTAL right now (lying/plank position) rather than
 * standing upright?
 *
 * WHY WE NEED THIS (the "standing push-up" bug):
 *   A push-up rep was being counted purely from the elbow bending down and
 *   straightening back up. But standing up and just bending your arms makes the
 *   elbow do the exact same thing, so it counted fake reps. The missing piece
 *   is body ORIENTATION: during a real push-up your whole body is stretched out
 *   roughly LEVEL with the floor, so in the camera image your shoulders and
 *   hips sit at nearly the same height. When you are standing, your shoulders
 *   are high up and your hips are far below them.
 *
 * HOW WE MEASURE IT (in plain language):
 *   1. Draw an imaginary line from the shoulder to the hip (the "torso line").
 *   2. Work out how tilted that line is away from flat/horizontal, in degrees:
 *        0 degrees   = perfectly flat (lying down / plank)  -> horizontal
 *        90 degrees  = straight up and down (standing)       -> NOT horizontal
 *   3. If the tilt is within `maxTiltDegrees` of flat, we call it horizontal.
 *
 *   We use the pixel positions the detector already gives us. Remember image
 *   coordinates: y grows DOWNWARD, but that does not matter here because we
 *   only care about the SIZE of the tilt, not its direction.
 *
 *   The threshold is deliberately generous (default 45 degrees) so a genuine
 *   push-up seen from a low or slightly angled webcam still passes, while an
 *   upright standing body (tilt near 90) is clearly rejected.
 *
 * This is a PURE helper: give it two points (a shoulder and a hip) and it
 * returns true/false. No React, no DOM.
 *
 * @param {{x:number,y:number}} shoulder   A shoulder keypoint.
 * @param {{x:number,y:number}} hip        A hip keypoint on the same side.
 * @param {object} [options]
 * @param {number} [options.maxTiltDegrees=45]  How far from flat still counts
 *                                               as horizontal.
 * @returns {boolean} true if the torso line is roughly horizontal.
 */
export function isBodyHorizontal(shoulder, hip, { maxTiltDegrees = 45 } = {}) {
  if (!shoulder || !hip) {
    return false;
  }

  const dx = hip.x - shoulder.x;
  const dy = hip.y - shoulder.y;

  // A zero-length torso line (both points on top of each other) tells us
  // nothing, so play it safe and say "not horizontal".
  if (dx === 0 && dy === 0) {
    return false;
  }

  // atan2(|dy|, |dx|) gives the tilt of the line measured UP from horizontal,
  // always in the 0..90 range because we feed it absolute values.
  const tiltDegrees = Math.atan2(Math.abs(dy), Math.abs(dx)) * (180 / Math.PI);

  return tiltDegrees <= maxTiltDegrees;
}

/**
 * Create a tiny moving-average smoother for a stream of angle readings.
 *
 * WHY (the "a little jumpy" problem):
 *   The pose detector is run fresh on every single frame and its joint
 *   positions wobble a bit frame to frame. That makes the measured angle
 *   jitter, which can flicker the rep counter near a threshold or let a single
 *   bad frame spike through. Averaging the last few readings together smooths
 *   that out so the number the rep counter sees is steadier.
 *
 * HOW IT WORKS:
 *   We keep the most recent `windowSize` readings in a little list. Each time
 *   you push a new angle in, we add it, drop the oldest if the list is too
 *   long, and return the average of whatever is in the list. A brief one-frame
 *   spike gets diluted by its neighbours instead of passing straight through.
 *
 *   This runs BEFORE the rep counter, and on TOP of (not instead of) the
 *   hysteresis band and the anti-cheat confidence gate.
 *
 * This is a PURE factory: no React, no DOM, no timers. Easy to unit test by
 * pushing numbers in and reading the smoothed value out.
 *
 * @param {object} [options]
 * @param {number} [options.windowSize=5]  How many recent readings to average.
 * @returns {{
 *   push: (angle:number) => number,
 *   get value: () => (number|null),
 *   reset: () => void
 * }}
 */
export function createAngleSmoother({ windowSize = 5 } = {}) {
  // Guard against nonsense window sizes; at least 1 reading.
  const size = Math.max(1, Math.floor(windowSize));
  let readings = [];

  function average() {
    if (readings.length === 0) return null;
    const total = readings.reduce((sum, n) => sum + n, 0);
    return total / readings.length;
  }

  return {
    /**
     * Add one new angle reading and get back the smoothed (averaged) value.
     * @param {number} angle
     * @returns {number} the average of the most recent readings.
     */
    push(angle) {
      readings.push(angle);
      if (readings.length > size) {
        readings.shift(); // drop the oldest so we only keep `size` readings
      }
      return average();
    },

    /** The current smoothed value, or null if nothing has been pushed yet. */
    get value() {
      return average();
    },

    /** Forget all readings (e.g. when starting a new exercise step). */
    reset() {
      readings = [];
    },
  };
}
