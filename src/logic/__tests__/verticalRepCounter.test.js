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

  it('exposes the SAME numbers the FSM used, for the debug readout', () => {
    const counter = makeCounter();
    counter.update(200, 100, true); // baseline, excursion 0 on this frame
    counter.update(230, 100, true); // excursion 0.3 -> down
    expect(counter.phase).toBe('down');
    expect(counter.lastExcursion).toBeCloseTo(0.3, 5);
    expect(counter.baseline).toBeCloseTo(200);
    const dbg = counter.debug;
    expect(dbg.phase).toBe('down');
    expect(dbg.lastExcursion).toBeCloseTo(0.3, 5);
    expect(dbg.downFraction).toBe(0.2);
    expect(dbg.upFraction).toBe(0.1);
    expect(dbg.lastPostureOk).toBe(true);
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

// The posture guard reaches the counter as the 4th `postureOk` argument. These
// tests prove the anti-standing guard actually blocks counting at the FSM.
describe('createVerticalRepCounter anti-standing posture gate', () => {
  it('a standing/walking BOB counts ZERO even when the excursion is big', () => {
    // Simulate a standing bob: the body-relative dip DOES cross downFraction
    // (0.2) over and over, but the upper-body posture guard says "not a
    // push-up" (postureOk=false) every frame, so it NEVER enters 'down'.
    const counter = makeCounter();
    counter.update(200, 100, true, false); // baseline frame
    for (let i = 0; i < 10; i += 1) {
      counter.update(240, 100, true, false); // deep dip but posture rejects
      counter.update(202, 100, true, false); // back up
    }
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(0);
    expect(counter.debug.lastPostureOk).toBe(false);
  });

  it('this SAME bob pattern WOULD count if the posture guard were removed', () => {
    // Control / "the test would fail if the guard were gone": the identical dip
    // pattern with postureOk=true (the pre-guard behavior) counts reps. This is
    // what proves the zero above is caused by the guard, not by the pattern.
    const counter = makeCounter();
    counter.update(200, 100, true, true);
    for (let i = 0; i < 3; i += 1) {
      counter.update(240, 100, true, true);
      counter.update(202, 100, true, true);
    }
    expect(counter.reps).toBe(3);
  });

  it('a genuine push-up (guard passes) still counts normally', () => {
    const counter = makeCounter();
    counter.update(200, 100, true, true); // baseline
    counter.update(230, 100, true, true); // down (posture ok)
    counter.update(205, 100, true, true); // up -> rep
    expect(counter.reps).toBe(1);
  });

  it('a guard flicker on the way UP does NOT strand an in-progress rep', () => {
    // Entry into 'down' is gated, but completion is not — so a brief posture
    // flicker as the user pushes back up cannot lose a legitimately-earned rep.
    const counter = makeCounter();
    counter.update(200, 100, true, true); // baseline
    counter.update(235, 100, true, true); // enter down (guard ok)
    expect(counter.phase).toBe('down');
    counter.update(205, 100, true, false); // guard flickers false while rising
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });

  it('postureOk defaults to true, so pre-existing 3-arg callers are unchanged', () => {
    // Every existing test calls update(y, scale, confident) with no 4th arg.
    // That must behave exactly as before (counts a genuine dip).
    const counter = makeCounter();
    counter.update(200, 100, true);
    counter.update(230, 100, true);
    counter.update(205, 100, true);
    expect(counter.reps).toBe(1);
  });
});

// Prove the STABLE ruler fixes the "swinging ruler breaks counting" bug: once
// the ruler is locked, a shoulder-width that swings frame-to-frame no longer
// changes the excursion the counter measures, so a genuine rep still counts.
describe('createVerticalRepCounter with a stable (locked) ruler', () => {
  it('a genuine gesture counts the same whether the ruler is locked near or far', () => {
    // Same fraction-pattern, two very different LOCKED body-scales. (This is the
    // counter-side mirror of the body-scale normalization: a locked ruler is
    // just a constant bodyScalePx, and the same gesture must agree.)
    function runLocked(lockedScale, baseY) {
      const counter = makeCounter();
      const dipFrac = (f) => baseY + f * lockedScale;
      counter.update(dipFrac(0), lockedScale, true, true); // baseline
      counter.update(dipFrac(0.3), lockedScale, true, true); // down
      counter.update(dipFrac(0.05), lockedScale, true, true); // up -> rep
      counter.update(dipFrac(0.3), lockedScale, true, true); // down
      counter.update(dipFrac(0.05), lockedScale, true, true); // up -> rep
      return counter.reps;
    }
    expect(runLocked(60, 150)).toBe(2); // small body, far away
    expect(runLocked(400, 900)).toBe(2); // large body, close up
  });

  it('a ruler that SWINGS frame-to-frame breaks counting, but a LOCKED one does not', () => {
    // The real gesture: the upper body dips a fixed 18px below a 200 baseline
    // and back. 18px is a solid dip against a true ~100px body-scale (0.18 >
    // downFraction 0.2? no — choose 24px so 0.24 clears 0.2 cleanly).
    const trueScale = 100;
    const baseY = 200;
    const downY = baseY + 24; // 24px dip = 0.24 of the TRUE scale -> clears 0.2
    const upY = baseY + 4; // 0.04 of true scale -> clears upFraction 0.1

    // A) SWINGING ruler (the bug): the front-facing shoulder width balloons on
    // the down frame so 24px becomes a tiny fraction and the dip never crosses.
    const swinging = makeCounter();
    swinging.update(baseY, 100, true, true); // baseline, ruler 100
    swinging.update(downY, 400, true, true); // ruler swung to 400 -> 24/400=0.06
    swinging.update(upY, 100, true, true); // ruler back to 100
    expect(swinging.reps).toBe(0); // the swing hid the real dip

    // B) LOCKED ruler (the fix): the same pixel motion measured against a fixed
    // 100px ruler crosses the threshold and counts.
    const locked = makeCounter();
    locked.update(baseY, trueScale, true, true); // baseline
    locked.update(downY, trueScale, true, true); // 0.24 -> down
    locked.update(upY, trueScale, true, true); // 0.04 -> up -> rep
    expect(locked.reps).toBe(1);
  });

  it('a SIDE-VIEW style gradual dip still counts with posture ok', () => {
    // Side view: nose+shoulder track together, posture guard passes each frame,
    // and the dip is a gentle multi-frame ramp (regression guard for the
    // upward-only baseline). Must count exactly one.
    const counter = makeCounter();
    counter.update(200, 100, true, true); // baseline
    for (let y = 202; y <= 230; y += 2) {
      counter.update(y, 100, true, true); // gentle descent, guard ok
    }
    expect(counter.phase).toBe('down');
    for (let y = 228; y >= 205; y -= 2) {
      counter.update(y, 100, true, true); // gentle rise
    }
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });
});
