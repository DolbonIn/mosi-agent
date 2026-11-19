import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * Is this nav layer what the user sees — the top of its stack in the active tab? Tabs stay mounted once visited and
 * pushed-under screens stay mounted too, so per-screen claims on shared chrome (the compact title, the top bar's
 * trailing capsule / centre action) must follow this, not mount/unmount. Outside the nav stack (sheets, onboarding)
 * it is always true.
 *
 * The context carries a STABLE source (not a boolean) so a tab switch does not re-render every screen that claims
 * chrome — claims subscribe imperatively (useRouteActiveSource). `useRouteActive()` is the opt-in boolean hook (it
 * re-renders its caller on change).
 */
export interface ActiveSource {
  get(): boolean;
  subscribe(fn: () => void): () => void;
}

const ALWAYS: ActiveSource = { get: () => true, subscribe: () => () => {} };
export const RouteActiveContext = createContext<ActiveSource>(ALWAYS);

/** a source that is `own && parent` (NavStack: TabLayer → parent ALWAYS, stack Layer → parent = its TabLayer) */
export function createActiveSource(own: boolean, parent: ActiveSource = ALWAYS): ActiveSource & { set(v: boolean): void } {
  let mine = own;
  let last = own && parent.get();
  const subs = new Set<() => void>();
  const notify = () => {
    const now = mine && parent.get();
    if (now === last) return;
    last = now;
    for (const fn of [...subs]) fn();
  };
  let off: (() => void) | null = null;
  return {
    get: () => mine && parent.get(),
    subscribe(fn) {
      subs.add(fn);
      if (!off) {
        last = mine && parent.get(); // the parent may have changed while nobody listened
        off = parent.subscribe(notify);
      }
      return () => {
        subs.delete(fn);
        if (!subs.size && off) {
          off();
          off = null;
        }
      };
    },
    set(v) {
      if (v === mine) return;
      mine = v;
      notify();
    },
  };
}

export const useRouteActiveSource = () => useContext(RouteActiveContext);

/** boolean for the caller's own render (re-renders on change; claims on shared chrome should subscribe instead) */
export function useRouteActive(): boolean {
  const src = useContext(RouteActiveContext);
  return useSyncExternalStore(src.subscribe, src.get, src.get);
}
