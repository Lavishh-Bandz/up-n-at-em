import { describe, it, expect } from 'vitest';
import { createStatusDebouncer, DEFAULT_GRACE_MS } from '../statusDebounce.js';

describe('createStatusDebouncer (warning debounce)', () => {
  it('starts optimistic (displayed = detected) so no warning flashes up front', () => {
    const debouncer = createStatusDebouncer({ graceMs: 500 });
    // Before any frame, we assume the pose is detected so the warning stays
    // hidden until we have real evidence otherwise.
    expect(debouncer.displayed).toBe(true);
  });

  it('flips to DETECTED instantly on a good frame', () => {
    const debouncer = createStatusDebouncer({ graceMs: 500 });
    // Sit in the "not detected" state long enough to show the warning...
    debouncer.update(false, 0);
    expect(debouncer.update(false, 600)).toBe(false);
    // ...then a single good frame hides it again immediately (no delay).
    expect(debouncer.update(true, 616)).toBe(true);
  });

  it('does NOT flip on a single brief bad frame', () => {
    const debouncer = createStatusDebouncer({ graceMs: 500 });
    // One quick bad frame surrounded by good ones: the warning must stay hidden
    // because the bad run never lasted the grace period.
    expect(debouncer.update(true, 0)).toBe(true);
    expect(debouncer.update(false, 16)).toBe(true); // bad, but only just started
    expect(debouncer.update(true, 32)).toBe(true); // recovered well within grace
    expect(debouncer.displayed).toBe(true);
  });

  it('flips to NOT DETECTED only after continuous false for >= graceMs', () => {
    const debouncer = createStatusDebouncer({ graceMs: 500 });
    expect(debouncer.update(false, 0)).toBe(true); // bad run begins, still shown as ok
    expect(debouncer.update(false, 200)).toBe(true); // 200ms of bad, not yet
    expect(debouncer.update(false, 499)).toBe(true); // 499ms, still within grace
    expect(debouncer.update(false, 500)).toBe(false); // 500ms continuous -> warn now
  });

  it('a return to detected mid-grace CANCELS the pending flip', () => {
    const debouncer = createStatusDebouncer({ graceMs: 500 });
    expect(debouncer.update(false, 0)).toBe(true); // bad run begins
    expect(debouncer.update(false, 300)).toBe(true); // 300ms bad (not yet)
    expect(debouncer.update(true, 350)).toBe(true); // recovered: pending flip cancelled
    // A NEW bad run must measure its own fresh grace period from here, so a
    // brief bad frame soon after does NOT immediately trip the warning.
    expect(debouncer.update(false, 400)).toBe(true); // new bad run starts at 400
    expect(debouncer.update(false, 700)).toBe(true); // only 300ms into the new run
    expect(debouncer.update(false, 900)).toBe(false); // 500ms of the new run -> warn
  });

  it('reset() returns to the optimistic start', () => {
    const debouncer = createStatusDebouncer({ graceMs: 500 });
    debouncer.update(false, 0);
    debouncer.update(false, 600); // warning now showing
    expect(debouncer.displayed).toBe(false);
    debouncer.reset();
    expect(debouncer.displayed).toBe(true);
  });

  it('with graceMs = 0, flips to not-detected on the very first bad frame', () => {
    const debouncer = createStatusDebouncer({ graceMs: 0 });
    expect(debouncer.update(false, 0)).toBe(false);
  });

  it('defaults to a 500ms grace period when graceMs is not given', () => {
    expect(DEFAULT_GRACE_MS).toBe(500);
    const debouncer = createStatusDebouncer();
    expect(debouncer.update(false, 0)).toBe(true); // bad run begins
    expect(debouncer.update(false, 499)).toBe(true); // just under default grace
    expect(debouncer.update(false, 500)).toBe(false); // hits the 500ms default
  });
});
