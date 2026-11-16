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
// WHAT THE NUMBERS ARE NOW: push-ups are counted from the 3D ELBOW JOINT ANGLE
// (shoulder -> elbow -> wrist, in degrees) run through an up/down state machine.
// So each sample records the SMOOTHED elbow angle this frame next to the
// down/up ANGLE thresholds it is aiming for: bend the elbow PAST downAngle
// (angle <= downAngle) to reach the bottom, then straighten PAST upAngle
// (angle >= upAngle) to complete the rep. If a real rep never bends the angle
// past downAngle, the copied report shows it (summary.downAngleReached === false
// and a minAngle that never dropped to downAngle), which tells us the threshold
// is set too shallow for how this camera sees the user.
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
 * @param {number} [decimals=1]
 * @returns {number|null}
 */
function round(n, decimals = 1) {
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
 *      for the set (exercise, difficulty, target reps, the downAngle / upAngle
 *      thresholds the detector is aiming for). `atMs` is the injected start
 *      timestamp.
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
  let minAngle = null; // smallest (deepest bend) elbow angle seen
  let maxAngle = null; // largest (straightest) elbow angle seen
  let lastAngle = null;
  // Did the smoothed elbow angle ever bend PAST the "down" threshold? (i.e.
  // angle <= downAngle). If this is false after a real set, downAngle is too
  // shallow (set too small) for how deep this camera reads the user's bend.
  let downAngleReached = false;
  let repsCounted = 0;

  function resetStats() {
    sampleCount = 0;
    minAngle = null;
    maxAngle = null;
    lastAngle = null;
    downAngleReached = false;
    repsCounted = 0;
  }

  return {
    /**
     * Begin recording for a freshly-armed set. Clears any previous recording.
     * @param {object} startMeta  Fixed context: { exercise, difficulty,
     *                             targetReps, downAngle, upAngle, side }.
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
     *   angle, rawAngle, downAngle, upAngle, confident, armed, phase,
     *   postureOk, reps }.
     * @param {number} atMs      Injected timestamp (ms).
     */
    sample(snapshot, atMs) {
      if (!active || !snapshot) {
        return;
      }
      sampleCount += 1;

      const angle =
        typeof snapshot.angle === 'number' && Number.isFinite(snapshot.angle)
          ? snapshot.angle
          : null;
      if (angle !== null) {
        lastAngle = angle;
        if (minAngle === null || angle < minAngle) {
          minAngle = angle;
        }
        if (maxAngle === null || angle > maxAngle) {
          maxAngle = angle;
        }
        // Reaching "down" means the elbow bent PAST (at or below) downAngle.
        if (
          typeof snapshot.downAngle === 'number' &&
          angle <= snapshot.downAngle
        ) {
          downAngleReached = true;
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
        angle: round(angle),
        rawAngle: round(snapshot.rawAngle),
        downAngle: round(snapshot.downAngle),
        upAngle: round(snapshot.upAngle),
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
          // The deepest bend (smallest angle) and straightest (largest angle)
          // reached this set, so a copied report shows the full range of motion
          // the camera actually saw.
          minAngle: round(minAngle),
          maxAngle: round(maxAngle),
          lastAngle: round(lastAngle),
          // Did the smoothed elbow angle ever bend PAST the "down" threshold?
          // If this is false after a real set, downAngle is set too shallow.
          downAngleReached,
          repsCounted,
        },
        samples,
      };
    },
  };
}
