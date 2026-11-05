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
