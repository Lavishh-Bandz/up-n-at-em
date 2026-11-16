import { describe, it, expect } from 'vitest';
import {
  measureBodyScale,
  measureUpperBodyY,
  isPushupPosture,
  createPostureGuard,
  createBodyScaleTracker,
  createUpperBodySignalValidator,
  isReadyForArming,
  DEFAULT_POSTURE_CONFIG,
  DEFAULT_SIGNAL_VALIDATOR_CONFIG,
  DEFAULT_READY_CONFIG,
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

describe('createUpperBodySignalValidator (rejects garbage MoveNet frames)', () => {
  // Body-scale ruler used throughout. 100px keeps the jump math easy: a jump of
  // N px is N/100 of a body-scale.
  const RULER = 100;

  it('accepts a sane in-range reading and seeds the teleport memory', () => {
    const v = createUpperBodySignalValidator();
    const r = v.update(558, RULER); // the user's sane starting value
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('REJECTS a negative upperBodyY (impossible pixel row) like the logged -39/-64', () => {
    const v = createUpperBodySignalValidator();
    v.update(558, RULER); // a good frame first
    expect(v.update(-39, RULER)).toEqual({ ok: false, reason: 'negative' });
    expect(v.update(-64, RULER)).toEqual({ ok: false, reason: 'negative' });
  });

  it('REJECTS a reading past the bottom of the frame when the height is known', () => {
    const v = createUpperBodySignalValidator();
    v.update(300, RULER);
    // Frame is 480px tall; 999 is off the bottom edge.
    expect(v.update(999, RULER, 480)).toEqual({
      ok: false,
      reason: 'out-of-frame',
    });
  });

  it('REJECTS an absurd value via the hard cap when the frame height is unknown', () => {
    const v = createUpperBodySignalValidator();
    v.update(300, RULER);
    const huge = DEFAULT_SIGNAL_VALIDATOR_CONFIG.maxPlausibleY + 1;
    expect(v.update(huge, RULER)).toEqual({ ok: false, reason: 'out-of-frame' });
  });

  it('REJECTS a teleport bigger than maxJumpFraction of a body-scale', () => {
    const v = createUpperBodySignalValidator(); // default maxJumpFraction 0.75
    v.update(0, RULER); // accepted, seeds memory at y=0
    // A jump from 0 to 504 against a 255px ruler is ~2.0 body-scales -> teleport.
    expect(v.update(504, 255)).toEqual({ ok: false, reason: 'teleport' });
  });

  it('keeps the LAST GOOD y as the reference so one teleport does not drag it', () => {
    const v = createUpperBodySignalValidator();
    expect(v.update(300, RULER).ok).toBe(true); // reference = 300
    expect(v.update(600, RULER).ok).toBe(false); // teleport (+300 = 3.0 scale)
    // A sane frame near the LAST GOOD value (300) is accepted, proving the
    // teleport did not move the reference to 600.
    expect(v.update(320, RULER).ok).toBe(true);
  });

  it('ACCEPTS a realistic per-frame dip (small fraction of a body-scale)', () => {
    const v = createUpperBodySignalValidator();
    // A real push-up descends gradually: ~15px/frame against a 255px ruler is
    // ~0.06 of a body-scale, well under 0.75.
    let y = 558;
    expect(v.update(y, 255).ok).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      y += 15;
      expect(v.update(y, 255).ok).toBe(true);
    }
  });

  it('skips the teleport check when there is no ruler (RULE 1 still applies)', () => {
    const v = createUpperBodySignalValidator();
    v.update(300, null); // no ruler -> cannot judge a jump, but y is in range
    // Big change but no ruler to measure it against -> accepted (RULE 1 ok).
    expect(v.update(900, null).ok).toBe(true);
    // A negative is still rejected regardless of ruler.
    expect(v.update(-5, null)).toEqual({ ok: false, reason: 'negative' });
  });

  it('treats a non-numeric / NaN reading as invalid without dropping the reference', () => {
    const v = createUpperBodySignalValidator();
    expect(v.update(300, RULER).ok).toBe(true);
    expect(v.update(null, RULER)).toEqual({ ok: false, reason: 'invalid' });
    expect(v.update(NaN, RULER)).toEqual({ ok: false, reason: 'invalid' });
    // The reference is still 300, so a nearby frame is accepted.
    expect(v.update(305, RULER).ok).toBe(true);
  });

  it('reset() forgets the accepted-y memory for a new step', () => {
    const v = createUpperBodySignalValidator();
    v.update(300, RULER);
    v.reset();
    // After reset the first frame always seeds fresh memory, so a value far
    // from the old reference is accepted (no history to compare against).
    expect(v.update(900, RULER).ok).toBe(true);
  });

  it('exposes tunable default config', () => {
    expect(typeof DEFAULT_SIGNAL_VALIDATOR_CONFIG.maxJumpFraction).toBe('number');
    expect(DEFAULT_SIGNAL_VALIDATOR_CONFIG.maxJumpFraction).toBeGreaterThan(0);
    expect(typeof DEFAULT_SIGNAL_VALIDATOR_CONFIG.maxPlausibleY).toBe('number');
  });
});

describe('isReadyForArming (gates the get-into-position countdown, side-view)', () => {
  // 100px body-scale ruler keeps fractions easy (0.5 of scale = 50px).
  const READY_SCALE = 100;

  // --- CUE LEVEL: shoulder-to-hip vertical gap (the strong side-on cue) ---

  it('is READY for a side-view DOWN position: shoulder and hip roughly level', () => {
    // Side-on plank: shoulder and hip at nearly the same height (torso near
    // horizontal). Here the shoulder is at y=300 and the hip at y=320, a 20px
    // (0.2 of scale) vertical gap -> well under 0.5 -> ready.
    const down = {
      left_shoulder: kp(200, 300),
      left_hip: kp(120, 320),
    };
    expect(isReadyForArming(down, 'left', READY_SCALE)).toBe(true);
  });

  it('is NOT READY while STANDING side-on: shoulder stacked high above the hip', () => {
    // Standing: the shoulder sits a full body-scale ABOVE the hip (shoulder
    // y=200, hip y=300 -> 100px = 1.0 of scale vertical gap) -> not ready, so
    // the countdown would NOT advance. This is the exact bug the user hit.
    const standing = {
      left_shoulder: kp(200, 200),
      left_hip: kp(205, 300),
    };
    expect(isReadyForArming(standing, 'left', READY_SCALE)).toBe(false);
  });

  it('uses the chosen side hip for the level cue (right side)', () => {
    const downRight = {
      right_shoulder: kp(200, 300),
      right_hip: kp(120, 315),
    };
    expect(isReadyForArming(downRight, 'right', READY_SCALE)).toBe(true);
  });

  it('ignores a LOW-CONFIDENCE hip and falls back to the next cue', () => {
    // Hip present but too low-confidence to trust: with no wrists and a nose
    // far above the shoulder (standing head), we must NOT arm.
    const standingNose = {
      left_shoulder: kp(200, 300),
      left_hip: kp(205, 400, 0.1), // low score -> not trusted
      nose: kp(200, 240), // 60px above shoulder = 0.6 of scale -> standing
    };
    expect(isReadyForArming(standingNose, 'left', READY_SCALE)).toBe(false);
  });

  // --- CUE PLANTED: wrists on the floor when the hip is not available ---

  it('is READY on PLANTED wrists when the hip is not visible', () => {
    // No hip (common side-on), but both wrists are confidently planted BELOW
    // the shoulder line (hands on the floor) -> ready.
    const planted = {
      left_shoulder: kp(200, 300),
      left_wrist: kp(180, 330), // 30px below (0.3 of scale) -> planted
      right_wrist: kp(220, 330),
    };
    expect(isReadyForArming(planted, 'left', READY_SCALE)).toBe(true);
  });

  it('is NOT READY when visible wrists are ABOVE the shoulder (hands not planted)', () => {
    const handsUp = {
      left_shoulder: kp(200, 300),
      left_wrist: kp(180, 260), // ABOVE the shoulder -> not planted
      right_wrist: kp(220, 260),
    };
    expect(isReadyForArming(handsUp, 'left', READY_SCALE)).toBe(false);
  });

  // --- CUE HEAD: nose near shoulder height (last-resort fallback) ---

  it('is READY on the head cue: nose near shoulder height, no hip/wrists', () => {
    // Only shoulder + nose. Head has dropped to near shoulder level (10px above
    // = 0.1 of scale, under the 0.35 ready threshold) -> ready.
    const headDown = {
      left_shoulder: kp(200, 300),
      nose: kp(210, 290),
    };
    expect(isReadyForArming(headDown, 'left', READY_SCALE)).toBe(true);
  });

  it('is NOT READY on the head cue when the nose sits well above the shoulder', () => {
    // Head is up (40px above = 0.4 of scale > the 0.35 ready threshold). This is
    // TIGHTER than isPushupPosture, which would still pass this (its reject
    // threshold is 0.6) -> proves the arming check is stricter about "down".
    const headUp = {
      left_shoulder: kp(200, 300),
      nose: kp(210, 260),
    };
    expect(isReadyForArming(headUp, 'left', READY_SCALE)).toBe(false);
  });

  // --- FAIL TOWARD NOT ARMING (the key behaviour change) ---

  it('FAILS TOWARD NOT READY when it cannot tell (opposite of isPushupPosture)', () => {
    // Only a shoulder: no hip, no wrists, no nose. isPushupPosture fails OPEN
    // (true) here so it never blocks a counted rep; the arming check must do the
    // OPPOSITE and fail toward NOT ready so a bare shoulder cannot arm.
    const bare = { left_shoulder: kp(200, 300) };
    expect(isPushupPosture(bare, 'left', READY_SCALE)).toBe(true);
    expect(isReadyForArming(bare, 'left', READY_SCALE)).toBe(false);

    // No ruler, no keypoints, missing shoulder -> all NOT ready.
    expect(isReadyForArming(bare, 'left', 0)).toBe(false);
    expect(isReadyForArming(null, 'left', READY_SCALE)).toBe(false);
    expect(isReadyForArming({}, 'left', READY_SCALE)).toBe(false);
    expect(isReadyForArming({ nose: kp(200, 200) }, 'left', READY_SCALE)).toBe(
      false
    );
  });

  it('exposes tunable default ready config', () => {
    expect(typeof DEFAULT_READY_CONFIG.maxShoulderHipVerticalFraction).toBe(
      'number'
    );
    expect(DEFAULT_READY_CONFIG.maxShoulderHipVerticalFraction).toBeGreaterThan(
      0
    );
    expect(typeof DEFAULT_READY_CONFIG.maxNoseAboveFraction).toBe('number');
    expect(typeof DEFAULT_READY_CONFIG.wristPlantedMargin).toBe('number');
  });
});
