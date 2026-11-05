import { describe, it, expect } from 'vitest';
import {
  angleBetween,
  isConfident,
  allConfident,
  isBodyHorizontal,
  createAngleSmoother,
} from '../angles.js';

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

describe('isBodyHorizontal', () => {
  it('is true when the shoulder->hip line is flat (lying / push-up position)', () => {
    // Shoulder and hip at the same height, spread out sideways: tilt ~0 degrees.
    const shoulder = { x: 100, y: 200 };
    const hip = { x: 300, y: 205 };
    expect(isBodyHorizontal(shoulder, hip)).toBe(true);
  });

  it('is false when the body is upright (standing)', () => {
    // Shoulder high up, hip far below it, barely any sideways spread: tilt ~90.
    const shoulder = { x: 100, y: 100 };
    const hip = { x: 105, y: 350 };
    expect(isBodyHorizontal(shoulder, hip)).toBe(false);
  });

  it('still accepts a push-up seen from a slightly tilted camera', () => {
    // Torso tilted ~30 degrees off flat: within the default 45-degree budget.
    const shoulder = { x: 100, y: 200 };
    const hip = { x: 300, y: 200 + 200 * Math.tan((30 * Math.PI) / 180) };
    expect(isBodyHorizontal(shoulder, hip)).toBe(true);
  });

  it('respects a custom maxTiltDegrees', () => {
    // ~60 degrees of tilt: rejected by the default 45, allowed by a lenient 75.
    const shoulder = { x: 100, y: 200 };
    const hip = { x: 300, y: 200 + 200 * Math.tan((60 * Math.PI) / 180) };
    expect(isBodyHorizontal(shoulder, hip)).toBe(false);
    expect(isBodyHorizontal(shoulder, hip, { maxTiltDegrees: 75 })).toBe(true);
  });

  it('returns false when a point is missing or degenerate', () => {
    expect(isBodyHorizontal(null, { x: 1, y: 1 })).toBe(false);
    expect(isBodyHorizontal({ x: 1, y: 1 }, undefined)).toBe(false);
    // Both points identical: no line to measure.
    expect(isBodyHorizontal({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(false);
  });
});

describe('createAngleSmoother', () => {
  it('averages the most recent readings within the window', () => {
    const smoother = createAngleSmoother({ windowSize: 3 });
    expect(smoother.push(90)).toBeCloseTo(90, 5); // [90]
    expect(smoother.push(120)).toBeCloseTo(105, 5); // [90,120]
    expect(smoother.push(150)).toBeCloseTo(120, 5); // [90,120,150]
    // Window is full; the oldest (90) drops off.
    expect(smoother.push(150)).toBeCloseTo(140, 5); // [120,150,150]
  });

  it('suppresses a single-frame spike', () => {
    // A steady ~100-degree reading with one wild 180 spike in the middle.
    const smoother = createAngleSmoother({ windowSize: 5 });
    smoother.push(100);
    smoother.push(100);
    const spiked = smoother.push(180); // the bad frame
    // The smoothed value is pulled nowhere near the raw 180 spike: the two
    // good neighbours dilute it, so a single bad frame cannot cross a threshold.
    expect(spiked).toBeLessThan(130);
    expect(spiked).toBeGreaterThan(100);
  });

  it('exposes the current value and resets', () => {
    const smoother = createAngleSmoother({ windowSize: 3 });
    expect(smoother.value).toBeNull();
    smoother.push(90);
    smoother.push(110);
    expect(smoother.value).toBeCloseTo(100, 5);
    smoother.reset();
    expect(smoother.value).toBeNull();
  });

  it('defaults to a window of at least 1 for bad input', () => {
    const smoother = createAngleSmoother({ windowSize: 0 });
    expect(smoother.push(42)).toBe(42);
    // Only keeps the latest reading.
    expect(smoother.push(100)).toBe(100);
  });
});
