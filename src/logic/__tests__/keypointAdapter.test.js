import { describe, it, expect } from 'vitest';
import {
  buildKeypointMap,
  BLAZEPOSE_KEYPOINT_NAMES,
} from '../keypointAdapter.js';

// buildKeypointMap is the tiny PURE merge step the BlazePose engine swap added.
// It takes ONE raw pose object (a 2D keypoints list + an optional 3D
// keypoints3D list) and folds them into the single "keypoints-by-name" map the
// rest of the app reads. These tests hand it plain fake pose objects (no DOM,
// no webcam, no TFJS).
//
// THE LIVE BUG THESE TESTS NOW PIN DOWN:
//   The first BlazePose build keyed the map off each 2D point's OWN `name` and
//   dropped any 2D point without one. Live, that left bodyScalePx null (no 2D
//   pixel ruler) while depthScaleM still worked (3D ruler) and NOTHING counted
//   or drew. The adapter now names every point by its fixed BlazePose INDEX and
//   merges 3D by the SAME index, and normalizes a confidence into `score`, so
//   the 2D pixel path can never silently vanish again. The tests below cover:
//     1. a normal named pose (names + pixel x/y/score kept, 3D depth attached),
//     2. a pose whose 2D keypoints have NO names -> still mapped, by INDEX,
//     3. a build that reports confidence as `visibility`/`presence` -> folded
//        into `score`,
//     4. graceful behavior when 3D is missing, and malformed input.
//
// UNITS (same as documented in keypointAdapter.js):
//   * 2D x/y are PIXELS, y grows DOWNWARD, each carries a score (0..1).
//   * 3D x/y/z are METERS, roughly hip-centered; z is DEPTH and gets SMALLER /
//     more NEGATIVE as a joint moves closer to the camera.

// Small helpers to build the two kinds of landmark quickly.
const kp2d = (name, x, y, score = 0.9) => ({ name, x, y, score });
const kp3d = (name, x, y, z) => ({ name, x, y, z });

// Index of each joint in BlazePose's fixed 33-point order (handy for building
// index-aligned fake poses below).
const IDX = {};
BLAZEPOSE_KEYPOINT_NAMES.forEach((n, i) => {
  IDX[n] = i;
});

// Build a full-length 33-slot 2D keypoints array with only the given joints
// filled in (the rest are harmless placeholder points), so index-based naming
// lands the real joints on the right names. `make` builds each entry so we can
// test named, unnamed and visibility-based shapes with the same helper.
function poseByIndex(filled, make) {
  const keypoints = BLAZEPOSE_KEYPOINT_NAMES.map((name, i) => {
    if (Object.prototype.hasOwnProperty.call(filled, name)) {
      return make(name, i, filled[name]);
    }
    // Placeholder joint far off-screen with low confidence; it just occupies
    // its index slot so the joints we care about keep their correct indexes.
    return make(name, i, { x: -1, y: -1, score: 0 });
  });
  return { keypoints };
}

describe('buildKeypointMap (BlazePose 2D + 3D adapter)', () => {
  it('keys the map by joint name and keeps the 2D pixel x/y/score', () => {
    const pose = {
      keypoints: [
        kp2d('left_shoulder', 100, 200, 0.95),
        kp2d('right_shoulder', 160, 205, 0.8),
      ],
      keypoints3D: [],
    };
    const map = buildKeypointMap(pose);

    // Named by INDEX in BlazePose order: index 0 is 'nose', 1 is
    // 'left_eye_inner', so the first two points here are named by their slots.
    // (This test's point is only that pixel x/y/score survive and the map is
    // keyed by name; the index-naming behavior gets its own test below.)
    const names = Object.keys(map);
    expect(names.length).toBe(2);
    const first = map[names[0]];
    expect(first.x).toBe(100);
    expect(first.y).toBe(200);
    expect(first.score).toBe(0.95);
    expect(first.name).toBe(names[0]);
  });

  it('names 2D keypoints by their FIXED INDEX even when they carry NO name', () => {
    // THE REGRESSION TEST for the live bug: BlazePose 2D keypoints that do not
    // carry a usable `name`. The old adapter skipped these entirely, so the
    // pixel ruler (shoulder width) could never be measured and bodyScalePx came
    // back null. Here we give the shoulders NO name at all and prove they still
    // land under 'left_shoulder' / 'right_shoulder' with their pixel x/y, so
    // measureBodyScale() downstream has real points to measure.
    const pose = poseByIndex(
      {
        left_shoulder: { x: 100, y: 200, score: 0.95 },
        right_shoulder: { x: 160, y: 205, score: 0.8 },
      },
      // make an UNNAMED 2D point (no name field): x/y/score only.
      (_name, _i, v) => ({ x: v.x, y: v.y, score: v.score })
    );

    const map = buildKeypointMap(pose);

    // Resolved by index -> correct canonical names, with pixel x/y intact.
    expect(map.left_shoulder.x).toBe(100);
    expect(map.left_shoulder.y).toBe(200);
    expect(map.left_shoulder.score).toBe(0.95);
    expect(map.left_shoulder.name).toBe('left_shoulder');
    expect(map.right_shoulder.x).toBe(160);
    expect(map.right_shoulder.y).toBe(205);
    expect(map.right_shoulder.name).toBe('right_shoulder');
  });

  it('normalizes a `visibility` (or `presence`) confidence into `score`', () => {
    // Some BlazePose builds expose confidence as `visibility` or `presence`
    // instead of `score`. Downstream gates + the overlay read `score`, so the
    // adapter folds whichever one is present into `score`.
    const pose = poseByIndex(
      {
        left_shoulder: { x: 100, y: 200, visibility: 0.77 },
        right_shoulder: { x: 160, y: 205, presence: 0.66 },
      },
      (_name, _i, v) => {
        const entry = { x: v.x, y: v.y };
        if (v.visibility !== undefined) entry.visibility = v.visibility;
        if (v.presence !== undefined) entry.presence = v.presence;
        return entry;
      }
    );

    const map = buildKeypointMap(pose);

    expect(map.left_shoulder.score).toBeCloseTo(0.77);
    expect(map.right_shoulder.score).toBeCloseTo(0.66);
  });

  it('attaches the correct depth z (and x3d/y3d/z3d) per joint, matched by INDEX', () => {
    // BlazePose returns the 2D and 3D lists in the SAME fixed order, so we merge
    // by index. Here both lists are index-aligned 33-slot arrays; we fill the
    // nose and both shoulders and prove each 2D joint gets the z from the 3D
    // point at the same index.
    const twoD = poseByIndex(
      {
        nose: { x: 130, y: 160, score: 0.9 },
        left_shoulder: { x: 100, y: 200, score: 0.9 },
        right_shoulder: { x: 160, y: 205, score: 0.9 },
      },
      (name, _i, v) => ({ name, x: v.x, y: v.y, score: v.score })
    );
    // Build an index-aligned 3D list with matching depths for those joints.
    const keypoints3D = BLAZEPOSE_KEYPOINT_NAMES.map((name, i) => {
      if (i === IDX.nose) return kp3d(name, 0.0, -0.6, -0.1);
      if (i === IDX.left_shoulder) return kp3d(name, -0.2, -0.3, -0.05);
      if (i === IDX.right_shoulder) return kp3d(name, 0.2, -0.3, 0.05);
      return kp3d(name, 0, 0, 0);
    });
    const pose = { keypoints: twoD.keypoints, keypoints3D };

    const map = buildKeypointMap(pose);

    // Each joint gets the z of the 3D entry at the SAME index.
    expect(map.left_shoulder.z).toBeCloseTo(-0.05);
    expect(map.right_shoulder.z).toBeCloseTo(0.05);
    expect(map.nose.z).toBeCloseTo(-0.1);

    // The full 3D position is exposed too (z3d mirrors z).
    expect(map.left_shoulder.x3d).toBeCloseTo(-0.2);
    expect(map.left_shoulder.y3d).toBeCloseTo(-0.3);
    expect(map.left_shoulder.z3d).toBeCloseTo(-0.05);
    expect(map.nose.x3d).toBeCloseTo(0.0);
    expect(map.nose.y3d).toBeCloseTo(-0.6);

    // And the 2D pixels are still intact alongside the new depth fields.
    expect(map.left_shoulder.x).toBe(100);
    expect(map.left_shoulder.y).toBe(200);
  });

  it('still returns the 2D points with z undefined when keypoints3D is MISSING entirely', () => {
    // Some frames can lack keypoints3D. The map must still carry every 2D joint
    // so the pure-y (side-on) path keeps working — z is just undefined.
    const pose = {
      keypoints: [kp2d('nose', 130, 160), kp2d('left_eye_inner', 125, 150)],
      // no keypoints3D key at all
    };
    const map = buildKeypointMap(pose);

    // Index 0 -> nose, index 1 -> left_eye_inner (named by their slots).
    expect(map.nose.x).toBe(130);
    expect(map.nose.y).toBe(160);
    expect(map.nose.z).toBeUndefined();
    expect(map.left_eye_inner.z).toBeUndefined();
  });

  it('leaves z undefined for a 2D joint whose index has no 3D entry', () => {
    // A short 3D list means later indexes have no 3D twin; those joints keep
    // their 2D pixels and simply get no depth.
    const pose = {
      keypoints: [kp2d('nose', 130, 160), kp2d('left_eye_inner', 125, 150)],
      keypoints3D: [kp3d('nose', 0.0, -0.6, -0.1)], // only index 0 has 3D
    };
    const map = buildKeypointMap(pose);

    expect(map.nose.z).toBeCloseTo(-0.1);
    expect(map.left_eye_inner.z).toBeUndefined();
    expect(map.left_eye_inner.x3d).toBeUndefined();
    expect(map.left_eye_inner.x).toBe(125);
    expect(map.left_eye_inner.y).toBe(150);
  });

  it('SYNTHESIZES pixel x/y from the 3D landmark when the 2D x/y are NULL (the live bug)', () => {
    // THE REGRESSION TEST for the proven live shape: this tfjs BlazePose runtime
    // returns every 2D keypoint with x:null, y:null (they still carry name +
    // score) while the 3D keypoints3D list is fully populated. The adapter must
    // rebuild a usable pixel x/y for each joint by projecting the 3D world
    // landmark into screen space, so the overlay + every pixel-based measurement
    // stop seeing null.
    const twoD = poseByIndex(
      {
        nose: { x: null, y: null, score: 0.98 },
        left_shoulder: { x: null, y: null, score: 0.96 },
        right_shoulder: { x: null, y: null, score: 0.8 },
      },
      (name, _i, v) => ({ name, x: v.x, y: v.y, score: v.score })
    );
    const keypoints3D = BLAZEPOSE_KEYPOINT_NAMES.map((name, i) => {
      if (i === IDX.nose) return kp3d(name, 0.0, -0.4, -0.2);
      if (i === IDX.left_shoulder) return kp3d(name, 0.17, -0.01, -0.16);
      if (i === IDX.right_shoulder) return kp3d(name, -0.17, 0.03, -0.13);
      return kp3d(name, 0, 0, 0);
    });
    const pose = { keypoints: twoD.keypoints, keypoints3D };

    // Hand in the real frame size the live dump reported.
    const map = buildKeypointMap(pose, { width: 1920, height: 1080 });

    // The null 2D x/y are replaced with finite projected pixels.
    for (const joint of ['nose', 'left_shoulder', 'right_shoulder']) {
      expect(Number.isFinite(map[joint].x)).toBe(true);
      expect(Number.isFinite(map[joint].y)).toBe(true);
    }

    // The projection places body-center at mid-frame (960, 540) and scales
    // meters by the frame height (1080). left_shoulder x3d 0.17 -> ~960+184.
    expect(map.left_shoulder.x).toBeCloseTo(960 + 0.17 * 1080, 1);
    expect(map.left_shoulder.y).toBeCloseTo(540 + -0.01 * 1080, 1);

    // The shoulders project to DIFFERENT x's, so a pixel ruler (shoulder width)
    // and the overlay have a real, non-degenerate geometry to work with.
    expect(map.left_shoulder.x).not.toBeCloseTo(map.right_shoulder.x, 1);

    // The true 3D fields are still attached for the depth-aware math.
    expect(map.left_shoulder.z).toBeCloseTo(-0.16);
    expect(map.left_shoulder.y3d).toBeCloseTo(-0.01);
  });

  it('PREFERS real 2D pixels over projection when the engine actually provides them', () => {
    // If a build/runtime ever returns real finite pixel x/y, we must use those
    // exactly and NOT overwrite them with the projection.
    const twoD = poseByIndex(
      {
        left_shoulder: { x: 123, y: 456, score: 0.9 },
      },
      (name, _i, v) => ({ name, x: v.x, y: v.y, score: v.score })
    );
    const keypoints3D = BLAZEPOSE_KEYPOINT_NAMES.map((name, i) => {
      if (i === IDX.left_shoulder) return kp3d(name, 0.2, -0.3, -0.05);
      return kp3d(name, 0, 0, 0);
    });
    const pose = { keypoints: twoD.keypoints, keypoints3D };

    const map = buildKeypointMap(pose, { width: 1920, height: 1080 });

    // Real pixels kept verbatim; depth still attached from 3D.
    expect(map.left_shoulder.x).toBe(123);
    expect(map.left_shoulder.y).toBe(456);
    expect(map.left_shoulder.z).toBeCloseTo(-0.05);
  });

  it('leaves x/y null when BOTH the 2D pixels and the 3D landmark are unusable', () => {
    // No real pixels AND no projectable 3D point -> we cannot invent a position,
    // so x/y stay null and downstream null-guards simply skip the joint.
    const pose = {
      keypoints: [{ name: 'nose', x: null, y: null, score: 0.9 }],
      // no keypoints3D at all
    };
    const map = buildKeypointMap(pose, { width: 1920, height: 1080 });
    expect(map.nose.x).toBeNull();
    expect(map.nose.y).toBeNull();
  });

  it('returns an empty map for a missing or malformed pose', () => {
    // Graceful: no pose, or no keypoints array -> {} so callers can skip the
    // frame instead of blowing up.
    expect(buildKeypointMap()).toEqual({});
    expect(buildKeypointMap(null)).toEqual({});
    expect(buildKeypointMap({})).toEqual({});
    expect(buildKeypointMap({ keypoints: null })).toEqual({});
  });
});
