import { describe, it, expect } from 'vitest';
import {
  formatDay,
  daysBetween,
  createInitialState,
  resolveDay,
  completeDay,
  skipDay,
  setDifficulty,
  setAutoIncrease,
  decreaseTarget,
  setStartingTarget,
  MAX_TARGET,
  STATE_VERSION,
} from '../progressStore.js';

// Everything below feeds DETERMINISTIC inputs (made-up 'YYYY-MM-DD' dates and
// plain state objects), mirroring positionGate.test.js. The pure core never
// reads the real clock, so these tests never need to mock time.

describe('formatDay', () => {
  it('passes an already-formatted day string straight through', () => {
    expect(formatDay('2026-01-05')).toBe('2026-01-05');
  });

  it('formats a ms timestamp to a UTC YYYY-MM-DD with zero padding', () => {
    // 2026-01-05T00:00:00Z
    const ms = Date.UTC(2026, 0, 5);
    expect(formatDay(ms)).toBe('2026-01-05');
  });

  it('formats a Date object the same way', () => {
    expect(formatDay(new Date(Date.UTC(2026, 10, 2)))).toBe('2026-11-02');
  });
});

describe('daysBetween', () => {
  it('is 0 for the same day', () => {
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('is 1 for consecutive days', () => {
    expect(daysBetween('2026-01-01', '2026-01-02')).toBe(1);
  });

  it('crosses a month boundary correctly', () => {
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1);
  });

  it('crosses a year boundary correctly', () => {
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('handles a longer, multi-month gap', () => {
    // Jan has 31 days, so 2026-01-10 -> 2026-02-10 is 31 days.
    expect(daysBetween('2026-01-10', '2026-02-10')).toBe(31);
  });

  it('is negative when going backwards', () => {
    expect(daysBetween('2026-01-02', '2026-01-01')).toBe(-1);
  });
});

describe('createInitialState', () => {
  it('returns the versioned default shape', () => {
    const state = createInitialState({
      exercise: 'pushup',
      difficulty: 'standard',
      startingTarget: 20,
    });
    expect(state).toEqual({
      version: STATE_VERSION,
      settings: {
        pushup: {
          difficulty: 'standard',
          currentTarget: 20,
          startingTarget: 20,
          autoIncrease: true,
        },
      },
      streak: 0,
      lastCompletedDate: null,
      lastResolvedDate: null,
      history: [],
    });
  });

  it('clamps and rounds a nonsense starting target into range', () => {
    const tooHigh = createInitialState({ exercise: 'pushup', difficulty: 'easy', startingTarget: 500 });
    expect(tooHigh.settings.pushup.startingTarget).toBe(MAX_TARGET);
    expect(tooHigh.settings.pushup.currentTarget).toBe(MAX_TARGET);
  });
});

describe('completeDay — streak + progressive overload per difficulty', () => {
  function base(difficulty, startingTarget = 10) {
    return createInitialState({ exercise: 'pushup', difficulty, startingTarget });
  }

  it('increments the streak and applies +1 on easy', () => {
    const next = completeDay(base('easy'), { entries: [{ exercise: 'pushup', reps: 10 }], elapsedMs: 5000 }, '2026-01-01');
    expect(next.streak).toBe(1);
    expect(next.settings.pushup.currentTarget).toBe(11);
  });

  it('applies +2 on standard', () => {
    const next = completeDay(base('standard'), { entries: [{ exercise: 'pushup', reps: 20 }] }, '2026-01-01');
    expect(next.settings.pushup.currentTarget).toBe(12);
  });

  it('applies +3 on hard', () => {
    const next = completeDay(base('hard'), { entries: [{ exercise: 'pushup', reps: 45 }] }, '2026-01-01');
    expect(next.settings.pushup.currentTarget).toBe(13);
  });

  it('applies +5 on extreme', () => {
    const next = completeDay(base('extreme'), { entries: [{ exercise: 'pushup', reps: 60 }] }, '2026-01-01');
    expect(next.settings.pushup.currentTarget).toBe(15);
  });

  it('does not mutate the input state', () => {
    const state = base('standard');
    const next = completeDay(state, { entries: [{ exercise: 'pushup', reps: 20 }] }, '2026-01-01');
    expect(state.streak).toBe(0);
    expect(state.settings.pushup.currentTarget).toBe(10);
    expect(next).not.toBe(state);
  });
});

describe('completeDay — the 100 cap', () => {
  it('reaches exactly 100 and never exceeds (99 + standard -> 100)', () => {
    const state = createInitialState({ exercise: 'pushup', difficulty: 'standard', startingTarget: 99 });
    const next = completeDay(state, { entries: [{ exercise: 'pushup', reps: 99 }] }, '2026-01-01');
    expect(next.settings.pushup.currentTarget).toBe(100);
  });

  it('holds at 100 when already at the cap (100 + anything stays 100)', () => {
    const state = createInitialState({ exercise: 'pushup', difficulty: 'extreme', startingTarget: 100 });
    const next = completeDay(state, { entries: [{ exercise: 'pushup', reps: 100 }] }, '2026-01-01');
    expect(next.settings.pushup.currentTarget).toBe(100);
  });
});

describe('completeDay — autoIncrease OFF holds the target', () => {
  it('keeps the target put when auto-increase is off', () => {
    let state = createInitialState({ exercise: 'pushup', difficulty: 'hard', startingTarget: 30 });
    state = setAutoIncrease(state, 'pushup', false);
    const next = completeDay(state, { entries: [{ exercise: 'pushup', reps: 30 }] }, '2026-01-01');
    expect(next.settings.pushup.currentTarget).toBe(30);
    // Streak still advances even though the target holds.
    expect(next.streak).toBe(1);
  });
});

describe('completeDay — history entry', () => {
  it('appends a history entry with date, entries, totalReps and elapsedMs', () => {
    const state = createInitialState({ exercise: 'pushup', difficulty: 'standard', startingTarget: 20 });
    const next = completeDay(
      state,
      { entries: [{ exercise: 'pushup', reps: 20 }, { exercise: 'situp', reps: 15 }], elapsedMs: 42000 },
      '2026-03-09',
    );
    expect(next.history).toHaveLength(1);
    expect(next.history[0]).toEqual({
      date: '2026-03-09',
      entries: [{ exercise: 'pushup', reps: 20 }, { exercise: 'situp', reps: 15 }],
      totalReps: 35,
      elapsedMs: 42000,
    });
    expect(next.lastCompletedDate).toBe('2026-03-09');
    expect(next.lastResolvedDate).toBe('2026-03-09');
  });
});

describe('setting mutators', () => {
  it('setDifficulty changes only the difficulty', () => {
    const state = createInitialState({ exercise: 'pushup', difficulty: 'easy', startingTarget: 10 });
    const next = setDifficulty(state, 'pushup', 'extreme');
    expect(next.settings.pushup.difficulty).toBe('extreme');
    expect(next.settings.pushup.currentTarget).toBe(10);
  });

  it('decreaseTarget lowers by 1 by default and floors at startingTarget', () => {
    let state = createInitialState({ exercise: 'pushup', difficulty: 'standard', startingTarget: 10 });
    // Push the target up a bit first.
    state = completeDay(state, { entries: [{ exercise: 'pushup', reps: 10 }] }, '2026-01-01'); // -> 12
    const once = decreaseTarget(state, 'pushup');
    expect(once.settings.pushup.currentTarget).toBe(11);
    // Drive it all the way down: it must never go below the startingTarget (10).
    const way = decreaseTarget(state, 'pushup', 50);
    expect(way.settings.pushup.currentTarget).toBe(10);
  });

  it('setStartingTarget raises currentTarget when the new floor is higher', () => {
    const state = createInitialState({ exercise: 'pushup', difficulty: 'easy', startingTarget: 10 });
    const next = setStartingTarget(state, 'pushup', 25);
    expect(next.settings.pushup.startingTarget).toBe(25);
    // currentTarget was 10, below the new floor, so it is raised to meet it.
    expect(next.settings.pushup.currentTarget).toBe(25);
  });

  it('setStartingTarget leaves a higher currentTarget alone when lowering the floor', () => {
    let state = createInitialState({ exercise: 'pushup', difficulty: 'extreme', startingTarget: 20 });
    state = completeDay(state, { entries: [{ exercise: 'pushup', reps: 20 }] }, '2026-01-01'); // -> 25
    const next = setStartingTarget(state, 'pushup', 15);
    expect(next.settings.pushup.startingTarget).toBe(15);
    expect(next.settings.pushup.currentTarget).toBe(25);
  });
});

describe('resolveDay — miss reconciliation', () => {
  // Build a state that last completed on a known day with a bumped target.
  function stateLastCompleted(day, { difficulty = 'standard', startingTarget = 10, currentTarget, streak = 5 } = {}) {
    const state = createInitialState({ exercise: 'pushup', difficulty, startingTarget });
    return {
      ...state,
      streak,
      lastCompletedDate: day,
      lastResolvedDate: day,
      settings: {
        pushup: {
          ...state.settings.pushup,
          currentTarget: currentTarget ?? startingTarget,
        },
      },
    };
  }

  it('does nothing (holds target, continues streak) when exactly one day is missed', () => {
    const state = stateLastCompleted('2026-01-01', { currentTarget: 30, streak: 5 });
    // last seen 2026-01-01, today 2026-01-02 -> missedDays 1.
    const next = resolveDay(state, '2026-01-02');
    expect(next.streak).toBe(5);
    expect(next.settings.pushup.currentTarget).toBe(30);
    expect(next.lastResolvedDate).toBe('2026-01-02');
  });

  it('resets streak and decays target by 2 flat when two days are missed', () => {
    const state = stateLastCompleted('2026-01-01', { currentTarget: 30, startingTarget: 10, streak: 5 });
    // last seen 2026-01-01, today 2026-01-03 -> missedDays 2.
    const next = resolveDay(state, '2026-01-03');
    expect(next.streak).toBe(0);
    expect(next.settings.pushup.currentTarget).toBe(28); // 30 - 2 flat
  });

  it('floors the decay at startingTarget on a large gap (never below)', () => {
    const state = stateLastCompleted('2026-01-01', { currentTarget: 15, startingTarget: 10, streak: 9 });
    // A 60-day gap would drive 15 - 60 negative; it must floor at 10.
    const next = resolveDay(state, '2026-03-02');
    expect(next.streak).toBe(0);
    expect(next.settings.pushup.currentTarget).toBe(10);
  });

  it('is idempotent: calling twice with the same today applies the decay once', () => {
    const state = stateLastCompleted('2026-01-01', { currentTarget: 30, startingTarget: 10, streak: 5 });
    const once = resolveDay(state, '2026-01-05'); // missedDays 4 -> 30 - 4 = 26
    expect(once.settings.pushup.currentTarget).toBe(26);
    expect(once.streak).toBe(0);
    const twice = resolveDay(once, '2026-01-05'); // same day -> missedDays 0 -> no change
    expect(twice.settings.pushup.currentTarget).toBe(26);
    expect(twice.streak).toBe(0);
  });

  it('just stamps today for a brand-new user with nothing to reconcile', () => {
    const state = createInitialState({ exercise: 'pushup', difficulty: 'easy', startingTarget: 10 });
    const next = resolveDay(state, '2026-01-01');
    expect(next.lastResolvedDate).toBe('2026-01-01');
    expect(next.streak).toBe(0);
    expect(next.settings.pushup.currentTarget).toBe(10);
  });
});

describe('skipDay — deliberate skip behaves like miss-one-day', () => {
  it('holds the target, continues the streak, and adds NO history entry', () => {
    let state = createInitialState({ exercise: 'pushup', difficulty: 'standard', startingTarget: 10 });
    state = completeDay(state, { entries: [{ exercise: 'pushup', reps: 10 }] }, '2026-01-01'); // streak 1, target 12
    const skipped = skipDay(state, '2026-01-02');
    expect(skipped.streak).toBe(1); // streak continues
    expect(skipped.settings.pushup.currentTarget).toBe(12); // target holds
    expect(skipped.history).toHaveLength(1); // no NEW completed entry
    expect(skipped.lastResolvedDate).toBe('2026-01-02');
    expect(skipped.lastCompletedDate).toBe('2026-01-01'); // untouched
  });

  it('records lastResolvedDate so a later resolveDay the same day does nothing extra', () => {
    let state = createInitialState({ exercise: 'pushup', difficulty: 'standard', startingTarget: 10 });
    state = completeDay(state, { entries: [{ exercise: 'pushup', reps: 10 }] }, '2026-01-01');
    const skipped = skipDay(state, '2026-01-02');
    const resolved = resolveDay(skipped, '2026-01-02'); // same day -> missedDays 0
    expect(resolved.streak).toBe(1);
    expect(resolved.settings.pushup.currentTarget).toBe(12);
  });
});
