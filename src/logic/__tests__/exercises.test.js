import { describe, it, expect } from 'vitest';
import {
  EXERCISES,
  DIFFICULTIES,
  getExercise,
  getPreset,
  sumSideConfidence,
  pickBetterSide,
} from '../exercises.js';

describe('exercise descriptors', () => {
  it('defines pushup and situp', () => {
    expect(getExercise('pushup').id).toBe('pushup');
    expect(getExercise('situp').id).toBe('situp');
  });

  it('throws on an unknown exercise', () => {
    expect(() => getExercise('backflip')).toThrow();
  });

  it('uses MoveNet keypoint names for the tracked angle joints (both sides)', () => {
    // Push-up tracks the elbow angle: shoulder -> elbow -> wrist, per side.
    expect(EXERCISES.pushup.sides.left.angleJoints).toEqual([
      'left_shoulder',
      'left_elbow',
      'left_wrist',
    ]);
    expect(EXERCISES.pushup.sides.right.angleJoints).toEqual([
      'right_shoulder',
      'right_elbow',
      'right_wrist',
    ]);
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
    expect(EXERCISES.pushup.sides.left.requiredKeypoints).toContain('left_elbow');
    expect(EXERCISES.pushup.sides.right.requiredKeypoints).toContain('right_elbow');
    expect(EXERCISES.situp.sides.left.requiredKeypoints).toContain('left_hip');
    expect(EXERCISES.situp.sides.right.requiredKeypoints).toContain('right_hip');
  });

  it('exposes all three difficulty presets per exercise', () => {
    for (const id of Object.keys(EXERCISES)) {
      for (const difficulty of DIFFICULTIES) {
        const preset = getPreset(id, difficulty);
        expect(typeof preset.downAngle).toBe('number');
        expect(typeof preset.upAngle).toBe('number');
        expect(typeof preset.defaultReps).toBe('number');
        // Hysteresis must hold for every preset.
        expect(preset.downAngle).toBeLessThan(preset.upAngle);
      }
    }
  });
});

describe('difficulty scaling', () => {
  it('makes hard stricter than easy for push-ups (deeper bend, straighter lockout, more reps)', () => {
    const easy = getPreset('pushup', 'easy');
    const hard = getPreset('pushup', 'hard');

    // A smaller downAngle means you must bend DEEPER.
    expect(hard.downAngle).toBeLessThan(easy.downAngle);
    // A larger upAngle means you must straighten MORE at the top.
    expect(hard.upAngle).toBeGreaterThan(easy.upAngle);
    // Hard asks for more reps.
    expect(hard.defaultReps).toBeGreaterThan(easy.defaultReps);
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
  it('picks the right side when the right joints are more visible', () => {
    // Left side barely visible, right side clear.
    const keypoints = {
      left_shoulder: { score: 0.1 },
      left_elbow: { score: 0.1 },
      left_wrist: { score: 0.1 },
      right_shoulder: { score: 0.9 },
      right_elbow: { score: 0.8 },
      right_wrist: { score: 0.7 },
    };
    const result = pickBetterSide('pushup', keypoints);
    expect(result.side).toBe('right');
    expect(result.angleJoints).toEqual([
      'right_shoulder',
      'right_elbow',
      'right_wrist',
    ]);
    expect(result.requiredKeypoints).toEqual([
      'right_shoulder',
      'right_elbow',
      'right_wrist',
    ]);
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
