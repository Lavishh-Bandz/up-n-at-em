import { describe, it, expect, afterEach } from 'vitest';
import { loadRaw, saveRaw, clearRaw, STORAGE_KEY } from '../storageAdapter.js';

// A tiny in-memory stand-in for the browser's localStorage. It implements just
// the methods the adapter uses (getItem/setItem/removeItem) over a plain object,
// so we can drive the adapter without a real browser. Tests assign this (or a
// throwing variant) onto globalThis.localStorage and clean up afterwards.
function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

// Always put globalThis.localStorage back to its original value between tests so
// one test's stub cannot leak into another.
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (original) {
    Object.defineProperty(globalThis, 'localStorage', original);
  } else {
    delete globalThis.localStorage;
  }
});

describe('storageAdapter round-trip', () => {
  it('saveRaw then loadRaw returns an equal object', () => {
    globalThis.localStorage = makeMemoryStorage();
    const data = { version: 1, streak: 3, history: [{ date: '2026-01-01', totalReps: 20 }] };
    expect(saveRaw(data)).toBe(true);
    expect(loadRaw()).toEqual(data);
  });

  it('clearRaw removes the stored blob so loadRaw is null again', () => {
    globalThis.localStorage = makeMemoryStorage();
    saveRaw({ version: 1, streak: 1 });
    expect(loadRaw()).not.toBeNull();
    expect(clearRaw()).toBe(true);
    expect(loadRaw()).toBeNull();
  });

  it('writes under the versioned storage key', () => {
    const store = makeMemoryStorage();
    globalThis.localStorage = store;
    saveRaw({ version: 1 });
    expect(store.getItem(STORAGE_KEY)).toBe(JSON.stringify({ version: 1 }));
  });
});

describe('storageAdapter degrades gracefully', () => {
  it('loadRaw returns null when nothing is stored', () => {
    globalThis.localStorage = makeMemoryStorage();
    expect(loadRaw()).toBeNull();
  });

  it('loadRaw returns null (no throw) on corrupt JSON', () => {
    const store = makeMemoryStorage();
    store.setItem(STORAGE_KEY, '{ this is not valid json ');
    globalThis.localStorage = store;
    expect(() => loadRaw()).not.toThrow();
    expect(loadRaw()).toBeNull();
  });

  it('does not throw and reports false when localStorage is undefined', () => {
    delete globalThis.localStorage;
    expect(() => loadRaw()).not.toThrow();
    expect(loadRaw()).toBeNull();
    expect(() => saveRaw({ a: 1 })).not.toThrow();
    expect(saveRaw({ a: 1 })).toBe(false);
    expect(() => clearRaw()).not.toThrow();
    expect(clearRaw()).toBe(false);
  });

  it('does not throw and reports false when setItem throws (quota/SecurityError)', () => {
    globalThis.localStorage = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error('QuotaExceededError');
      },
      removeItem() {
        throw new Error('SecurityError');
      },
    };
    expect(() => saveRaw({ a: 1 })).not.toThrow();
    expect(saveRaw({ a: 1 })).toBe(false);
    expect(() => clearRaw()).not.toThrow();
    expect(clearRaw()).toBe(false);
    // loadRaw still works (getItem returns null) and must not throw.
    expect(loadRaw()).toBeNull();
  });
});
