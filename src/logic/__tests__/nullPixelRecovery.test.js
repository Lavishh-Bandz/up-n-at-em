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
import { angleBetween } from '../angles.js';

// -----------------------------------------------------------------------------
// NULL-2D-PIXEL RECOVERY: the machine-checkable proof of the live fix.
// -----------------------------------------------------------------------------
// A live raw dump proved that this tfjs BlazePose runtime returns the 2D
// keypoints with x:null and y:null for every joint, while the 3D keypoints3D
// list is fully populated with real world coordinates in meters. Historically
// the whole app read the 2D pixel x/y, so null meant: no skeleton drew, the
// pixel body-scale ruler came back null, nothing counted, and the arming
// countdown misbehaved (it was fed confidence/orientation from the broken 2D
// path).
//
// THE FIX lives in keypointAdapter.js: when the 2D x/y are null it PROJECTS the
// working 3D world landmark into screen pixels so every pixel-based consumer
// gets real numbers again. These tests feed the adapter the EXACT proven raw
// shape (null 2D + full 3D) and prove the downstream pixel math is restored:
//   1. measureBodyScale returns a real positive pixel ruler (was null, the
//      exact bug fingerprint),
//   2. measureUpperBodyY returns a real pixel y,
//   3. the sit-up angle path (angleBetween on the recovered pixels) works,
//   4. a FRONT-FACING push-up counts a rep end-to-end from a raw-shape stream.

// BlazePose's fixed index for each joint we need to place in a 33-slot array.
const IDX = {};
BLAZEPOSE_KEYPOINT_NAMES.forEach((n, i) => {
  IDX[n] = i;
});

// The real frame size the live dump reported.
const FRAME = { width: 1920, height: 1080 };

/**
 * Build ONE raw pose in the EXACT shape the live runtime returns:
 *   - keypoints:   33 entries, each with x:null, y:null, z:null, a real score
 *                  and name (the proven fingerprint),
 *   - keypoints3D: 33 entries with real meter coordinates.
 * Only the joints we care about get distinctive 3D coords; the rest are filler.
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
    return { x: w.x, y: w.y, z: w.z, score: scores[name] ?? 0.9, name };
  });
  return { keypoints, keypoints3D, score: 0.94 };
}

describe('recovering a usable pose from null 2D pixels + full 3D', () => {
  it('builds finite projected pixels for every joint that has a 3D landmark', () => {
    const pose = rawPose({
      nose: { x: 0.0, y: -0.4, z: -0.2 },
      left_shoulder: { x: 0.17, y: -0.01, z: -0.16 },
      right_shoulder: { x: -0.17, y: 0.03, z: -0.13 },
    });
    const map = buildKeypointMap(pose, FRAME);

    for (const joint of ['nose', 'left_shoulder', 'right_shoulder']) {
      expect(Number.isFinite(map[joint].x)).toBe(true);
      expect(Number.isFinite(map[joint].y)).toBe(true);
    }
    // The shoulders land at different x's so the geometry is non-degenerate.
    expect(map.left_shoulder.x).not.toBeCloseTo(map.right_shoulder.x, 1);
  });

  it('RESTORES measureBodyScale (was null) and measureUpperBodyY from the recovered pixels', () => {
    const pose = rawPose({
      nose: { x: 0.0, y: -0.4, z: -0.2 },
      left_shoulder: { x: 0.17, y: -0.01, z: -0.16 },
      right_shoulder: { x: -0.17, y: 0.03, z: -0.13 },
    });
    const map = buildKeypointMap(pose, FRAME);

    // The exact bug fingerprint was bodyScalePx === null. It is now a real
    // positive pixel ruler measured from the recovered shoulder pixels.
    const bodyScalePx = measureBodyScale(map);
    expect(bodyScalePx).not.toBeNull();
    expect(bodyScalePx).toBeGreaterThan(0);

    // And the upper-body y signal (shoulder averaged with the nose) is a real
    // finite pixel value instead of null.
    const upperY = measureUpperBodyY(map, 'left');
    expect(Number.isFinite(upperY)).toBe(true);

    // The depth ruler (meters) still comes straight from the true 3D coords.
    expect(measureDepthScale(map)).toBeGreaterThan(0);
  });

  it('keeps the SIT-UP angle path working off the recovered pixels', () => {
    // Sit-ups read 2D pixel x/y via angleBetween(shoulder, hip, knee). With the
    // null pixels recovered by projection, the angle is computable again.
    const pose = rawPose({
      left_shoulder: { x: 0.0, y: -0.3, z: 0 },
      left_hip: { x: 0.0, y: 0.1, z: 0 },
      left_knee: { x: 0.35, y: 0.1, z: 0 },
    });
    const map = buildKeypointMap(pose, FRAME);

    const a = map.left_shoulder;
    const v = map.left_hip;
    const c = map.left_knee;
    expect(a && v && c).toBeTruthy();
    const angle = angleBetween(a, v, c);
    // A bent L-shape (shoulder above the hip, knee out to the side) -> about 90
    // degrees. The exact value is not the point; that it is a finite, sensible
    // angle (not NaN from null inputs) is.
    expect(Number.isFinite(angle)).toBe(true);
    expect(angle).toBeGreaterThan(60);
    expect(angle).toBeLessThan(120);
  });

  it('counts a FRONT-FACING push-up end-to-end from the raw null-2D stream', () => {
    // Drive the SAME arm-then-count pipeline WorkoutSession runs, but sourcing
    // every frame from the proven raw shape through buildKeypointMap, so this
    // proves the fix end-to-end (adapter -> rulers -> signal -> FSM).
    const counter = createVerticalRepCounter({
      downFraction: 0.2,
      upFraction: 0.1,
    });
    const bodyRuler = createBodyScaleTracker();
    const depthRuler = createBodyScaleTracker();
    const signalRefs = createSignalReferenceTracker();

    // Build one raw frame at a given upper-body depth (z, meters) and real-world
    // nose height above the shoulders. Shoulders sit 0.4 m apart in x3d (a
    // stable depth ruler) and barely move on screen; the rep happens in DEPTH.
    const rawFrame = (shoulderZ, noseAbove = 0.1) =>
      rawPose({
        nose: { x: 0.0, y: -noseAbove, z: shoulderZ },
        left_shoulder: { x: 0.2, y: 0.0, z: shoulderZ },
        right_shoulder: { x: -0.2, y: 0.0, z: shoulderZ },
      });

    // --- ARMING: hold the top and feed the rulers + rest refs, then lock. ---
    const topRaw = rawFrame(0.0);
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
    expect(bodyScalePx).toBeGreaterThan(0); // ruler recovered (not null!)
    expect(depthScaleM).toBeCloseTo(0.4, 5); // 3D shoulder width

    const feed = (shoulderZ) => {
      const m = buildKeypointMap(rawFrame(shoulderZ), FRAME);
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
    // Lower toward the camera: z drops to -0.12 m -> 0.12/0.4 = 0.30 body-widths
    // -> clears downFraction 0.2.
    const mid = feed(-0.12);
    expect(mid.usedDepth).toBe(true);
    expect(counter.phase).toBe('down');
    // Rise back: z returns near rest -> completes exactly one rep.
    feed(-0.01);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });
});
