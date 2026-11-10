import { describe, it, expect } from 'vitest';
import { measureBodyScale, measureUpperBodyY } from '../upperBodySignal.js';

// Small helper to build a keypoint quickly.
const kp = (x, y, score = 0.9) => ({ x, y, score });

describe('measureBodyScale', () => {
  it('returns the shoulder width when both shoulders are present', () => {
    // Shoulders 40px apart horizontally, same y -> width = 40.
    const scale = measureBodyScale({
      left_shoulder: kp(100, 200),
      right_shoulder: kp(140, 200),
    });
    expect(scale).toBeCloseTo(40);
  });

  it('measures shoulder width diagonally too', () => {
    // 3-4-5 triangle -> distance 5 (times 10 = 50px apart).
    const scale = measureBodyScale({
      left_shoulder: kp(0, 0),
      right_shoulder: kp(30, 40),
    });
    expect(scale).toBeCloseTo(50);
  });

  it('falls back to nose-to-shoulder when a shoulder is missing', () => {
    // Only the left shoulder + nose are present. Distance nose->shoulder = 30.
    const scale = measureBodyScale({
      left_shoulder: kp(100, 200),
      nose: kp(100, 170),
    });
    expect(scale).toBeCloseTo(30);
  });

  it('falls back to nose-to-right-shoulder when only the right shoulder is present', () => {
    const scale = measureBodyScale({
      right_shoulder: kp(100, 200),
      nose: kp(100, 160),
    });
    expect(scale).toBeCloseTo(40);
  });

  it('returns null when both shoulders sit on top of each other (degenerate) and no nose', () => {
    const scale = measureBodyScale({
      left_shoulder: kp(100, 200),
      right_shoulder: kp(100, 200),
    });
    expect(scale).toBeNull();
  });

  it('returns null when there are no usable points', () => {
    expect(measureBodyScale({})).toBeNull();
    expect(measureBodyScale(null)).toBeNull();
    // A lone shoulder with no other shoulder and no nose: nothing to measure.
    expect(measureBodyScale({ left_shoulder: kp(100, 200) })).toBeNull();
  });
});

describe('measureUpperBodyY', () => {
  it('averages the chosen shoulder and the nose when the nose is present', () => {
    // Left shoulder y = 200, nose y = 160 -> average 180.
    const y = measureUpperBodyY(
      { left_shoulder: kp(100, 200), nose: kp(100, 160) },
      'left'
    );
    expect(y).toBeCloseTo(180);
  });

  it('uses the right shoulder when side is "right"', () => {
    const y = measureUpperBodyY(
      {
        left_shoulder: kp(100, 999),
        right_shoulder: kp(140, 200),
        nose: kp(120, 160),
      },
      'right'
    );
    // Right shoulder 200 averaged with nose 160 -> 180.
    expect(y).toBeCloseTo(180);
  });

  it('returns the shoulder y on its own when the nose is absent', () => {
    const y = measureUpperBodyY({ left_shoulder: kp(100, 200) }, 'left');
    expect(y).toBeCloseTo(200);
  });

  it('returns null when the chosen shoulder is missing', () => {
    expect(
      measureUpperBodyY({ right_shoulder: kp(140, 200) }, 'left')
    ).toBeNull();
    expect(measureUpperBodyY({}, 'left')).toBeNull();
    expect(measureUpperBodyY(null, 'left')).toBeNull();
  });
});
