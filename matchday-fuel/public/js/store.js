// The order in progress: drink key -> quantity. Kept in this browser so a reload or a trip to
// another section doesn't lose it.

const STORAGE_KEY = "matchday-fuel-order-v1";
export const MAX_PER_DRINK = 12;
export const MAX_BOTTLES = 24;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return new Map(Object.entries(saved).filter(([, qty]) => Number.isInteger(qty) && qty > 0));
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
  const emit = (change) => { save(); listeners.forEach((listener) => listener(change)); };

  return {
    get: (key) => items.get(key) || 0,
    entries: () => [...items.entries()],
    count: () => [...items.values()].reduce((sum, qty) => sum + qty, 0),
    set(key, qty, limit = MAX_PER_DRINK) {
      const others = this.count() - this.get(key);
      const next = Math.max(0, Math.min(qty, limit, MAX_PER_DRINK, MAX_BOTTLES - others));
      if (next === this.get(key)) return next;
      if (next === 0) items.delete(key);
      else items.set(key, next);
      emit({ key, qty: next });
      return next;
    },
    clear() {
      items.clear();
      emit({ key: null, qty: 0 });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
