// useStore keeps a selection for the state and the selector it came from (lib/createStore.ts). A component that
// updates its own state while rendering renders again at once with its hooks kept (react-dom/server too), so one
// server render shows what a second render of the same instance reads.
import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore, useStore } from "../src/lib/createStore";

/** renders `read` twice in one instance, the second time with `step` 1; what each render read */
function twice<S>(read: (step: number) => S): S[] {
  const seen: S[] = [];
  function Probe() {
    const [step, setStep] = useState(0);
    seen.push(read(step));
    if (step === 0) setStep(1);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return seen;
}

describe("useStore", () => {
  test("a selector that closes over props reads the store again when they change, the state the same", () => {
    const store = createStore<Record<string, string>>({ a: "가", b: "나" });
    expect(twice((step) => useStore(store, (s) => s[step ? "b" : "a"], Object.is))).toEqual(["가", "나"]);
    // the default isEqual (shallowEqual) too
    const rows = createStore({ items: [{ id: "a", n: 1 }, { id: "b", n: 2 }] });
    expect(twice((step) => useStore(rows, (s) => s.items.find((r) => r.id === (step ? "b" : "a")))?.n)).toEqual([1, 2]);
  });
  test("the same selector reads the store again when the state changes", () => {
    const store = createStore({ n: 1 });
    const sel = (s: { n: number }) => s.n;
    expect(
      twice((step) => {
        const n = useStore(store, sel);
        if (step === 0) store.set({ n: 2 });
        return n;
      }),
    ).toEqual([1, 2]);
  });
  test("the same selector on the same state is not called again", () => {
    const store = createStore({ n: 1 });
    let calls = 0;
    const sel = (s: { n: number }) => (calls++, s.n);
    expect(twice(() => useStore(store, sel))).toEqual([1, 1]);
    expect(calls).toBe(1);
  });
  test("a new selection equal to the last keeps the last one (a new selector each render)", () => {
    const store = createStore({ a: 1, b: 2 });
    const seen = twice(() => useStore(store, (s) => ({ a: s.a, b: s.b })));
    expect(seen[1]).toEqual({ a: 1, b: 2 });
    expect(seen[1]).toBe(seen[0]);
  });
});
