// verticalRepCounter.js
// -----------------------------------------------------------------------------
// A finite state machine (FSM) that counts push-ups from the VISIBLE UPPER BODY
// moving DOWN toward the floor and then back UP. It is the sibling of the
// angle-based createRepCounter in repCounter.js: same shape and voice, but it
// watches a VERTICAL POSITION signal instead of a joint angle, so it keeps
// working even when the legs/hips are out of frame (the whole point of
// Solution 1). The angle-based counter stays exactly as it is for sit-ups.
//
// It is a PURE module: you feed it one reading per frame and it returns the
// current phase. No timers, no DOM, no webcam, so it is easy to unit test with
// made-up numbers.
//
// REMEMBER THE COORDINATE SYSTEM (this is the key to reading the code below):
//   MoveNet keypoints are in PIXELS and y increases DOWNWARD. So when the upper
//   body moves DOWN toward the floor, the y value gets BIGGER; coming back UP
//   makes y SMALLER. Everything here is written in terms of that.
//
// WHAT WE ACTUALLY WATCH — THE "EXCURSION":
//   We keep an ADAPTIVE BASELINE, which is the resting / "up" y (the top of the
//   push-up). Each confident frame we compute how far the body has dipped DOWN
//   from that baseline, measured as a FRACTION of the body-scale (in pixels):
//
//     excursion = (currentY - baseline) / bodyScalePx
//
//   Because y grows downward, dipping toward the floor makes currentY bigger
//   than the baseline, so excursion is POSITIVE. Dividing by the body-scale
//   (roughly shoulder-width) makes the number body-relative: a real push-up is
//   the same fraction whether the user is near or far from the camera.
//
// WHY TWO THRESHOLDS (HYSTERESIS)?
//   Same reasoning as repCounter.js. If we toggled on a single line, tiny
//   jitter near that line would rack up fake reps. Instead we use two:
//     downFraction (bigger) -> you must dip PAST this to reach the 'down' phase
//     upFraction   (smaller)-> you must rise back PAST this to complete the rep
//   You must come back UP past a SMALLER excursion than the one that sent you
//   DOWN, so 0 < upFraction < downFraction. The gap between them is the
//   "hysteresis band" and small wobbles inside it change nothing.
//
// THE PHASES:
//   'up'   = resting / top of the push-up (near the baseline)
//   'down' = you have dipped toward the floor past downFraction
//
// A rep is counted on the transition down -> up (you went all the way down and
// then released all the way back up). One full cycle = one rep.
//
// THE ADAPTIVE BASELINE RULE (documented plainly):
//   The "top" of a push-up is not a fixed pixel row — it drifts as the user
//   shifts, and we do not know it up front. So:
//     - The FIRST confident 'up' frame simply sets the baseline to currentY.
//     - After that, while we are in the 'up' phase, the baseline only ever
//       re-anchors UPWARD: if currentY is higher up than the baseline (a
//       SMALLER y) we snap the baseline to it. If currentY is LOWER (a bigger
//       y, i.e. the body is starting to dip toward the floor) we LEAVE the
//       baseline where it is. We deliberately do NOT ease the baseline down.
//     - Once a rep completes we go back to 'up', so the baseline naturally
//       re-anchors to the new resting position on the following up frames.
//
//   WHY WE DON'T EASE THE BASELINE DOWNWARD (this matters a lot):
//     An earlier version eased the baseline gently DOWN toward a lower reading
//     while still in the 'up' phase. That sounds harmless, but it meant the
//     baseline chased the shoulder DOWN during a descent, so the excursion the
//     FSM measures could never keep up with a SLOW or heavily-smoothed dip. The
//     result was the exact failure this redesign exists to prevent: a genuine,
//     deep-enough push-up performed gently/smoothly would count ZERO reps while
//     the same dip done as one sharp jump counted one. Rep ENTRY would depend
//     on how FAST you moved instead of how FAR you dipped.
//     By re-anchoring only upward, the baseline still follows a real new
//     RESTING position (you can only rest HIGHER-up, which is a smaller y, and
//     it re-anchors again the moment a rep completes), but it never drifts down
//     into a descent — so how far you dip is all that decides a rep. A standing
//     bob is still rejected because a small nod stays a tiny fraction of
//     body-scale and never reaches downFraction.
//
// ANTI-CHEAT:
//   update(currentY, bodyScalePx, confident) takes a `confident` flag. If the
//   needed upper-body keypoints are not clearly visible (confident === false),
//   we DO NOT advance the state machine at all — exactly like repCounter.js.

/**
 * Create an upper-body vertical-movement rep counter.
 *
 * @param {object} options
 * @param {number} options.downFraction   Dip PAST this (excursion >= downFraction)
 *                                         to enter the 'down' phase. The BIGGER
 *                                         of the pair (a deeper dip).
 * @param {number} options.upFraction      Rise back PAST this (excursion <= upFraction)
 *                                         while 'down' to complete a rep. The
 *                                         SMALLER of the pair.
 * @param {number} [options.minConfidence] Kept for callers that want to remember
 *                                         the threshold alongside the counter.
 *                                         The FSM itself trusts the `confident`
 *                                         flag passed to update().
 * @returns {{
 *   update: (currentY:number, bodyScalePx:number, confident:boolean) => ('up'|'down'),
 *   reset: () => void,
 *   get reps: () => number,
 *   get phase: () => ('up'|'down')
 * }}
 */
export function createVerticalRepCounter({
  downFraction,
  upFraction,
  minConfidence = 0.3,
} = {}) {
  // Guard against a misconfiguration that would break the hysteresis idea.
  // We must come back UP past a SMALLER excursion than the one that sent us
  // DOWN, and both must be positive dips below the resting baseline.
  if (!(upFraction > 0 && upFraction < downFraction)) {
    throw new Error(
      `verticalRepCounter requires 0 < upFraction < downFraction ` +
        `(got upFraction=${upFraction}, downFraction=${downFraction})`
    );
  }

  // Private state. Everyone starts in the 'up' (resting) position with 0 reps
  // and no baseline yet (we learn it from the first confident frame).
  let phase = 'up';
  let reps = 0;
  let baseline = null;

  return {
    // Expose the config in case the UI wants to show it. Not used by the FSM.
    minConfidence,

    /**
     * Feed one frame into the machine.
     *
     * @param {number} currentY       The representative upper-body y (pixels).
     * @param {number} bodyScalePx    The body-scale ruler (pixels) for this frame.
     * @param {boolean} confident     Whether the needed joints were clearly visible.
     * @returns {'up'|'down'} the phase after processing this reading.
     */
    update(currentY, bodyScalePx, confident) {
      // ANTI-CHEAT GATE: ignore readings we cannot trust. The phase, rep count
      // and baseline are left exactly as they were.
      if (!confident) {
        return phase;
      }

      // Not-countable frames: without a usable ruler or position we cannot
      // compute an excursion, so leave the state unchanged.
      if (
        typeof currentY !== 'number' ||
        typeof bodyScalePx !== 'number' ||
        bodyScalePx <= 0
      ) {
        return phase;
      }

      // Learn the baseline from the very first usable frame.
      if (baseline === null) {
        baseline = currentY;
        return phase; // excursion is 0 on this frame; nothing to decide yet
      }

      // How far DOWN from the resting baseline are we, as a fraction of body
      // size? Positive = dipped toward the floor (because y grows downward).
      const excursion = (currentY - baseline) / bodyScalePx;

      if (phase === 'up') {
        // While resting, keep the baseline anchored to the most "up" position,
        // but ONLY ever re-anchor UPWARD (toward a smaller y).
        if (currentY < baseline) {
          // Higher up than before (smaller y): snap the resting point up.
          baseline = currentY;
        }
        // If currentY is LOWER (bigger y) we leave the baseline alone. We do
        // NOT ease it down: easing down would chase the shoulder during a
        // descent and make a slow/smooth real dip count zero (see the big
        // comment at the top). Now rep entry depends on how FAR you dip, not
        // how fast.

        // Dipping past downFraction starts the rep.
        if (excursion >= downFraction) {
          phase = 'down';
        }
      } else {
        // phase === 'down': waiting for the body to come back UP.
        // Rising back so the excursion shrinks past upFraction completes a rep.
        if (excursion <= upFraction) {
          phase = 'up';
          reps += 1;
          // Re-anchor the resting point to where we came back up to.
          baseline = currentY;
        }
      }

      return phase;
    },

    /** Reset back to the starting state (0 reps, 'up' phase, no baseline). */
    reset() {
      phase = 'up';
      reps = 0;
      baseline = null;
    },

    /** Current number of completed reps. */
    get reps() {
      return reps;
    },

    /** Current phase: 'up' or 'down'. */
    get phase() {
      return phase;
    },
  };
}
