import { describe, it, expect } from 'vitest';
import { angleBetween, isConfident, allConfident } from '../angles.js';

describe('angleBetween', () => {
  it('measures a straight line as ~180 degrees', () => {
    // a --- vertex --- c all on one horizontal line: the joint is fully open.
    const a = { x: 0, y: 0 };
    const vertex = { x: 1, y: 0 };
    const c = { x: 2, y: 0 };
    expect(angleBetween(a, vertex, c)).toBeCloseTo(180, 5);
  });

  it('measures a right angle as ~90 degrees', () => {
    // One arm points left, the other points up from the vertex => 90 degrees.
    const a = { x: 0, y: 0 }; // to the left of the vertex
    const vertex = { x: 1, y: 0 };
    const c = { x: 1, y: 1 }; // straight down (in image coords) from the vertex
    expect(angleBetween(a, vertex, c)).toBeCloseTo(90, 5);
  });

  it('measures a 45 degree bend', () => {
    // From the vertex: arm `a` points straight right (toward +x, 0 degrees),
    // arm `c` points up-right along the 45-degree diagonal. The opening between
    // them is 45 degrees.
    const vertex = { x: 0, y: 0 };
    const a = { x: 1, y: 0 };
    const c = { x: 1, y: -1 };
    expect(angleBetween(a, vertex, c)).toBeCloseTo(45, 5);
  });

  it('never returns a reflex angle (stays within 0..180)', () => {
    const a = { x: 0, y: -1 };
    const vertex = { x: 0, y: 0 };
    const c = { x: 0.0001, y: -1 };
    const result = angleBetween(a, vertex, c);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(180);
  });
});

describe('isConfident', () => {
  it('accepts a keypoint at or above the threshold', () => {
    expect(isConfident({ x: 1, y: 2, score: 0.5 }, 0.3)).toBe(true);
    expect(isConfident({ x: 1, y: 2, score: 0.3 }, 0.3)).toBe(true);
  });

  it('rejects a low-confidence keypoint', () => {
    expect(isConfident({ x: 1, y: 2, score: 0.1 }, 0.3)).toBe(false);
  });

  it('rejects missing or scoreless keypoints', () => {
    expect(isConfident(undefined, 0.3)).toBe(false);
    expect(isConfident(null, 0.3)).toBe(false);
    expect(isConfident({ x: 1, y: 2 }, 0.3)).toBe(false);
  });
});

describe('allConfident', () => {
  it('is true only when every keypoint clears the threshold', () => {
    const good = [
      { score: 0.9 },
      { score: 0.5 },
      { score: 0.4 },
    ];
    expect(allConfident(good, 0.3)).toBe(true);
  });

  it('is false if any keypoint is below the threshold', () => {
    const mixed = [{ score: 0.9 }, { score: 0.1 }];
    expect(allConfident(mixed, 0.3)).toBe(false);
  });

  it('is false for an empty or invalid list', () => {
    expect(allConfident([], 0.3)).toBe(false);
    expect(allConfident(undefined, 0.3)).toBe(false);
  });
});
