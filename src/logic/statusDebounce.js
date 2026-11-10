// statusDebounce.js
// -----------------------------------------------------------------------------
// A tiny "calm down the status light" helper for the heads-up display.
//
// THE PROBLEM IT SOLVES (the blinking "Pose not detected" warning):
//   The pose detector runs fresh every single frame, and its confidence wobbles
//   a little from frame to frame. Near the trust threshold that makes the
//   "detected / not detected" answer flip true/false many times a second. If we
//   show the warning the instant a single bad frame says "not detected", the
//   warning blinks on and off and the HUD looks jittery.
//
// WHAT THIS DOES:
//   It debounces ONLY the value we SHOW in the warning. It is asymmetric on
//   purpose:
//     - Flip to "detected" INSTANTLY. The moment the camera sees you clearly we
//       hide the warning right away (good news should be immediate).
//     - Flip to "not detected" SLOWLY. We only show the warning after the
//       detector has been continuously unsure for a short grace period
//       (default ~500ms). A one-off bad frame is ignored, so the warning stops
//       blinking.
//
// IMPORTANT — DISPLAY ONLY:
//   This smoothing is for the WARNING TEXT in the HUD, nothing else. Rep
//   counting, the anti-cheat gate, and the get-into-position arming gate all
//   keep using the RAW per-frame confidence exactly as before. We never want a
//   delayed display value to change what actually counts.
//
// PURE + TIME-INJECTABLE:
//   No React, no DOM, and it never calls Date.now()/performance.now() itself.
//   YOU pass the current time (ms) into update(), the same pattern used by
//   positionGate.js. That makes it deterministic to unit test: feed in made-up
//   timestamps and check exactly when the display flips.

// How long (ms) the detector must be CONTINUOUSLY unsure before we actually
// show the "not detected" warning. Exported so the app and tests share it.
export const DEFAULT_GRACE_MS = 500;

/**
 * Create a status debouncer for the "pose detected" warning.
 *
 * @param {object} [options]
 * @param {number} [options.graceMs=DEFAULT_GRACE_MS]  How long the condition must
 *                                                      stay false before the
 *                                                      displayed value flips to
 *                                                      "not detected".
 * @returns {{
 *   update: (detected:boolean, nowMs:number) => boolean,
 *   get displayed: () => boolean,
 *   reset: () => void
 * }}
 */
export function createStatusDebouncer({ graceMs = DEFAULT_GRACE_MS } = {}) {
  // Guard against a nonsense grace time; never negative.
  const requiredGraceMs = Math.max(0, graceMs);

  // Private state:
  //   displayed      -> the value we currently SHOW (start optimistic: detected,
  //                     so we do not flash a warning before the first good frame).
  //   falseSinceMs   -> when the raw value first went false in the current run
  //                     of bad frames, or null if the raw value is currently
  //                     true. Used to measure how long we have been unsure.
  let displayed = true;
  let falseSinceMs = null;

  return {
    /**
     * Feed one frame of the RAW detected/not-detected reading.
     *
     * @param {boolean} detected  Is the pose confidently detected RIGHT NOW
     *                            (the raw per-frame value)?
     * @param {number} nowMs      The current time in milliseconds (a frame
     *                            timestamp). Should be non-decreasing.
     * @returns {boolean} the value the HUD should display (debounced).
     */
    update(detected, nowMs) {
      if (detected) {
        // Good news is immediate: show "detected" right away and forget any
        // pending flip to the warning.
        displayed = true;
        falseSinceMs = null;
        return displayed;
      }

      // Raw value is false. Remember when this run of bad frames started.
      if (falseSinceMs === null) {
        falseSinceMs = nowMs;
      }

      // Only flip the display to "not detected" once we have been continuously
      // unsure for the whole grace period. (>= so a graceMs of 0 flips at once.)
      if (nowMs - falseSinceMs >= requiredGraceMs) {
        displayed = false;
      }

      return displayed;
    },

    /** The value currently shown (debounced). */
    get displayed() {
      return displayed;
    },

    /** Reset to the optimistic start (e.g. when a new step begins). */
    reset() {
      displayed = true;
      falseSinceMs = null;
    },
  };
}
