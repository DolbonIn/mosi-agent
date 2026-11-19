import type { TabId } from "@pickle/protocol";
import { createElement, useEffect, useState, type ComponentType } from "react";
import { createStore, useStore } from "../lib/createStore";

/**
 * Navigation: one tab at a time, each tab keeps its own push/pop stack (HIG tab bars preserve each section's state).
 *   nav.setTab("profile")                        // the droplet travels; content swaps by direction (16px, no scale)
 *   nav.push("settings.display", { from: "row" }, { title: "화면 및 디자인", titleLayoutId: "row-display" })
 *   nav.pop()                                    // or the back swipe from the left edge (direct manipulation)
 * Detail screens register once: registerScreen("settings.display", DisplayScreen). Tab roots: registerTabRoot().
 * Heavy or rarely opened screens register as their own chunk (route-level code splitting):
 *   registerScreen("call", lazyScreen(() => import("./call/CallScreen").then((m) => m.CallScreen)))
 * nav.push / nav.setTab wait for a lazy screen's chunk before they start the transition (so the page never slides in
 * empty), and NavStack prefetches every lazy screen on idle after the first load, so that wait is normally zero.
 * A pushed screen's large title can morph from the row that opened it: give the row `layoutId` and pass the same id
 * as `titleLayoutId` (LargeTitle reads it from the route).
 */
export interface Route {
  key: string;
  screen: string;
  params?: Record<string, unknown>;
  title?: string;
  titleLayoutId?: string;
}

export interface ScreenProps {
  route: Route;
}

export interface NavState {
  tab: TabId;
  /** −1 | 1: which way the last tab change went (content travels with it) */
  tabDir: -1 | 1;
  stacks: Record<TabId, Route[]>;
  drawer: boolean;
  /** the last change was already shown by a gesture: skip its animation */
  instant: boolean;
  last: "tab" | "push" | "pop" | "none";
}

export const TAB_ORDER: TabId[] = ["chat", "explore", "archive", "profile"];

export const navStore = createStore<NavState>({
  tab: "chat",
  tabDir: 1,
  stacks: { chat: [], explore: [], archive: [], profile: [] },
  drawer: false,
  instant: false,
  last: "none",
});

export function useNav<S>(sel: (s: NavState) => S): S {
  return useStore(navStore, sel);
}

let seq = 0;
const scrolls = new Map<string, number>();

// nav.compose → the chat builder's composer (registered with setComposeHandler); queued until one registers
type ComposeHandler = (text: string, threadId?: string) => void;
let composeHandler: ComposeHandler | null = null;
let pendingCompose: { text: string; threadId?: string } | null = null;
/** the chat screens register how to put text into a thread's draft and focus the composer */
export function setComposeHandler(fn: ComposeHandler | null) {
  composeHandler = fn;
  if (fn && pendingCompose) {
    const p = pendingCompose;
    pendingCompose = null;
    fn(p.text, p.threadId);
  }
}

let tabAt = 0;
/** when the latest tab switch started (the tap, or a lazy root's chunk arriving): a first visit's entrance is timed
 *  from here, however late its first render and frames land */
export const tabSwitchedAt = () => tabAt;

export const nav = {
  setTab(tab: TabId) {
    const s = navStore.get();
    if (tab === s.tab) {
      // tapping the active tab pops to its root (iOS)
      if (s.stacks[tab].length) nav.popToRoot();
      return;
    }
    whenLoaded(overriddenTabs.has(tab) ? undefined : roots.get(tab), () => {
      const cur = navStore.get();
      if (cur.tab === tab) return;
      const dir = TAB_ORDER.indexOf(tab) >= TAB_ORDER.indexOf(cur.tab) ? 1 : -1;
      tabAt = performance.now();
      navStore.patch({ tab, tabDir: dir, instant: false, last: "tab", drawer: false });
    });
  },
  push(screen: string, params?: Record<string, unknown>, opts: { title?: string; titleLayoutId?: string } = {}): string {
    const tab = navStore.get().tab;
    const key = `${screen}#${++seq}`;
    const route: Route = { key, screen, params, ...opts };
    whenLoaded(screens.get(screen), () => {
      const s = navStore.get();
      navStore.patch({ stacks: { ...s.stacks, [tab]: [...s.stacks[tab], route] }, instant: false, last: "push", drawer: false });
    });
    return key;
  },
  pop(opts: { instant?: boolean } = {}) {
    const s = navStore.get();
    const stack = s.stacks[s.tab];
    if (!stack.length) return;
    const gone = stack[stack.length - 1]!;
    scrolls.delete(gone.key);
    navStore.patch({ stacks: { ...s.stacks, [s.tab]: stack.slice(0, -1) }, instant: !!opts.instant, last: "pop" });
  },
  popToRoot() {
    const s = navStore.get();
    for (const r of s.stacks[s.tab]) scrolls.delete(r.key);
    navStore.patch({ stacks: { ...s.stacks, [s.tab]: [] }, instant: false, last: "pop" });
  },
  /**
   * Empty states and suggestion chips (MOTION-SPEC §8.14): go to the chat (the given thread, else the default chat at
   * the chat root), put `text` into that thread's draft and focus the composer — nothing is sent.
   */
  compose(text: string, threadId?: string) {
    const s = navStore.get();
    if (s.tab !== "chat") nav.setTab("chat");
    if (threadId) {
      const top = nav.current();
      if (!(top?.screen === "thread" && top.params?.threadId === threadId)) nav.push("thread", { threadId });
    } else if (navStore.get().stacks.chat.length) {
      nav.popToRoot();
    }
    if (navStore.get().drawer) navStore.patch({ drawer: false });
    if (composeHandler) composeHandler(text, threadId);
    else pendingCompose = { text, threadId };
  },
  openDrawer() {
    navStore.patch({ drawer: true });
  },
  closeDrawer() {
    navStore.patch({ drawer: false });
  },
  toggleDrawer() {
    navStore.patch({ drawer: !navStore.get().drawer });
  },
  /** top route of the current tab (null = the tab root) */
  current(): Route | null {
    const s = navStore.get();
    const stack = s.stacks[s.tab];
    return stack[stack.length - 1] ?? null;
  },
  canGoBack() {
    const s = navStore.get();
    return s.stacks[s.tab].length > 0;
  },
};

/** per-route scroll memory (saved on unmount, restored on mount) */
export const saveScroll = (key: string, y: number) => scrolls.set(key, y);
export const readScroll = (key: string) => scrolls.get(key) ?? 0;

// ── screen registry ──
const screens = new Map<string, ComponentType<ScreenProps>>();
const roots = new Map<TabId, ComponentType<ScreenProps>>();
const registryStore = createStore(0);

export function registerScreen(name: string, component: ComponentType<ScreenProps>) {
  screens.set(name, component);
  registryStore.set((n) => n + 1);
}
export function registerTabRoot(tab: TabId, component: ComponentType<ScreenProps>) {
  roots.set(tab, component);
  registryStore.set((n) => n + 1);
}
export const getScreen = (name: string) => screens.get(name);
export const getTabRoot = (tab: TabId) => roots.get(tab);
export const useRegistryVersion = () => useStore(registryStore);

// ── lazy screens (route-level code splitting) ──
export type LazyScreen<P extends object = ScreenProps> = ComponentType<P> & { preload(): Promise<void>; loaded(): boolean };

const isLazy = (c: unknown): c is LazyScreen => typeof c === "function" && typeof (c as Partial<LazyScreen>).preload === "function";
const lazies: LazyScreen<never>[] = [];

/**
 * A screen (or any heavy, not-first-paint component: an overlay, a viewer) in its own chunk. Not React.lazy: no
 * Suspense boundary, no fallback commit and no reveal throttle — the host renders the component synchronously once
 * its chunk is in (nav waits for that before animating), else nothing until it arrives. Every lazyScreen() is
 * prefetched on idle after startup (app/startup.ts). A failed load is retried on the next mount or navigation.
 */
export function lazyScreen<P extends object = ScreenProps>(load: () => Promise<ComponentType<P>>): LazyScreen<P> {
  let loadedC: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;
  const preload = () =>
    (pending ??= load().then(
      (c) => {
        loadedC = c;
      },
      (err: unknown) => {
        pending = null;
        throw err;
      },
    ));
  function LazyScreenHost(props: P) {
    const [C, setC] = useState<ComponentType<P> | null>(() => loadedC);
    useEffect(() => {
      if (C) return;
      let live = true;
      preload().then(
        () => live && setC(() => loadedC),
        () => {},
      );
      return () => {
        live = false;
      };
    }, [C]);
    return C ? createElement(C as ComponentType<object>, props) : null;
  }
  const lazyC = Object.assign(LazyScreenHost, { preload, loaded: () => !!loadedC });
  lazies.push(lazyC as unknown as LazyScreen<never>);
  return lazyC;
}

/** run `fn` once the screen's chunk is in (now, for eager screens); a failed load still runs it (the host retries) */
function whenLoaded(c: ComponentType<ScreenProps> | undefined, fn: () => void) {
  if (!isLazy(c) || c.loaded()) return fn();
  c.preload().then(fn, fn);
}

// tab roots replaced by NavStack's override (the dev gallery, onboarding) are never rendered: don't wait for them
let overriddenTabs = new Set<TabId>();
export function setOverriddenTabs(tabs: TabId[]) {
  overriddenTabs = new Set(tabs);
}

/** every lazyScreen() whose chunk is not in yet: registered tab roots first, then screens, then the rest */
export function unloadedScreens(): LazyScreen<never>[] {
  const registered = [...roots.values(), ...screens.values()].filter(isLazy) as unknown as LazyScreen<never>[];
  return [...new Set([...registered, ...lazies])].filter((c) => !c.loaded());
}
