// positionGate.js
// -----------------------------------------------------------------------------
// A "get into position first" countdown gate. Before UP N AT EM starts counting
// reps for a step, we want to be SURE the user is actually in the right position
// (down in a push-up, lying down for a sit-up, etc.). This little helper is the
// pure logic that runs a visible 5-second countdown and decides when to flip
// from "arming" (still getting ready) to "armed" (start counting).
//
// HOW THE COUNTDOWN WORKS (PAUSE / RESUME):
//   Think of it like a stopwatch that only runs while you are in position:
//     - While the body IS in position, we ADD the time since the last frame to
//       an accumulator (the countdown ticks down 5…4…3…2…1).
//     - While the body is OUT of position, we FREEZE the accumulator. We do NOT
//       add time and we do NOT reset it — the countdown simply PAUSES.
//     - When the body comes back into position, we RESUME from exactly where we
//       paused. It does not start over at 5.
//   The step ARMS the moment the accumulator reaches the required hold time
//   (5 seconds by default). This rewards actually holding the position without
//   punishing a brief wobble: a single-frame flicker through the position barely
//   adds any time, and leaving position just pauses the progress you earned.
//
// PURE + TIME-INJECTABLE:
//   This module has no React, no DOM, and it never calls Date.now() itself.
//   Instead YOU pass the current time (in milliseconds) into update(). That
//   makes it completely deterministic to unit test: the test can feed in made-up
//   timestamps and check exactly when it arms. In the real app the caller passes
//   a real timestamp (e.g. performance.now()) once per animation frame.
//
//   Because the caller's frames are irregular, we measure how much time passed
//   since the LAST frame (nowMs - lastFrameNowMs) and only count that slice if
//   the user was in position. We guard the very first frame (no previous
//   timestamp yet, so it contributes 0) and clamp any weird deltas (a negative
//   jump or a huge hiccup, e.g. the tab was backgrounded) to 0 so a glitch can
//   never jump the countdown forward.

// How long (in milliseconds) the user must spend IN POSITION, in total, before
// the step arms. Exported so the UI and tests can share the same number.
export const DEFAULT_HOLD_MS = 5000;

// Any per-frame time slice longer than this is treated as a hiccup (e.g. the
// tab was in the background) and clamped to 0, so it cannot jump the countdown.
const MAX_FRAME_DELTA_MS = 1000;

/**
 * Create a position gate (a pause/resume countdown).
 *
 * @param {object} [options]
 * @param {number} [options.holdMs=DEFAULT_HOLD_MS]  Total in-position time (ms)
 *                                                    required before arming.
 *                                                    Defaults to 5 seconds.
 * @returns {{
 *   update: (conditionMet:boolean, nowMs:number) => {
 *     armed:boolean, heldMs:number, remainingMs:number, remainingSeconds:number
 *   },
 *   reset: () => void,
 *   get armed: () => boolean
 * }}
 */
export function createPositionGate({ holdMs = DEFAULT_HOLD_MS } = {}) {
  // Guard against a nonsense hold time; never negative.
  const requiredHoldMs = Math.max(0, holdMs);

  // Private state:
  //   armed          -> have we finished the countdown and started counting?
  //   accumulatedMs  -> total time spent IN position so far (the countdown
  //                     progress). This is what we freeze on pause and resume.
  //   lastFrameNowMs -> timestamp of the previous update() call, so we can work
  //                     out how much time passed this frame. null until the
  //                     first frame.
  let armed = false;
  let accumulatedMs = 0;
  let lastFrameNowMs = null;

  // Build the little result object from the current accumulator. Kept in one
  // place so every return is consistent.
  function result() {
    const heldMs = Math.min(accumulatedMs, requiredHoldMs);
    const remainingMs = Math.max(0, requiredHoldMs - heldMs);
    return {
      armed,
      heldMs,
      remainingMs,
      // Whole seconds left for the big on-screen number (5, 4, 3, 2, 1, 0).
      // Math.ceil means "4.2s left" still shows 5 ticking, reaching 0 only when
      // the time is truly up.
      remainingSeconds: Math.ceil(remainingMs / 1000),
    };
  }

  return {
    /**
     * Feed one frame into the gate.
     *
     * @param {boolean} conditionMet  Is the body in the expected position RIGHT
     *                                NOW (e.g. evaluateOrientation returned true)?
     * @param {number} nowMs          The current time in milliseconds (a frame
     *                                timestamp). Should be non-decreasing.
     * @returns {{armed:boolean, heldMs:number, remainingMs:number, remainingSeconds:number}}
     */
    update(conditionMet, nowMs) {
      // Once armed, we stay armed for the rest of the step. Briefly leaving the
      // position mid-set must NOT disarm us (the per-rep orientation gate already
      // rejects bad reps). We only ever re-arm by calling reset() on a new step.
      if (armed) {
        // Keep lastFrameNowMs current so timing stays sane if reset() is called
        // later, but there is no more countdown to run.
        lastFrameNowMs = nowMs;
        return result();
      }

      // Work out how much time passed since the previous frame.
      let deltaMs = 0;
      if (lastFrameNowMs !== null) {
        deltaMs = nowMs - lastFrameNowMs;
        // Clamp anything weird: a negative jump (clock went backwards) or a huge
        // gap (a hiccup / backgrounded tab) is ignored so it cannot jump the
        // countdown. The very first frame has no previous timestamp, so it
        // naturally contributes 0.
        if (deltaMs < 0 || deltaMs > MAX_FRAME_DELTA_MS) {
          deltaMs = 0;
        }
      }
      lastFrameNowMs = nowMs;

      if (conditionMet) {
        // In position: the countdown runs. Add this frame's slice of time.
        accumulatedMs += deltaMs;
        if (accumulatedMs >= requiredHoldMs) {
          accumulatedMs = requiredHoldMs; // don't overshoot
          armed = true;
        }
      }
      // If NOT in position we simply do nothing: the accumulator freezes exactly
      // where it was (pause), ready to resume on the next in-position frame.

      return result();
    },

    /** Current armed state. */
    get armed() {
      return armed;
    },

    /** Forget everything and go back to the start of the countdown (new step). */
    reset() {
      armed = false;
      accumulatedMs = 0;
      lastFrameNowMs = null;
    },
  };
}
