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
      lastActiveDate: null,
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

describe('resolveDay: miss reconciliation (gap counted from last ACTIVE day)', () => {
  // Build a state whose last ACTIVE day (completed or skipped) is a known day,
  // with a bumped target. The gap the miss/decay maths uses is measured from
  // this active day, NOT from lastResolvedDate (which is only the idempotency
  // guard). We seed lastActiveDate here to prove the corrected behaviour.
  function stateLastActive(day, { difficulty = 'standard', startingTarget = 10, currentTarget, streak = 5 } = {}) {
    const state = createInitialState({ exercise: 'pushup', difficulty, startingTarget });
    return {
      ...state,
      streak,
      lastCompletedDate: day,
      lastActiveDate: day,
      lastResolvedDate: day,
      settings: {
        pushup: {
          ...state.settings.pushup,
          currentTarget: currentTarget ?? startingTarget,
        },
      },
    };
  }

  it('holds the target and continues the streak the very NEXT day (gap 1 = zero days missed)', () => {
    // Completed Mon (2026-01-01), opening Tue (2026-01-02): gap 1 -> 0 missed.
    const state = stateLastActive('2026-01-01', { currentTarget: 30, streak: 5 });
    const next = resolveDay(state, '2026-01-02');
    expect(next.streak).toBe(5);
    expect(next.settings.pushup.currentTarget).toBe(30);
    expect(next.lastResolvedDate).toBe('2026-01-02');
  });

  it('HOLDS target + continues streak when exactly ONE day is missed (gap 2)', () => {
    // Completed Mon (2026-01-01), opening Wed (2026-01-03): gap 2 -> exactly ONE
    // day actually missed (Tue). The user rule: miss one day holds + continues.
    const state = stateLastActive('2026-01-01', { currentTarget: 30, startingTarget: 10, streak: 5 });
    const next = resolveDay(state, '2026-01-03');
    expect(next.streak).toBe(5); // streak CONTINUES
    expect(next.settings.pushup.currentTarget).toBe(30); // target HOLDS
    expect(next.lastResolvedDate).toBe('2026-01-03');
  });

  it('resets streak and decays target by 2 flat when TWO days are missed (gap 3)', () => {
    // Completed Mon (2026-01-01), opening Thu (2026-01-04): gap 3 -> TWO days
    // actually missed (Tue + Wed). Reset streak, decay by 2 flat.
    const state = stateLastActive('2026-01-01', { currentTarget: 30, startingTarget: 10, streak: 5 });
    const next = resolveDay(state, '2026-01-04');
    expect(next.streak).toBe(0);
    expect(next.settings.pushup.currentTarget).toBe(28); // 30 - 2 flat
  });

  it('decays by exactly the number of days actually missed, not the calendar gap', () => {
    // Completed Mon (2026-01-01), opening 2026-01-06: gap 5 -> FOUR days missed.
    const state = stateLastActive('2026-01-01', { currentTarget: 30, startingTarget: 10, streak: 5 });
    const next = resolveDay(state, '2026-01-06');
    expect(next.streak).toBe(0);
    expect(next.settings.pushup.currentTarget).toBe(26); // 30 - 4 flat
  });

  it('floors the decay at startingTarget on a large gap (never below)', () => {
    const state = stateLastActive('2026-01-01', { currentTarget: 15, startingTarget: 10, streak: 9 });
    // A 60-day gap drives 15 - 59 negative; it must floor at 10.
    const next = resolveDay(state, '2026-03-02');
    expect(next.streak).toBe(0);
    expect(next.settings.pushup.currentTarget).toBe(10);
  });

  it('is idempotent: re-running for the same today changes nothing', () => {
    const state = stateLastActive('2026-01-01', { currentTarget: 30, startingTarget: 10, streak: 5 });
    const once = resolveDay(state, '2026-01-05'); // gap 4 -> 3 missed -> 30 - 3 = 27
    expect(once.settings.pushup.currentTarget).toBe(27);
    expect(once.streak).toBe(0);
    const twice = resolveDay(once, '2026-01-05'); // lastResolvedDate === today -> no-op
    expect(twice.settings.pushup.currentTarget).toBe(27);
    expect(twice.streak).toBe(0);
    expect(twice).toBe(once); // literally the same object back (pure no-op)
  });

  it('just stamps today for a brand-new user with nothing to reconcile', () => {
    const state = createInitialState({ exercise: 'pushup', difficulty: 'easy', startingTarget: 10 });
    const next = resolveDay(state, '2026-01-01');
    expect(next.lastResolvedDate).toBe('2026-01-01');
    expect(next.streak).toBe(0);
    expect(next.settings.pushup.currentTarget).toBe(10);
  });
});

describe('resolveDay: keyed to WORKOUTS DONE, not app opens', () => {
  // This is the cadence fix: opening the app on consecutive days WITHOUT
  // completing a workout must NOT prevent the 2+-missed-day reset+decay. The
  // gap is measured from lastActiveDate (last completed-or-skipped day), and
  // resolveDay never advances that baseline, so daily opens cannot keep a
  // streak alive forever.

  it('opening the app several days running WITHOUT working out eventually resets + decays', () => {
    // Completed Mon (2026-01-01) with a grown target and a streak.
    let state = stateForCadence('2026-01-01', { currentTarget: 30, startingTarget: 10, streak: 5 });

    // Tue open, no workout: gap 1 from active Mon -> 0 missed -> HOLD. The app
    // stamps lastResolvedDate = Tue but does NOT touch lastActiveDate.
    state = resolveDay(state, '2026-01-02');
    expect(state.streak).toBe(5);
    expect(state.settings.pushup.currentTarget).toBe(30);
    expect(state.lastActiveDate).toBe('2026-01-01'); // baseline unmoved by the open

    // Wed open, still no workout: gap 2 from active Mon -> 1 missed -> still HOLD.
    state = resolveDay(state, '2026-01-03');
    expect(state.streak).toBe(5);
    expect(state.settings.pushup.currentTarget).toBe(30);
    expect(state.lastActiveDate).toBe('2026-01-01');

    // Thu open, still no workout: gap 3 from active Mon -> 2 missed -> RESET +
    // decay by 2. The daily opens did NOT save the streak.
    state = resolveDay(state, '2026-01-04');
    expect(state.streak).toBe(0);
    expect(state.settings.pushup.currentTarget).toBe(28); // 30 - 2 flat
  });

  it('completing a workout RESETS the miss baseline to today', () => {
    // Missed enough to reset once, then complete: completing moves lastActiveDate
    // to the completion day, so the next day starts a fresh grace window.
    let state = stateForCadence('2026-01-01', { currentTarget: 30, startingTarget: 10, streak: 5 });
    state = resolveDay(state, '2026-01-04'); // 2 missed -> reset, target 28
    expect(state.streak).toBe(0);

    // Complete on the 4th.
    state = completeDay(state, { entries: [{ exercise: 'pushup', reps: 28 }] }, '2026-01-04');
    expect(state.lastActiveDate).toBe('2026-01-04');
    expect(state.streak).toBe(1);
    const targetAfterComplete = state.settings.pushup.currentTarget; // 28 + 2 = 30

    // Open the 5th (gap 1 from the new active day) -> HOLD, streak continues.
    state = resolveDay(state, '2026-01-05');
    expect(state.streak).toBe(1);
    expect(state.settings.pushup.currentTarget).toBe(targetAfterComplete);
  });

  it('a deliberate skip holds exactly ONE day, then the miss clock resumes', () => {
    // Completed Mon, skip Tue deliberately: the skip advances the active day to
    // Tue, so Wed is only one day past the skip (HOLD), but Thu is two days past
    // (RESET) if still no workout.
    let state = stateForCadence('2026-01-01', { currentTarget: 30, startingTarget: 10, streak: 5 });

    state = skipDay(state, '2026-01-02'); // deliberate rest Tue
    expect(state.streak).toBe(5); // held
    expect(state.settings.pushup.currentTarget).toBe(30); // held
    expect(state.lastActiveDate).toBe('2026-01-02'); // skip counts as active
    expect(state.lastCompletedDate).toBe('2026-01-01'); // but not a completion

    // Wed open, no workout: gap 1 from the skip -> 0 missed -> still HOLD.
    state = resolveDay(state, '2026-01-03');
    expect(state.streak).toBe(5);
    expect(state.settings.pushup.currentTarget).toBe(30);

    // Fri open, no workout: gap 3 from the skip -> 2 missed -> RESET + decay 2.
    state = resolveDay(state, '2026-01-05');
    expect(state.streak).toBe(0);
    expect(state.settings.pushup.currentTarget).toBe(28);
  });

  // Same seed helper as above, named for this block's intent.
  function stateForCadence(day, opts) {
    const state = createInitialState({ exercise: 'pushup', difficulty: 'standard', startingTarget: opts.startingTarget });
    return {
      ...state,
      streak: opts.streak,
      lastCompletedDate: day,
      lastActiveDate: day,
      lastResolvedDate: day,
      settings: {
        pushup: { ...state.settings.pushup, currentTarget: opts.currentTarget },
      },
    };
  }
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
