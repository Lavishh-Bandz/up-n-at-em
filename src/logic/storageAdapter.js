// storageAdapter.js
// -----------------------------------------------------------------------------
// The ONE and ONLY place in the whole app that touches the browser's
// localStorage. Everything else (the progression/streak core, the UI) stays
// pure and talks to this thin "edge" instead.
//
// WHY ISOLATE localStorage HERE?
//   localStorage is the messy, real-world edge of the app:
//     - It might not exist at all (a server-side render, a unit test, an old
//       or stripped-down browser).
//     - It can THROW even when it exists: Safari private mode refuses writes
//       with a quota error, some browsers raise a SecurityError when storage
//       is blocked by privacy settings, and a full disk raises a quota error.
//     - What we read back might be CORRUPT (someone edited it by hand, a half
//       written value, a leftover from an older version).
//   If any of that crashed the app, UP N AT EM would simply fail to open. So
//   this adapter SWALLOWS every storage error and returns a safe, boring value
//   (null, or nothing) instead. The rest of the app can then just say "no saved
//   progress yet" and carry on with a fresh start.
//
// KEEPING IT IN ONE FILE also means that when the user later folds UP N AT EM
// into the separate 'Juggernaut Fitness' app, swapping localStorage for a
// different store (a file, a database, native device storage) is a change to
// THIS file only. The pure core in progressStore.js never has to know.
//
// WHAT WE STORE: a single JSON blob (the whole progress state object produced by
// progressStore.js) under one versioned key. "v1" in the key means a future
// schema change can pick a new key / migrate without clobbering old data.

// The single localStorage key we read and write. Versioned on purpose (see
// above) so a later Juggernaut merge or schema change can migrate cleanly.
export const STORAGE_KEY = 'up-n-at-em:progress:v1';

/**
 * Safely get hold of the localStorage object, or null if it is not usable.
 *
 * We do not just trust that `localStorage` exists: merely TOUCHING it can throw
 * in some locked-down browsers. So we wrap the access in a try/catch and return
 * null the moment anything looks wrong. Returning null (rather than throwing)
 * lets every function below degrade gracefully to a "no storage available"
 * no-op.
 *
 * @returns {Storage|null} the localStorage object, or null if unavailable.
 */
function getStore() {
  try {
    // `globalThis` is the portable way to reach the global object in a browser,
    // a web worker, Node, or a test — without assuming `window` exists.
    const store = globalThis.localStorage;
    // Guard against a missing or malformed stand-in (e.g. undefined in SSR, or
    // a stub that is not really a Storage).
    if (!store || typeof store.getItem !== 'function') {
      return null;
    }
    return store;
  } catch {
    // Even reading the property threw (privacy settings, sandboxed iframe, ...).
    return null;
  }
}

/**
 * Read the saved progress blob back out of localStorage.
 *
 * Returns the parsed object on success. Returns null for every "nothing usable"
 * case WITHOUT throwing, so the caller can treat all of them the same ("start
 * fresh"):
 *   - storage is unavailable,
 *   - nothing has been saved yet (the key is absent),
 *   - the stored string is corrupt / not valid JSON.
 *
 * @returns {object|null} the parsed state object, or null.
 */
export function loadRaw() {
  const store = getStore();
  if (!store) {
    return null;
  }
  try {
    const text = store.getItem(STORAGE_KEY);
    // Key absent (or explicitly null) -> nothing saved yet.
    if (text == null) {
      return null;
    }
    // JSON.parse throws on corrupt text; the catch below turns that into null.
    return JSON.parse(text);
  } catch {
    // Corrupt JSON, or a getItem that threw. Treat as "no saved progress".
    return null;
  }
}

/**
 * Write the progress blob to localStorage, replacing whatever was there.
 *
 * Swallows any write error (quota exceeded, SecurityError, storage missing) and
 * reports success as a boolean so a caller can tell whether the save actually
 * stuck, without ever having to wrap the call in its own try/catch. Saving is a
 * nice-to-have: if it fails, the in-memory state is still correct for this
 * session, we just could not persist it.
 *
 * @param {object} obj  The state object to persist.
 * @returns {boolean} true if the write succeeded, false if it was swallowed.
 */
export function saveRaw(obj) {
  const store = getStore();
  if (!store) {
    return false;
  }
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(obj));
    return true;
  } catch {
    // Quota exceeded, private-mode refusal, SecurityError, a stringify cycle...
    // nothing we can do about it here, so just report that it did not save.
    return false;
  }
}

/**
 * Remove the saved progress blob entirely (e.g. a "reset my progress" button).
 *
 * Like the others, this never throws: if storage is unavailable or removal
 * fails, there is simply nothing to clear and we report false.
 *
 * @returns {boolean} true if the removal succeeded, false if it was swallowed.
 */
export function clearRaw() {
  const store = getStore();
  if (!store) {
    return false;
  }
  try {
    store.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
