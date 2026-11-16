// progressStore.js
// -----------------------------------------------------------------------------
// The PURE heart of the difficulty / progressive-overload / streak / consistency
// tracker for UP N AT EM. This is where ALL the daily-progression rules live:
//   - finishing a day bumps your rep target (progressive overload),
//   - the target is capped at 100 and can be held or manually lowered,
//   - missing days reconciles your streak and gently decays the target.
//
// WHY THIS FILE IS PURE (no React, no DOM, no localStorage, NO CLOCK):
//   Just like positionGate.js never calls Date.now() and instead takes the
//   current time as an argument, this module NEVER reads the real clock. Every
//   transition takes an injected `today` — a plain calendar-day string in
//   'YYYY-MM-DD' form — supplied by the caller. The caller is the only part that
//   knows what "today" actually is (it will pass formatDay(Date.now()) in the
//   real app). That makes every rule here fully deterministic and trivial to
//   unit-test: a test just feeds made-up dates and checks the result.
//
//   NOTE: we DO use Date.UTC(...) inside daysBetween to turn two injected
//   'YYYY-MM-DD' strings into a whole-day difference. That is NOT a clock read —
//   it is a pure transform of the function's string inputs (same inputs always
//   give the same answer), and using UTC keeps it stable no matter the user's
//   timezone or daylight-saving changes.
//
// EVERY TRANSITION RETURNS A NEW STATE OBJECT and never mutates its input. That
// "copy, change the copy, return it" style keeps the data flow easy to reason
// about and plays nicely with UI frameworks later.
//
// PORTABILITY: this core depends on exactly ONE other project file —
// exercises.js, only to read the per-difficulty daily increment through
// getDailyIncrement(). Nothing else. That keeps it easy to lift into the future
// 'Juggernaut Fitness' app.

import { getDailyIncrement } from './exercises.js';

// The hard ceiling on a rep target. Progressive overload can grow the target
// day after day, but it will never push past this. Exported so the UI and tests
// share the exact same number.
export const MAX_TARGET = 100;

// The schema version baked into every state object. localStorage is keyed
// 'up-n-at-em:progress:v1' and the object carries a matching version:1 so a
// future schema change (e.g. during the Juggernaut merge) can detect old data
// and migrate it.
export const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// DATE HELPERS (pure string/number transforms — not clock reads)
// ---------------------------------------------------------------------------

/**
 * Turn a Date, a millisecond timestamp, or an already-formatted day string into
 * a canonical calendar-day string 'YYYY-MM-DD'.
 *
 * This is the one bridge between "a real moment in time" and "which calendar
 * day is that". The REAL app calls formatDay(Date.now()) ONCE at the edge and
 * then only ever passes the resulting string into the transitions below — so the
 * pure core still never touches the clock itself.
 *
 * We read the UTC year/month/day so the same instant always maps to the same day
 * string regardless of the machine's timezone. If you pass a string that already
 * looks like a day ('YYYY-MM-DD'), we hand it straight back.
 *
 * @param {Date|number|string} dateOrMs  A Date, a ms timestamp, or 'YYYY-MM-DD'.
 * @returns {string} the day as 'YYYY-MM-DD'.
 */
export function formatDay(dateOrMs) {
  // Already a day string? Return it unchanged (idempotent).
  if (typeof dateOrMs === 'string') {
    return dateOrMs;
  }
  const date = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
  const year = date.getUTCFullYear();
  // getUTCMonth is 0-based (January === 0), so add 1 for a human month number.
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  // padStart keeps months/days two digits ('2026-01-05', not '2026-1-5').
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * How many whole calendar days are there from day `aDay` to day `bDay`?
 *
 * Both inputs are 'YYYY-MM-DD' strings. The answer is bDay minus aDay, so:
 *   daysBetween('2026-01-01', '2026-01-01') === 0   (same day)
 *   daysBetween('2026-01-01', '2026-01-02') === 1   (next day)
 *   daysBetween('2026-01-31', '2026-02-01') === 1   (month boundary is fine)
 *   daysBetween('2026-01-02', '2026-01-01') === -1  (going backwards)
 *
 * We convert each day to a UTC midnight timestamp with Date.UTC and divide the
 * difference by the number of milliseconds in a day. UTC avoids daylight-saving
 * jumps (where a "day" could be 23 or 25 hours long) so the whole-day count is
 * exact. Math.round mops up any floating-point fuzz.
 *
 * @param {string} aDay  The earlier day as 'YYYY-MM-DD'.
 * @param {string} bDay  The later day as 'YYYY-MM-DD'.
 * @returns {number} whole calendar days from aDay to bDay (can be negative).
 */
export function daysBetween(aDay, bDay) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const a = dayToUtcMs(aDay);
  const b = dayToUtcMs(bDay);
  return Math.round((b - a) / msPerDay);
}

/**
 * Parse a 'YYYY-MM-DD' string into its UTC-midnight millisecond timestamp.
 * Pure helper used only by daysBetween. Date.UTC takes a 0-based month, so we
 * subtract 1 from the month number we parsed out of the string.
 *
 * @param {string} day  A day as 'YYYY-MM-DD'.
 * @returns {number} UTC-midnight timestamp for that day.
 */
function dayToUtcMs(day) {
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, dayOfMonth);
}

// ---------------------------------------------------------------------------
// INITIAL STATE
// ---------------------------------------------------------------------------

/**
 * Build a brand-new progress state object for a first-time user.
 *
 * The shape (see context.json data_model) is:
 *   {
 *     version: 1,
 *     settings: { [exerciseId]: { difficulty, currentTarget, startingTarget, autoIncrease } },
 *     streak: 0,
 *     lastCompletedDate: null,   // last day a workout was actually FINISHED (drives history/tracker)
 *     lastActiveDate: null,      // last day the user COMPLETED or deliberately SKIPPED a workout.
 *                                //   THIS is the baseline the miss/decay gap is measured from, so
 *                                //   consistency reflects WORKOUTS DONE, not merely the app being opened.
 *     lastResolvedDate: null,    // last day the miss/decay logic ran. ONLY an idempotency guard
 *                                //   ("have we already reconciled today?"); it is NOT the gap baseline,
 *                                //   so simply opening the app does not advance where the gap is measured from.
 *     history: [],               // completed-day log for the consistency tracker
 *   }
 *
 * startingTarget is both the user's chosen baseline AND the FLOOR that the
 * target can never decay below. currentTarget begins equal to it. autoIncrease
 * defaults to ON (progressive overload is the whole point); the user can turn it
 * off later with setAutoIncrease.
 *
 * @param {object} args
 * @param {('pushup'|'situp')} args.exercise       Which exercise this config is for.
 * @param {('easy'|'standard'|'hard'|'extreme')} args.difficulty  Chosen difficulty.
 * @param {number} args.startingTarget             The baseline rep target / floor.
 * @returns {object} a fresh versioned state object.
 */
export function createInitialState({ exercise, difficulty, startingTarget }) {
  // Keep the starting target sane: a whole number within 0..MAX_TARGET.
  const baseline = clampTarget(Math.round(startingTarget));
  return {
    version: STATE_VERSION,
    settings: {
      [exercise]: {
        difficulty,
        currentTarget: baseline,
        startingTarget: baseline,
        autoIncrease: true,
      },
    },
    streak: 0,
    lastCompletedDate: null,
    lastActiveDate: null,
    lastResolvedDate: null,
    history: [],
  };
}

// ---------------------------------------------------------------------------
// SMALL INTERNAL HELPERS (pure)
// ---------------------------------------------------------------------------

/**
 * Clamp a rep target into the allowed 0..MAX_TARGET range. Progressive overload
 * never pushes past MAX_TARGET (the hard cap), and a target is never negative.
 * @param {number} n
 * @returns {number}
 */
function clampTarget(n) {
  if (n < 0) return 0;
  if (n > MAX_TARGET) return MAX_TARGET;
  return n;
}

/**
 * Shallow-copy the whole state while REPLACING one exercise's settings object
 * with a changed copy. This is the "return a new state, never mutate" workhorse
 * the setting mutators and transitions lean on. If the exercise has no settings
 * yet, `changes` is applied on top of an empty object.
 *
 * @param {object} state        The current state.
 * @param {string} exerciseId   Which exercise's settings to change.
 * @param {object} changes      Fields to overwrite on that exercise's settings.
 * @returns {object} a new state object.
 */
function withExerciseSettings(state, exerciseId, changes) {
  const current = state.settings[exerciseId] || {};
  return {
    ...state,
    settings: {
      ...state.settings,
      [exerciseId]: { ...current, ...changes },
    },
  };
}

// ---------------------------------------------------------------------------
// SETTING MUTATORS (pure — each returns a new state)
// ---------------------------------------------------------------------------

/**
 * Change the difficulty for one exercise. Difficulty drives how big the daily
 * increment is (easy +1 ... extreme +5) but does not itself move the target.
 * @returns {object} new state.
 */
export function setDifficulty(state, exerciseId, difficulty) {
  return withExerciseSettings(state, exerciseId, { difficulty });
}

/**
 * Turn the daily auto-increase (progressive overload) on or off for an exercise.
 * With it OFF, finishing a day keeps the target exactly where it is — handy when
 * the number is already as high as the user wants for now.
 * @returns {object} new state.
 */
export function setAutoIncrease(state, exerciseId, on) {
  return withExerciseSettings(state, exerciseId, { autoIncrease: Boolean(on) });
}

/**
 * MANUAL decrease: the user lowers their current target because it got too hard.
 * We drop it by `by` (default 1) but never below the user's startingTarget —
 * that baseline is the floor. (Bad inputs like a negative `by` are guarded: we
 * only ever lower, never secretly raise, the target here.)
 * @param {object} state
 * @param {string} exerciseId
 * @param {number} [by=1]  How many reps to drop.
 * @returns {object} new state.
 */
export function decreaseTarget(state, exerciseId, by = 1) {
  const settings = state.settings[exerciseId];
  if (!settings) return state;
  // Never treat a negative/NaN `by` as a sneaky increase.
  const drop = Math.max(0, Math.round(by) || 0);
  const lowered = settings.currentTarget - drop;
  // Floor at startingTarget, and keep it within the overall clamp for safety.
  const next = clampTarget(Math.max(settings.startingTarget, lowered));
  return withExerciseSettings(state, exerciseId, { currentTarget: next });
}

/**
 * Change the baseline / floor (startingTarget) for an exercise. Because the
 * floor is also the "never decay below" line, if the new floor is HIGHER than
 * the current target we raise the current target up to meet it (you cannot sit
 * below your own floor). Lowering the floor leaves the current target alone.
 * @returns {object} new state.
 */
export function setStartingTarget(state, exerciseId, n) {
  const settings = state.settings[exerciseId];
  if (!settings) return state;
  const newFloor = clampTarget(Math.round(n));
  // currentTarget can never be below the floor.
  const newCurrent = Math.max(settings.currentTarget, newFloor);
  return withExerciseSettings(state, exerciseId, {
    startingTarget: newFloor,
    currentTarget: clampTarget(newCurrent),
  });
}

// ---------------------------------------------------------------------------
// DAY TRANSITIONS (pure — each takes an injected `today` and returns new state)
// ---------------------------------------------------------------------------

/**
 * Work out the day the miss/decay gap is measured FROM: the last day the user
 * was actually ACTIVE, meaning they either COMPLETED a workout or deliberately
 * SKIPPED one. This is the key to making the tracker reward WORKOUTS DONE rather
 * than merely opening the app.
 *
 * WHY NOT lastResolvedDate? Because resolveDay stamps lastResolvedDate on every
 * app open, using it as the baseline would mean a user who opens the app every
 * day but never works out keeps their streak and grown target forever: the
 * decay would never fire. That is the loophole we are closing. lastResolvedDate
 * is now used ONLY as an idempotency guard (see resolveDay), never as the gap
 * baseline.
 *
 * We prefer lastActiveDate (completed OR skipped). For older saved states that
 * predate lastActiveDate we fall back to lastCompletedDate so existing users
 * reconcile sensibly. Returns null if the user has never been active (nothing
 * to compare to yet, a brand-new user).
 * @param {object} state
 * @returns {string|null}
 */
function lastActiveDay(state) {
  return state.lastActiveDate || state.lastCompletedDate || null;
}

/**
 * RESOLVE / RECONCILE missed days. Run this on app open (and before any new
 * action) so the streak and targets reflect how many days have slipped by.
 *
 * THE RULES (exactly as the user specified):
 *   - A day is "missed" when the user did NOT do (or deliberately skip) the
 *     workout that day. We measure from lastActiveDay, the last day they
 *     completed or deliberately skipped, NOT from the last app open.
 *   - Miss EXACTLY ONE day: do nothing. The target HOLDS and the streak
 *     CONTINUES. One slipped day costs nothing.
 *   - Miss TWO OR MORE days: the streak RESETS to 0, AND every exercise's
 *     currentTarget DECAYS by 1 FLAT per missed day (not scaled to difficulty),
 *     floored at that exercise's startingTarget so it never drops below the
 *     user's baseline.
 *
 * GAP vs DAYS ACTUALLY MISSED (the important off-by-one):
 *   daysBetween(lastActive, today) is the CALENDAR gap, which is one MORE than
 *   the number of days actually missed. If you worked out Monday and it is now
 *   Tuesday, the gap is 1 but you have missed ZERO full days so far. If it is
 *   Wednesday, the gap is 2 but only ONE day (Tuesday) was actually missed,
 *   which is the "miss one day, hold + continue" grace case. So:
 *       missedDays = daysBetween(lastActive, today) - 1
 *   A gap of 1 gives 0 missed (hold). A gap of 2 gives 1 missed (hold). A gap of
 *   3 gives 2 missed (reset + decay by 2). We decay by missedDays, so an
 *   N-missed-day absence decays by exactly N.
 *
 * IDEMPOTENT: lastResolvedDate is the guard. If we have ALREADY resolved today
 * (lastResolvedDate === today) we change nothing, so re-opening the app
 * repeatedly on the same day never double-applies or drifts. Crucially we do
 * NOT measure the gap from lastResolvedDate, only from lastActiveDay, so the
 * mere act of resolving (opening the app) never advances the baseline. A user
 * who opens the app several days running WITHOUT working out keeps accumulating
 * missed days against their last ACTIVE day and will hit the 2+-day reset+decay.
 *
 * If the user is brand new (never active), there is nothing to reconcile, so we
 * just stamp today's resolve guard.
 *
 * @param {object} state
 * @param {string} today  Injected 'YYYY-MM-DD'.
 * @returns {object} new state.
 */
export function resolveDay(state, today) {
  // Idempotency guard: if we already reconciled today, do nothing at all. This
  // is the ONLY role lastResolvedDate plays; it never feeds the gap maths.
  if (state.lastResolvedDate === today) {
    return state;
  }

  const active = lastActiveDay(state);

  // Brand-new user (never completed or skipped): nothing to reconcile, just
  // stamp today's resolve guard so repeat opens today stay a no-op.
  if (!active) {
    return { ...state, lastResolvedDate: today };
  }

  // Days ACTUALLY missed = calendar gap minus 1 (see the off-by-one note above).
  // A negative gap (clock skew / travelling back a timezone) also lands here and
  // safely holds.
  const missedDays = daysBetween(active, today) - 1;

  // Miss one day or fewer: HOLD everything (target + streak), just stamp the
  // resolve guard.
  if (missedDays <= 1) {
    return { ...state, lastResolvedDate: today };
  }

  // Miss two or more: reset the streak AND decay every target by 1 flat per
  // missed day, floored at each exercise's own startingTarget.
  const decayedSettings = {};
  for (const [exerciseId, settings] of Object.entries(state.settings)) {
    const decayed = settings.currentTarget - missedDays;
    decayedSettings[exerciseId] = {
      ...settings,
      currentTarget: Math.max(settings.startingTarget, decayed),
    };
  }

  return {
    ...state,
    streak: 0,
    settings: decayedSettings,
    lastResolvedDate: today,
  };
}

/**
 * COMPLETE a day: the user actually finished their workout today.
 *
 * WHAT HAPPENS:
 *   - streak grows by 1 (another day in a row).
 *   - For every exercise with autoIncrease ON, the currentTarget climbs by that
 *     difficulty's daily increment (easy +1, standard +2, hard +3, extreme +5),
 *     CAPPED at MAX_TARGET (100) — it never exceeds the cap. With autoIncrease
 *     OFF, that exercise's target holds.
 *   - lastCompletedDate, lastActiveDate and lastResolvedDate are all set to
 *     today. lastActiveDate is what the miss/decay gap is measured from, so
 *     completing RESETS the miss baseline to today (future misses count from
 *     here). lastResolvedDate stamps that today is already reconciled.
 *   - A history entry is appended for the consistency tracker: the day, the
 *     per-exercise reps, the total reps, and how long it took (elapsedMs, from
 *     the session timer; v1 just records it, it does not yet affect progression).
 *
 * @param {object} state
 * @param {object} session
 * @param {Array<{exercise:string, reps:number}>} session.entries  Per-exercise reps done.
 * @param {number} [session.elapsedMs]  How long the whole session took, in ms.
 * @param {string} today  Injected 'YYYY-MM-DD'.
 * @returns {object} new state.
 */
export function completeDay(state, { entries = [], elapsedMs = 0 } = {}, today) {
  // Bump every auto-increasing target by its difficulty's increment, capped.
  const bumpedSettings = {};
  for (const [exerciseId, settings] of Object.entries(state.settings)) {
    if (settings.autoIncrease) {
      const increment = getDailyIncrement(exerciseId, settings.difficulty);
      bumpedSettings[exerciseId] = {
        ...settings,
        // min(100, ...) is the hard cap: adding the increment can reach 100 but
        // never goes past it.
        currentTarget: Math.min(MAX_TARGET, settings.currentTarget + increment),
      };
    } else {
      // Auto-increase off for this exercise: hold the target exactly.
      bumpedSettings[exerciseId] = { ...settings };
    }
  }

  // Total reps across every exercise in this session, for the tracker.
  const totalReps = entries.reduce((sum, e) => sum + (e.reps || 0), 0);

  // A fresh history entry (copied inputs, so later edits to the caller's arrays
  // cannot reach back into our stored state).
  const historyEntry = {
    date: today,
    entries: entries.map((e) => ({ exercise: e.exercise, reps: e.reps })),
    totalReps,
    elapsedMs,
  };

  return {
    ...state,
    streak: state.streak + 1,
    settings: bumpedSettings,
    lastCompletedDate: today,
    lastActiveDate: today,
    lastResolvedDate: today,
    history: [...state.history, historyEntry],
  };
}

/**
 * SKIP a day on purpose (the user deliberately held the "skip today" control on
 * the settings screen, NOT an accidental mid-workout emergency bail-out).
 *
 * A deliberate skip behaves exactly like MISSING ONE day: the target HOLDS and
 * the streak CONTINUES. The key move is that a skip updates lastActiveDate =
 * today, so it counts as the user being "active" today and the miss baseline
 * advances by exactly one day. That is what makes a single skip hold exactly
 * one day and no more: resolveDay tomorrow measures its gap from today's skip,
 * so a skip followed by another missed day without working out still rolls into
 * the 2+-missed-day reset at the right time. We also stamp lastResolvedDate =
 * today so re-opening the app today stays a no-op.
 *
 * We do NOT touch lastCompletedDate and we do NOT append a history entry,
 * because a skip is not a completed workout: the consistency history only logs
 * days the user actually finished.
 *
 * @param {object} state
 * @param {string} today  Injected 'YYYY-MM-DD'.
 * @returns {object} new state.
 */
export function skipDay(state, today) {
  return { ...state, lastActiveDate: today, lastResolvedDate: today };
}
