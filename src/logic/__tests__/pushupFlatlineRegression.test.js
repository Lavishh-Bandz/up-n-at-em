import { describe, it, expect } from 'vitest';
import {
  buildKeypointMap,
  BLAZEPOSE_KEYPOINT_NAMES,
} from '../keypointAdapter.js';
import {
  measureBodyScale,
  measureUpperBodyY,
  measureDepthScale,
  measureUpperBodyDepth,
  measureCombinedDownSignal,
  isPushupPosture,
  createBodyScaleTracker,
  createSignalReferenceTracker,
} from '../upperBodySignal.js';
import { createVerticalRepCounter } from '../verticalRepCounter.js';
import { pickBetterSide } from '../exercises.js';

// -----------------------------------------------------------------------------
// PUSH-UP FLATLINE REGRESSION — the tests that would have CAUGHT the live bug.
// -----------------------------------------------------------------------------
// WHY THIS FILE EXISTS (read this first — it reconciles the pass-vs-flatline gap):
//   The live app flatlined (confident + armed, bodyScalePx a real locked ~107,
//   but upperBodyY null EVERY frame and the depth dip zDip stuck at exactly 0,
//   so nothing ever counted) WHILE the existing nullPixelRecovery.test.js and
//   depthPushupSignal.test.js stayed green. That is the trap this file closes.
//
//   The reason those tests passed while the app failed is captured in
//   context.root_cause_findings.why_test_passed_live_failed: they only ever
//   built synthetic frames where EVERY needed joint had fully-populated, VARYING
//   3D coordinates, so projection ALWAYS succeeded and the depth z ALWAYS
//   changed. They never exercised the two shapes the live runtime actually hit:
//     1. a frame where the CHOSEN side's shoulder cannot be projected (its 3D
//        x/y are null) while the other shoulder + nose project fine — the exact
//        reason upperBodyY went null while bodyScalePx survived, and
//     2. a frame where the upper-body depth z stays EQUAL to the locked restZ
//        (frozen), so zDip = -(currentZ - restZ)/depthScaleM collapses to 0.
//
//   These tests drive the EXACT proven live raw shape (all 2D keypoints
//   { x:null, y:null, z:null, score, name } plus a full keypoints3D list)
//   through buildKeypointMap, exactly like usePoseDetector does, and then
//   through the SAME lock/read flow WorkoutSession uses (createBodyScaleTracker
//   + createSignalReferenceTracker -> lock -> measureCombinedDownSignal ->
//   createVerticalRepCounter). Each test asserts the PREVIOUSLY-BROKEN value
//   (finite upperBodyY, non-zero zDip, exactly one rep), not a static constant,
//   so each would FAIL if the FEAT-002 fallback fix were reverted.

// BlazePose's fixed index for each joint, so we can place 3D coords by name.
const IDX = {};
BLAZEPOSE_KEYPOINT_NAMES.forEach((name, i) => {
  IDX[name] = i;
});

// The real frame size the live dump reported (mirrors nullPixelRecovery.test).
const FRAME = { width: 1920, height: 1080 };

// Shared counter thresholds (same easy pair the other push-up tests use).
const makeCounter = () =>
  createVerticalRepCounter({ downFraction: 0.2, upFraction: 0.1 });

/**
 * Build ONE raw pose in the EXACT shape the live runtime returns:
 *   - keypoints:   33 entries, each { x:null, y:null, z:null, score, name }
 *                  (the proven fingerprint: pixels are NULL, only name + score
 *                  are real),
 *   - keypoints3D: 33 entries of real meter coordinates for the joints we set.
 *
 * A joint listed in `world3d` whose entry has null x/y (but a real z) models the
 * live "unprojectable chosen-side shoulder": buildKeypointMap cannot project it
 * to a pixel (so its x/y stay null) yet it still carries a true depth z. Joints
 * not listed get filler zeros and a 0 score so they are effectively absent.
 *
 * @param {object} world3d  { joint: {x,y,z} } world coords for the joints we set
 * @param {object} scores   { joint: score } confidence per joint (default 0.9)
 */
function rawPose(world3d, scores = {}) {
  const keypoints = BLAZEPOSE_KEYPOINT_NAMES.map((name) => ({
    // The proven live shape: pixel coords are NULL, only name + score are real.
    x: null,
    y: null,
    z: null,
    score: scores[name] ?? (world3d[name] ? 0.9 : 0),
    name,
  }));
  const keypoints3D = BLAZEPOSE_KEYPOINT_NAMES.map((name) => {
    const w = world3d[name] || { x: 0, y: 0, z: 0 };
    // Pass x/y/z straight through. When x or y is null (an unprojectable joint)
    // projectWorldToPixels returns null and the pixel x/y stay null — exactly
    // the live chosen-side-shoulder case — while z is still carried as depth.
    return { x: w.x, y: w.y, z: w.z, score: scores[name] ?? 0.9, name };
  });
  return { keypoints, keypoints3D, score: 0.94 };
}

describe('Test A: chosen-side shoulder unprojectable -> upperBodyY is finite (was null)', () => {
  it('bodyScale survives (real positive px) AND upperBodyY is finite for the chosen side', () => {
    // The live fingerprint: the CHOSEN side's shoulder 3D cannot be projected
    // (its x/y are null) so its pixel y stays null, while the OTHER shoulder and
    // the nose project fine. pickBetterSide ties to 'left', so we knock out the
    // LEFT shoulder's projection — the chosen side is exactly the broken one,
    // just like live.
    const pose = rawPose({
      nose: { x: 0.0, y: -0.4, z: -0.2 },
      // Left shoulder: real depth z, but null x/y -> NOT projectable to a pixel.
      left_shoulder: { x: null, y: null, z: -0.16 },
      // Right shoulder + nose project fine.
      right_shoulder: { x: -0.17, y: 0.03, z: -0.13 },
    });
    const map = buildKeypointMap(pose, FRAME);

    // pickBetterSide ties to 'left' (equal scores) — confirm the chosen side is
    // the one whose shoulder pixel is missing, reproducing the live condition.
    const { side } = pickBetterSide('pushup', map);
    expect(side).toBe('left');
    expect(Number.isFinite(map.left_shoulder.x)).toBe(false); // null pixel
    expect(Number.isFinite(map.right_shoulder.x)).toBe(true); // projected fine

    // BUG PRECONDITION: the pixel ruler still comes back a real positive value
    // (it falls back nose -> available shoulder), matching the live "bodyScalePx
    // is a real 107" while everything else was dead.
    const bodyScalePx = measureBodyScale(map);
    expect(bodyScalePx).not.toBeNull();
    expect(bodyScalePx).toBeGreaterThan(0);

    // THE FIX: upperBodyY for the CHOSEN side is now a FINITE number. Before
    // FEAT-002 this read only the chosen (left) shoulder's y and returned null
    // the instant that one pixel was missing — the live "upperBodyY null every
    // frame". It now falls back to the other shoulder / nose, so it is finite.
    const upperY = measureUpperBodyY(map, side);
    expect(Number.isFinite(upperY)).toBe(true);
  });
});

describe('Test B: front-facing rep -> non-zero zDip crossing downFraction, one rep', () => {
  it('posZ is non-zero, usedDepth is true, and a full down-then-up counts ONE rep', () => {
    const counter = makeCounter();

    // Build a front-facing raw frame: the shoulders barely move on screen (their
    // world y stays put) and the whole upper body moves in DEPTH (z). Both
    // shoulders carry full 3D (0.4 m apart in x3d) so measureDepthScale locks a
    // stable 0.4 m ruler.
    //
    // CRUCIAL for the revert check: on the REP frames the CHOSEN (left) shoulder
    // carries NO depth z (it is the joint the live runtime keeps losing), so the
    // depth read MUST come from the FEAT-002 fallback (other shoulder / nose).
    // That makes this test fail if the fallback is reverted: pre-fix,
    // measureUpperBodyDepth read only the chosen shoulder, returned null here,
    // posZ collapsed to null and zDip froze -> 0 reps. With the fix, the varying
    // z from the other shoulder + nose flows through and zDip is non-zero.

    // Top (arming) frame: BOTH shoulders have full 3D so the rulers lock.
    const armTopFrame = (shoulderZ) =>
      rawPose({
        nose: { x: 0.0, y: -0.1, z: shoulderZ },
        left_shoulder: { x: 0.2, y: 0.0, z: shoulderZ },
        right_shoulder: { x: -0.2, y: 0.0, z: shoulderZ },
      });

    // Rep frame: the chosen (left) shoulder still PROJECTS (so its pixel y is
    // fine and screen-y barely moves) but carries NO depth z, forcing the depth
    // read through the fallback to the other shoulder + nose.
    const repFrame = (shoulderZ) =>
      rawPose({
        nose: { x: 0.0, y: -0.1, z: shoulderZ },
        left_shoulder: { x: 0.2, y: 0.0 }, // no z: chosen-side depth is missing
        right_shoulder: { x: -0.2, y: 0.0, z: shoulderZ },
      });

    // --- ARMING: hold the top and feed + lock the rulers and rest refs, exactly
    // as WorkoutSession does at the isArmed && !wasArmed transition. ---
    const bodyRuler = createBodyScaleTracker();
    const depthRuler = createBodyScaleTracker();
    const signalRefs = createSignalReferenceTracker();

    const topRaw = armTopFrame(0.0); // resting top of the push-up, depth z = 0
    for (let i = 0; i < 6; i += 1) {
      const m = buildKeypointMap(topRaw, FRAME);
      bodyRuler.push(measureBodyScale(m), true);
      depthRuler.push(measureDepthScale(m), true);
      signalRefs.push(
        measureUpperBodyY(m, 'left'),
        measureUpperBodyDepth(m, 'left'),
        true
      );
    }
    bodyRuler.lock();
    depthRuler.lock();
    const refs = signalRefs.lock();

    const bodyScalePx = bodyRuler.scale;
    const depthScaleM = depthRuler.scale;
    expect(bodyScalePx).toBeGreaterThan(0);
    expect(depthScaleM).toBeCloseTo(0.4, 5); // stable 3D shoulder-width ruler
    expect(Number.isFinite(refs.restZ)).toBe(true);

    const feed = (shoulderZ) => {
      // Rep frames use the chosen-side-depth-missing shape so the depth read
      // exercises the fallback, mirroring the live lost-shoulder behavior.
      const m = buildKeypointMap(repFrame(shoulderZ), FRAME);
      const combined = measureCombinedDownSignal(
        m,
        'left',
        bodyScalePx,
        depthScaleM,
        refs
      );
      const postureOk = isPushupPosture(m, 'left', bodyScalePx);
      counter.update(combined.signal, 1, true, postureOk);
      return combined;
    };

    feed(0.0); // baseline at the locked top (zDip should be ~0 here)

    // Lower toward the camera: z drops to -0.12 m. The depth DIP is now
    // 0.12/0.4 = 0.30 body-widths. This is the exact thing that was FROZEN live:
    // the zDip must be NON-ZERO and clear downFraction 0.2.
    const mid = feed(-0.12);
    expect(mid.usedDepth).toBe(true);
    // THE FIX: posZ is non-zero (it was stuck at exactly 0 in the live app).
    expect(Math.abs(mid.posZ)).toBeGreaterThan(0.2);
    expect(mid.posZ).toBeCloseTo(0.3, 5);
    // Screen-y barely moved (the shoulders' world y stayed at 0), so the depth
    // axis is genuinely what carried the dip, not a smuggled-in y change.
    expect(Math.abs(mid.posY)).toBeLessThan(0.05);
    expect(mid.signal).toBeCloseTo(0.3, 5); // MAX picked the depth dip
    expect(counter.phase).toBe('down');

    // Rise back up: z returns near rest -> completes exactly ONE rep.
    feed(-0.01);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });
});

describe('Test C: side-on rep -> y dips, depth flat, still counts ONE rep', () => {
  it('posY carries the rep with depth ~flat, proving no regression to the side path', () => {
    const counter = makeCounter();

    // Side-on: the upper body moves DOWN the screen (world y grows) while the
    // depth z stays essentially flat. Everything sourced from the raw null-2D
    // shape through buildKeypointMap, like live.
    const restZ = -0.3; // some resting depth that barely moves this whole rep
    const rawFrame = (shoulderWorldY, shoulderZ) =>
      rawPose({
        // Nose rides a little above the shoulders (smaller world y = higher up).
        nose: { x: 0.0, y: shoulderWorldY - 0.05, z: shoulderZ },
        left_shoulder: { x: 0.2, y: shoulderWorldY, z: shoulderZ },
        right_shoulder: { x: -0.2, y: shoulderWorldY, z: shoulderZ },
      });

    // --- ARMING: lock rulers + rest refs at the top, WorkoutSession style. ---
    const bodyRuler = createBodyScaleTracker();
    const depthRuler = createBodyScaleTracker();
    const signalRefs = createSignalReferenceTracker();

    const topRaw = rawFrame(0.0, restZ);
    for (let i = 0; i < 6; i += 1) {
      const m = buildKeypointMap(topRaw, FRAME);
      bodyRuler.push(measureBodyScale(m), true);
      depthRuler.push(measureDepthScale(m), true);
      signalRefs.push(
        measureUpperBodyY(m, 'left'),
        measureUpperBodyDepth(m, 'left'),
        true
      );
    }
    bodyRuler.lock();
    depthRuler.lock();
    const refs = signalRefs.lock();
    const bodyScalePx = bodyRuler.scale;
    const depthScaleM = depthRuler.scale;
    expect(bodyScalePx).toBeGreaterThan(0);

    const feed = (shoulderWorldY, shoulderZ) => {
      const m = buildKeypointMap(rawFrame(shoulderWorldY, shoulderZ), FRAME);
      const combined = measureCombinedDownSignal(
        m,
        'left',
        bodyScalePx,
        depthScaleM,
        refs
      );
      const postureOk = isPushupPosture(m, 'left', bodyScalePx);
      counter.update(combined.signal, 1, true, postureOk);
      return combined;
    };

    feed(0.0, restZ); // baseline at the top

    // Lower toward the floor: world y grows by 0.15 m (projected to pixels, a
    // clear screen-y dip well past downFraction) while depth stays within 1 mm.
    const mid = feed(0.15, restZ + 0.001);
    expect(Math.abs(mid.posZ)).toBeLessThan(0.02); // depth essentially flat
    expect(mid.posY).toBeGreaterThan(0.2); // the y axis carried the dip
    expect(mid.signal).toBeCloseTo(mid.posY, 5); // MAX picked the y dip
    expect(counter.phase).toBe('down');

    // Rise back up -> completes exactly ONE rep via the side (y) path.
    feed(0.01, restZ);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });
});

describe('Test D: end-to-end through WorkoutSession arming-then-counting order', () => {
  it('a front-facing push-up sourced entirely from the raw null-2D shape counts ONE rep', () => {
    // This is the pipeline-mirroring test the prior nullPixelRecovery test did
    // not have for the front-facing depth case driven through the WHOLE lock/read
    // order: EVERY frame starts as the proven raw shape (all 2D x/y null) and
    // flows adapter -> rulers -> signal -> FSM in the exact order
    // WorkoutSession.handlePose arms then counts. The upper body moves in DEPTH
    // (z) while screen-y barely changes, so this exercises the depth path that
    // was frozen live, end to end from the raw null-2D shape.
    const counter = makeCounter();
    const bodyRuler = createBodyScaleTracker();
    const depthRuler = createBodyScaleTracker();
    const signalRefs = createSignalReferenceTracker();

    // Arming (top) frame: BOTH shoulders carry full projectable 3D (0.4 m apart
    // in x3d) so the pixel ruler AND the depth ruler lock cleanly. The 2D pixels
    // are still all null in the raw input (the live fingerprint); buildKeypointMap
    // projects them, exactly like usePoseDetector feeds WorkoutSession.
    const armTopFrame = (shoulderZ) =>
      rawPose({
        nose: { x: 0.0, y: -0.1, z: shoulderZ },
        left_shoulder: { x: 0.2, y: 0.0, z: shoulderZ },
        right_shoulder: { x: -0.2, y: 0.0, z: shoulderZ },
      });

    // Rep frame: the chosen (left) shoulder is ENTIRELY lost — null x/y (no
    // pixel) and no depth z — exactly the live frame where BlazePose drops that
    // joint. So BOTH the pixel-y read and the depth read for the chosen side
    // must come through the FEAT-002 fallback (other shoulder + nose). Pre-fix
    // this made upperBodyY null and the depth read null every rep frame -> dead
    // signal -> 0 reps; this is the end-to-end revert guard.
    const repFrame = (shoulderZ) =>
      rawPose({
        nose: { x: 0.0, y: -0.1, z: shoulderZ },
        left_shoulder: { x: null, y: null }, // chosen side fully lost this frame
        right_shoulder: { x: -0.2, y: 0.0, z: shoulderZ },
      });

    // --- ARMING: feed + lock the rulers and rest refs at the top. ---
    const topRaw = armTopFrame(0.0);
    // Sanity: the RAW input really is the null-2D shape before projection, so
    // this test genuinely sources from the proven live fingerprint.
    expect(topRaw.keypoints[IDX.left_shoulder].x).toBeNull();
    for (let i = 0; i < 6; i += 1) {
      const m = buildKeypointMap(topRaw, FRAME);
      bodyRuler.push(measureBodyScale(m), true);
      depthRuler.push(measureDepthScale(m), true);
      signalRefs.push(
        measureUpperBodyY(m, 'left'),
        measureUpperBodyDepth(m, 'left'),
        true
      );
    }
    bodyRuler.lock();
    depthRuler.lock();
    const refs = signalRefs.lock();

    const bodyScalePx = bodyRuler.scale;
    const depthScaleM = depthRuler.scale;
    // The pixel ruler locks from the recovered (projected) pixels — the live
    // "bodyScalePx is a real 107" — and the depth ruler locks from true meters.
    expect(bodyScalePx).toBeGreaterThan(0);
    expect(depthScaleM).toBeGreaterThan(0);
    // restY/restZ are FINITE (the Y read no longer collapses to null).
    expect(Number.isFinite(refs.restY)).toBe(true);
    expect(Number.isFinite(refs.restZ)).toBe(true);

    const feed = (shoulderZ) => {
      const m = buildKeypointMap(repFrame(shoulderZ), FRAME);
      // The chosen-side shoulder pixel really is missing this frame.
      expect(Number.isFinite(m.left_shoulder.x)).toBe(false);
      const combined = measureCombinedDownSignal(
        m,
        'left',
        bodyScalePx,
        depthScaleM,
        refs
      );
      const postureOk = isPushupPosture(m, 'left', bodyScalePx);
      counter.update(combined.signal, 1, true, postureOk);
      return combined;
    };

    feed(0.0); // baseline at the top
    const mid = feed(-0.12); // lower toward the camera: a real depth dip
    expect(mid.usedDepth).toBe(true);
    expect(Math.abs(mid.posZ)).toBeGreaterThan(0.2); // non-zero zDip (was frozen)
    expect(counter.phase).toBe('down');
    feed(-0.01); // rise back up -> exactly one rep end to end
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });
});
