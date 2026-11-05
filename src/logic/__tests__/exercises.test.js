import { describe, it, expect } from 'vitest';
import {
  EXERCISES,
  DIFFICULTIES,
  getExercise,
  getPreset,
} from '../exercises.js';

describe('exercise descriptors', () => {
  it('defines pushup and situp', () => {
    expect(getExercise('pushup').id).toBe('pushup');
    expect(getExercise('situp').id).toBe('situp');
  });

  it('throws on an unknown exercise', () => {
    expect(() => getExercise('backflip')).toThrow();
  });

  it('uses MoveNet keypoint names for the tracked angle joints', () => {
    // Push-up tracks the elbow angle: shoulder -> elbow -> wrist.
    expect(EXERCISES.pushup.angleJoints).toEqual([
      'left_shoulder',
      'left_elbow',
      'left_wrist',
    ]);
    // Sit-up tracks the hip/torso angle: shoulder -> hip -> knee.
    expect(EXERCISES.situp.angleJoints).toEqual([
      'left_shoulder',
      'left_hip',
      'left_knee',
    ]);
  });

  it('lists required keypoints for anti-cheat pose validation', () => {
    expect(EXERCISES.pushup.requiredKeypoints).toContain('left_elbow');
    expect(EXERCISES.situp.requiredKeypoints).toContain('left_hip');
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
