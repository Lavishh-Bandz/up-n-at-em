import { describe, it, expect } from 'vitest';
import { createRepCounter } from '../repCounter.js';

describe('createRepCounter', () => {
  it('starts in the up phase with zero reps', () => {
    const counter = createRepCounter({ downAngle: 90, upAngle: 160 });
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(0);
  });

  it('requires downAngle < upAngle', () => {
    expect(() => createRepCounter({ downAngle: 160, upAngle: 90 })).toThrow();
    expect(() => createRepCounter({ downAngle: 100, upAngle: 100 })).toThrow();
  });

  it('counts exactly one rep per full down -> up cycle', () => {
    const counter = createRepCounter({ downAngle: 90, upAngle: 160 });

    // Go down (bend below 90).
    counter.update(80, true);
    expect(counter.phase).toBe('down');
    expect(counter.reps).toBe(0); // not counted yet

    // Come back up (straighten above 160) -> one rep.
    counter.update(170, true);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);

    // Another full cycle -> two reps.
    counter.update(70, true);
    counter.update(165, true);
    expect(counter.reps).toBe(2);
  });

  it('does NOT double-count jitter inside the hysteresis band', () => {
    const counter = createRepCounter({ downAngle: 90, upAngle: 160 });

    // Reach the top but hover between the two thresholds. None of these mid-band
    // wobbles should flip the phase or add reps.
    counter.update(80, true); // down
    counter.update(170, true); // up -> rep 1
    expect(counter.reps).toBe(1);

    // Wobble around 120-150 (inside the 90..160 gap): no change.
    counter.update(150, true);
    counter.update(120, true);
    counter.update(155, true);
    counter.update(100, true);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });

  it('does NOT count while readings are unconfident (anti-cheat)', () => {
    const counter = createRepCounter({ downAngle: 90, upAngle: 160 });

    // Even a perfect-looking down/up motion is ignored if not confident.
    counter.update(80, false); // would be "down" but not trusted
    expect(counter.phase).toBe('up');
    counter.update(170, false); // would complete a rep but not trusted
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(0);
  });

  it('ignores an unconfident reading mid-rep without losing earned progress', () => {
    const counter = createRepCounter({ downAngle: 90, upAngle: 160 });

    counter.update(80, true); // down
    expect(counter.phase).toBe('down');

    // Camera briefly loses the joints: this reading must not change state.
    counter.update(170, false);
    expect(counter.phase).toBe('down');
    expect(counter.reps).toBe(0);

    // Joints come back and we finish the rep for real.
    counter.update(170, true);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });

  it('reset() clears reps and returns to the up phase', () => {
    const counter = createRepCounter({ downAngle: 90, upAngle: 160 });
    counter.update(80, true);
    counter.update(170, true);
    expect(counter.reps).toBe(1);

    counter.reset();
    expect(counter.reps).toBe(0);
    expect(counter.phase).toBe('up');
  });
});
