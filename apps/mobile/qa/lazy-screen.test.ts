import { describe, expect, test } from "bun:test";
import type { ComponentType } from "react";
import { lazyScreen, nav, navStore, registerScreen, registerTabRoot, setOverriddenTabs, unloadedScreens, type ScreenProps } from "../src/app/nav";

function deferred() {
  let resolve!: (c: ComponentType<ScreenProps>) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<ComponentType<ScreenProps>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const Dummy: ComponentType<ScreenProps> = () => null;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("lazyScreen (route-level code splitting)", () => {
  test("push waits for the chunk, then lands on the tab it was pushed from", async () => {
    const d = deferred();
    let loads = 0;
    const S = lazyScreen(() => {
      loads++;
      return d.promise;
    });
    registerScreen("qa.lazy", S);
    expect(unloadedScreens()).toContain(S);
    const before = navStore.get().stacks.chat.length;
    const key = nav.push("qa.lazy", { a: 1 });
    expect(key).toMatch(/^qa\.lazy#/);
    await tick();
    expect(navStore.get().stacks.chat.length).toBe(before); // not yet: the page would slide in empty
    d.resolve(Dummy);
    await tick();
    const stack = navStore.get().stacks.chat;
    expect(stack.length).toBe(before + 1);
    expect(stack[stack.length - 1]!.key).toBe(key);
    expect(S.loaded()).toBe(true);
    expect(unloadedScreens()).not.toContain(S);
    nav.push("qa.lazy"); // loaded: synchronous
    expect(navStore.get().stacks.chat.length).toBe(before + 2);
    expect(loads).toBe(1);
    nav.popToRoot();
  });

  test("a failed load still navigates (the host retries) and the next preload tries again", async () => {
    let attempt = 0;
    const S = lazyScreen(() => (++attempt === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(Dummy)));
    registerScreen("qa.flaky", S);
    nav.push("qa.flaky");
    await tick();
    await tick();
    expect(nav.current()?.screen).toBe("qa.flaky");
    expect(S.loaded()).toBe(false);
    await S.preload();
    expect(S.loaded()).toBe(true);
    expect(attempt).toBe(2);
    nav.popToRoot();
  });

  test("setTab waits for a lazy tab root, but not when the root is overridden", async () => {
    const d = deferred();
    registerTabRoot("archive", lazyScreen(() => d.promise));
    nav.setTab("archive");
    await tick();
    expect(navStore.get().tab).toBe("chat");
    d.resolve(Dummy);
    await tick();
    expect(navStore.get().tab).toBe("archive");

    nav.setTab("chat");
    const never = new Promise<ComponentType<ScreenProps>>(() => {});
    registerTabRoot("profile", lazyScreen(() => never));
    setOverriddenTabs(["profile"]);
    nav.setTab("profile");
    expect(navStore.get().tab).toBe("profile");
    setOverriddenTabs([]);
    nav.setTab("chat");
  });
});
