import { describe, it, expect } from 'vitest';
import {
  EXERCISES,
  DIFFICULTIES,
  getExercise,
  getPreset,
  sumSideConfidence,
  pickBetterSide,
  evaluateOrientation,
} from '../exercises.js';

describe('exercise descriptors', () => {
  it('defines pushup and situp', () => {
    expect(getExercise('pushup').id).toBe('pushup');
    expect(getExercise('situp').id).toBe('situp');
  });

  it('throws on an unknown exercise', () => {
    expect(() => getExercise('backflip')).toThrow();
  });

  it('tracks push-ups by the upper-body shoulder signal, not an angle (both sides)', () => {
    // Push-ups are position-based now: no angle to measure, and the single
    // shoulder we watch is the vertical signal + body-scale anchor for its side.
    expect(EXERCISES.pushup.sides.left.angleJoints).toBeNull();
    expect(EXERCISES.pushup.sides.right.angleJoints).toBeNull();
    expect(EXERCISES.pushup.sides.left.signalJoints).toEqual(['left_shoulder']);
    expect(EXERCISES.pushup.sides.right.signalJoints).toEqual(['right_shoulder']);
  });

  it('uses MoveNet keypoint names for the sit-up tracked angle joints (both sides)', () => {
    // Sit-up tracks the hip/torso angle: shoulder -> hip -> knee, per side.
    expect(EXERCISES.situp.sides.left.angleJoints).toEqual([
      'left_shoulder',
      'left_hip',
      'left_knee',
    ]);
    expect(EXERCISES.situp.sides.right.angleJoints).toEqual([
      'right_shoulder',
      'right_hip',
      'right_knee',
    ]);
  });

  it('lists required keypoints for anti-cheat pose validation (both sides)', () => {
    // Push-ups require ONLY the shoulder on each side — no elbow, wrist or hip —
    // so the legs/hips being out of a webcam's frame never blocks counting.
    expect(EXERCISES.pushup.sides.left.requiredKeypoints).toEqual(['left_shoulder']);
    expect(EXERCISES.pushup.sides.right.requiredKeypoints).toEqual(['right_shoulder']);
    for (const side of ['left', 'right']) {
      for (const joint of ['elbow', 'wrist', 'hip']) {
        expect(EXERCISES.pushup.sides[side].requiredKeypoints).not.toContain(`${side}_${joint}`);
      }
    }
    // Sit-ups are unchanged: they still require the hip.
    expect(EXERCISES.situp.sides.left.requiredKeypoints).toContain('left_hip');
    expect(EXERCISES.situp.sides.right.requiredKeypoints).toContain('right_hip');
  });

  it('exposes all three sit-up difficulty presets as angles', () => {
    for (const difficulty of DIFFICULTIES) {
      const preset = getPreset('situp', difficulty);
      expect(typeof preset.downAngle).toBe('number');
      expect(typeof preset.upAngle).toBe('number');
      expect(typeof preset.defaultReps).toBe('number');
      // Hysteresis must hold for every sit-up preset.
      expect(preset.downAngle).toBeLessThan(preset.upAngle);
    }
  });

  it('exposes all three push-up difficulty presets as body-scale fractions', () => {
    for (const difficulty of DIFFICULTIES) {
      const preset = getPreset('pushup', difficulty);
      expect(typeof preset.downFraction).toBe('number');
      expect(typeof preset.upFraction).toBe('number');
      expect(typeof preset.defaultReps).toBe('number');
      // The vertical counter requires 0 < upFraction < downFraction.
      expect(preset.upFraction).toBeGreaterThan(0);
      expect(preset.upFraction).toBeLessThan(preset.downFraction);
    }
  });
});

describe('difficulty scaling', () => {
  it('makes hard stricter than easy for push-ups (deeper dip, more reps)', () => {
    const easy = getPreset('pushup', 'easy');
    const standard = getPreset('pushup', 'standard');
    const hard = getPreset('pushup', 'hard');

    // A bigger downFraction means you must dip DEEPER (as a fraction of your
    // own body-scale) to reach the bottom of the push-up.
    expect(hard.downFraction).toBeGreaterThan(easy.downFraction);
    expect(standard.downFraction).toBeGreaterThan(easy.downFraction);
    expect(hard.downFraction).toBeGreaterThan(standard.downFraction);
    // Hard asks for more reps. defaultReps is unchanged from the old presets.
    expect(hard.defaultReps).toBeGreaterThan(easy.defaultReps);
    expect(easy.defaultReps).toBe(10);
    expect(standard.defaultReps).toBe(20);
    expect(hard.defaultReps).toBe(45);
  });

  it('makes hard stricter than easy for sit-ups too', () => {
    const easy = getPreset('situp', 'easy');
    const hard = getPreset('situp', 'hard');

    expect(hard.downAngle).toBeLessThan(easy.downAngle);
    expect(hard.upAngle).toBeGreaterThan(easy.upAngle);
    expect(hard.defaultReps).toBeGreaterThan(easy.defaultReps);
  });

  it('throws on an unknown difficulty', () => {
    expect(() => getPreset('pushup', 'nightmare')).toThrow();
  });
});

describe('sumSideConfidence', () => {
  it('adds up the scores of the listed joints', () => {
    const keypoints = {
      left_shoulder: { score: 0.5 },
      left_elbow: { score: 0.4 },
      left_wrist: { score: 0.3 },
    };
    expect(
      sumSideConfidence(keypoints, ['left_shoulder', 'left_elbow', 'left_wrist'])
    ).toBeCloseTo(1.2, 5);
  });

  it('treats missing or scoreless keypoints as 0', () => {
    const keypoints = {
      left_shoulder: { score: 0.5 },
      // left_elbow missing entirely
      left_wrist: { x: 1, y: 2 }, // present but no score
    };
    expect(
      sumSideConfidence(keypoints, ['left_shoulder', 'left_elbow', 'left_wrist'])
    ).toBeCloseTo(0.5, 5);
  });

  it('returns 0 for invalid input', () => {
    expect(sumSideConfidence(null, ['left_hip'])).toBe(0);
    expect(sumSideConfidence({}, null)).toBe(0);
  });
});

describe('pickBetterSide', () => {
  it('picks the better-visible SHOULDER side for push-ups', () => {
    // Push-ups now choose the side whose SHOULDER the camera sees best.
    // Left shoulder barely visible, right shoulder clear.
    const keypoints = {
      left_shoulder: { score: 0.1 },
      right_shoulder: { score: 0.9 },
    };
    const result = pickBetterSide('pushup', keypoints);
    expect(result.side).toBe('right');
    // Push-ups have no angle, so angleJoints is null and requiredKeypoints is
    // the upper-body-only list.
    expect(result.angleJoints).toBeNull();
    expect(result.requiredKeypoints).toEqual(['right_shoulder']);
    expect(result.rightScore).toBeGreaterThan(result.leftScore);
  });

  it('picks the left side when the left joints are more visible', () => {
    const keypoints = {
      left_shoulder: { score: 0.9 },
      left_hip: { score: 0.9 },
      left_knee: { score: 0.9 },
      right_shoulder: { score: 0.2 },
      right_hip: { score: 0.1 },
      right_knee: { score: 0.1 },
    };
    const result = pickBetterSide('situp', keypoints);
    expect(result.side).toBe('left');
    expect(result.angleJoints).toEqual([
      'left_shoulder',
      'left_hip',
      'left_knee',
    ]);
  });

  it('defaults to the left side on a tie (including nothing visible)', () => {
    // No keypoints at all: both sides score 0, so we fall back to the left.
    const result = pickBetterSide('pushup', {});
    expect(result.side).toBe('left');
    expect(result.leftScore).toBe(0);
    expect(result.rightScore).toBe(0);
  });
});

describe('exercise orientation descriptors', () => {
  it('push-ups do NOT gate on orientation (upper-body vertical detection handles it)', () => {
    // 'any' on purpose: the old 'horizontal' gate needed the hip, which is out
    // of frame on a webcam. A standing bob is rejected by the body-relative
    // vertical excursion + hysteresis + the 5s arming countdown instead.
    expect(EXERCISES.pushup.orientation).toBe('any');
  });

  it('sit-ups use a lenient horizontal sanity check', () => {
    expect(EXERCISES.situp.orientation).toBe('horizontal');
    expect(EXERCISES.situp.orientationMaxTiltDegrees).toBeGreaterThan(45);
  });
});

describe('evaluateOrientation', () => {
  // SIT-UPS still use the lenient horizontal gate, so we exercise that behavior
  // through sit-ups (push-ups no longer gate on orientation at all).
  it('passes a sit-up when the body is horizontal', () => {
    // Shoulder and hip at the same height (lying down).
    const keypoints = {
      left_shoulder: { x: 100, y: 300, score: 0.9 },
      left_hip: { x: 300, y: 305, score: 0.9 },
    };
    expect(evaluateOrientation('situp', keypoints, 'left')).toBe(true);
  });

  it('rejects a sit-up when the body is fully standing upright', () => {
    // Shoulder high, hip far below: an upright standing torso. Even the lenient
    // sit-up tilt threshold (75 degrees) rejects a near-vertical torso.
    const keypoints = {
      left_shoulder: { x: 100, y: 100, score: 0.9 },
      left_hip: { x: 108, y: 350, score: 0.9 },
    };
    expect(evaluateOrientation('situp', keypoints, 'left')).toBe(false);
  });

  it('does not block a sit-up when the shoulder or hip is missing', () => {
    expect(evaluateOrientation('situp', { left_shoulder: { x: 1, y: 1 } }, 'left')).toBe(true);
    expect(evaluateOrientation('situp', {}, 'left')).toBe(true);
  });

  // PUSH-UPS: orientation must NEVER block counting now, including when the hip
  // is out of frame — that is the whole point of Solution 1.
  it('never blocks a push-up on orientation, even when the hip is missing', () => {
    // Hip absent entirely (out of frame): still returns true.
    expect(evaluateOrientation('pushup', { left_shoulder: { x: 1, y: 1, score: 0.9 } }, 'left')).toBe(true);
    // No keypoints at all: still returns true.
    expect(evaluateOrientation('pushup', {}, 'left')).toBe(true);
    // Even a "standing upright" shoulder+hip layout returns true for push-ups,
    // because the orientation is 'any' — rejecting a standing bob is the
    // vertical counter's job, proven in verticalRepCounter.test.js.
    const standing = {
      left_shoulder: { x: 100, y: 100, score: 0.9 },
      left_hip: { x: 108, y: 350, score: 0.9 },
    };
    expect(evaluateOrientation('pushup', standing, 'left')).toBe(true);
  });
});

describe('push-up anti-cheat: upper-body requirements', () => {
  // Push-ups are counted from upper-body vertical movement, so the descriptor
  // must not require the lower-body / arm joints a webcam cannot fit, and
  // orientation must not block counting. (The "standing bob counts zero"
  // behavior itself lives with the vertical counter — see
  // verticalRepCounter.test.js — because that is where the body-relative
  // excursion + hysteresis actually reject a small standing nod.)
  it('does not require elbow, wrist or hip on either side', () => {
    for (const side of ['left', 'right']) {
      const required = EXERCISES.pushup.sides[side].requiredKeypoints;
      expect(required).toEqual([`${side}_shoulder`]);
      expect(required).not.toContain(`${side}_elbow`);
      expect(required).not.toContain(`${side}_wrist`);
      expect(required).not.toContain(`${side}_hip`);
    }
  });

  it('pickBetterSide + evaluateOrientation keep counting unblocked when the hip is out of frame', () => {
    // A frame with only the chosen shoulder visible (legs/hips out of frame).
    const frame = { right_shoulder: { x: 400, y: 200, score: 0.9 } };
    const { side, requiredKeypoints } = pickBetterSide('pushup', frame);
    expect(side).toBe('right');
    expect(requiredKeypoints).toEqual(['right_shoulder']);
    // Orientation must NOT block, so push-up counting can proceed.
    expect(evaluateOrientation('pushup', frame, side)).toBe(true);
  });
});
