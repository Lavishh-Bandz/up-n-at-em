// pushupDiagnostics.js
// -----------------------------------------------------------------------------
// The user's "way to watch the video" WITHOUT a webcam in front of the agent.
//
// When a push-up set ARMS (the Begin / "GO!" moment) we start recording a small
// REPORT of the exact numbers the push-up detector used each (throttled) frame,
// side by side with the TARGET thresholds it is trying to reach. The user can
// read this back off the screen (or copy the JSON from the browser console) so
// we can tune the thresholds from REAL data instead of guessing.
//
// This module is PURE: no React, no DOM, no timers, no Date.now(). You feed it
// plain numbers (the detector's debug snapshot + a timestamp you inject), it
// stores them and computes running summary stats. That keeps it trivial to unit
// test and means it can never cause a frame-rate re-render by itself — the UI
// decides when to read the summary back out.
//
// IT DELIBERATELY DOES NOT: write to disk, hit the network, or keep an
// unbounded list. We cap the number of stored samples so a long set cannot grow
// the report without bound (the summary stats still cover every sample fed in).

// Hard cap on stored samples so the report stays small and copyable even on a
// long set. We keep the most recent MAX_SAMPLES; the summary stats below are
// updated on EVERY sample fed in, so min/max/count stay correct regardless.
const MAX_SAMPLES = 400;

/**
 * Round a number to a few decimals for a readable report, passing null through.
 * @param {number|null|undefined} n
 * @param {number} [decimals=3]
 * @returns {number|null}
 */
function round(n, decimals = 3) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/**
 * Create a pure push-up diagnostics recorder for ONE set.
 *
 * Lifecycle:
 *   1. start(meta, atMs) when the set ARMS. `meta` carries the fixed context
 *      for the set (exercise, difficulty, target reps, the downFraction /
 *      upFraction thresholds the detector is aiming for). `atMs` is the injected
 *      start timestamp.
 *   2. sample(snapshot, atMs) each throttled frame (or on a phase change) with
 *      the SAME numbers the detector used this frame. Only records while active.
 *   3. finish(reason, atMs) when the set completes or the user emergency-exits.
 *   4. report getter returns a plain, JSON-serializable object with the samples
 *      and summary stats, ready to show on screen and/or console.log as JSON.
 *
 * @returns {{
 *   start: (meta:object, atMs:number) => void,
 *   sample: (snapshot:object, atMs:number) => void,
 *   finish: (reason:string, atMs:number) => void,
 *   reset: () => void,
 *   get active: () => boolean,
 *   get report: () => object
 * }}
 */
export function createPushupDiagnostics() {
  let active = false;
  let meta = null;
  let startedAtMs = null;
  let finishedAtMs = null;
  let finishReason = null;
  let samples = [];

  // Running summary stats, updated on EVERY sample (not just the stored ones).
  let sampleCount = 0;
  let minExcursion = null;
  let maxExcursion = null;
  let lastExcursion = null;
  let downFractionReached = false; // did the smoothed excursion ever reach down?
  let repsCounted = 0;

  function resetStats() {
    sampleCount = 0;
    minExcursion = null;
    maxExcursion = null;
    lastExcursion = null;
    downFractionReached = false;
    repsCounted = 0;
  }

  return {
    /**
     * Begin recording for a freshly-armed set. Clears any previous recording.
     * @param {object} startMeta  Fixed context: { exercise, difficulty,
     *                             targetReps, downFraction, upFraction, side }.
     * @param {number} atMs       Injected start timestamp (ms).
     */
    start(startMeta, atMs) {
      active = true;
      meta = startMeta ? { ...startMeta } : {};
      startedAtMs = typeof atMs === 'number' ? atMs : null;
      finishedAtMs = null;
      finishReason = null;
      samples = [];
      resetStats();
    },

    /**
     * Record one throttled frame. Ignored unless the recorder is active.
     * @param {object} snapshot  The detector numbers this frame: {
     *   excursion, downFraction, upFraction, bodyScalePx, bodyScaleLocked,
     *   upperBodyY, confident, armed, phase, postureOk, reps }.
     * @param {number} atMs      Injected timestamp (ms).
     */
    sample(snapshot, atMs) {
      if (!active || !snapshot) {
        return;
      }
      sampleCount += 1;

      const excursion =
        typeof snapshot.excursion === 'number' ? snapshot.excursion : null;
      if (excursion !== null) {
        lastExcursion = excursion;
        if (minExcursion === null || excursion < minExcursion) {
          minExcursion = excursion;
        }
        if (maxExcursion === null || excursion > maxExcursion) {
          maxExcursion = excursion;
        }
        if (
          typeof snapshot.downFraction === 'number' &&
          excursion >= snapshot.downFraction
        ) {
          downFractionReached = true;
        }
      }
      if (typeof snapshot.reps === 'number') {
        repsCounted = snapshot.reps;
      }

      // Store the (rounded, readable) sample, capped to the most recent ones.
      samples.push({
        tMs:
          typeof atMs === 'number' && startedAtMs !== null
            ? Math.round(atMs - startedAtMs)
            : null,
        excursion: round(excursion),
        downFraction: round(snapshot.downFraction),
        upFraction: round(snapshot.upFraction),
        bodyScalePx:
          typeof snapshot.bodyScalePx === 'number'
            ? Math.round(snapshot.bodyScalePx)
            : null,
        bodyScaleLocked: !!snapshot.bodyScaleLocked,
        upperBodyY:
          typeof snapshot.upperBodyY === 'number'
            ? Math.round(snapshot.upperBodyY)
            : null,
        confident: !!snapshot.confident,
        armed: !!snapshot.armed,
        phase: snapshot.phase ?? null,
        postureOk: !!snapshot.postureOk,
        reps: typeof snapshot.reps === 'number' ? snapshot.reps : null,
      });
      if (samples.length > MAX_SAMPLES) {
        samples.shift();
      }
    },

    /**
     * Stop recording (set completed or emergency exit). Keeps the data so the
     * report can still be read/copied afterwards.
     * @param {string} reason  'completed' | 'emergency-exit' | string.
     * @param {number} atMs    Injected timestamp (ms).
     */
    finish(reason, atMs) {
      if (!active) {
        return;
      }
      active = false;
      finishReason = reason || 'finished';
      finishedAtMs = typeof atMs === 'number' ? atMs : null;
    },

    /** Clear everything (e.g. starting an entirely new session). */
    reset() {
      active = false;
      meta = null;
      startedAtMs = null;
      finishedAtMs = null;
      finishReason = null;
      samples = [];
      resetStats();
    },

    /** Whether a set is currently being recorded. */
    get active() {
      return active;
    },

    /**
     * A plain, JSON-serializable snapshot of the whole report: the fixed set
     * context, every (capped) sample, and the running summary stats. Safe to
     * console.log(JSON.stringify(...)) and to show in an on-screen text block.
     */
    get report() {
      return {
        meta: meta ? { ...meta } : null,
        startedAtMs,
        finishedAtMs,
        finishReason,
        durationMs:
          startedAtMs !== null && finishedAtMs !== null
            ? Math.round(finishedAtMs - startedAtMs)
            : null,
        summary: {
          sampleCount,
          minExcursion: round(minExcursion),
          maxExcursion: round(maxExcursion),
          lastExcursion: round(lastExcursion),
          // Did the detector's smoothed dip ever reach the "down" threshold?
          // If this is false after a real set, the downFraction is too deep.
          downFractionReached,
          repsCounted,
        },
        samples,
      };
    },
  };
}
