import { describe, it, expect } from 'vitest';
import { createPositionGate, DEFAULT_HOLD_MS } from '../positionGate.js';

describe('createPositionGate (pause/resume countdown)', () => {
  it('starts disarmed with the full time remaining', () => {
    const gate = createPositionGate({ holdMs: 5000 });
    expect(gate.armed).toBe(false);
    // Nothing has happened yet, so the whole countdown is still to go.
    const first = gate.update(false, 0);
    expect(first.armed).toBe(false);
    expect(first.heldMs).toBe(0);
    expect(first.remainingMs).toBe(5000);
    expect(first.remainingSeconds).toBe(5);
  });

  it('does NOT arm on a brief / flickering true', () => {
    const gate = createPositionGate({ holdMs: 5000 });
    // In position for a single quick frame, then gone again. Each frame only
    // adds a tiny slice of time, nowhere near the 5000ms needed.
    expect(gate.update(true, 0).armed).toBe(false); // first frame contributes 0
    expect(gate.update(false, 16).armed).toBe(false);
    expect(gate.update(true, 32).armed).toBe(false);
    expect(gate.update(false, 48).armed).toBe(false);
    expect(gate.armed).toBe(false);
  });

  it('accumulates across continuous in-position time and ARMS at exactly holdMs', () => {
    const gate = createPositionGate({ holdMs: 5000 });
    // Realistic ~1s frames (frame deltas longer than 1s are treated as hiccups
    // and clamped, so we never hand the gate a single giant jump).
    gate.update(true, 0); // first frame: no previous timestamp -> contributes 0
    expect(gate.update(true, 1000).armed).toBe(false); // +1000 -> 1s
    expect(gate.update(true, 2000).armed).toBe(false); // +1000 -> 2s
    expect(gate.update(true, 3000).armed).toBe(false); // +1000 -> 3s
    const almost = gate.update(true, 4000); // +1000 -> 4s
    expect(almost.armed).toBe(false);
    expect(almost.remainingSeconds).toBe(1); // 1000ms left -> still showing "1"
    const done = gate.update(true, 5000); // +1000 -> 5s exactly
    expect(done.armed).toBe(true);
    expect(done.remainingMs).toBe(0);
    expect(done.remainingSeconds).toBe(0);
    expect(gate.armed).toBe(true);
  });

  it('reports a whole-seconds countdown that ticks 5 -> 1 as time is held', () => {
    const gate = createPositionGate({ holdMs: 5000 });
    gate.update(true, 0); // start the clock (contributes 0)
    expect(gate.update(true, 1).remainingSeconds).toBe(5); // 4999ms left -> ceil 5
    expect(gate.update(true, 1000).remainingSeconds).toBe(4); // 4000ms left
    expect(gate.update(true, 2000).remainingSeconds).toBe(3);
    expect(gate.update(true, 3000).remainingSeconds).toBe(2);
    expect(gate.update(true, 4000).remainingSeconds).toBe(1);
    expect(gate.update(true, 5000).remainingSeconds).toBe(0);
  });

  it('PAUSES (keeps progress) when out of position and RESUMES from where it left off', () => {
    const gate = createPositionGate({ holdMs: 5000 });
    // 2 seconds in position, fed as realistic ~1s frames (0,1000,2000).
    gate.update(true, 0); // first frame contributes 0
    gate.update(true, 1000); // +1000 -> 1s
    let r = gate.update(true, 2000); // +1000 -> 2s
    expect(r.armed).toBe(false);
    expect(r.heldMs).toBe(2000); // earned 2s so far

    // 3 seconds OUT of position (frames 3000,4000,5000). The accumulator must
    // FREEZE: no time added and no reset. Still exactly 2s afterwards.
    gate.update(false, 3000);
    gate.update(false, 4000);
    r = gate.update(false, 5000);
    expect(r.armed).toBe(false);
    expect(r.heldMs).toBe(2000); // out-of-position time was NOT counted
    expect(r.remainingMs).toBe(3000); // and progress was NOT reset

    // 3 more seconds in position (frames 6000,7000,8000). Resuming from 2s, the
    // extra 3s reaches 5s total and arms. Note each of these frames IS in
    // position, so each ~1s slice counts.
    expect(gate.update(true, 6000).heldMs).toBe(3000); // +1000 -> 3s
    expect(gate.update(true, 7000).heldMs).toBe(4000); // +1000 -> 4s
    const armedResult = gate.update(true, 8000); // +1000 -> 5s -> armed
    expect(armedResult.armed).toBe(true);
    expect(gate.armed).toBe(true);
  });

  it('the first frame (no previous timestamp) contributes 0', () => {
    const gate = createPositionGate({ holdMs: 5000 });
    // Even though nowMs is large, the very first frame has no previous timestamp
    // to measure against, so no time is credited.
    const first = gate.update(true, 10000);
    expect(first.heldMs).toBe(0);
    expect(first.armed).toBe(false);
  });

  it('clamps a negative or absurdly large frame delta to 0', () => {
    const gate = createPositionGate({ holdMs: 5000 });
    gate.update(true, 1000); // establish a previous timestamp
    // Clock jumps backwards: negative delta must be ignored.
    expect(gate.update(true, 500).heldMs).toBe(0);
    // A huge gap (e.g. tab was backgrounded) must be ignored, not counted.
    expect(gate.update(true, 60000).heldMs).toBe(0);
    // A normal slice after that counts as usual.
    expect(gate.update(true, 60500).heldMs).toBe(500);
  });

  // Small helper: hold in position from the first frame until armed, feeding
  // realistic ~1s frames so no delta is ever clamped as a hiccup.
  function holdUntilArmed(gate, startMs = 0) {
    gate.update(true, startMs); // first frame contributes 0
    for (let t = startMs + 1000; ; t += 1000) {
      if (gate.update(true, t).armed) return t;
    }
  }

  it('stays armed even if the position is briefly lost mid-set', () => {
    const gate = createPositionGate({ holdMs: 5000 });
    const armedAt = holdUntilArmed(gate); // armed at t=5000
    expect(gate.armed).toBe(true);
    // User briefly leaves position mid-set: we must NOT disarm.
    expect(gate.update(false, armedAt + 1000).armed).toBe(true);
    expect(gate.update(true, armedAt + 2000).armed).toBe(true);
    expect(gate.armed).toBe(true);
  });

  it('re-arms from scratch after reset()', () => {
    const gate = createPositionGate({ holdMs: 5000 });
    holdUntilArmed(gate); // armed at t=5000
    expect(gate.armed).toBe(true);

    gate.reset(); // start of a new step
    expect(gate.armed).toBe(false);
    // After reset the next frame is treated as a first frame (contributes 0).
    expect(gate.update(true, 6000).heldMs).toBe(0);
    expect(gate.update(true, 7000).armed).toBe(false); // ~1s in
    // A full fresh 5s of in-position time is needed again.
    holdUntilArmed(gate, 8000);
    expect(gate.armed).toBe(true);
  });

  it('defaults to a 5 second hold when holdMs is not given', () => {
    expect(DEFAULT_HOLD_MS).toBe(5000);
    const gate = createPositionGate();
    const armedAt = holdUntilArmed(gate); // ~1s frames from t=0
    expect(armedAt).toBe(5000); // exactly 5 seconds of in-position time
  });
});
