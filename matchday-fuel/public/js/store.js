// The order in progress: drink key -> quantity. Kept in this browser so a reload or a trip to
// another section doesn't lose it.

const STORAGE_KEY = "matchday-fuel-order-v1";
export const MAX_PER_DRINK = 12;
export const MAX_BOTTLES = 24;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return new Map(Object.entries(saved)
      .filter(([, qty]) => Number.isInteger(qty) && qty > 0)
      .map(([key, qty]) => [key, Math.min(qty, MAX_PER_DRINK)]));
  } catch {
    return new Map();
  }
}

export function createCart() {
  const items = load();
  const listeners = new Set();

  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(items)));
    } catch {
      // Storage can be unavailable (private windows); the order still works for this visit.
    }
  };
  const notify = (change) => listeners.forEach((listener) => listener(change));

  return {
    storageKey: STORAGE_KEY,
    get: (key) => items.get(key) || 0,
    entries: () => [...items.entries()],
    count: () => [...items.values()].reduce((sum, qty) => sum + qty, 0),
    // How many of this drink the order could hold before reaching the bottle limit.
    room(key) {
      return MAX_BOTTLES - this.count() + this.get(key);
    },
    set(key, qty, limit = MAX_PER_DRINK) {
      const next = Math.max(0, Math.min(qty, limit, MAX_PER_DRINK, this.room(key)));
      if (next === this.get(key)) return next;
      if (next === 0) items.delete(key);
      else items.set(key, next);
      save();
      notify({ key, qty: next });
      return next;
    },
    clear() {
      items.clear();
      save();
      notify({ key: null, qty: 0 });
    },
    // Re-reads the saved order, for example after another tab changed it or after paying.
    reload() {
      items.clear();
      for (const [key, qty] of load()) items.set(key, qty);
      notify({ key: null, qty: 0 });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
