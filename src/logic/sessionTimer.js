// sessionTimer.js
// -----------------------------------------------------------------------------
// A tiny STOPWATCH for one whole workout session. It answers a single question:
// "how long did the exercises take, from the moment counting actually started
// to the moment the workout was finished?"
//
// WHEN DOES IT START AND STOP?
//   - START: the moment the FIRST step ARMS (the "GO!" moment where we begin
//     counting reps). In UP N AT EM a workout can have several steps (e.g.
//     push-ups then sit-ups). We only want to start the clock ONCE, on the very
//     first arming, so the single measured span covers the entire workout.
//   - STOP: the moment the whole workout is complete (every step's reps done).
//
// v1 SCOPE (IMPORTANT): this is MEASURE + DISPLAY + STORE only. The number this
//   produces is shown on the success screen and saved into history so we can
//   later study real timing data. It must NOT (yet) feed into any decision about
//   whether the daily target holds or increases — that smart, time/effort-based
//   auto-progression is deliberately deferred to v2.
//
// PURE + TIME-INJECTED (mirrors positionGate.js):
//   This module has NO React, NO DOM, and it NEVER reads the real clock itself
//   (no Date.now(), no performance.now(), no new Date()). Instead the CALLER
//   passes the current time in milliseconds (nowMs) into start(), stop() and
//   elapsedMsAt(). That makes every behaviour deterministic and trivial to unit
//   test: a test feeds in made-up timestamps and checks the exact elapsed value.
//   In the real app the caller passes a real timestamp (e.g. performance.now()).
//
// The timing idiom is the same one pushupDiagnostics.js uses:
//   durationMs = finishedAtMs - startedAtMs.

/**
 * Create a session stopwatch.
 *
 * The returned object is a small state machine with three phases:
 *   1. IDLE    - nothing started yet (startedAtMs === null).
 *   2. RUNNING - start() has been called, stop() has not (the clock is ticking).
 *   3. STOPPED - stop() has been called; the elapsed value is now FROZEN.
 *
 * @returns {{
 *   start: (nowMs:number) => void,
 *   stop: (nowMs:number) => void,
 *   reset: () => void,
 *   get elapsedMs: number|null,
 *   get running: boolean,
 *   elapsedMsAt: (nowMs:number) => number|null
 * }}
 */
export function createSessionTimer() {
  // Private state. Both start as null meaning "has not happened yet".
  //   startedAtMs  -> the injected timestamp when the first step armed.
  //   finishedAtMs -> the injected timestamp when the workout completed.
  let startedAtMs = null;
  let finishedAtMs = null;

  return {
    /**
     * Start the clock. IDEMPOTENT: the FIRST call wins and every later call is
     * ignored. This is deliberate — in a multi-step workout each later step also
     * "arms", but we must not restart the stopwatch, otherwise the span would
     * only cover the last step instead of the whole session.
     *
     * @param {number} nowMs  The current time in milliseconds (injected).
     */
    start(nowMs) {
      // Only record the start once, and only if we were handed a real number.
      if (startedAtMs === null && typeof nowMs === 'number') {
        startedAtMs = nowMs;
      }
    },

    /**
     * Stop the clock and FREEZE the elapsed value. Records the finish time once.
     * Two guards:
     *   - a stop() BEFORE any start() is a no-op (you cannot finish a race that
     *     never began), and
     *   - a REPEAT stop() is ignored (the first finish time is the real one), so
     *     elapsedMs never changes after the first stop.
     *
     * @param {number} nowMs  The current time in milliseconds (injected).
     */
    stop(nowMs) {
      if (
        startedAtMs !== null && // must have started
        finishedAtMs === null && // must not have already stopped
        typeof nowMs === 'number'
      ) {
        finishedAtMs = nowMs;
      }
    },

    /** Forget everything and go back to IDLE (e.g. starting a new session). */
    reset() {
      startedAtMs = null;
      finishedAtMs = null;
    },

    /**
     * The FINAL, frozen elapsed time of the session, in milliseconds.
     *
     * DOCUMENTED CHOICE for the not-yet-finished cases: this getter returns
     * `null` whenever we do not yet have a complete, final measurement — that is
     * both before start() (still IDLE) AND while the clock is still RUNNING
     * (started but not stopped). `null` means "no final time to show yet".
     * Callers that want a LIVE, ticking value while running should use
     * elapsedMsAt(nowMs) instead.
     *
     * Only once stop() has frozen the finish time does this return the real
     * duration: finishedAtMs - startedAtMs.
     *
     * @returns {number|null}
     */
    get elapsedMs() {
      if (startedAtMs !== null && finishedAtMs !== null) {
        return finishedAtMs - startedAtMs;
      }
      return null;
    },

    /**
     * Is the clock currently ticking? True only when we have started AND not yet
     * stopped. False while IDLE and false once STOPPED.
     *
     * @returns {boolean}
     */
    get running() {
      return startedAtMs !== null && finishedAtMs === null;
    },

    /**
     * Read the elapsed time AT a given moment. This is the handy one for a HUD
     * that wants to show a live, ticking clock during the workout:
     *   - While RUNNING, it returns the live duration so far: nowMs - startedAtMs.
     *   - Once STOPPED, it returns the FROZEN final duration (and ignores nowMs),
     *     so the number stops climbing the instant the workout completes.
     *   - Before start() (IDLE) it returns null, matching elapsedMs.
     *
     * @param {number} nowMs  The current time in milliseconds (injected).
     * @returns {number|null}
     */
    elapsedMsAt(nowMs) {
      if (startedAtMs === null) {
        return null; // nothing started yet
      }
      if (finishedAtMs !== null) {
        return finishedAtMs - startedAtMs; // frozen final value
      }
      if (typeof nowMs === 'number') {
        return nowMs - startedAtMs; // live, still ticking
      }
      return null;
    },
  };
}

/**
 * Turn a millisecond duration into a friendly 'm:ss' clock string for the UI.
 *
 * Examples (these are the exact cases the tests check):
 *       0  -> '0:00'
 *    5000  -> '0:05'
 *   83000  -> '1:23'
 *  605000  -> '10:05'
 *
 * The seconds part is always zero-padded to two digits; the minutes part is NOT
 * padded (so ten minutes reads '10:05', not '010:05'). Minutes can grow past 59
 * without rolling into hours — a 90-minute session would read '90:00' — which is
 * plenty for a workout clock.
 *
 * DOCUMENTED CHOICE for null/invalid input: we return '0:00'. The timer's
 * elapsedMs getter returns null before the session has a final time, and the
 * simplest, least-surprising thing to show on screen in that case is a clean
 * zeroed clock rather than a dash. Negative values (which should never happen
 * with non-decreasing timestamps) are also clamped to '0:00'.
 *
 * @param {number|null|undefined} ms  A duration in milliseconds.
 * @returns {string}  A 'm:ss' string, e.g. '1:23'.
 */
export function formatElapsed(ms) {
  // Guard: null, undefined, non-numbers, NaN and negatives all become 0:00.
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return '0:00';
  }

  // Whole seconds elapsed (we drop any leftover milliseconds — a workout clock
  // ticking by whole seconds is what a person expects to read).
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  // Pad the seconds to two digits so '5' shows as '05'. padStart does this for
  // us: '5' -> '05', while '23' stays '23'.
  const paddedSeconds = String(seconds).padStart(2, '0');
  return `${minutes}:${paddedSeconds}`;
}
