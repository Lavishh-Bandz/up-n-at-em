// upperBodySignal.js
// -----------------------------------------------------------------------------
// Pure helpers that turn a frame of pose keypoints into the two numbers the
// upper-body push-up counter needs:
//   1. a BODY-SCALE reference (how big the user looks right now, in pixels), and
//   2. a representative UPPER-BODY VERTICAL position (a y value, in pixels).
//
// No React, no DOM, no webcam. You hand in a plain map of keypoints and get a
// plain number (or null) back, which makes these trivial to unit test.
//
// WHY THESE TWO NUMBERS?
//   Solution 1 counts a push-up from the VISIBLE UPPER BODY moving DOWN toward
//   the floor and back UP, so it still works when the legs/hips are out of
//   frame. To do that robustly we need to answer "how far down did the upper
//   body move?" in a way that does not depend on how close the user is to the
//   camera. So we measure the movement (a change in y) as a FRACTION of the
//   body's own size (the body-scale). Someone far away looks small and moves a
//   few pixels; someone close looks big and moves many pixels — but as a
//   fraction of their own shoulder-width, a real push-up looks the same.
//
// REMEMBER THE COORDINATE SYSTEM (this trips up everyone):
//   MoveNet keypoints are in PIXELS and y increases DOWNWARD. So moving "down
//   toward the floor" makes the y value get BIGGER, and coming back "up" makes
//   it get SMALLER. We do not flip anything here; we just hand back the raw y.
//
// A "keypoint" looks like: { x: number, y: number, score: number }. The map we
// receive is keyed by MoveNet name, e.g. keypointsByName.left_shoulder.

/**
 * Tiny helper: the straight-line (Euclidean) distance between two keypoints,
 * or null if either point is missing. Pure pixels in, pixels out.
 *
 * @param {{x:number,y:number}} [p1]
 * @param {{x:number,y:number}} [p2]
 * @returns {number|null}
 */
function distance(p1, p2) {
  if (!p1 || !p2) {
    return null;
  }
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Measure a positive BODY-SCALE reference in PIXELS from UPPER-BODY keypoints.
 *
 * This is the "ruler" we measure the push-up movement against so the counter
 * does not care how far the user is from the camera.
 *
 * HOW WE PICK THE RULER:
 *   - PRIMARY: the shoulder width — the distance between the left and right
 *     shoulders — whenever BOTH shoulders are present. This is a nice stable
 *     measure of how big the user looks, and it is upper-body only.
 *   - FALLBACK: if one shoulder is missing (common when filming from the side),
 *     use the distance from the nose to whichever shoulder we do have.
 *
 * We return null if we cannot build a trustworthy ruler, or if the distance
 * comes out as zero/degenerate (the points landed on top of each other), so the
 * counter knows to skip that frame rather than divide by a bad number.
 *
 * NOTE: this function does NOT check keypoint scores. The caller already gates
 * on confidence (allConfident / MIN_CONFIDENCE) before trusting a frame; here we
 * only decide whether the points we were given form a usable ruler.
 *
 * @param {object} keypointsByName  Map of MoveNet keypoints keyed by name.
 * @returns {number|null} a positive body-scale in pixels, or null.
 */
export function measureBodyScale(keypointsByName) {
  if (!keypointsByName) {
    return null;
  }

  const leftShoulder = keypointsByName.left_shoulder;
  const rightShoulder = keypointsByName.right_shoulder;
  const nose = keypointsByName.nose;

  // PRIMARY: shoulder width when both shoulders are present.
  if (leftShoulder && rightShoulder) {
    const shoulderWidth = distance(leftShoulder, rightShoulder);
    if (shoulderWidth !== null && shoulderWidth > 0) {
      return shoulderWidth;
    }
    // Both shoulders present but sitting on top of each other (degenerate):
    // fall through and try the nose-to-shoulder fallback instead.
  }

  // FALLBACK: nose to whichever shoulder we have (left preferred, then right).
  const availableShoulder = leftShoulder || rightShoulder;
  if (nose && availableShoulder) {
    const noseToShoulder = distance(nose, availableShoulder);
    if (noseToShoulder !== null && noseToShoulder > 0) {
      return noseToShoulder;
    }
  }

  // Nothing usable.
  return null;
}

/**
 * Measure the representative UPPER-BODY VERTICAL position (a y pixel value) for
 * the chosen side, or null if we cannot.
 *
 * This single number is the "signal" the counter watches go DOWN (bigger y) and
 * back UP (smaller y). We want it to reflect the HEAD and SHOULDERS moving
 * together during a push-up:
 *   - If the nose is visible, we average the chosen shoulder's y with the nose's
 *     y, so the signal follows the whole head+shoulders block dipping down.
 *   - If the nose is not available, we fall back to the shoulder's y on its own.
 *
 * We return a plain number so it can flow straight through createAngleSmoother
 * (which just averages whatever numbers you push into it).
 *
 * @param {object} keypointsByName  Map of MoveNet keypoints keyed by name.
 * @param {'left'|'right'} side     Which side's shoulder to read.
 * @returns {number|null} a y pixel value, or null if the shoulder is missing.
 */
export function measureUpperBodyY(keypointsByName, side) {
  if (!keypointsByName) {
    return null;
  }

  const shoulder =
    side === 'right'
      ? keypointsByName.right_shoulder
      : keypointsByName.left_shoulder;

  // Without the chosen shoulder we have no signal to report.
  if (!shoulder || typeof shoulder.y !== 'number') {
    return null;
  }

  const nose = keypointsByName.nose;

  // Nose present: average head + shoulder so the signal tracks them together.
  if (nose && typeof nose.y === 'number') {
    return (shoulder.y + nose.y) / 2;
  }

  // Shoulder-only fallback.
  return shoulder.y;
}
