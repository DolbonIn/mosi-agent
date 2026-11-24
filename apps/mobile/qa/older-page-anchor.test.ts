// An older page goes in above the rows on screen (ThreadView load-older, olderPage.ts): the row at the top of the view
// is read before the page is drawn and put back at its y after, whatever the browser's own scroll anchoring did. Fake
// rows stand in for the thread's children (a class list, a box, whether they are still in the document).
//   bun test ./qa/older-page-anchor.test.ts
import { describe, expect, test } from "bun:test";
import { keptScrollTop, olderAnchor } from "../src/screens/chat/olderPage";

type Fake = { cls: string; top: number; height: number; connected?: boolean };
const el = (f: Fake) =>
  ({
    classList: { contains: (c: string) => f.cls.split(" ").includes(c) },
    getBoundingClientRect: () => ({ top: f.top, bottom: f.top + f.height, height: f.height }),
    get isConnected() {
      return f.connected ?? true;
    },
  }) as unknown as Element;
const scroller = (top: number) => ({ getBoundingClientRect: () => ({ top }) }) as unknown as Element;
const content = (rows: Element[]) => ({ children: rows }) as unknown as Element;

describe("olderAnchor: the row an older page keeps in place", () => {
  test("the first row any of which shows below the scroller's top; rows wholly above it are passed over", () => {
    const above = el({ cls: "msg-row", top: 40, height: 60 }); // bottom 100 = the scroller's top: not in view
    const cut = el({ cls: "msg-row", top: 80, height: 120 }); // runs from above the top into the view
    const next = el({ cls: "msg-row", top: 200, height: 50 });
    const a = olderAnchor(scroller(100), content([above, cut, next]));
    expect(a?.row).toBe(cut);
    expect(a?.top).toBe(80);
  });

  test("leaves out the loading ring and the date line over the first row: both go away with the page", () => {
    const ring = el({ cls: "thread-older", top: 90, height: 48 });
    const sep = el({ cls: "msg-sep", top: 138, height: 30 });
    const first = el({ cls: "msg-row", top: 168, height: 70 });
    expect(olderAnchor(scroller(100), content([ring, sep, first]))?.row).toBe(first);
  });

  test("a row that takes no room (nothing drawn) is passed over; no row in view gives null", () => {
    const empty = el({ cls: "msg-row", top: 150, height: 0 });
    const row = el({ cls: "msg-row", top: 150, height: 40 });
    expect(olderAnchor(scroller(100), content([empty, row]))?.row).toBe(row);
    expect(olderAnchor(scroller(100), content([el({ cls: "msg-row", top: 0, height: 50 })]))).toBeNull();
    expect(olderAnchor(scroller(100), content([]))).toBeNull();
  });
});

describe("keptScrollTop: where the view goes so the row is back at its y", () => {
  test("moves the view by how far the row moved: the page's height when nothing else moved it, nothing when the browser already did", () => {
    const f: Fake = { cls: "msg-row", top: 171, height: 80 };
    const a = { row: el(f), top: 171 };
    f.top = 171 + 2072; // the page went in above; the browser left the view where it was
    expect(keptScrollTop(348, a)).toBe(348 + 2072);
    f.top = 171; // the browser anchored: the view already moved with the row
    expect(keptScrollTop(2420, a)).toBe(2420);
  });

  test("rounds to whole pixels (engines drop a fraction of scrollTop), so the row lands within half a pixel", () => {
    const f: Fake = { cls: "msg-row", top: 71.17, height: 80 };
    const a = { row: el(f), top: 71.17 };
    f.top = 71.17 + 2071.69;
    expect(keptScrollTop(348, a)).toBe(2420); // 2419.69 → 2420, not floored to 2419
    f.top = 71.17 + 2071.4;
    expect(keptScrollTop(348, a)).toBe(2419);
  });

  test("null when the row is no longer in the document (ThreadView then falls back to the page's height)", () => {
    const f: Fake = { cls: "msg-row", top: 100, height: 40 };
    const a = { row: el(f), top: 100 };
    f.connected = false;
    expect(keptScrollTop(500, a)).toBeNull();
  });
});
