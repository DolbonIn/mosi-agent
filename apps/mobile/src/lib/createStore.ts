import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * A tiny external store (no context, no provider): `get`, `set`, `subscribe`, plus a selector hook built on
 * useSyncExternalStore. Every app-level store (session, threads, nav, island, tier, …) is one of these.
 */
export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  /** shallow merge for object states */
  patch(partial: Partial<T>): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of [...listeners]) l();
  };
  return {
    get: () => state,
    set(next) {
      const value = typeof next === "function" ? (next as (p: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      emit();
    },
    patch(partial) {
      state = { ...state, ...partial };
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const shallowEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
};

/** Subscribe to a store, optionally through a selector (re-renders only when the selection changes). */
export function useStore<T>(store: Store<T>): T;
export function useStore<T, S>(store: Store<T>, selector: (s: T) => S, isEqual?: (a: S, b: S) => boolean): S;
export function useStore<T, S>(store: Store<T>, selector?: (s: T) => S, isEqual: (a: S, b: S) => boolean = shallowEqual): S | T {
  const memo = useRef<{ state: T; sel: S } | null>(null);
  const selRef = useRef(selector);
  selRef.current = selector;
  const getSnapshot = useCallback(() => {
    const state = store.get();
    const sel = selRef.current;
    if (!sel) return state as unknown as S;
    const prev = memo.current;
    if (prev && Object.is(prev.state, state)) return prev.sel;
    const next = sel(state);
    if (prev && isEqual(prev.sel, next)) {
      memo.current = { state, sel: prev.sel };
      return prev.sel;
    }
    memo.current = { state, sel: next };
    return next;
  }, [store, isEqual]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
