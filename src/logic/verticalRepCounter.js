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
//     - After that, while we are in the 'up' phase, we EASE the baseline toward
//       the most "up" (smallest y) resting position we see: if currentY is
//       higher up than the baseline (smaller y) we snap the baseline to it, and
//       if it is a little lower we drift the baseline gently toward it. This
//       lets the resting point re-anchor over time without a brief dip
//       dragging it down.
//     - Once a rep completes we go back to 'up', so the baseline naturally
//       re-anchors to the new resting position on the following up frames.
//
// ANTI-CHEAT:
//   update(currentY, bodyScalePx, confident) takes a `confident` flag. If the
//   needed upper-body keypoints are not clearly visible (confident === false),
//   we DO NOT advance the state machine at all — exactly like repCounter.js.

// How gently the baseline drifts DOWN toward a slightly-lower resting position
// while in the 'up' phase (0 = never drift, 1 = snap instantly). A small value
// keeps the resting point steady while still letting it re-anchor over time.
const BASELINE_EASE = 0.1;

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
        // While resting, keep the baseline anchored to the most "up" position.
        if (currentY < baseline) {
          // Higher up than before (smaller y): snap the resting point up.
          baseline = currentY;
        } else {
          // A little lower: drift gently toward it so the baseline can
          // re-anchor over time without a brief dip dragging it down.
          baseline += (currentY - baseline) * BASELINE_EASE;
        }

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
