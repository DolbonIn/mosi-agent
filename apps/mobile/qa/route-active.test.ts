import { describe, expect, test } from "bun:test";
import { createActiveSource } from "../src/app/routeActive";

describe("route activity source (shared-chrome claims)", () => {
  test("a layer is active only while it is top AND its tab is active; changes notify once", () => {
    const tab = createActiveSource(true);
    const layer = createActiveSource(true, tab);
    const seen: boolean[] = [];
    const off = layer.subscribe(() => seen.push(layer.get()));
    tab.set(false); // switch away
    tab.set(false); // no-op
    tab.set(true); // back
    layer.set(false); // a screen pushed over it
    tab.set(false);
    tab.set(true); // still covered: no change
    layer.set(true); // popped back
    expect(seen).toEqual([false, true, false, true]);
    off();
  });

  test("subscribing after the parent changed while nobody listened still sees later changes", () => {
    const tab = createActiveSource(true);
    const layer = createActiveSource(true, tab);
    tab.set(false);
    const seen: boolean[] = [];
    const off = layer.subscribe(() => seen.push(layer.get()));
    expect(layer.get()).toBe(false);
    tab.set(true);
    expect(seen).toEqual([true]);
    off();
  });
});
