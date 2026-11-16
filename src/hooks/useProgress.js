// useProgress.js
// -----------------------------------------------------------------------------
// The THIN React bridge between the pure progression core (progressStore.js)
// and the rest of the app's UI. Think of it as the "edge" where three worlds
// meet:
//
//   1. the browser's localStorage        (via storageAdapter.js)
//   2. the real-world clock              (Date.now())
//   3. the pure, clock-free rules engine (progressStore.js)
//
// WHY A HOOK, AND WHY HERE?
//   progressStore.js is deliberately PURE: it never reads the clock and never
//   touches storage. That makes it easy to test, but something has to actually
//   (a) read what "today" is, (b) load/save from localStorage, and (c) hold the
//   live state so React re-renders when it changes. That "something" is this
//   hook. Keeping ALL the clock reads in exactly two places — this hook and
//   App.jsx — is a hard rule of the project: the pure modules stay clock-free,
//   so every rule they encode stays deterministic and unit-testable.
//
// HOW "today" FLOWS:
//   Whenever we need to run a rule, we compute today = formatDay(Date.now())
//   right here at the edge and PASS that plain 'YYYY-MM-DD' string into the
//   pure function. The pure function never sees Date.now(); it only sees the
//   string we hand it.
//
// WHAT THIS HOOK DOES ON MOUNT (once):
//   - loadRaw() the saved blob. If there is none (first run), build a sensible
//     default state with createInitialState().
//   - run resolveDay(state, today) ONCE to apply any pending miss/decay that
//     built up while the app was closed (resolveDay is idempotent, so doing it
//     once per open is correct and safe).
//   - saveRaw() the resolved state so the reconciliation is persisted.
//
// WHAT IT EXPOSES:
//   - `state`: the current progress state object (or null until mount runs).
//   - action wrappers that each call the matching pure function with today,
//     then saveRaw + update React state in one go:
//       setDifficulty, setAutoIncrease, decreaseTarget, setStartingTarget,
//       completeDay, skipDay.
//
// A future Juggernaut Fitness merge can swap storageAdapter for native storage
// without touching the pure core OR this hook's public shape.

import { useState, useEffect, useCallback } from 'react';
import { loadRaw, saveRaw } from '../logic/storageAdapter.js';
import {
  formatDay,
  createInitialState,
  resolveDay,
  setDifficulty as pureSetDifficulty,
  setAutoIncrease as pureSetAutoIncrease,
  decreaseTarget as pureDecreaseTarget,
  setStartingTarget as pureSetStartingTarget,
  completeDay as pureCompleteDay,
  skipDay as pureSkipDay,
} from '../logic/progressStore.js';
import { getPreset } from '../logic/exercises.js';

// The sensible first-run defaults for a brand-new user: a standard push-up
// workout whose starting target is the preset's suggested default reps. These
// are only used the very first time, before anything is saved.
const DEFAULT_EXERCISE = 'pushup';
const DEFAULT_DIFFICULTY = 'standard';

/**
 * Read today's calendar day as a 'YYYY-MM-DD' string. This is the ONE place
 * (together with App.jsx) allowed to read the real clock for progression. Every
 * pure call below is handed the STRING this returns, never Date.now() itself.
 * @returns {string}
 */
function today() {
  return formatDay(Date.now());
}

/**
 * The progress hook. Returns the live state plus action wrappers.
 *
 * @returns {{
 *   state: object|null,
 *   setDifficulty: (exerciseId:string, difficulty:string) => void,
 *   setAutoIncrease: (exerciseId:string, on:boolean) => void,
 *   decreaseTarget: (exerciseId:string, by?:number) => void,
 *   setStartingTarget: (exerciseId:string, n:number) => void,
 *   completeDay: (sessionResult:{entries:Array, elapsedMs:number}) => void,
 *   skipDay: () => void,
 * }}
 */
export function useProgress() {
  // The live progress state. null until the mount effect has loaded/resolved,
  // so consumers should guard on it (the UI shows nothing progression-y until
  // it exists, which is a single frame).
  const [state, setState] = useState(null);

  // ---- Mount: load (or create), resolve ONCE, persist --------------------
  useEffect(() => {
    // 1. Try to load the saved blob. null means "nothing saved yet".
    const saved = loadRaw();

    // 2. First run? Build a sensible default. The starting target is the
    //    chosen difficulty's suggested default reps.
    const base =
      saved ||
      createInitialState({
        exercise: DEFAULT_EXERCISE,
        difficulty: DEFAULT_DIFFICULTY,
        startingTarget: getPreset(DEFAULT_EXERCISE, DEFAULT_DIFFICULTY)
          .defaultReps,
      });

    // 3. Reconcile any days that slipped by while the app was closed. This is
    //    the EDGE where we read the real clock and hand the pure core a plain
    //    day string. resolveDay is idempotent, so running it once per open is
    //    exactly right.
    const resolved = resolveDay(base, today());

    // 4. Persist the reconciled state and show it.
    saveRaw(resolved);
    setState(resolved);
  }, []);

  // A tiny helper that every action wrapper uses: given the CURRENT state, run
  // a pure transition to get the NEXT state, then persist + store it. Using the
  // functional setState form means we always transition from the freshest
  // state even if several actions fire in quick succession.
  const applyTransition = useCallback((transition) => {
    setState((current) => {
      if (!current) return current; // not loaded yet; ignore (should not happen)
      const next = transition(current);
      saveRaw(next);
      return next;
    });
  }, []);

  // ---- Action wrappers ----------------------------------------------------
  // Each one is a thin shim: it reads today at the edge, calls the matching
  // PURE function, then applyTransition persists + updates React state.

  const setDifficulty = useCallback(
    (exerciseId, difficulty) =>
      applyTransition((s) => pureSetDifficulty(s, exerciseId, difficulty)),
    [applyTransition]
  );

  const setAutoIncrease = useCallback(
    (exerciseId, on) =>
      applyTransition((s) => pureSetAutoIncrease(s, exerciseId, on)),
    [applyTransition]
  );

  const decreaseTarget = useCallback(
    (exerciseId, by = 1) =>
      applyTransition((s) => pureDecreaseTarget(s, exerciseId, by)),
    [applyTransition]
  );

  const setStartingTarget = useCallback(
    (exerciseId, n) =>
      applyTransition((s) => pureSetStartingTarget(s, exerciseId, n)),
    [applyTransition]
  );

  // Record a finished workout. today is read at the edge and handed into the
  // pure completeDay, which advances the streak, progresses the target, and
  // appends the session (incl. elapsedMs from the timer) to history.
  const completeDay = useCallback(
    (sessionResult) =>
      applyTransition((s) => pureCompleteDay(s, sessionResult, today())),
    [applyTransition]
  );

  // A DELIBERATE skip (the press-and-hold Skip-today control). Behaves like
  // missing exactly one day: target holds, streak continues.
  const skipDay = useCallback(
    () => applyTransition((s) => pureSkipDay(s, today())),
    [applyTransition]
  );

  return {
    state,
    setDifficulty,
    setAutoIncrease,
    decreaseTarget,
    setStartingTarget,
    completeDay,
    skipDay,
  };
}
