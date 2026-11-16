import { describe, it, expect } from 'vitest';
import {
  measureCombinedDownSignal,
  measureDepthScale,
  measureUpperBodyY,
  measureUpperBodyDepth,
  isPushupPosture,
  createSignalReferenceTracker,
  createBodyScaleTracker,
} from '../upperBodySignal.js';
import { createVerticalRepCounter } from '../verticalRepCounter.js';

// -----------------------------------------------------------------------------
// DEPTH-AWARE PUSH-UP SIGNAL — the machine-checkable proof of "any viewpoint".
// -----------------------------------------------------------------------------
// This file proves the core claim of the BlazePose/depth upgrade: a push-up now
// counts from the FRONT (where the body moves toward/away from the camera, a
// change in DEPTH z) just like it always did from the SIDE (where the body
// moves down/up the screen, a change in y) — while a STANDING / walking person
// still counts ZERO.
//
// It wires together the REAL pieces the live app uses, in the same order
// WorkoutSession.handlePose does:
//   1. lock the PIXEL ruler (bodyScalePx) + the METER depth ruler (depthScaleM)
//      + the top-of-push-up REST references (restY/restZ) ONCE during arming,
//   2. each rep frame, build the combined signal via measureCombinedDownSignal,
//   3. feed that signal to createVerticalRepCounter with scale = 1 (the signal
//      is already body-relative) and the posture guard as postureOk.
//
// UNITS / CONVENTIONS (documented so every synthetic number is readable):
//   * SCALE = 100 px is the locked PIXEL shoulder-width ruler, so a y DIP of
//     N px equals N/100 body-widths (same trick as upperBodySignal.test.js).
//   * DEPTH_SCALE = 0.4 m is the locked METER shoulder-width ruler, so a z DIP
//     of M meters equals M/0.4 body-widths.
//   * Counter thresholds downFraction 0.2 / upFraction 0.1 keep the numbers
//     easy (same pair as verticalRepCounter.test.js). A dip must reach 0.2 of a
//     body-width to go 'down' and shrink back under 0.1 to complete a rep.
//   * Depth z sign (verified for this engine): z gets SMALLER / more NEGATIVE
//     as the upper body moves CLOSER to the camera. So lowering into a
//     front-facing push-up DECREASES z, and measureCombinedDownSignal NEGATES
//     the z change so that reads as a POSITIVE "down-ness" dip.

const SCALE = 100; // locked pixel body-scale ruler (shoulder width in px)
const DEPTH_SCALE = 0.4; // locked meter depth ruler (3D shoulder width in m)

// Shared counter thresholds (match verticalRepCounter.test.js for readability).
const makeCounter = () =>
  createVerticalRepCounter({ downFraction: 0.2, upFraction: 0.1 });

// -----------------------------------------------------------------------------
// Synthetic-frame builders.
// -----------------------------------------------------------------------------
// A single 2D keypoint (pixels; score high enough to be trusted).
const kp = (x, y, score = 0.9) => ({ x, y, score });

/**
 * Build a full keypoint map for one frame carrying BOTH 2D pixels and the 3D
 * fields the depth helpers read. We place the two shoulders DEPTH_SCALE (0.4 m)
 * apart in x3d so measureDepthScale returns exactly 0.4, and we let the caller
 * dial the upper-body screen-y (shoulderY) and depth-z (shoulderZ) per frame.
 *
 * The nose rides a little above and shares the same depth so the averaged
 * head+shoulder signal tracks the shoulder exactly (keeps the arithmetic
 * obvious). `noseWorldAbove` controls how far ABOVE the shoulders the nose sits
 * in the REAL WORLD (y3d, meters) — small for a plank, large for standing — so
 * we can drive the viewpoint-robust posture guard directly.
 *
 * @param {number} shoulderY     upper-body screen-y in PIXELS (y grows downward)
 * @param {number} shoulderZ     upper-body depth in METERS (smaller = closer)
 * @param {number} noseWorldAbove  meters the nose sits above the shoulders in 3D
 * @param {object} [extra]       optional field overrides (e.g. wrists)
 */
function frame(shoulderY, shoulderZ, noseWorldAbove = 0.1, extra = {}) {
  // Shoulder y3d is arbitrary (meters); we only care about the nose-vs-shoulder
  // GAP for the posture guard, so pin the shoulder at y3d = 0 and lift the nose
  // by -noseWorldAbove (negative y3d = higher up, since y grows downward).
  const shoulderY3d = 0;
  const noseY3d = shoulderY3d - noseWorldAbove;
  return {
    // Both shoulders 0.4 m apart in x3d -> measureDepthScale === 0.4.
    left_shoulder: {
      ...kp(100, shoulderY),
      z: shoulderZ,
      x3d: -0.2,
      y3d: shoulderY3d,
      z3d: shoulderZ,
    },
    right_shoulder: {
      ...kp(160, shoulderY),
      z: shoulderZ,
      x3d: 0.2,
      y3d: shoulderY3d,
      z3d: shoulderZ,
    },
    // Nose shares the shoulders' depth; only its height (screen-y + y3d) moves.
    nose: {
      ...kp(130, shoulderY - 10),
      z: shoulderZ,
      x3d: 0,
      y3d: noseY3d,
      z3d: shoulderZ,
    },
    ...extra,
  };
}

describe('depth rulers used to normalize the combined signal', () => {
  it('measureDepthScale reads the 3D shoulder width in meters', () => {
    // Shoulders are 0.4 m apart in x3d (and equal y3d/z3d), so the width is 0.4.
    const scale = measureDepthScale(frame(200, 0));
    expect(scale).toBeCloseTo(DEPTH_SCALE, 5);
  });

  it('measureUpperBodyDepth averages the shoulder and nose z (meters)', () => {
    // Here shoulder and nose share z = -0.05, so the average is -0.05.
    const z = measureUpperBodyDepth(frame(200, -0.05), 'left');
    expect(z).toBeCloseTo(-0.05, 5);
  });
});

describe('FRONT-FACING push-up (depth drives the rep)', () => {
  it('counts ONE rep when z dips toward the camera while screen-y barely moves', () => {
    const counter = makeCounter();

    // --- ARMING: hold the top of the push-up and LOCK the rulers + rest refs,
    // exactly as WorkoutSession does at the isArmed && !wasArmed transition. ---
    const depthRuler = createBodyScaleTracker();
    const signalRefs = createSignalReferenceTracker();
    // Top rest: shoulder at y=200 px, depth z = 0.00 m (a comfortable distance).
    // We push the SAME measured values WorkoutSession does: measureUpperBodyY
    // (shoulder averaged with the nose) and measureUpperBodyDepth, so the locked
    // rest lines up exactly with what measureCombinedDownSignal reads each rep
    // frame. (The nose rides 10 px above the shoulder, so restY ends up at 195,
    // not 200 — handled for us because we lock the measured value.)
    const topFrame = frame(200, 0.0);
    for (let i = 0; i < 5; i += 1) {
      depthRuler.push(measureDepthScale(topFrame), true);
      signalRefs.push(
        measureUpperBodyY(topFrame, 'left'),
        measureUpperBodyDepth(topFrame, 'left'),
        true
      );
    }
    depthRuler.lock();
    const { restY: lockedRestY, restZ: lockedRestZ } = signalRefs.lock();
    const depthScaleM = depthRuler.scale;
    expect(depthScaleM).toBeCloseTo(DEPTH_SCALE, 5);
    expect(lockedRestY).toBeCloseTo(195, 5); // (200 shoulder + 190 nose) / 2
    expect(lockedRestZ).toBeCloseTo(0.0, 5);
    const refs = { restY: lockedRestY, restZ: lockedRestZ };

    // Helper: run one frame through the real combine rule + the FSM.
    const feed = (shoulderY, shoulderZ) => {
      const f = frame(shoulderY, shoulderZ);
      const combined = measureCombinedDownSignal(f, 'left', SCALE, depthScaleM, refs);
      const postureOk = isPushupPosture(f, 'left', SCALE);
      counter.update(combined.signal, 1, true, postureOk);
      return combined;
    };

    // --- REP: screen-y moves only 3 px (0.03 body-widths — negligible, well
    // under downFraction 0.2) while depth z drops from 0.0 to -0.10 m. That
    // z DIP is 0.10/0.4 = 0.25 body-widths -> clears downFraction 0.2. ---
    const top = feed(200, 0.0); // baseline frame (at the locked top)
    // Confirm depth really is the axis doing the work on a mid-dip frame.
    const mid = feed(203, -0.1);
    expect(mid.usedDepth).toBe(true);
    expect(mid.posY).toBeCloseTo(0.03, 5); // y barely moved
    expect(mid.posZ).toBeCloseTo(0.25, 5); // depth carried the dip
    expect(mid.signal).toBeCloseTo(0.25, 5); // MAX picked the depth dip
    expect(counter.phase).toBe('down'); // the depth dip reached 'down'

    // Rise back: z returns toward 0 (-0.02 m -> 0.05 body-widths < upFraction
    // 0.1), screen-y back near rest -> completes exactly one rep.
    feed(201, -0.02);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);

    // A tiny unused-top baseline reference so lint/readers see it was the start.
    expect(top.posY).toBeCloseTo(0, 5);
  });
});

describe('STANDING / WALKING (posture guard blocks the rep)', () => {
  // The same vertical bob pattern is run TWICE: once with the REAL posture
  // guard (which sees a standing-tall torso via 3D and returns false) and once
  // with postureOk forced true (the pre-guard behavior). The first must count
  // ZERO and the second must count reps — so if the guard were deleted, the
  // ZERO assertion would start failing. That is the control that keeps this
  // test honest.

  // A standing frame: the nose sits a big fraction of a shoulder-width above
  // the shoulders in the REAL WORLD. uprightNose3DFraction default is 0.9, and
  // DEPTH_SCALE is 0.4 m, so 0.5 m above = 0.5/0.4 = 1.25 > 0.9 -> rejected.
  const STAND_NOSE_ABOVE = 0.5;

  // The bob: the body-relative dip DOES cross downFraction (0.2) each cycle, so
  // the ONLY thing that can stop a count is the posture guard.
  const standTop = (y) => frame(y, 0.0, STAND_NOSE_ABOVE);

  it('confirms the guard actually rejects the standing posture', () => {
    // Sanity: the standing frame reads as NOT a push-up (via the 3D CUE B).
    expect(isPushupPosture(standTop(200), 'left', SCALE)).toBe(false);
  });

  it('counts ZERO reps for a standing bob (guard returns false every frame)', () => {
    const counter = makeCounter();
    // No depth rest/scale needed: we drive the y path directly against the
    // counter's own baseline. restY not locked -> raw-y position, zeroed by the
    // FSM baseline (the side-on fallback), so the bob's y dip is what crosses.
    const refs = null;

    const feed = (y) => {
      const f = standTop(y);
      const combined = measureCombinedDownSignal(f, 'left', SCALE, null, refs);
      const postureOk = isPushupPosture(f, 'left', SCALE); // REAL guard -> false
      counter.update(combined.signal, 1, true, postureOk);
    };

    feed(200); // baseline
    for (let i = 0; i < 10; i += 1) {
      feed(230); // 0.30 body-width dip — would be 'down' if posture allowed
      feed(202); // back up
    }
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(0);
    expect(counter.debug.lastPostureOk).toBe(false);
  });

  it('CONTROL: the identical motion WOULD count if the guard were removed', () => {
    // Same y pattern, but postureOk forced true (what removing the guard would
    // do). Now the dip counts — proving the ZERO above is the GUARD's doing,
    // not a too-shallow motion. If the guard were deleted, the test above would
    // match THIS behavior and its reps === 0 assertion would fail.
    const counter = makeCounter();
    const feed = (y) => {
      const f = standTop(y);
      const combined = measureCombinedDownSignal(f, 'left', SCALE, null, null);
      counter.update(combined.signal, 1, true, true); // guard forced OPEN
    };
    feed(200); // baseline
    for (let i = 0; i < 3; i += 1) {
      feed(230);
      feed(202);
    }
    expect(counter.reps).toBe(3);
  });
});

describe('SIDE-ON push-up (y drives the rep, depth barely changes)', () => {
  it('counts ONE rep from a y dip even with little/no z change', () => {
    const counter = makeCounter();

    // Lock the rulers + refs just like the front-facing case, but here the
    // depth will stay essentially flat so the Y axis must carry the rep.
    const depthRuler = createBodyScaleTracker();
    const signalRefs = createSignalReferenceTracker();
    const restZ = -0.3; // some arbitrary resting depth; it will barely move
    const topFrame = frame(200, restZ);
    for (let i = 0; i < 5; i += 1) {
      depthRuler.push(measureDepthScale(topFrame), true);
      signalRefs.push(
        measureUpperBodyY(topFrame, 'left'),
        measureUpperBodyDepth(topFrame, 'left'),
        true
      );
    }
    depthRuler.lock();
    const { restY: lockedRestY, restZ: lockedRestZ } = signalRefs.lock();
    const depthScaleM = depthRuler.scale;
    // restY is the measured head+shoulder average at the top (195 px).
    expect(lockedRestY).toBeCloseTo(195, 5);
    expect(lockedRestZ).toBeCloseTo(restZ, 5);
    const refs = { restY: lockedRestY, restZ: lockedRestZ };

    const feed = (shoulderY, shoulderZ) => {
      const f = frame(shoulderY, shoulderZ);
      const combined = measureCombinedDownSignal(f, 'left', SCALE, depthScaleM, refs);
      const postureOk = isPushupPosture(f, 'left', SCALE);
      counter.update(combined.signal, 1, true, postureOk);
      return combined;
    };

    feed(200, restZ); // baseline at the top

    // Lower toward the floor: screen-y drops 26 px (0.26 body-widths -> clears
    // downFraction 0.2) while depth stays within 1 mm of rest (z dip ~0.0025
    // body-widths — negligible). So the Y axis drives the rep.
    const mid = feed(226, -0.299);
    expect(mid.posY).toBeCloseTo(0.26, 5); // y carried the dip
    expect(Math.abs(mid.posZ)).toBeLessThan(0.01); // depth essentially flat
    expect(mid.signal).toBeCloseTo(0.26, 5); // MAX picked the y dip
    expect(counter.phase).toBe('down');

    // Rise back up: y returns to 0.05 body-widths (< upFraction 0.1) -> one rep.
    feed(205, -0.3);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });

  it('still counts side-on when the camera gives NO depth at all (pure-y fallback)', () => {
    // No z fields and no depth scale: measureCombinedDownSignal must fall back
    // to the plain y position and the counter's own baseline must zero it. This
    // proves the side path did not regress when depth is simply unavailable.
    const counter = makeCounter();
    const noDepth = (y) => ({
      left_shoulder: kp(100, y),
      right_shoulder: kp(160, y),
      nose: kp(130, y - 10),
    });
    const feed = (y) => {
      const f = noDepth(y);
      const combined = measureCombinedDownSignal(f, 'left', SCALE, null, null);
      expect(combined.usedDepth).toBe(false); // no depth folded in
      const postureOk = isPushupPosture(f, 'left', SCALE);
      counter.update(combined.signal, 1, true, postureOk);
    };
    feed(200); // baseline
    feed(226); // 0.26 dip -> down
    expect(counter.phase).toBe('down');
    feed(205); // rise -> rep
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });
});
