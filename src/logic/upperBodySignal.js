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
//     When you stand tall your head sits FAR above your shoulders relative to
//     your body-scale; the nose-to-shoulder vertical gap is large. When you are
//     down in a push-up / plank your head and shoulders are much closer to the
//     same height (the head drops forward, the whole block is near-level), so
//     that vertical gap is a SMALL fraction of body-scale. We REJECT the frame
//     as "standing upright" when the nose sits more than `uprightNoseFraction`
//     of a body-scale ABOVE the shoulder (nose y smaller than shoulder y by a
//     big margin). This uses only the nose + a shoulder, so it works whether
//     the camera sees you head-on or side-on.
//     HONEST TRADE-OFF: this is a coarse upright test, not a precise plank
//     detector; a very deep forward head tilt could fool it. It is tuned to
//     clearly separate "standing tall" from "down on the floor", which is the
//     specific failure (walking/standing) we must stop.
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
  // CUE B: if the nose sits MORE than this fraction of a body-scale ABOVE the
  // shoulder, the torso reads as standing upright -> reject. Tuned to separate
  // "standing tall" (large head-above-shoulder gap) from "down in a plank"
  // (small gap). Meant to be tuned live.
  uprightNoseFraction: 0.6,
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
  if (nose && typeof nose.y === 'number') {
    // How far the nose sits ABOVE the shoulder, as a fraction of body-scale.
    // y grows downward, so "above" means a SMALLER y -> (shoulder.y - nose.y)
    // is positive when the head is up high (standing tall).
    const noseAboveFraction = (shoulder.y - nose.y) / bodyScalePx;
    if (noseAboveFraction > cfg.uprightNoseFraction) {
      // Head is stacked high above the shoulders: this is a standing posture.
      return false;
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
