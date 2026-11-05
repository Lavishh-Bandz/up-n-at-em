// positionGate.js
// -----------------------------------------------------------------------------
// A tiny "get into position first" gate. Before UP N AT EM starts counting reps
// for a step, we want to be SURE the user is actually in the right position
// (down in a push-up, lying down for a sit-up, etc.). This little helper is the
// pure logic that decides when we are confident enough to flip from
// "arming" (still getting ready) to "armed" (start counting).
//
// WHY A HOLD / DEBOUNCE?
//   The pose detector wobbles frame to frame, and a user might just pass THROUGH
//   the right position for a single frame on their way somewhere else. If we
//   armed the moment the position looked right for one frame, that flicker would
//   falsely say "Ready!". So instead the position has to be held CONTINUOUSLY
//   for a short while (about 1 second) before we arm. If the position drops even
//   for one frame before the hold finishes, the running timer resets to zero and
//   the user has to hold it again.
//
// PURE + TIME-INJECTABLE:
//   This module has no React, no DOM, and it never calls Date.now() itself.
//   Instead YOU pass the current time (in milliseconds) into update(). That
//   makes it completely deterministic to unit test: the test can feed in made-up
//   timestamps and check exactly when it arms. In the real app the caller passes
//   a real timestamp (e.g. performance.now()) once per animation frame.

/**
 * Create a position gate.
 *
 * @param {object} [options]
 * @param {number} [options.holdMs=1000]  How long (in milliseconds) the position
 *                                         must be held continuously before the
 *                                         gate arms. Defaults to ~1 second.
 * @returns {{
 *   update: (conditionMet:boolean, nowMs:number) => { armed:boolean, heldMs:number },
 *   reset: () => void,
 *   get armed: () => boolean
 * }}
 */
export function createPositionGate({ holdMs = 1000 } = {}) {
  // Guard against a nonsense hold time; never negative.
  const requiredHoldMs = Math.max(0, holdMs);

  // Private state:
  //   armed       -> have we finished the hold and started counting?
  //   holdStartMs -> the timestamp when the CURRENT run of "in position" began,
  //                  or null if we are not currently in position.
  let armed = false;
  let holdStartMs = null;

  return {
    /**
     * Feed one frame into the gate.
     *
     * @param {boolean} conditionMet  Is the body in the expected position RIGHT
     *                                NOW (e.g. evaluateOrientation returned true)?
     * @param {number} nowMs          The current time in milliseconds. Must be a
     *                                non-decreasing clock (frame timestamps).
     * @returns {{armed:boolean, heldMs:number}} the armed flag plus how long the
     *          current hold has lasted so far (handy for a progress bar later).
     */
    update(conditionMet, nowMs) {
      // Once armed, we stay armed for the rest of the step. Briefly leaving the
      // position mid-set must NOT disarm us (the per-rep orientation gate already
      // rejects bad reps). We only ever re-arm by calling reset() on a new step.
      if (armed) {
        return { armed: true, heldMs: requiredHoldMs };
      }

      if (!conditionMet) {
        // Lost the position before the hold finished: start over from zero.
        holdStartMs = null;
        return { armed: false, heldMs: 0 };
      }

      // We are in position. If this is the first frame of a fresh run, remember
      // when it started.
      if (holdStartMs === null) {
        holdStartMs = nowMs;
      }

      const heldMs = nowMs - holdStartMs;
      if (heldMs >= requiredHoldMs) {
        armed = true;
        return { armed: true, heldMs: requiredHoldMs };
      }

      return { armed: false, heldMs };
    },

    /** Current armed state. */
    get armed() {
      return armed;
    },

    /** Forget everything and go back to "arming" (used at the start of a step). */
    reset() {
      armed = false;
      holdStartMs = null;
    },
  };
}
