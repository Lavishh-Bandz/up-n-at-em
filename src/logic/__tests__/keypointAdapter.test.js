import { describe, it, expect } from 'vitest';
import { buildKeypointMap } from '../keypointAdapter.js';

// buildKeypointMap is the tiny PURE merge step the BlazePose engine swap added.
// It takes ONE raw pose object (a 2D keypoints list + an optional 3D
// keypoints3D list) and folds them into the single "keypoints-by-name" map the
// rest of the app reads. These tests hand it plain fake pose objects (no DOM,
// no webcam, no TFJS) and prove three things the downstream depth math relies
// on:
//   1. the map is keyed by joint NAME and keeps the 2D pixel x/y/score, and
//   2. the matching 3D depth z (plus x3d/y3d/z3d, all meters) is attached to
//      the right joint, and
//   3. when keypoints3D is missing the 2D points are STILL present with z left
//      undefined (the graceful 2D fallback the side-on path needs).
//
// UNITS (same as documented in keypointAdapter.js):
//   * 2D x/y are PIXELS, y grows DOWNWARD, each carries a score (0..1).
//   * 3D x/y/z are METERS, roughly hip-centered; z is DEPTH and gets SMALLER /
//     more NEGATIVE as a joint moves closer to the camera.

// Small helpers to build the two kinds of landmark quickly.
const kp2d = (name, x, y, score = 0.9) => ({ name, x, y, score });
const kp3d = (name, x, y, z) => ({ name, x, y, z });

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

    // Keyed by name, not by array index.
    expect(Object.keys(map).sort()).toEqual(['left_shoulder', 'right_shoulder']);
    // 2D fields survive untouched (pixels + score + name).
    expect(map.left_shoulder.x).toBe(100);
    expect(map.left_shoulder.y).toBe(200);
    expect(map.left_shoulder.score).toBe(0.95);
    expect(map.left_shoulder.name).toBe('left_shoulder');
    expect(map.right_shoulder.score).toBe(0.8);
  });

  it('attaches the correct depth z (and x3d/y3d/z3d) per joint, matched by name', () => {
    // The 3D list is deliberately in a DIFFERENT order than the 2D list, to
    // prove the merge matches by NAME, not by position.
    const pose = {
      keypoints: [
        kp2d('nose', 130, 160),
        kp2d('left_shoulder', 100, 200),
        kp2d('right_shoulder', 160, 205),
      ],
      keypoints3D: [
        // meters, hip-centered. left_shoulder sits slightly closer to the
        // camera (more negative z) than right_shoulder here.
        kp3d('right_shoulder', 0.2, -0.3, 0.05),
        kp3d('nose', 0.0, -0.6, -0.1),
        kp3d('left_shoulder', -0.2, -0.3, -0.05),
      ],
    };
    const map = buildKeypointMap(pose);

    // Each joint gets the z of the 3D entry with the SAME name.
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

  it('leaves z undefined for a 2D joint that has no matching 3D entry', () => {
    // Only left_shoulder has a 3D twin; right_shoulder does not.
    const pose = {
      keypoints: [
        kp2d('left_shoulder', 100, 200),
        kp2d('right_shoulder', 160, 205),
      ],
      keypoints3D: [kp3d('left_shoulder', -0.2, -0.3, -0.05)],
    };
    const map = buildKeypointMap(pose);

    expect(map.left_shoulder.z).toBeCloseTo(-0.05);
    // No 3D twin -> z (and the 3D fields) stay undefined, 2D still present.
    expect(map.right_shoulder.z).toBeUndefined();
    expect(map.right_shoulder.x3d).toBeUndefined();
    expect(map.right_shoulder.x).toBe(160);
    expect(map.right_shoulder.y).toBe(205);
  });

  it('still returns the 2D points with z undefined when keypoints3D is MISSING entirely', () => {
    // Some frames can lack keypoints3D. The map must still carry every 2D joint
    // so the pure-y (side-on) path keeps working — z is just undefined.
    const pose = {
      keypoints: [kp2d('left_shoulder', 100, 200), kp2d('nose', 130, 160)],
      // no keypoints3D key at all
    };
    const map = buildKeypointMap(pose);

    expect(map.left_shoulder.x).toBe(100);
    expect(map.left_shoulder.y).toBe(200);
    expect(map.left_shoulder.z).toBeUndefined();
    expect(map.nose.z).toBeUndefined();
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
