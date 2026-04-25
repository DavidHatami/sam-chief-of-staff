// state.js — Tiny signals + store primitive for SAM.
//
// No build step, no dependencies. Two primitives:
//
//   createSignal(value) → [get, set, subscribe]
//     get()               returns current value
//     set(next)           sets value, notifies subs if changed (Object.is)
//     subscribe(fn)       registers fn; returns an unsubscribe fn
//
//   createStore(initial) → store
//     store.get()                returns current object
//     store.set(nextObj)         replaces object wholesale
//     store.patch(partial)       shallow-merges partial into current
//     store.subscribe(fn)        registers fn(next, prev)
//     store.select(picker, fn)   subscribes only when picker(state) changes
//
// Both are intentionally minimal. They exist so that Phase-1 modules can
// share state without reaching into globals, and so render.js has something
// to subscribe to.

export function createSignal(initial) {
  let val = initial;
  const subs = new Set();
  const get = () => val;
  const set = (next) => {
    if (Object.is(val, next)) return;
    const prev = val;
    val = next;
    for (const s of subs) {
      try { s(val, prev); } catch (e) { console.error('[state] signal subscriber failed:', e); }
    }
  };
  const subscribe = (fn) => {
    subs.add(fn);
    return () => subs.delete(fn);
  };
  return [get, set, subscribe];
}

export function createStore(initial) {
  let state = { ...initial };
  const subs = new Set();
  const selectors = new Set();

  const notify = (prev) => {
    for (const s of subs) {
      try { s(state, prev); } catch (e) { console.error('[state] store subscriber failed:', e); }
    }
    for (const entry of selectors) {
      try {
        const nextVal = entry.picker(state);
        if (!Object.is(nextVal, entry.lastVal)) {
          const prevVal = entry.lastVal;
          entry.lastVal = nextVal;
          entry.fn(nextVal, prevVal);
        }
      } catch (e) { console.error('[state] store selector failed:', e); }
    }
  };

  return {
    get: () => state,
    set: (nextObj) => {
      const prev = state;
      state = { ...nextObj };
      notify(prev);
    },
    patch: (partial) => {
      const prev = state;
      state = { ...state, ...partial };
      notify(prev);
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    select: (picker, fn) => {
      const entry = { picker, fn, lastVal: picker(state) };
      selectors.add(entry);
      return () => selectors.delete(entry);
    },
  };
}
