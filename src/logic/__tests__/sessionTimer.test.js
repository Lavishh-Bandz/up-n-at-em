import { describe, it, expect } from 'vitest';
import { createSessionTimer, formatElapsed } from '../sessionTimer.js';

describe('createSessionTimer (pure, injected-time stopwatch)', () => {
  it('starts IDLE: not running and no elapsed value yet', () => {
    const timer = createSessionTimer();
    expect(timer.running).toBe(false);
    // Before start() there is no final time to show, so elapsedMs is null.
    expect(timer.elapsedMs).toBe(null);
    // And a live read before starting is also null (nothing to measure from).
    expect(timer.elapsedMsAt(1000)).toBe(null);
  });

  it('start then stop yields the exact injected difference', () => {
    const timer = createSessionTimer();
    timer.start(1000);
    expect(timer.running).toBe(true);
    // While running there is no FINAL value yet, so elapsedMs stays null.
    expect(timer.elapsedMs).toBe(null);

    timer.stop(4500);
    expect(timer.running).toBe(false);
    expect(timer.elapsedMs).toBe(3500); // 4500 - 1000
  });

  it('start() is IDEMPOTENT: a second start() does NOT move startedAtMs', () => {
    const timer = createSessionTimer();
    timer.start(1000); // first arming — this is the one that counts
    timer.start(2000); // a later step arming — must be ignored
    timer.start(9999); // and any further arming too
    timer.stop(5000);
    // The span must run from the FIRST start (1000), not a later one.
    expect(timer.elapsedMs).toBe(4000); // 5000 - 1000, not 5000 - 2000
  });

  it('stop() before start() is a no-op', () => {
    const timer = createSessionTimer();
    timer.stop(5000); // nothing was started, so this does nothing
    expect(timer.running).toBe(false);
    expect(timer.elapsedMs).toBe(null);

    // A normal start/stop afterwards still works as usual.
    timer.start(1000);
    timer.stop(3000);
    expect(timer.elapsedMs).toBe(2000);
  });

  it('a second stop() does NOT change the frozen elapsedMs', () => {
    const timer = createSessionTimer();
    timer.start(1000);
    timer.stop(4000); // first finish — this is the real one
    expect(timer.elapsedMs).toBe(3000);

    timer.stop(9000); // a later stop must be ignored
    expect(timer.elapsedMs).toBe(3000); // unchanged
  });

  it('elapsedMsAt reflects the running duration before stop and the frozen value after', () => {
    const timer = createSessionTimer();
    timer.start(1000);
    // While running it ticks up with the injected "now".
    expect(timer.elapsedMsAt(1500)).toBe(500); // 1500 - 1000
    expect(timer.elapsedMsAt(3000)).toBe(2000); // 3000 - 1000

    timer.stop(4000);
    // Once stopped it returns the frozen value and IGNORES the passed-in now.
    expect(timer.elapsedMsAt(999999)).toBe(3000); // frozen 4000 - 1000
  });

  it('reset() clears everything back to IDLE', () => {
    const timer = createSessionTimer();
    timer.start(1000);
    timer.stop(4000);
    expect(timer.elapsedMs).toBe(3000);

    timer.reset();
    expect(timer.running).toBe(false);
    expect(timer.elapsedMs).toBe(null);
    expect(timer.elapsedMsAt(5000)).toBe(null);

    // After reset the timer can be used again from scratch.
    timer.start(2000);
    timer.stop(2500);
    expect(timer.elapsedMs).toBe(500);
  });
});

describe('formatElapsed (m:ss, zero-padded seconds)', () => {
  it('formats the documented cases correctly', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(5000)).toBe('0:05');
    expect(formatElapsed(83000)).toBe('1:23');
    expect(formatElapsed(605000)).toBe('10:05');
  });

  it('drops leftover milliseconds (ticks by whole seconds)', () => {
    expect(formatElapsed(5999)).toBe('0:05'); // not yet 6 seconds
    expect(formatElapsed(59999)).toBe('0:59');
    expect(formatElapsed(60000)).toBe('1:00');
  });

  it('returns 0:00 for null/undefined/invalid/negative input (documented choice)', () => {
    expect(formatElapsed(null)).toBe('0:00');
    expect(formatElapsed(undefined)).toBe('0:00');
    expect(formatElapsed(NaN)).toBe('0:00');
    expect(formatElapsed(-1000)).toBe('0:00');
  });
});
