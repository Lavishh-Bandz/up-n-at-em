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

// -----------------------------------------------------------------------------
// DEPTH (Z) SIGNAL — the any-viewpoint upgrade
// -----------------------------------------------------------------------------
// WHY DEPTH AT ALL (the whole point of this feature):
//   The vertical (screen-y) signal above works great when the camera sees you
//   from the SIDE: lowering toward the floor moves the head+shoulders DOWN the
//   screen (y grows). But when the camera is in FRONT of you, a push-up barely
//   moves the shoulders up/down on screen — instead the upper body moves TOWARD
//   and then AWAY from the camera. That is a change in DEPTH, not in screen-y.
//   BlazePose gives us an estimated depth `z` (meters) per joint, so we can see
//   that toward/away motion and count a front-facing push-up too.
//
// THE Z SIGN (verified for this engine; see keypointAdapter.js):
//   keypoints3D are WORLD landmarks in METERS, roughly hip-centered. z is the
//   depth axis and gets SMALLER / more NEGATIVE as a joint moves CLOSER to the
//   camera, larger/positive as it moves AWAY. So lowering into a front-facing
//   push-up makes the upper-body z DECREASE at the bottom and INCREASE back up
//   — the MIRROR of how screen-y INCREASES at the bottom. We account for that
//   sign below when we turn z into a "down-and-toward-the-camera" number.
//
// UNITS DON'T MATCH, SO WE NORMALIZE BOTH:
//   screen-y is in PIXELS, depth-z is in METERS, so we cannot just add them. We
//   convert each to BODY-RELATIVE units first: y is divided by the locked PIXEL
//   body-scale (shoulder width in pixels, exactly as the y path already does),
//   and z is divided by a stable DEPTH scale in meters (the 3D shoulder width,
//   measured the same lock-once way). After that both are dimensionless "how
//   many body-widths" numbers that can be compared and combined.

/**
 * Tiny helper: the straight-line distance between two 3D points using their
 * meter coordinates (x3d/y3d/z3d, attached by the keypoint adapter), or null if
 * either point lacks 3D data. Pure meters in, meters out.
 *
 * @param {{x3d?:number,y3d?:number,z3d?:number}} [p1]
 * @param {{x3d?:number,y3d?:number,z3d?:number}} [p2]
 * @returns {number|null}
 */
function distance3D(p1, p2) {
  if (
    !p1 ||
    !p2 ||
    typeof p1.x3d !== 'number' ||
    typeof p2.x3d !== 'number' ||
    typeof p1.y3d !== 'number' ||
    typeof p2.y3d !== 'number' ||
    typeof p1.z3d !== 'number' ||
    typeof p2.z3d !== 'number'
  ) {
    return null;
  }
  const dx = p2.x3d - p1.x3d;
  const dy = p2.y3d - p1.y3d;
  const dz = p2.z3d - p1.z3d;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Measure a positive DEPTH-SCALE reference in METERS from the 3D upper body.
 *
 * This is the depth-axis twin of measureBodyScale: a stable "ruler" in meters
 * we divide the depth movement by, so the depth dip is body-relative (how many
 * shoulder-widths toward the camera) rather than raw meters, and distance from
 * the camera does not change the threshold. We use the 3D SHOULDER WIDTH (the
 * meter distance between the two shoulders' world landmarks) when both are
 * present. It is a real-world length that barely changes through a push-up, so
 * it makes a steady ruler.
 *
 * Returns null when the 3D shoulder points are missing or degenerate, so the
 * caller can skip the depth part of the signal for that frame (graceful 2D
 * fallback — the y path still works).
 *
 * @param {object} keypointsByName  Keypoints keyed by name (carrying 3D fields).
 * @returns {number|null} a positive depth-scale in meters, or null.
 */
export function measureDepthScale(keypointsByName) {
  if (!keypointsByName) {
    return null;
  }
  const leftShoulder = keypointsByName.left_shoulder;
  const rightShoulder = keypointsByName.right_shoulder;
  if (leftShoulder && rightShoulder) {
    const width3D = distance3D(leftShoulder, rightShoulder);
    if (width3D !== null && width3D > 0) {
      return width3D;
    }
  }
  return null;
}

/**
 * Measure the representative UPPER-BODY DEPTH (a z meter value) for the chosen
 * side, mirroring measureUpperBodyY but on the depth axis.
 *
 * Just like the y signal averages the chosen shoulder with the nose when the
 * nose is present, we average the shoulder's z with the nose's z so the depth
 * signal follows the whole head+shoulders block moving toward/away from the
 * camera. We read the `z` field the keypoint adapter attached (meters). If the
 * chosen shoulder has no z (no 3D this frame), we return null so the caller
 * falls back to the y-only signal.
 *
 * REMEMBER THE SIGN: smaller/more-negative z = closer to the camera. We return
 * the raw z here (no flip); the combine step below is where we turn a DECREASE
 * in z into a positive "down-and-toward-camera" dip.
 *
 * @param {object} keypointsByName  Keypoints keyed by name (carrying z).
 * @param {'left'|'right'} side     Which side's shoulder to read.
 * @returns {number|null} a z meter value, or null if depth is unavailable.
 */
export function measureUpperBodyDepth(keypointsByName, side) {
  if (!keypointsByName) {
    return null;
  }
  const shoulder =
    side === 'right'
      ? keypointsByName.right_shoulder
      : keypointsByName.left_shoulder;
  if (!shoulder || typeof shoulder.z !== 'number') {
    return null;
  }
  const nose = keypointsByName.nose;
  if (nose && typeof nose.z === 'number') {
    return (shoulder.z + nose.z) / 2;
  }
  return shoulder.z;
}

/**
 * Build ONE combined, viewpoint-agnostic "down-ness" POSITION for the upper
 * body, so the SAME rep counter (createVerticalRepCounter) can count a push-up
 * whether the camera is to the SIDE (motion in screen-y) or in FRONT (motion in
 * depth-z). This is the heart of the any-viewpoint upgrade.
 *
 * WHAT WE RETURN (read this, it explains how it feeds the FSM):
 *   A single number that grows LARGER the more the upper body is "down-and-away
 *   from rest" — down the screen AND/OR toward the camera — expressed in
 *   BODY-RELATIVE units (body-widths), NOT pixels or meters. We hand this to
 *   the vertical rep counter as its position signal with a scale of 1, because
 *   it is already body-relative. The counter then does its own adaptive
 *   baselining + hysteresis on it exactly as before, so a dip from rest in this
 *   combined number is the "excursion" it compares to downFraction/upFraction.
 *
 * THE COMBINE RULE (documented plainly):
 *   We compute two body-relative "down-ness" DIPS from the locked top-of-push-up
 *   rest and take their MAX:
 *     yDip = (screenY - restY) / bodyScalePx    (grows as the body goes DOWN)
 *     zDip = -(z - restZ) / depthScaleM         (grows as the body nears camera,
 *                                                because z DECREASES toward it)
 *     combined = max(yDip, zDip)
 *   MAX (not a sum) is deliberate: a pure SIDE push-up moves mostly in y, so
 *   yDip dominates and the combined number tracks yDip; a pure FRONT push-up
 *   moves mostly in z, so zDip dominates and it tracks zDip. Either viewpoint
 *   reaches the threshold on its own, and we never need to know which way the
 *   camera is pointing. When the two are comparable (an in-between angle)
 *   whichever axis shows the bigger dip wins, which is exactly what we want: we
 *   count on the clearest evidence of a rep. The counter then applies its own
 *   adaptive baseline + hysteresis on top of this combined dip, so a slightly
 *   imperfect locked rest is self-correcting.
 *
 * GRACEFUL FALLBACK: if depth is unavailable this frame (no z / no depth
 * scale), we fall back to the y-only position (posY) so the side-on path keeps
 * working unchanged. If even the y position is unavailable we return null so
 * the caller skips the frame.
 *
 * WHY WE NEED A "REST" REFERENCE PER AXIS (important):
 *   The two axes live at totally different offsets. The shoulder's screen-y
 *   divided by the pixel scale sits around ~1.0 (the shoulder is about a
 *   shoulder-width or so down from the top of the frame), while the depth
 *   position sits around ~0. If we took the MAX of those RAW positions, the big
 *   y offset would always win and the depth motion could never show through. So
 *   we first subtract a REST reference on EACH axis (the "top of the push-up"
 *   captured once during the 5s arming hold) to turn each position into a DIP
 *   from rest, and THEN take the max. Now a pure side dip (y moves, z still) and
 *   a pure front dip (z moves, y still) each produce the right positive dip and
 *   the other axis contributes ~0. The caller still feeds the result through the
 *   rep counter, which applies its own adaptive baseline + hysteresis on top, so
 *   a slightly-off locked rest is self-correcting.
 *
 *   If a rest reference is not supplied for an axis we fall back to using that
 *   axis's RAW position (useful for the side-on, y-only path where the counter's
 *   own baseline does the zeroing). Mixing a raw-y with a dip-z is avoided: the
 *   depth component is only combined in when BOTH a depth rest AND a depth scale
 *   are available, so we never compare a dip against a raw offset.
 *
 * @param {object} keypointsByName  Keypoints keyed by name (2D + optional z).
 * @param {'left'|'right'} side     Which side pickBetterSide chose.
 * @param {number} bodyScalePx      The locked PIXEL body-scale ruler (y axis).
 * @param {number|null} [depthScaleM]  The locked METER depth-scale ruler (z axis).
 *                                   Pass null/undefined to skip the depth part.
 * @param {object} [refs]           Locked "top of the push-up" rest references,
 *                                   captured once during arming:
 *                                   { restY:number, restZ:number }. Omit to let
 *                                   the counter's own baseline do the zeroing
 *                                   (y-only fallback).
 * @returns {{
 *   signal: number,
 *   posY: number,
 *   posZ: (number|null),
 *   usedDepth: boolean
 * }|null} the combined signal plus its parts (for the debug readout), or null.
 */
export function measureCombinedDownSignal(
  keypointsByName,
  side,
  bodyScalePx,
  depthScaleM = null,
  refs = null
) {
  // Without a usable pixel ruler we cannot build the y component, which is our
  // always-available base — so there is nothing to report this frame.
  if (typeof bodyScalePx !== 'number' || bodyScalePx <= 0) {
    return null;
  }

  const currentY = measureUpperBodyY(keypointsByName, side);
  if (currentY == null) {
    return null;
  }

  const hasRestY = refs && typeof refs.restY === 'number';
  const hasRestZ = refs && typeof refs.restZ === 'number';

  // Y component: body-relative "down the screen". When we have a locked rest
  // reference we express it as a DIP from that top (so rest ~= 0 and it lines up
  // with the depth dip); otherwise we pass the raw body-relative position and
  // let the counter's own baseline zero it (the y-only fallback path).
  const posY = hasRestY
    ? (currentY - refs.restY) / bodyScalePx
    : currentY / bodyScalePx;

  // Z component: body-relative "toward the camera" DIP. Only combined in when we
  // have a depth reading, a stable depth ruler AND a locked depth rest (so we
  // never mix a dip against a raw-y offset). We NEGATE the z change so moving
  // CLOSER to the camera (z gets smaller/more negative than the resting top)
  // makes zDip POSITIVE, matching posY's "bigger = more down" direction.
  let posZ = null;
  let usedDepth = false;
  if (typeof depthScaleM === 'number' && depthScaleM > 0 && hasRestZ) {
    const currentZ = measureUpperBodyDepth(keypointsByName, side);
    if (currentZ != null) {
      posZ = -(currentZ - refs.restZ) / depthScaleM;
      usedDepth = true;
    }
  }

  // Combine: MAX of the two body-relative down-ness dips (see rule above).
  const signal = posZ === null ? posY : Math.max(posY, posZ);

  return { signal, posY, posZ, usedDepth };
}

// -----------------------------------------------------------------------------
// ANTI-STANDING GUARD (upper-body only)
// -----------------------------------------------------------------------------
// WHY THIS EXISTS (the live bug):
//   When push-ups switched to upper-body vertical detection we removed the old
//   orientation gate, because the old gate measured the shoulder->hip tilt and
//   the HIP is exactly the keypoint a webcam loses on a floor push-up. With no
//   gate at all, the ONLY thing between "walking around the room" and a counted
//   rep was the body-relative excursion + hysteresis, and a normal standing /
//   walking bob can cross that -> fake reps. So we need an anti-standing guard
//   that uses ONLY upper-body keypoints (shoulders, nose, wrists) and never
//   re-requires the hip or any lower-body point.
//
// THE TWO CUES WE USE (layered, each documented honestly):
//
//   CUE A — WRISTS PLANTED ON THE FLOOR (strong, but only when wrists visible):
//     During a real floor push-up the hands are planted on the floor, so the
//     WRISTS sit at or BELOW the shoulders (remember: y grows downward, so
//     "below" = a LARGER y than the shoulders). When you are standing or
//     walking, your wrists hang somewhere around hip height / swing freely and
//     are generally NOT a full body-scale below the shoulders in the stable,
//     planted way a push-up shows. We ask for both visible wrists to be at
//     least `wristPlantedMargin` of a body-scale BELOW the shoulder line.
//     HONEST TRADE-OFF: wrists are often low-confidence or out of frame on a
//     webcam push-up, so we CANNOT require this cue every frame. It is used as
//     a POSITIVE confirmation when wrists are clearly visible, not as a hard
//     requirement, otherwise we would re-break counting the same way the hip
//     requirement did.
//
//   CUE B — TORSO IS NOT UPRIGHT (works head-on AND side-on, no hip needed):
//     When you stand tall your head sits FAR above your shoulders; when you are
//     down in a push-up / plank your head and shoulders are much closer to the
//     same height (the whole block is near-level). So a large head-above-
//     shoulder VERTICAL gap means "standing", a small one means "down".
//
//     VIEWPOINT PROBLEM WITH THE OLD 2D-ONLY VERSION (the bug this feature
//     fixes): the old check measured that gap in SCREEN-Y pixels only. From the
//     FRONT, a legitimate head-up plank (you lift your head to face the camera)
//     makes the nose sit high on screen even though, in the real world, the
//     head is barely above the shoulders. The 2D gap looked just like standing,
//     so a genuine front-facing plank got falsely REJECTED.
//
//     THE 3D FIX: when depth is available we measure the gap along the REAL
//     WORLD vertical axis (y3d, meters) instead, as a fraction of the 3D
//     shoulder-width depth-scale. In the real world a standing head is a big
//     fraction of a shoulder-width above the shoulders; a plank head is a small
//     one — and this is TRUE regardless of where the camera sits, because world
//     landmarks are not distorted by the camera angle the way screen pixels
//     are. So we REJECT "standing upright" using the 3D gap when we have it, and
//     only fall back to the 2D screen-y gap when 3D is missing (so the guard
//     still does something useful on a pure-2D frame). Either way it still uses
//     only the nose + a shoulder — no hip required.
//     HONEST TRADE-OFF: this is still a coarse upright test, not a precise plank
//     detector. It is tuned to clearly separate "standing tall" from "down on
//     the floor", which is the specific failure (walking/standing) we must stop.
//
// HOW THE CUES COMBINE (the returned boolean = "posture looks like a push-up"):
//   - If CUE B says the torso is clearly UPRIGHT -> posture is NOT ok (reject).
//     This alone stops a standing / walking person, head-on or side-on.
//   - If both wrists are confidently visible, CUE A must ALSO pass (wrists
//     planted) for posture to be ok. Visible-but-dangling wrists while standing
//     are a strong "not a push-up" signal, so we let them veto.
//   - If the wrists are NOT confidently visible, we fall back to CUE B alone:
//     "the torso is not standing upright" is enough to let a genuine side/front
//     push-up through while still rejecting a standing bob.
//
// PURITY: this is a pure function. You pass in the keypoint map, the chosen
// side, the body-scale, and the config; it returns true/false. No DOM, no
// timers, no Date.now(). The "roughly stationary wrists over time" part lives
// in a separate pure factory (createPostureGuard) below so timestamps/positions
// are injected and it stays unit-testable.

/**
 * Default tuning for the anti-standing guard. Exposed so exercises.js can place
 * it on the push-up descriptor (easy to find + tune live via the debug
 * readout). All values are FRACTIONS of the body-scale unless noted.
 */
export const DEFAULT_POSTURE_CONFIG = {
  // CUE A: how far BELOW the shoulder (in body-scale fractions) a wrist must
  // sit to count as "planted on the floor". Wrists at/under the shoulder line
  // by this much read as planted.
  wristPlantedMargin: 0.15,
  // CUE A: confidence a wrist must clear before we trust it enough to demand it
  // be planted (and to let a dangling wrist veto). Matches the app's
  // MIN_CONFIDENCE gate.
  wristMinConfidence: 0.3,
  // CUE B (2D fallback): if the nose sits MORE than this fraction of a
  // body-scale ABOVE the shoulder IN SCREEN PIXELS, the torso reads as standing
  // upright -> reject. Only used when 3D depth is NOT available this frame (see
  // uprightNose3DFraction for the viewpoint-robust 3D version). Meant to be
  // tuned live.
  uprightNoseFraction: 0.6,
  // CUE B (3D, viewpoint-robust): the SAME idea measured along the real-world
  // vertical axis (y3d, meters) as a fraction of the 3D shoulder-width
  // depth-scale. If the nose sits MORE than this fraction of a 3D shoulder-width
  // ABOVE the shoulders in the real world, the torso reads as standing -> reject.
  // Because world landmarks are not warped by the camera angle, this no longer
  // falsely rejects a FRONT-FACING head-up plank (where the head only LOOKS high
  // on screen). A touch more generous than the 2D value because real-world head
  // lift in a plank is still a modest fraction of a shoulder-width. Live-tunable
  // starting value.
  uprightNose3DFraction: 0.9,
};

/**
 * Pure anti-standing posture check from UPPER-BODY keypoints only.
 *
 * Returns TRUE when the visible upper body plausibly looks like a push-up /
 * plank posture, and FALSE when it looks like someone standing or walking. See
 * the big comment above for the full rationale and honest trade-offs.
 *
 * It never reads the hip or any lower-body keypoint. If it cannot tell (no
 * body-scale, no usable points), it FAILS OPEN (returns true) so a missing
 * keypoint never silently blocks a genuine rep — exactly like the existing
 * orientation helpers. The REAL rejection of a standing bob is a combination of
 * this guard and the body-relative excursion in the counter.
 *
 * @param {object} keypointsByName  Map of MoveNet keypoints keyed by name.
 * @param {'left'|'right'} side     Which side's shoulder/wrist to read.
 * @param {number} bodyScalePx      The body-scale ruler (pixels) for this frame.
 * @param {object} [config]         Tuning (see DEFAULT_POSTURE_CONFIG).
 * @returns {boolean} true if posture looks like a push-up, false if standing.
 */
export function isPushupPosture(
  keypointsByName,
  side,
  bodyScalePx,
  config = DEFAULT_POSTURE_CONFIG
) {
  // Without a usable ruler or any keypoints we cannot judge posture; fail open.
  if (!keypointsByName || typeof bodyScalePx !== 'number' || bodyScalePx <= 0) {
    return true;
  }

  const cfg = { ...DEFAULT_POSTURE_CONFIG, ...config };

  const shoulder =
    side === 'right'
      ? keypointsByName.right_shoulder
      : keypointsByName.left_shoulder;

  // No shoulder anchor -> we have nothing to compare against; fail open.
  if (!shoulder || typeof shoulder.y !== 'number') {
    return true;
  }

  // CUE B: reject a clearly UPRIGHT torso (nose far above the shoulder line).
  const nose = keypointsByName.nose;
  if (nose) {
    // PREFER the 3D, viewpoint-robust test when both the nose and the chosen
    // shoulder carry real-world coordinates. We measure the head-above-shoulder
    // gap along the WORLD vertical axis (y3d, meters; y grows DOWNWARD like the
    // image) as a fraction of the 3D shoulder-width depth-scale. "Above" means a
    // SMALLER y3d, so (shoulder.y3d - nose.y3d) is positive when the head is up
    // high in the real world — i.e. standing tall — no matter where the camera
    // sits. This is what stops a front-facing head-up plank being mistaken for
    // standing.
    const depthScaleM = measureDepthScale(keypointsByName);
    if (
      typeof nose.y3d === 'number' &&
      typeof shoulder.y3d === 'number' &&
      depthScaleM !== null &&
      depthScaleM > 0
    ) {
      const noseAbove3DFraction = (shoulder.y3d - nose.y3d) / depthScaleM;
      if (noseAbove3DFraction > cfg.uprightNose3DFraction) {
        // Head is stacked high above the shoulders in the real world: standing.
        return false;
      }
    } else if (typeof nose.y === 'number') {
      // FALLBACK (no 3D this frame): measure the gap in SCREEN pixels. y grows
      // downward, so "above" means a SMALLER y -> (shoulder.y - nose.y) is
      // positive when the head is up high. Coarser and camera-angle dependent,
      // but better than nothing on a pure-2D frame.
      const noseAboveFraction = (shoulder.y - nose.y) / bodyScalePx;
      if (noseAboveFraction > cfg.uprightNoseFraction) {
        return false;
      }
    }
  }

  // CUE A: if BOTH wrists are confidently visible, require them planted (at or
  // below the shoulder line by the margin). Visible dangling wrists veto.
  const leftWrist = keypointsByName.left_wrist;
  const rightWrist = keypointsByName.right_wrist;
  const leftWristSeen =
    leftWrist &&
    typeof leftWrist.y === 'number' &&
    typeof leftWrist.score === 'number' &&
    leftWrist.score >= cfg.wristMinConfidence;
  const rightWristSeen =
    rightWrist &&
    typeof rightWrist.y === 'number' &&
    typeof rightWrist.score === 'number' &&
    rightWrist.score >= cfg.wristMinConfidence;

  if (leftWristSeen && rightWristSeen) {
    // Planted = wrist y is at least `wristPlantedMargin` of a body-scale BELOW
    // the shoulder (a LARGER y, since y grows downward).
    const leftPlanted =
      (leftWrist.y - shoulder.y) / bodyScalePx >= cfg.wristPlantedMargin;
    const rightPlanted =
      (rightWrist.y - shoulder.y) / bodyScalePx >= cfg.wristPlantedMargin;
    if (!(leftPlanted && rightPlanted)) {
      // Both wrists are clearly visible but NOT planted on the floor: this is a
      // standing / walking posture with hands up, not a push-up.
      return false;
    }
  }

  // Nothing rejected it: posture plausibly looks like a push-up.
  return true;
}

/**
 * Create a tiny PURE stateful posture guard that adds a "wrists are roughly
 * STATIONARY" check on top of isPushupPosture.
 *
 * WHY A STATEFUL HELPER:
 *   A planted hand barely moves frame-to-frame, while a walking person's wrists
 *   swing. To notice that we must remember where the wrists were on recent
 *   frames. We keep that memory here, as a pure factory with update()/reset(),
 *   so timestamps/positions are INJECTED and tests stay deterministic (same
 *   pattern as positionGate.js / statusDebounce.js). There is no Date.now().
 *
 * HOW IT DECIDES:
 *   Each update() first runs the stateless isPushupPosture check. Then, when
 *   both wrists are confidently visible, it also checks that the wrists have
 *   not moved more than `wristStationaryFraction` of a body-scale since the
 *   previous frame. A swinging (walking) wrist exceeds that and the frame is
 *   rejected; a planted wrist stays well under it. When wrists are not clearly
 *   visible we simply skip the stationary test and rely on isPushupPosture.
 *
 * HONEST TRADE-OFF: a single frame of wrist jitter could trip the stationary
 * test, so the threshold is generous; its job is to catch a walking SWING, not
 * demand a perfectly frozen hand.
 *
 * @param {object} [config] Tuning (see DEFAULT_POSTURE_CONFIG plus
 *                          wristStationaryFraction).
 * @returns {{
 *   update: (keypointsByName:object, side:('left'|'right'), bodyScalePx:number) => boolean,
 *   reset: () => void
 * }}
 */
export function createPostureGuard(config = {}) {
  const cfg = {
    ...DEFAULT_POSTURE_CONFIG,
    // How far (fraction of body-scale) a visible wrist may move between frames
    // and still count as "planted / stationary". A walking swing exceeds this.
    wristStationaryFraction: 0.2,
    ...config,
  };

  // Remember the previous frame's wrist positions to measure movement.
  let prevLeftWrist = null;
  let prevRightWrist = null;

  function wristMovedTooMuch(wrist, prev, bodyScalePx) {
    if (!prev) return false; // no history yet -> cannot have "moved"
    const moved = distance(wrist, prev);
    if (moved === null) return false;
    return moved / bodyScalePx > cfg.wristStationaryFraction;
  }

  return {
    /**
     * Feed one frame. Returns true if posture (position + stationary) looks
     * like a push-up, false if it looks like standing / walking.
     */
    update(keypointsByName, side, bodyScalePx) {
      // Start from the stateless posture check (CUE A + CUE B above).
      const posturalOk = isPushupPosture(keypointsByName, side, bodyScalePx, cfg);

      // If the stateless check already failed, or we have no ruler, do not
      // bother with the movement test — but still remember current wrists so a
      // later frame has history.
      const leftWrist = keypointsByName ? keypointsByName.left_wrist : null;
      const rightWrist = keypointsByName ? keypointsByName.right_wrist : null;

      const leftSeen =
        leftWrist &&
        typeof leftWrist.score === 'number' &&
        leftWrist.score >= cfg.wristMinConfidence;
      const rightSeen =
        rightWrist &&
        typeof rightWrist.score === 'number' &&
        rightWrist.score >= cfg.wristMinConfidence;

      let stationaryOk = true;
      if (
        posturalOk &&
        typeof bodyScalePx === 'number' &&
        bodyScalePx > 0 &&
        leftSeen &&
        rightSeen
      ) {
        // Both wrists visible: reject if either swung too far since last frame.
        if (
          wristMovedTooMuch(leftWrist, prevLeftWrist, bodyScalePx) ||
          wristMovedTooMuch(rightWrist, prevRightWrist, bodyScalePx)
        ) {
          stationaryOk = false;
        }
      }

      // Update history (only for wrists we actually trust this frame).
      prevLeftWrist = leftSeen ? leftWrist : null;
      prevRightWrist = rightSeen ? rightWrist : null;

      return posturalOk && stationaryOk;
    },

    /** Forget wrist history (e.g. when starting a new exercise step). */
    reset() {
      prevLeftWrist = null;
      prevRightWrist = null;
    },
  };
}

// -----------------------------------------------------------------------------
// STABLE BODY-SCALE RULER
// -----------------------------------------------------------------------------
// WHY A LOCKED RULER BEATS A PER-FRAME ONE (the second live bug):
//   measureBodyScale uses the LIVE left-right shoulder width as the pixel ruler.
//   Facing the camera, that width CHANGES through a push-up: the shoulders
//   rotate/tuck and perspective shifts as the torso nears the camera. So the
//   excursion (currentY - baseline) / bodyScalePx is being divided by a MOVING
//   number every frame. A genuine rep's dip can fail to cross the threshold
//   cleanly while noise crosses it. The fix is to measure the ruler ONCE, while
//   the user holds the top position during the 5-second arming countdown, then
//   REUSE that locked value for the whole set. A fixed ruler means the only
//   thing that changes frame-to-frame is the actual vertical movement, which is
//   what we want to measure.
//
// This factory is pure: you feed it per-frame candidate scales (and whether the
// frame is confident), it smooths them during an "arming" window, locks the
// smoothed baseline when you tell it the arming window is done, and then returns
// that locked value forever after. Reset per step.

/**
 * Create a pure STABLE body-scale tracker.
 *
 * Lifecycle:
 *   1. During arming (the 5s get-into-position hold), call push(scale, true)
 *      each confident frame. The tracker keeps a smoothed average of the recent
 *      candidate scales.
 *   2. Call lock() once (when the arming window completes) to freeze the
 *      smoothed baseline as the locked ruler.
 *   3. For the rest of the set, getScale() returns the locked value regardless
 *      of what the live shoulder width does.
 *   4. reset() clears everything for the next step.
 *
 * If lock() is called before any confident scale was seen, the tracker stays
 * unlocked and getScale() returns null, so the caller can fall back to the
 * live measureBodyScale for that (unusual) frame.
 *
 * @param {object} [options]
 * @param {number} [options.windowSize=15]  How many recent candidate scales to
 *                                           average while arming. Bigger =
 *                                           steadier lock.
 * @returns {{
 *   push: (scale:number, confident?:boolean) => (number|null),
 *   lock: () => (number|null),
 *   reset: () => void,
 *   get scale: () => (number|null),
 *   get locked: () => boolean
 * }}
 */
/**
 * Create a pure "top of the push-up" REST-REFERENCE tracker.
 *
 * This is the rest-position twin of createBodyScaleTracker. While the body-scale
 * tracker locks the RULERS (shoulder width in pixels / meters), THIS one locks
 * the resting POSITION on each axis — the upper-body screen-y and depth-z the
 * user holds at the TOP of a push-up during the 5s arming hold. measureCombined
 * DownSignal subtracts these so each axis becomes a DIP from the top (rest ~= 0)
 * and the MAX-of-dips combine rule works (see that function's header for why a
 * per-axis rest is needed).
 *
 * Unlike the body-scale tracker, the values here are POSITIONS, not lengths:
 * restY is a pixel y (positive) and restZ is a depth in meters that can be
 * NEGATIVE or zero (it is hip-centered). So this tracker accepts ANY finite
 * number, not just positive ones. Each axis is tracked independently: a frame
 * may contribute a y but no z (no 3D), and that is fine.
 *
 * Lifecycle mirrors the body-scale tracker: push() confident arming frames,
 * lock() once when the step arms, then read the frozen refs for the rest of the
 * set, and reset() per step.
 *
 * @param {object} [options]
 * @param {number} [options.windowSize=15]  How many recent readings to average
 *                                           per axis while arming.
 * @returns {{
 *   push: (y:(number|null), z:(number|null), confident?:boolean) => void,
 *   lock: () => ({restY:number|null, restZ:number|null}),
 *   reset: () => void,
 *   get refs: () => ({restY:number|null, restZ:number|null}),
 *   get locked: () => boolean
 * }}
 */
export function createSignalReferenceTracker({ windowSize = 15 } = {}) {
  const size = Math.max(1, Math.floor(windowSize));
  let yReadings = [];
  let zReadings = [];
  let locked = false;
  let lockedY = null;
  let lockedZ = null;

  function avg(list) {
    if (list.length === 0) return null;
    return list.reduce((sum, n) => sum + n, 0) / list.length;
  }

  return {
    /**
     * Offer one per-frame rest candidate while arming. y and/or z may be null
     * for a frame (e.g. no 3D depth yet); each axis is accumulated on its own.
     * Ignored once locked and on unconfident frames.
     */
    push(y, z, confident = true) {
      if (locked || !confident) {
        return;
      }
      if (typeof y === 'number' && Number.isFinite(y)) {
        yReadings.push(y);
        if (yReadings.length > size) yReadings.shift();
      }
      if (typeof z === 'number' && Number.isFinite(z)) {
        zReadings.push(z);
        if (zReadings.length > size) zReadings.shift();
      }
    },

    /** Freeze the current smoothed rest references. */
    lock() {
      lockedY = avg(yReadings);
      lockedZ = avg(zReadings);
      locked = true;
      return { restY: lockedY, restZ: lockedZ };
    },

    /** Forget everything for the next step. */
    reset() {
      yReadings = [];
      zReadings = [];
      locked = false;
      lockedY = null;
      lockedZ = null;
    },

    /**
     * The references to USE right now: the locked values once locked, otherwise
     * the current smoothed candidates (so a caller can peek before locking).
     */
    get refs() {
      return locked
        ? { restY: lockedY, restZ: lockedZ }
        : { restY: avg(yReadings), restZ: avg(zReadings) };
    },

    get locked() {
      return locked;
    },
  };
}

export function createBodyScaleTracker({ windowSize = 15 } = {}) {
  const size = Math.max(1, Math.floor(windowSize));
  let readings = [];
  let lockedScale = null;

  function smoothed() {
    if (readings.length === 0) return null;
    const total = readings.reduce((sum, n) => sum + n, 0);
    return total / readings.length;
  }

  return {
    /**
     * Offer one per-frame candidate scale while arming. Ignores non-positive /
     * non-numeric scales and unconfident frames. Once locked, pushes are
     * ignored (the ruler is fixed). Returns the current smoothed candidate (or
     * the locked value if already locked).
     */
    push(scale, confident = true) {
      if (lockedScale !== null) {
        return lockedScale; // already locked: ignore new candidates
      }
      if (confident && typeof scale === 'number' && scale > 0) {
        readings.push(scale);
        if (readings.length > size) {
          readings.shift();
        }
      }
      return smoothed();
    },

    /**
     * Freeze the current smoothed candidate as the locked ruler. If nothing
     * usable was seen, stays unlocked (returns null).
     */
    lock() {
      const value = smoothed();
      if (value !== null && value > 0) {
        lockedScale = value;
      }
      return lockedScale;
    },

    /** Forget everything for the next step. */
    reset() {
      readings = [];
      lockedScale = null;
    },

    /**
     * The scale to USE right now: the locked value once locked, otherwise the
     * current smoothed candidate (or null if nothing usable yet).
     */
    get scale() {
      return lockedScale !== null ? lockedScale : smoothed();
    },

    /** Whether the ruler has been locked. */
    get locked() {
      return lockedScale !== null;
    },
  };
}
