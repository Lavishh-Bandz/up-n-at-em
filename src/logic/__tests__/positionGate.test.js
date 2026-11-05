import { describe, it, expect } from 'vitest';
import { createPositionGate } from '../positionGate.js';

describe('createPositionGate', () => {
  it('starts disarmed', () => {
    const gate = createPositionGate({ holdMs: 1000 });
    expect(gate.armed).toBe(false);
  });

  it('does NOT arm on a brief / flickering true', () => {
    const gate = createPositionGate({ holdMs: 1000 });
    // In position for a single quick frame, then gone again. Nowhere near the
    // 1000ms hold, so this flicker must not arm us.
    expect(gate.update(true, 0).armed).toBe(false);
    expect(gate.update(false, 16).armed).toBe(false);
    expect(gate.update(true, 32).armed).toBe(false);
    expect(gate.update(false, 48).armed).toBe(false);
    expect(gate.armed).toBe(false);
  });

  it('ARMS after the position is held continuously for the hold duration', () => {
    const gate = createPositionGate({ holdMs: 1000 });
    expect(gate.update(true, 0).armed).toBe(false); // hold starts at t=0
    expect(gate.update(true, 500).armed).toBe(false); // halfway, not yet
    expect(gate.update(true, 999).armed).toBe(false); // just shy of the hold
    expect(gate.update(true, 1000).armed).toBe(true); // reached the hold -> armed
    expect(gate.armed).toBe(true);
  });

  it('reports how long the current hold has lasted', () => {
    const gate = createPositionGate({ holdMs: 1000 });
    expect(gate.update(true, 0).heldMs).toBe(0);
    expect(gate.update(true, 400).heldMs).toBe(400);
    expect(gate.update(true, 700).heldMs).toBe(700);
  });

  it('RESETS the running hold if the condition drops before the hold completes', () => {
    const gate = createPositionGate({ holdMs: 1000 });
    gate.update(true, 0);
    gate.update(true, 800); // almost there...
    gate.update(false, 850); // ...but we lost position: timer resets to zero
    expect(gate.armed).toBe(false);

    // A new run must start counting from scratch. 900ms after the drop is NOT
    // enough on its own; we need a fresh full 1000ms of continuous hold.
    expect(gate.update(true, 900).armed).toBe(false); // fresh hold starts at 900
    expect(gate.update(true, 1750).armed).toBe(false); // only 850ms held so far
    expect(gate.update(true, 1900).armed).toBe(true); // 1000ms since t=900 -> armed
  });

  it('stays armed even if the position is briefly lost mid-set', () => {
    const gate = createPositionGate({ holdMs: 1000 });
    gate.update(true, 0);
    gate.update(true, 1000); // armed
    expect(gate.armed).toBe(true);
    // User briefly leaves position mid-set: we must NOT disarm.
    expect(gate.update(false, 1500).armed).toBe(true);
    expect(gate.update(true, 1600).armed).toBe(true);
    expect(gate.armed).toBe(true);
  });

  it('re-arms from scratch after reset()', () => {
    const gate = createPositionGate({ holdMs: 1000 });
    gate.update(true, 0);
    gate.update(true, 1000); // armed
    expect(gate.armed).toBe(true);

    gate.reset(); // start of a new step
    expect(gate.armed).toBe(false);

    // Being in position for a single frame right after reset must not re-arm us.
    expect(gate.update(true, 1016).armed).toBe(false);
    expect(gate.update(true, 2016).armed).toBe(true); // full hold again -> armed
  });

  it('defaults to a ~1 second hold when holdMs is not given', () => {
    const gate = createPositionGate();
    expect(gate.update(true, 0).armed).toBe(false);
    expect(gate.update(true, 999).armed).toBe(false);
    expect(gate.update(true, 1000).armed).toBe(true);
  });
});
