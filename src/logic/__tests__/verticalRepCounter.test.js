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
