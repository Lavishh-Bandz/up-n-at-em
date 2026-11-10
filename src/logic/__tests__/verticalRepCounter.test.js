import { describe, it, expect } from 'vitest';
import { createVerticalRepCounter } from '../verticalRepCounter.js';

// Shared, easy-to-read thresholds for most tests:
//   downFraction 0.2 -> must dip to 20% of body-scale below rest to go 'down'
//   upFraction   0.1 -> must rise back above 10% to complete the rep
// With bodyScalePx = 100, a fraction maps straight to pixels: 0.2 = 20px.
const makeCounter = () =>
  createVerticalRepCounter({ downFraction: 0.2, upFraction: 0.1 });

describe('createVerticalRepCounter', () => {
  it('starts in the up phase with zero reps', () => {
    const counter = makeCounter();
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(0);
  });

  it('throws on bad fraction ordering (and non-positive fractions)', () => {
    // upFraction must be strictly less than downFraction.
    expect(() =>
      createVerticalRepCounter({ downFraction: 0.1, upFraction: 0.2 })
    ).toThrow();
    // Equal fractions leave no hysteresis band.
    expect(() =>
      createVerticalRepCounter({ downFraction: 0.2, upFraction: 0.2 })
    ).toThrow();
    // upFraction must be positive (a dip below rest, not above it).
    expect(() =>
      createVerticalRepCounter({ downFraction: 0.2, upFraction: 0 })
    ).toThrow();
    expect(() =>
      createVerticalRepCounter({ downFraction: 0.2, upFraction: -0.1 })
    ).toThrow();
  });

  it('counts exactly one rep per full down -> up excursion', () => {
    const counter = makeCounter();

    // First frame learns the resting baseline at y = 200.
    counter.update(200, 100, true);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(0);

    // Dip DOWN toward the floor (y grows). 230 -> excursion 0.3 >= 0.2.
    counter.update(230, 100, true);
    expect(counter.phase).toBe('down');
    expect(counter.reps).toBe(0); // not counted until we come back up

    // Rise back UP (y shrinks). 205 -> excursion 0.05 <= 0.1 -> one rep.
    counter.update(205, 100, true);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);

    // Another full cycle -> two reps (baseline re-anchored around 205).
    counter.update(235, 100, true);
    counter.update(206, 100, true);
    expect(counter.reps).toBe(2);
  });

  it('counts the SAME gesture the same at very different body-scales (near vs far)', () => {
    // The SAME push-up gesture, expressed as fractions of body-scale, must
    // produce the same rep count whether the user looks small (far away) or
    // large (close to the camera). We run an identical fraction-pattern at two
    // very different bodyScalePx values and expect identical results.
    const pattern = [
      { restFrac: 0, expectPhase: 'up' }, // learns baseline
      { restFrac: 0.3, expectPhase: 'down' }, // dip past 0.2
      { restFrac: 0.05, expectPhase: 'up' }, // rise past 0.1 -> rep
      { restFrac: 0.3, expectPhase: 'down' },
      { restFrac: 0.05, expectPhase: 'up' }, // -> rep
    ];

    function runAtScale(bodyScalePx, baseY) {
      const counter = makeCounter();
      for (const frame of pattern) {
        // y = baseline + fraction * scale (down is +y because y grows downward).
        const y = baseY + frame.restFrac * bodyScalePx;
        counter.update(y, bodyScalePx, true);
      }
      return counter.reps;
    }

    const repsFar = runAtScale(60, 150); // small body, far away
    const repsNear = runAtScale(400, 900); // large body, close up

    expect(repsFar).toBe(2);
    expect(repsNear).toBe(2);
    expect(repsFar).toBe(repsNear);
  });

  it('counts a GRADUAL (slow/smooth) deep dip as exactly one rep', () => {
    // REGRESSION GUARD for the baseline-drift bug. A genuine, deep-enough
    // push-up performed GENTLY must still count, because rep entry depends on
    // how FAR you dip, not how FAST. We ramp the signal down frame-by-frame at
    // a realistic (post-smoothing) rate rather than jumping it in one frame.
    //
    // With bodyScalePx = 100 and downFraction 0.2 (= 20px), we descend only
    // ~2px per frame. Under the OLD "ease the baseline down at 0.1/frame"
    // behavior the measured excursion would plateau around 0.02 * 10 = 0.2 and
    // flicker right at the threshold / never cleanly clear it; the dip below
    // was deliberately set well past that cap so this test FAILS against the
    // old easing and PASSES with the fix (baseline only re-anchors upward).
    const counter = makeCounter();

    counter.update(200, 100, true); // learn baseline at y = 200

    // Descend gently from 200 to 240 (a 40px / 0.40-of-scale dip) over 20
    // frames = ~2px per frame. Comfortably past downFraction (0.2) in total.
    for (let y = 202; y <= 240; y += 2) {
      counter.update(y, 100, true);
    }
    expect(counter.phase).toBe('down'); // the gentle dip DID reach 'down'

    // Rise gently back up to 205 (excursion 0.05 <= upFraction 0.1) -> one rep.
    for (let y = 238; y >= 205; y -= 2) {
      counter.update(y, 100, true);
    }
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });

  it('counts the SAME GRADUAL gesture the same at very different body-scales', () => {
    // Like the near/far test above, but each dip is a multi-frame RAMP instead
    // of a single jump, so the body-scale normalization is proven on the exact
    // frame-by-frame path the real pipeline (and the old baseline bug) lives
    // on. The same fraction-ramp at tiny vs huge bodyScalePx must agree.
    function runGradualAtScale(bodyScalePx, baseY) {
      const counter = createVerticalRepCounter({
        downFraction: 0.2,
        upFraction: 0.1,
      });

      const dipTo = (targetFrac) => {
        // Ramp from the current reading toward baseY + targetFrac*scale in
        // small ~0.02-of-scale steps (a realistic gentle rate).
        const targetY = baseY + targetFrac * bodyScalePx;
        const step = bodyScalePx * 0.02;
        // Walk from the resting-ish top down to the target, then back up.
        for (let y = baseY; y <= targetY; y += step) {
          counter.update(y, bodyScalePx, true);
        }
        for (let y = targetY; y >= baseY + 0.05 * bodyScalePx; y -= step) {
          counter.update(y, bodyScalePx, true);
        }
      };

      counter.update(baseY, bodyScalePx, true); // learn baseline
      dipTo(0.3); // one full gentle down->up (0.30 past, release to 0.05)
      dipTo(0.3); // a second one
      return counter.reps;
    }

    const repsFar = runGradualAtScale(60, 150); // small body, far away
    const repsNear = runGradualAtScale(400, 900); // large body, close up

    expect(repsFar).toBe(2);
    expect(repsNear).toBe(2);
    expect(repsFar).toBe(repsNear);
  });

  it('does NOT count jitter that stays inside the hysteresis band', () => {
    const counter = makeCounter();
    counter.update(200, 100, true); // baseline

    // Tiny wobbles that never reach downFraction (0.2). 0.15, 0.05, 0.18...
    counter.update(215, 100, true); // excursion 0.15 -> still up
    counter.update(205, 100, true); // 0.05 -> still up
    counter.update(218, 100, true); // 0.18 -> still up
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(0);
  });

  it('a single jittery deep frame does NOT complete a rep on its own', () => {
    const counter = makeCounter();
    counter.update(200, 100, true); // baseline

    // One lone deep frame enters 'down' but cannot ALSO complete the rep: a
    // completion needs a later up-transition frame. So after this single frame
    // we are 'down' with zero reps, not a counted rep.
    counter.update(260, 100, true); // excursion 0.6 -> down
    expect(counter.phase).toBe('down');
    expect(counter.reps).toBe(0);
  });

  it('never advances when confident === false (anti-cheat)', () => {
    const counter = makeCounter();
    counter.update(200, 100, true); // baseline from a trusted frame

    // A perfect-looking down/up motion is ignored entirely when not confident.
    counter.update(260, 100, false); // would be 'down' but not trusted
    expect(counter.phase).toBe('up');
    counter.update(205, 100, false); // would complete a rep but not trusted
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(0);
  });

  it('ignores an unconfident frame mid-rep without losing earned progress', () => {
    const counter = makeCounter();
    counter.update(200, 100, true); // baseline
    counter.update(230, 100, true); // down
    expect(counter.phase).toBe('down');

    // Camera briefly loses the joints: must not change state.
    counter.update(205, 100, false);
    expect(counter.phase).toBe('down');
    expect(counter.reps).toBe(0);

    // Joints come back and we finish the rep for real.
    counter.update(205, 100, true);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });

  it('counts ZERO reps when standing still (no vertical movement)', () => {
    const counter = makeCounter();
    // Feed many frames all at the same resting y: excursion stays ~0.
    for (let i = 0; i < 30; i += 1) {
      counter.update(200, 100, true);
    }
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(0);
  });

  it('leaves state unchanged when the body-scale is missing or non-positive', () => {
    const counter = makeCounter();
    counter.update(200, 100, true); // baseline

    counter.update(260, 0, true); // zero scale -> not countable
    counter.update(260, -50, true); // negative scale -> not countable
    counter.update(260, null, true); // null scale -> not countable
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(0);
  });

  it('reset() clears reps and returns to the up phase', () => {
    const counter = makeCounter();
    counter.update(200, 100, true);
    counter.update(230, 100, true);
    counter.update(205, 100, true);
    expect(counter.reps).toBe(1);

    counter.reset();
    expect(counter.reps).toBe(0);
    expect(counter.phase).toBe('up');

    // After reset it learns a fresh baseline again.
    counter.update(500, 100, true); // new baseline
    counter.update(530, 100, true); // down
    counter.update(505, 100, true); // up -> rep
    expect(counter.reps).toBe(1);
  });
});
