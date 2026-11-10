import { describe, it, expect } from 'vitest';
import {
  measureBodyScale,
  measureUpperBodyY,
  isPushupPosture,
  createPostureGuard,
  createBodyScaleTracker,
  DEFAULT_POSTURE_CONFIG,
} from '../upperBodySignal.js';

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

// A body-scale ruler used across the posture tests. 100px keeps fractions easy:
// a fraction maps straight to pixels (0.6 of scale = 60px).
const SCALE = 100;

describe('isPushupPosture (anti-standing guard, upper-body only)', () => {
  it('passes a genuine push-up: head near shoulder height, wrists planted', () => {
    // Down in a plank: nose only a little above the shoulder (small gap), and
    // both wrists well BELOW the shoulder line (planted on the floor).
    const frame = {
      left_shoulder: kp(100, 200),
      right_shoulder: kp(160, 200),
      nose: kp(130, 190), // only 10px above the shoulder (0.1 of scale)
      left_wrist: kp(90, 230), // 30px below shoulder (0.3 of scale) -> planted
      right_wrist: kp(170, 230),
    };
    expect(isPushupPosture(frame, 'left', SCALE)).toBe(true);
  });

  it('REJECTS a standing-tall posture (nose far above the shoulders)', () => {
    // Standing: the head sits a big fraction of body-scale above the shoulders.
    // 70px above on a 100px scale = 0.7 > uprightNoseFraction (0.6) -> reject.
    const standing = {
      left_shoulder: kp(100, 300),
      right_shoulder: kp(160, 300),
      nose: kp(130, 230),
    };
    expect(isPushupPosture(standing, 'left', SCALE)).toBe(false);
  });

  it('REJECTS visible-but-dangling wrists (hands not planted while standing)', () => {
    // Head not stacked high (passes CUE B), but both wrists are ABOVE the
    // shoulder line (hands up), i.e. clearly not planted -> reject via CUE A.
    const handsUp = {
      left_shoulder: kp(100, 300),
      right_shoulder: kp(160, 300),
      nose: kp(130, 290), // small gap, passes CUE B
      left_wrist: kp(90, 250), // ABOVE the shoulder -> not planted
      right_wrist: kp(170, 250),
    };
    expect(isPushupPosture(handsUp, 'left', SCALE)).toBe(false);
  });

  it('passes on CUE B alone when wrists are NOT confidently visible', () => {
    // No usable wrists (low score) -> we rely on the not-upright torso check,
    // which a genuine push-up passes. This is the side-view / wrists-hidden
    // case we must NOT block.
    const frame = {
      left_shoulder: kp(100, 200),
      nose: kp(110, 195), // tiny gap -> not standing
      left_wrist: kp(90, 230, 0.1), // too low-confidence to trust
      right_wrist: kp(170, 230, 0.1),
    };
    expect(isPushupPosture(frame, 'left', SCALE)).toBe(true);
  });

  it('fails OPEN (true) on degenerate/missing input so it never silently blocks', () => {
    expect(isPushupPosture(null, 'left', SCALE)).toBe(true);
    expect(isPushupPosture({}, 'left', SCALE)).toBe(true);
    // No body-scale -> cannot judge -> fail open.
    expect(isPushupPosture({ left_shoulder: kp(100, 200) }, 'left', 0)).toBe(true);
    expect(isPushupPosture({ left_shoulder: kp(100, 200) }, 'left', null)).toBe(true);
    // Shoulder missing -> no anchor -> fail open.
    expect(isPushupPosture({ nose: kp(100, 100) }, 'left', SCALE)).toBe(true);
  });

  it('exposes tunable default config', () => {
    expect(typeof DEFAULT_POSTURE_CONFIG.wristPlantedMargin).toBe('number');
    expect(typeof DEFAULT_POSTURE_CONFIG.uprightNoseFraction).toBe('number');
    expect(DEFAULT_POSTURE_CONFIG.uprightNoseFraction).toBeGreaterThan(0);
  });
});

describe('createPostureGuard (adds roughly-stationary wrists)', () => {
  it('rejects a WALKING swing: wrists move a lot between frames', () => {
    const guard = createPostureGuard();
    const scale = SCALE;
    // Frame 1 establishes history; posture itself looks plausible (not upright,
    // wrists planted) so only the SWING on frame 2 should reject.
    const f1 = {
      left_shoulder: kp(100, 200),
      right_shoulder: kp(160, 200),
      nose: kp(130, 195),
      left_wrist: kp(90, 230),
      right_wrist: kp(170, 230),
    };
    expect(guard.update(f1, 'left', scale)).toBe(true);

    // Frame 2: wrists swung ~40px (0.4 of scale) > wristStationaryFraction 0.2.
    const f2 = {
      left_shoulder: kp(100, 200),
      right_shoulder: kp(160, 200),
      nose: kp(130, 195),
      left_wrist: kp(130, 230),
      right_wrist: kp(210, 230),
    };
    expect(guard.update(f2, 'left', scale)).toBe(false);
  });

  it('passes PLANTED hands that barely move between frames', () => {
    const guard = createPostureGuard();
    const scale = SCALE;
    const base = {
      left_shoulder: kp(100, 200),
      right_shoulder: kp(160, 200),
      nose: kp(130, 195),
      left_wrist: kp(90, 230),
      right_wrist: kp(170, 230),
    };
    expect(guard.update(base, 'left', scale)).toBe(true);
    // A couple of px of jitter is well under the stationary threshold.
    const jittered = {
      left_shoulder: kp(100, 200),
      right_shoulder: kp(160, 200),
      nose: kp(130, 195),
      left_wrist: kp(92, 231),
      right_wrist: kp(171, 229),
    };
    expect(guard.update(jittered, 'left', scale)).toBe(true);
  });

  it('reset() forgets wrist history', () => {
    const guard = createPostureGuard();
    const scale = SCALE;
    const f = {
      left_shoulder: kp(100, 200),
      right_shoulder: kp(160, 200),
      nose: kp(130, 195),
      left_wrist: kp(90, 230),
      right_wrist: kp(170, 230),
    };
    guard.update(f, 'left', scale);
    guard.reset();
    // After reset there is no history, so a far-moved wrist cannot be flagged
    // as a swing on the very first post-reset frame (nothing to compare to).
    const moved = {
      left_shoulder: kp(100, 200),
      right_shoulder: kp(160, 200),
      nose: kp(130, 195),
      left_wrist: kp(130, 230),
      right_wrist: kp(210, 230),
    };
    expect(guard.update(moved, 'left', scale)).toBe(true);
  });
});

describe('createBodyScaleTracker (stable locked ruler)', () => {
  it('smooths candidates while arming, then locks and reuses the value', () => {
    const tracker = createBodyScaleTracker({ windowSize: 10 });
    expect(tracker.locked).toBe(false);
    expect(tracker.scale).toBeNull();

    // Arming: shoulder width wobbles around 100 as the user settles.
    tracker.push(96, true);
    tracker.push(104, true);
    tracker.push(100, true);
    // Smoothed candidate is the average so far (~100), not locked yet.
    expect(tracker.scale).toBeCloseTo(100);
    expect(tracker.locked).toBe(false);

    const locked = tracker.lock();
    expect(locked).toBeCloseTo(100);
    expect(tracker.locked).toBe(true);

    // Once locked, later wildly-swinging widths are IGNORED: the ruler holds.
    tracker.push(250, true);
    tracker.push(40, true);
    expect(tracker.scale).toBeCloseTo(100);
  });

  it('ignores unconfident / non-positive candidates while arming', () => {
    const tracker = createBodyScaleTracker();
    tracker.push(100, true);
    tracker.push(999, false); // not confident -> ignored
    tracker.push(0, true); // non-positive -> ignored
    tracker.push(-5, true); // negative -> ignored
    tracker.push(null, true); // non-numeric -> ignored
    expect(tracker.scale).toBeCloseTo(100);
  });

  it('stays unlocked (null) if nothing usable was ever seen', () => {
    const tracker = createBodyScaleTracker();
    tracker.push(0, true);
    tracker.push(100, false);
    expect(tracker.lock()).toBeNull();
    expect(tracker.locked).toBe(false);
    expect(tracker.scale).toBeNull();
  });

  it('reset() clears the lock for the next step', () => {
    const tracker = createBodyScaleTracker();
    tracker.push(100, true);
    tracker.lock();
    expect(tracker.locked).toBe(true);
    tracker.reset();
    expect(tracker.locked).toBe(false);
    expect(tracker.scale).toBeNull();
  });
});
