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
// OUTLIER / INVALID-FRAME VALIDATOR (the main fix in this pass)
// -----------------------------------------------------------------------------
// WHY THIS EXISTS (the live bug, proven by the user's diagnostics):
//   MoveNet sometimes LOSES the tracked shoulder/nose on a side-view floor
//   push-up and emits GARBAGE coordinates for them. The user's own console log
//   shows upperBodyY jumping from a sane ~558px to NEGATIVE / impossible values
//   (-39, -64) and teleporting hundreds of pixels frame-to-frame (0 -> 504)
//   between ~200ms samples. The push-up signal was trusted blindly, so a single
//   garbage frame produced a huge excursion spike (the log shows 3.764 and
//   1.569) that blew past downFraction, and the next frame "rose" back up —
//   counting a full rep that never happened. Nine phantom reps in one run.
//
//   The counter is not wrong: it is faithfully counting detector NOISE. The fix
//   is to REJECT a frame's upperBodyY reading BEFORE it reaches the counter when
//   the reading is physically implausible, and to treat a rejected frame exactly
//   like a not-confident frame (do not count, do not advance, do not tick the
//   arming countdown).
//
// TWO PLAUSIBILITY RULES (both body-relative where it matters):
//
//   RULE 1 — IN-RANGE PIXELS: a real keypoint y is a pixel row on the video, so
//   it can never be negative and can never sit outside the frame. upperBodyY of
//   -39 / -64 is impossible. We reject any y that is non-finite, negative, or
//   (when the caller knows the video height) beyond the bottom of the frame. If
//   the frame height is unknown we still reject the clearly-impossible negatives
//   and absurdly large values via a generous cap, so a teleport to a wild pixel
//   value is caught even without exact bounds.
//
//   RULE 2 — NO TELEPORT: a human upper body cannot move most of its own
//   body-scale in a single ~16-60ms frame. We remember the previous ACCEPTED y
//   and reject a frame whose y jumped more than `maxJumpFraction` of a
//   body-scale since then. Using the LOCKED bodyScalePx makes this threshold
//   body-relative (near or far from the camera behave the same). A jump from
//   ~0px to 504px against a ~255px ruler is ~2.0 body-scales in one frame — far
//   past any real movement — so it is rejected.
//
// HONEST TRADE-OFFS:
//   - We only START the teleport check once we have a previous accepted y, so
//     the very first usable frame is always allowed through (it just seeds the
//     memory). A real rep's frame-to-frame travel is a small fraction of a
//     body-scale, so a generous maxJumpFraction (0.75 by default) rejects
//     teleports while never touching a genuine dip.
//   - Rejecting a frame does NOT reset the rep counter or the baseline; it just
//     skips the frame. The next plausible frame continues from where we were,
//     exactly like a camera blink (not-confident) frame.
//
// PURITY: this is a pure factory (createUpperBodySignalValidator) with
// update()/reset(), no DOM and no Date.now(). The previous-y memory lives inside
// it so tests stay deterministic (same pattern as positionGate.js).

/**
 * Default tuning for the outlier validator. Exposed so callers/tests can share
 * (and live-tune) the same numbers.
 */
export const DEFAULT_SIGNAL_VALIDATOR_CONFIG = {
  // RULE 2: the biggest per-frame jump in upperBodyY, as a fraction of the
  // body-scale, that we will still accept as real human movement. Anything
  // bigger is a detector teleport. 0.75 of a shoulder-width in one frame is
  // already faster than any real push-up, so this rejects the garbage while
  // leaving a genuine ~0.2 dip (spread over several frames) untouched.
  maxJumpFraction: 0.75,
  // RULE 1 (no-bounds fallback): when the caller does not know the video height
  // we still reject an absurdly large y via this hard pixel cap, so a teleport
  // to a wild value is caught even without exact frame bounds. Real webcam
  // frames are well under this.
  maxPlausibleY: 5000,
};

/**
 * Create a pure validator that decides whether a single frame's upper-body y
 * reading is PLAUSIBLE (should be counted) or an OUTLIER (should be skipped).
 *
 * Call update() once per frame with the y the signal path produced, the ruler
 * (bodyScalePx) in use, and optionally the video frame height so RULE 1 can use
 * exact bounds. It returns a small result object:
 *
 *   { ok: boolean, reason: (string|null) }
 *
 * where ok === true means "trust this frame" and ok === false means "reject it
 * like a not-confident frame". `reason` is a short human-readable tag for the
 * debug readout so the user can SEE the garbage being filtered live
 * ('negative', 'out-of-frame', 'teleport', 'invalid').
 *
 * @param {object} [config]  Tuning (see DEFAULT_SIGNAL_VALIDATOR_CONFIG).
 * @returns {{
 *   update: (currentY:number, bodyScalePx:number, frameHeight?:number) => {ok:boolean, reason:(string|null)},
 *   reset: () => void
 * }}
 */
export function createUpperBodySignalValidator(config = {}) {
  const cfg = { ...DEFAULT_SIGNAL_VALIDATOR_CONFIG, ...config };

  // The last y we ACCEPTED, so RULE 2 can measure a frame-to-frame jump. Null
  // until the first plausible frame seeds it.
  let prevAcceptedY = null;

  return {
    /**
     * Validate one frame's upper-body y.
     *
     * @param {number} currentY     The y the signal path produced this frame.
     * @param {number} bodyScalePx  The body-scale ruler (pixels) in use.
     * @param {number} [frameHeight] Optional video height so RULE 1 can reject
     *                               anything past the bottom of the frame.
     * @returns {{ok:boolean, reason:(string|null)}}
     */
    update(currentY, bodyScalePx, frameHeight) {
      // A missing / non-numeric reading is not countable. We do NOT touch the
      // accepted-y memory, so the next real frame still compares against the
      // last good value rather than a gap.
      if (typeof currentY !== 'number' || !Number.isFinite(currentY)) {
        return { ok: false, reason: 'invalid' };
      }

      // RULE 1a: a pixel row can never be negative. -39 / -64 are impossible.
      if (currentY < 0) {
        return { ok: false, reason: 'negative' };
      }

      // RULE 1b: reject anything past the bottom of the frame when we know the
      // height, otherwise fall back to the generous hard cap.
      if (typeof frameHeight === 'number' && frameHeight > 0) {
        if (currentY > frameHeight) {
          return { ok: false, reason: 'out-of-frame' };
        }
      } else if (currentY > cfg.maxPlausibleY) {
        return { ok: false, reason: 'out-of-frame' };
      }

      // RULE 2: reject a physically-impossible teleport since the last accepted
      // frame, measured as a fraction of the body-scale. Needs a usable ruler
      // and a previous accepted y; without a ruler we cannot judge the jump, so
      // we skip RULE 2 (RULE 1 already caught the impossible values).
      if (
        prevAcceptedY !== null &&
        typeof bodyScalePx === 'number' &&
        bodyScalePx > 0
      ) {
        const jump = Math.abs(currentY - prevAcceptedY);
        if (jump / bodyScalePx > cfg.maxJumpFraction) {
          // A teleport. Deliberately do NOT update prevAcceptedY: we keep the
          // last GOOD value so a lone garbage frame cannot drag our reference.
          return { ok: false, reason: 'teleport' };
        }
      }

      // Plausible: remember it as the new reference and accept the frame.
      prevAcceptedY = currentY;
      return { ok: true, reason: null };
    },

    /** Forget the accepted-y memory (e.g. when a new step begins). */
    reset() {
      prevAcceptedY = null;
    },
  };
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
// READY-POSITION CHECK FOR THE ARMING COUNTDOWN (side-view friendly)
// -----------------------------------------------------------------------------
// WHY THIS EXISTS (the live bug the user reported):
//   The 5-second "get into position" countdown advances whenever the frame is
//   "confident", and for push-ups "confident" only means the chosen-side
//   shoulder is visible and the outlier validator accepted the reading. So just
//   STANDING in front of the camera armed the countdown. It should only count
//   down once the user is genuinely DOWN in the push-up / ready position.
//
//   We cannot reuse isPushupPosture directly for this, for two reasons:
//     1. isPushupPosture FAILS OPEN (returns true when it cannot tell) so a
//        missing keypoint never blocks a counted rep. That is right for the rep
//        counter, but exactly WRONG for arming: for arming we want the opposite,
//        "if we are not sure you are down, do NOT start the countdown".
//     2. The user films from the SIDE, and side-on the single strongest cue in
//        isPushupPosture (nose-high-above-shoulder) is weak.
//
//   So this is a SEPARATE, PURPOSE-BUILT check for the arming gate only. It is
//   used in addition to (not instead of) the per-frame confidence + validator,
//   and it FAILS TOWARD NOT ARMING: when it cannot positively confirm a ready
//   position it returns false, so the countdown pauses rather than arming on a
//   standing body. It never gates the rep counter, so it cannot strand earned
//   reps once the set is armed.
//
// THE CUES (each works side-on, listed strongest-first):
//
//   CUE LEVEL — TORSO IS ROUGHLY HORIZONTAL (strongest, needs the hip):
//     In a real side-view push-up / plank the shoulder and hip sit at nearly
//     the SAME height (the torso is near-level with the floor), so the VERTICAL
//     gap between shoulder and hip is a SMALL fraction of the body-scale. When
//     standing, the shoulder is stacked high ABOVE the hip, so that vertical gap
//     is a LARGE fraction of body-scale. When the chosen-side hip is visible we
//     use this directly: a small shoulder-to-hip vertical gap = ready; a large
//     one = standing. This is the cleanest side-on separator, so when the hip is
//     present it decides on its own.
//
//   CUE PLANTED — WRISTS ON THE FLOOR (strong, needs both wrists):
//     Same idea as isPushupPosture CUE A, but used here as a POSITIVE readiness
//     signal: if both wrists are confidently visible and planted at/below the
//     shoulder line, the hands are on the floor -> ready.
//
//   CUE HEAD — HEAD NEAR SHOULDER HEIGHT (fallback, needs the nose):
//     When the hip and wrists are not available (common side-on), fall back to
//     the head height. Down in a push-up the head drops to near shoulder level,
//     so the nose sits only a small fraction of body-scale above (or even below)
//     the shoulder. Standing tall, the nose sits far ABOVE the shoulder. We only
//     treat this as READY when the gap is clearly SMALL (a tighter threshold
//     than isPushupPosture's reject threshold), so a borderline standing frame
//     does not arm.
//
// DECISION (fails toward NOT ready):
//   - No usable body-scale or no shoulder anchor -> NOT ready (false).
//   - Hip visible -> ready IFF the shoulder-to-hip vertical gap is small.
//   - Else both wrists visible+planted -> ready.
//   - Else nose visible and clearly near shoulder height -> ready.
//   - Otherwise -> NOT ready (we could not positively confirm a down position).

/**
 * Default tuning for the ready-position (arming) check. Fractions of the
 * body-scale unless noted. Exposed so exercises.js can place it on the push-up
 * descriptor and the user can tune it live via the debug readout.
 */
export const DEFAULT_READY_CONFIG = {
  // CUE LEVEL: the shoulder-to-hip VERTICAL gap (as a fraction of body-scale)
  // must be at or under this for the torso to read as "roughly horizontal"
  // (down in a plank). Standing stacks the shoulder ~a full body-scale above
  // the hip, so a small value here cleanly separates the two. 0.5 = the torso
  // is more level than upright.
  maxShoulderHipVerticalFraction: 0.5,
  // CUE PLANTED: how far BELOW the shoulder (fraction of body-scale) both wrists
  // must sit to read as planted on the floor. Matches the posture guard.
  wristPlantedMargin: 0.15,
  // Confidence a wrist / hip must clear before we trust it for a cue.
  jointMinConfidence: 0.3,
  // CUE HEAD: the nose may sit at most this fraction of a body-scale ABOVE the
  // shoulder to read as "head near shoulder height" (down). This is TIGHTER
  // than isPushupPosture's reject threshold (0.6) on purpose: for arming we
  // want a clear, confident "you are down" before we start the countdown, not
  // merely "you are not obviously standing".
  maxNoseAboveFraction: 0.35,
};

/**
 * Decide whether THIS frame positively looks like a genuine push-up READY /
 * down position, for the purpose of advancing the arming countdown.
 *
 * Unlike isPushupPosture (which fails OPEN so it never blocks a counted rep),
 * this FAILS TOWARD NOT READY: if it cannot positively confirm a down position
 * it returns false, so the countdown pauses instead of arming on a standing
 * body. See the big comment above for the per-cue rationale.
 *
 * Pure function: keypoints in, true/false out. No DOM, no timers.
 *
 * @param {object} keypointsByName  Map of MoveNet keypoints keyed by name.
 * @param {'left'|'right'} side     Which side's shoulder/hip/wrist to read.
 * @param {number} bodyScalePx      The body-scale ruler (pixels) for this frame.
 * @param {object} [config]         Tuning (see DEFAULT_READY_CONFIG).
 * @returns {boolean} true only if the frame positively looks like a ready
 *                    push-up position; false otherwise (including "not sure").
 */
export function isReadyForArming(
  keypointsByName,
  side,
  bodyScalePx,
  config = DEFAULT_READY_CONFIG
) {
  // Without a usable ruler we cannot judge any body-relative cue -> NOT ready.
  if (!keypointsByName || typeof bodyScalePx !== 'number' || bodyScalePx <= 0) {
    return false;
  }

  const cfg = { ...DEFAULT_READY_CONFIG, ...config };

  const shoulder =
    side === 'right'
      ? keypointsByName.right_shoulder
      : keypointsByName.left_shoulder;

  // No shoulder anchor -> nothing to compare against -> NOT ready.
  if (!shoulder || typeof shoulder.y !== 'number') {
    return false;
  }

  // CUE LEVEL (strongest, side-on): if the chosen-side hip is confidently
  // visible, decide purely on the shoulder-to-hip VERTICAL gap. A small gap =
  // torso roughly horizontal = down in a plank = ready. A large gap = shoulder
  // stacked above hip = standing = not ready.
  const hip =
    side === 'right' ? keypointsByName.right_hip : keypointsByName.left_hip;
  const hipSeen =
    hip &&
    typeof hip.y === 'number' &&
    typeof hip.score === 'number' &&
    hip.score >= cfg.jointMinConfidence;
  if (hipSeen) {
    const verticalGap = Math.abs(shoulder.y - hip.y) / bodyScalePx;
    return verticalGap <= cfg.maxShoulderHipVerticalFraction;
  }

  // CUE PLANTED: both wrists confidently visible and planted at/below the
  // shoulder line -> hands on the floor -> ready.
  const leftWrist = keypointsByName.left_wrist;
  const rightWrist = keypointsByName.right_wrist;
  const leftWristSeen =
    leftWrist &&
    typeof leftWrist.y === 'number' &&
    typeof leftWrist.score === 'number' &&
    leftWrist.score >= cfg.jointMinConfidence;
  const rightWristSeen =
    rightWrist &&
    typeof rightWrist.y === 'number' &&
    typeof rightWrist.score === 'number' &&
    rightWrist.score >= cfg.jointMinConfidence;
  if (leftWristSeen && rightWristSeen) {
    const leftPlanted =
      (leftWrist.y - shoulder.y) / bodyScalePx >= cfg.wristPlantedMargin;
    const rightPlanted =
      (rightWrist.y - shoulder.y) / bodyScalePx >= cfg.wristPlantedMargin;
    return leftPlanted && rightPlanted;
  }

  // CUE HEAD (fallback): the head must be CLEARLY near shoulder height. The nose
  // sits at most maxNoseAboveFraction of a body-scale ABOVE the shoulder (y
  // grows downward, so "above" = smaller y). A big gap means standing tall.
  const nose = keypointsByName.nose;
  if (nose && typeof nose.y === 'number') {
    const noseAboveFraction = (shoulder.y - nose.y) / bodyScalePx;
    return noseAboveFraction <= cfg.maxNoseAboveFraction;
  }

  // Nothing let us positively confirm a down position -> fail toward NOT ready.
  return false;
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
