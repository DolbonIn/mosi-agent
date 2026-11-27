// snap-nav-tabpush (lead 2153): a setTab + push in one tick (규칙 보기, a notification tap) onto a tab not visited yet.
//   1. NavStack: a stack that mounts already pushed shows only its top; every layer under it starts hidden, 24 px back
//      (screens-chat 2140), and the tab's entrance is the one motion (DD 2142)
//   2. nav: while setTab waits for a lazy root, push / current / popToRoot act on the tab it waits for (DD 2131 §2;
//      DD's probes P2 and P2b, moved here), and the switch also waits for what is pushed onto it meanwhile
import { afterEach, describe, expect, test } from "bun:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TabId } from "@pickle/protocol";
import { getScreen, getTabRoot, lazyScreen, nav, navStore, pendingTab, registerScreen, registerTabRoot, setComposeHandler, tabSwitchedAt, unregisterScreen, unregisterTabRoot, useRegistryVersion, type NavState, type ScreenProps } from "../src/app/nav";
import { layers, rootKey, startUnder } from "../src/app/navLayers";
import { NavStack } from "../src/app/NavStack";
import { openTarget } from "../src/app/push";

const Dummy: ComponentType<ScreenProps> = () => null;
const tick = () => new Promise((r) => setTimeout(r, 0));
/** a lazy screen whose chunk comes in when `release()` is called */
function held() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { screen: lazyScreen(() => gate.then(() => Dummy)), release };
}
const was = navStore.get();
const roots0 = { profile: getTabRoot("profile"), archive: getTabRoot("archive") };
const invest0 = getScreen("invest");
/** chat on screen; each tab's stack as given (screen names) */
function fresh(stacks: Partial<Record<TabId, string[]>> = {}) {
  const mk = (t: TabId) => (stacks[t] ?? []).map((screen, i) => ({ key: `${screen}#${t}${i}`, screen }));
  navStore.set({ ...was, tab: "chat", drawer: false, stacks: { chat: mk("chat"), explore: mk("explore"), archive: mk("archive"), profile: mk("profile") } } as NavState);
}
const names = (t: TabId) => navStore.get().stacks[t].map((r) => r.screen);

afterEach(() => {
  // nothing may be left waiting for the next test (or the next file in the run)
  if (pendingTab()) nav.setTab(navStore.get().tab);
  expect(pendingTab()).toBe(null);
  // the registry as this file found it: a registration that was not there is forgotten, not left as Dummy (DD 2359:
  // invest-cards.test, run after this file, starts from "invest is not registered")
  for (const tab of ["profile", "archive"] as const) {
    const r = roots0[tab];
    if (r) registerTabRoot(tab, r);
    else unregisterTabRoot(tab);
    expect([tab, getTabRoot(tab)]).toEqual([tab, r]);
  }
  if (invest0) registerScreen("invest", invest0);
  else unregisterScreen("invest");
  expect(getScreen("invest")).toBe(invest0);
  navStore.set(was);
});

describe("the registry a test leaves (DD 2359)", () => {
  test("unregisterScreen / unregisterTabRoot forget a registration and tell the registry's readers; an absent one is a no-op", () => {
    const seen: number[] = [];
    function Probe() {
      seen.push(useRegistryVersion());
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    const v0 = seen.at(-1)!;
    registerScreen("t.unreg", Dummy);
    registerTabRoot("archive", Dummy);
    expect(getScreen("t.unreg")).toBe(Dummy);
    unregisterScreen("t.unreg");
    unregisterTabRoot("archive");
    expect(getScreen("t.unreg")).toBeUndefined();
    expect(getTabRoot("archive")).toBeUndefined();
    renderToStaticMarkup(createElement(Probe));
    expect(seen.at(-1)).toBe(v0 + 4);
    // nothing to forget: the version stays
    unregisterScreen("t.unreg");
    unregisterTabRoot("archive");
    renderToStaticMarkup(createElement(Probe));
    expect(seen.at(-1)).toBe(v0 + 4);
  });
});

describe("a tab switch that waits for its root's chunk (DD 2131 §2)", () => {
  test("P2: 규칙 보기's shape before 나의 모시's chunk is in — the rules land on 나의 모시, nothing on 채팅", async () => {
    registerScreen("invest", Dummy);
    const root = held();
    registerTabRoot("profile", root.screen);
    fresh({ chat: ["invest"] }); // even with an `invest` on top of 채팅, 규칙 보기 reads 나의 모시's top
    nav.setTab("profile");
    expect(pendingTab()).toBe("profile");
    expect(navStore.get().tab).toBe("chat");
    expect(nav.current()).toBe(null); // 나의 모시's top (its root), not 채팅's
    if (nav.current()?.screen !== "invest") nav.push("invest", { symbol: "SOXL", ruleId: "r1" });
    expect(names("profile")).toEqual(["invest"]); // already there, before the tab is
    expect(names("chat")).toEqual(["invest"]);
    expect(navStore.get().tab).toBe("chat");
    root.release();
    await tick();
    const s = navStore.get();
    expect([s.tab, names("chat"), s.stacks.profile.map((r) => [r.screen, r.params])]).toEqual(["profile", ["invest"], [["invest", { symbol: "SOXL", ruleId: "r1" }]]]);
    expect(pendingTab()).toBe(null);
  });

  test("P2b: a notification tap (push.ts openTarget) before the chunk is in — 투자 on 나의 모시, 채팅's thread stays", async () => {
    registerScreen("invest", Dummy);
    const root = held();
    registerTabRoot("profile", root.screen);
    fresh({ chat: ["thread"] });
    openTarget({ invest: true });
    expect(names("profile")).toEqual(["invest"]);
    root.release();
    await tick();
    expect([navStore.get().tab, names("chat"), names("profile")]).toEqual(["profile", ["thread"], ["invest"]]);
    // a second tap with 투자 on top: nothing more is pushed
    openTarget({ invest: true });
    expect(names("profile")).toEqual(["invest"]);
  });

  test("the switch waits for the pushed screen's chunk too, in either order: the tab arrives with it on top", async () => {
    for (const rootFirst of [true, false]) {
      const root = held();
      const inv = held();
      registerTabRoot("profile", root.screen);
      registerScreen("invest", inv.screen);
      fresh();
      nav.setTab("profile");
      nav.push("invest");
      (rootFirst ? root : inv).release();
      await tick();
      expect([rootFirst, navStore.get().tab, names("profile")]).toEqual([rootFirst, "chat", rootFirst ? [] : ["invest"]]);
      expect(pendingTab()).toBe("profile");
      (rootFirst ? inv : root).release();
      await tick();
      expect([rootFirst, navStore.get().tab, names("profile"), pendingTab()]).toEqual([rootFirst, "profile", ["invest"], null]);
    }
  });

  test("popToRoot acts on the tab it waits for; pop and canGoBack stay on the tab on screen", async () => {
    const root = held();
    registerTabRoot("profile", root.screen);
    fresh({ chat: ["thread"], profile: ["invest", "invest.rule"] });
    nav.setTab("profile");
    expect(nav.current()?.screen).toBe("invest.rule");
    expect(nav.canGoBack()).toBe(true); // 채팅's thread
    nav.popToRoot();
    expect([names("chat"), names("profile")]).toEqual([["thread"], []]);
    nav.pop();
    expect([names("chat"), names("profile")]).toEqual([[], []]);
    root.release();
    await tick();
    expect(navStore.get().tab).toBe("profile");
    // with nothing on the awaited tab, back still reads 채팅's
    const r2 = held();
    registerTabRoot("archive", r2.screen);
    fresh({ chat: ["thread"] });
    nav.setTab("archive");
    expect([nav.canGoBack(), nav.current()]).toEqual([true, null]);
    r2.release();
    await tick();
  });

  test("back to the tab on screen drops the wait without popping it; another tab replaces the wait", async () => {
    const root = held();
    registerTabRoot("profile", root.screen);
    fresh({ chat: ["thread"] });
    nav.setTab("profile");
    nav.setTab("chat");
    expect([pendingTab(), names("chat")]).toEqual([null, ["thread"]]);
    nav.push("thread.info");
    expect([names("chat"), names("profile")]).toEqual([["thread", "thread.info"], []]);
    root.release();
    await tick();
    expect(navStore.get().tab).toBe("chat");

    const p2 = held();
    const a2 = held();
    registerTabRoot("profile", p2.screen);
    registerTabRoot("archive", a2.screen);
    const inv = held();
    registerScreen("invest", inv.screen);
    nav.setTab("profile");
    nav.push("invest");
    nav.setTab("profile"); // the same tab again (a second tap): still one wait, still for 투자 too
    p2.release();
    await tick();
    expect([navStore.get().tab, pendingTab()]).toEqual(["chat", "profile"]);
    inv.release();
    await tick();
    expect([navStore.get().tab, names("profile")]).toEqual(["profile", ["invest"]]);
    nav.setTab("chat");
    nav.setTab("archive");
    expect(pendingTab()).toBe("archive");
    const p3 = held();
    registerTabRoot("profile", p3.screen);
    nav.setTab("profile"); // archive's wait is replaced by profile's, which is replaced by archive again
    nav.setTab("archive");
    p3.release();
    await tick();
    expect(navStore.get().tab).toBe("chat");
    a2.release();
    await tick();
    expect([navStore.get().tab, pendingTab()]).toEqual(["archive", null]);
  });

  test("compose while 나의 모시 is awaited from 채팅: the wait is dropped and the thread opens on 채팅", () => {
    const root = held();
    registerTabRoot("profile", root.screen);
    fresh();
    nav.setTab("profile");
    let got: [string, string | undefined] | null = null;
    setComposeHandler((text, threadId) => (got = [text, threadId]));
    try {
      nav.compose("안녕", "t1");
    } finally {
      setComposeHandler(null);
    }
    expect([pendingTab(), navStore.get().tab, names("chat"), names("profile"), got]).toEqual([null, "chat", ["thread"], [], ["안녕", "t1"]]);
    root.release();
  });

  test("chunks already in: setTab + push switch at once, and the push lands on the new tab", () => {
    registerScreen("invest", Dummy);
    registerTabRoot("profile", Dummy);
    fresh({ chat: ["thread"] });
    openTarget({ invest: true });
    expect([navStore.get().tab, pendingTab(), names("chat"), names("profile")]).toEqual(["profile", null, ["thread"], ["invest"]]);
  });
});

describe("a stack that mounts already pushed shows only its top (screens-chat 2140, DD 2142)", () => {
  test("startUnder: the root and every layer under the top start hidden, 24 px back; the top and an empty stack are left", () => {
    for (const k of [rootKey("archive"), "a#1", "b#2", "c#3"]) layers.delete(k);
    startUnder("archive", []);
    expect(layers.has(rootKey("archive"))).toBe(false);
    startUnder("archive", [{ key: "a#1" }, { key: "b#2" }, { key: "c#3" }]);
    const at = (k: string) => [layers.get(k)?.x.get(), layers.get(k)?.o.get()];
    expect([at(rootKey("archive")), at("a#1"), at("b#2"), layers.has("c#3")]).toEqual([[-24, 0], [-24, 0], [-24, 0], false]);
    for (const k of [rootKey("archive"), "a#1", "b#2"]) layers.delete(k);
  });

  // the first paint as React gives it (no effects run): each layer's opacity and visibility, and the tab layer's
  const paint = () => {
    const html = renderToStaticMarkup(createElement(NavStack));
    const style = (cls: string) => [...html.matchAll(new RegExp(`<(?:section|div) class="${cls}"[^>]*style="([^"]*)"`, "g"))].map((m) => m[1]!);
    const o = (s: string) => Number(/opacity:\s*([\d.]+)/.exec(s)?.[1] ?? "1");
    const v = (s: string) => /visibility:\s*hidden/.test(s);
    return { layers: style("stack-layer").map((s) => [o(s), v(s) ? "hidden" : "visible"]), tab: style("tab-layer").map(o) };
  };
  const clear = (tab: TabId) => {
    for (const k of [...layers.keys()]) if (k === rootKey(tab) || k === `tab:${tab}` || k.startsWith("invest")) layers.delete(k);
  };

  test("a notification tap onto 나의 모시 not visited yet: the first paint shows 투자 only, and the tab enters", () => {
    registerScreen("invest", Dummy);
    registerTabRoot("profile", Dummy);
    clear("profile");
    fresh();
    nav.setTab("profile"); // chat was on screen; the switch is the tab's entrance…
    expect(tabSwitchedAt()).toBeGreaterThan(0);
    nav.push("invest", undefined, { title: "투자" }); // …even with the push in the same tick
    nav.push("invest", { symbol: "SOXL" });
    // this test's NavStack mounts on 나의 모시 (its first visit), the stack already [투자, 투자 SOXL]
    expect(paint()).toEqual({ layers: [[0, "hidden"], [0, "hidden"], [1, "visible"]], tab: [0.12] });
    clear("profile");
  });

  test("a tab mounting with an empty stack: its root shows", () => {
    registerTabRoot("archive", Dummy);
    clear("archive");
    fresh();
    navStore.set({ ...navStore.get(), tab: "archive" });
    const first = paint();
    expect(first.layers).toEqual([[1, "visible"]]);
    clear("archive");
  });
});
