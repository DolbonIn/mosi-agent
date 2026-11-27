import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ServerEvent } from "@pickle/protocol";

/**
 * A notification of a line in a thread on screen raises no banner (events.ts, DD 1957 §3, DD 0825): the line is right
 * there, and the banner covered the thread's head saying it again. A line's notification carries the line's
 * `messageId`; one that is not a line (the after-turn "기억했어요", a skipped schedule) carries none and still comes.
 * Banners wait in a queue one at a time: a line's banner is asked again when its turn comes, and goes unseen if its
 * thread is on screen by then (island.ts `skip`, DD 2210); the one already up stays. A thread's line banner still waiting
 * gives its place to the thread's newer line (island.ts `group`, DD 2210 덧붙임): quick lines give one banner, the last.
 * Screens say what is on screen through catchUp.ts showThread (ThreadView `active`, useShownThread). Drives the real
 * events.ts dispatch through a fake EventSource; fetch answers nothing. bun runs every test file in one process: the
 * file starts and ends with resetSession.
 *   bun test ./qa/open-thread-banner.test.ts
 */

class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close() {
    this.readyState = 2;
  }
}

const realFetch = globalThis.fetch;
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;
const push = (e: ServerEvent) => FakeEventSource.last!.onmessage!({ data: JSON.stringify(e) } as MessageEvent<string>);
const neverFetch = ((_: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;

type Store = typeof import("../src/api/store");
type Island = typeof import("../src/app/island");
type CatchUp = typeof import("../src/screens/chat/catchUp");
let store: Store;
let isl: Island;
let catchUp: CatchUp;
const bannerTitle = () => isl.islandStore.get().banner?.title ?? null;
const bannerBody = () => isl.islandStore.get().banner?.body ?? null;
/** the shown banner goes; the next one drops 520 ms later (island.ts lets the contraction play) */
const nextBanner = async () => {
  isl.island.dismissBanner();
  await new Promise((r) => setTimeout(r, 600));
};

beforeAll(async () => {
  store = await import("../src/api/store");
  isl = await import("../src/app/island");
  catchUp = await import("../src/screens/chat/catchUp");
  store.resetSession();
  isl.island.clearBanners();
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  globalThis.fetch = neverFetch;
});
afterAll(() => {
  store.resetSession();
  isl.island.clearBanners();
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});
beforeEach(async () => {
  store.resetSession();
  isl.island.clearBanners();
  const { setToken } = await import("../src/api/client");
  setToken("qa-token");
  const { connectEvents } = await import("../src/api/events");
  connectEvents();
  expect(FakeEventSource.last?.url).toContain("/api/events?token=");
});

let n = 0;
/** a friend's line, as threads.ts sends its notification (with the stored line's id) */
const line = (threadId: string, body: string): ServerEvent => ({ type: "notification", title: "서연 님", body, threadId, icon: "people", messageId: `m_line${++n}` });

describe("a line's notification and the thread on screen", () => {
  test("the thread on screen: no banner; the listeners still hear the event", async () => {
    const { onServerEvent } = await import("../src/api/events");
    const heard: string[] = [];
    const off = onServerEvent((e) => e.type === "notification" && heard.push(e.body));
    const hide = catchUp.showThread("t_friend");
    push(line("t_friend", "그래, 7시에 봐"));
    expect(bannerTitle()).toBeNull();
    expect(heard).toEqual(["그래, 7시에 봐"]);
    hide();
    off();
  });

  test("another thread on screen, or none: the banner as before", () => {
    const hide = catchUp.showThread("t_main");
    push(line("t_friend", "그래, 7시에 봐"));
    expect(bannerTitle()).toBe("서연 님");
    hide();
    isl.island.clearBanners();
    push(line("t_friend", "내일 봐"));
    expect(bannerTitle()).toBe("서연 님");
  });

  test("once the screen leaves (showThread's cleanup), the thread's lines raise banners again", () => {
    const hide = catchUp.showThread("t_friend");
    push(line("t_friend", "한 줄"));
    expect(bannerTitle()).toBeNull();
    hide();
    push(line("t_friend", "두 줄"));
    expect(bannerTitle()).toBe("서연 님");
  });

  test("the thread on screen: \"기억했어요\" after a turn (no line, no messageId) still raises its banner", () => {
    const hide = catchUp.showThread("t_main");
    push({ type: "notification", title: "기억했어요", body: "저녁 약속은 7시", threadId: "t_main", icon: "sparkles" });
    expect(bannerTitle()).toBe("기억했어요");
    hide();
  });

  test("a notification with no thread always raises its banner", () => {
    const hide = catchUp.showThread("t_friend");
    push({ type: "notification", title: "예약된 일을 건너뛰었어요", body: "오늘 사용량 한도가 다 차서 …", icon: "clock" });
    expect(bannerTitle()).toBe("예약된 일을 건너뛰었어요");
    hide();
  });
});

describe("banners waiting in the queue (DD 2210)", () => {
  test("a line's banner queued while its thread was elsewhere goes unseen if the thread is on screen when its turn comes; the 기억했어요 and another thread's line queued with it still come, in order", async () => {
    push(line("t_other", "먼저 온 줄")); // up now: the rest queue behind it
    push(line("t_friend", "빠른 줄 1"));
    push(line("t_friend", "빠른 줄 2"));
    push({ type: "notification", title: "기억했어요", body: "하늘 님과 7시 약속", threadId: "t_friend", icon: "sparkles" });
    push(line("t_friend", "빠른 줄 3"));
    push(line("t_other", "다른 스레드의 줄"));
    expect(bannerBody()).toBe("먼저 온 줄");
    const hide = catchUp.showThread("t_friend"); // the person opens the friend thread
    try {
      await nextBanner();
      expect(bannerTitle()).toBe("기억했어요"); // 빠른 줄 1 and 2 skipped, one after the other
      await nextBanner();
      expect(bannerBody()).toBe("다른 스레드의 줄"); // 빠른 줄 3 skipped
      await nextBanner();
      expect(bannerTitle()).toBeNull(); // nothing else waited
    } finally {
      hide(); // a failure here must not leave the thread on screen for the tests after it
    }
  });

  test("the banner already up stays when its thread comes on screen (it leaves on its own time)", () => {
    push(line("t_friend", "도착했어"));
    expect(bannerBody()).toBe("도착했어");
    const hide = catchUp.showThread("t_friend");
    try {
      expect(bannerBody()).toBe("도착했어");
    } finally {
      hide();
    }
  });

  test("the thread on screen for a while and gone again before the turn comes: its queued line comes after all", async () => {
    push(line("t_other", "먼저 온 줄"));
    push(line("t_friend", "나중 줄")); // queued: the friend thread is not on screen
    const hide = catchUp.showThread("t_friend");
    hide();
    await nextBanner();
    expect(bannerBody()).toBe("나중 줄");
  });
});

describe("a thread's lines waiting in the queue: only the last (DD 2210 덧붙임)", () => {
  test("five quick lines: the first is up at once, the four behind it give one banner, the fifth; then nothing", async () => {
    for (let i = 1; i <= 5; i++) push(line("t_friend", `빠른 줄 ${i}`));
    expect(bannerBody()).toBe("빠른 줄 1"); // the one already up stays
    await nextBanner();
    expect(bannerBody()).toBe("빠른 줄 5");
    await nextBanner();
    expect(bannerTitle()).toBeNull();
  });

  test("the newer line takes the waiting one's place in the queue (ahead of what came between)", async () => {
    push(line("t_other", "먼저 온 줄"));
    push(line("t_friend", "줄 1"));
    push({ type: "notification", title: "기억했어요", body: "하늘 님과 7시 약속", threadId: "t_friend", icon: "sparkles" });
    push(line("t_friend", "줄 2"));
    await nextBanner();
    expect(bannerBody()).toBe("줄 2");
    await nextBanner();
    expect(bannerTitle()).toBe("기억했어요");
    await nextBanner();
    expect(bannerTitle()).toBeNull();
  });

  test("lines of different threads stay apart; each thread keeps its own last", async () => {
    push(line("t_other", "먼저 온 줄"));
    push(line("t_a", "a 1"));
    push(line("t_b", "b 1"));
    push(line("t_a", "a 2"));
    push(line("t_b", "b 2"));
    await nextBanner();
    expect(bannerBody()).toBe("a 2");
    await nextBanner();
    expect(bannerBody()).toBe("b 2");
    await nextBanner();
    expect(bannerTitle()).toBeNull();
  });

  test("what is not a line (no messageId) never gives way: two 기억했어요 of one thread both come", async () => {
    push(line("t_other", "먼저 온 줄"));
    push({ type: "notification", title: "기억했어요", body: "첫 약속", threadId: "t_friend", icon: "sparkles" });
    push({ type: "notification", title: "기억했어요", body: "둘째 약속", threadId: "t_friend", icon: "sparkles" });
    await nextBanner();
    expect(bannerBody()).toBe("첫 약속");
    await nextBanner();
    expect(bannerBody()).toBe("둘째 약속");
  });

  test("the line in the waiting place is still asked when its turn comes: its thread on screen by then, nothing drops", async () => {
    push(line("t_other", "먼저 온 줄"));
    push(line("t_friend", "줄 1"));
    push(line("t_friend", "줄 2"));
    const hide = catchUp.showThread("t_friend");
    try {
      await nextBanner();
      expect(bannerTitle()).toBeNull();
    } finally {
      hide();
    }
  });

  test("a newer line comes after the thread's banner that is up; it does not change the one up", async () => {
    push(line("t_friend", "도착했어"));
    push(line("t_friend", "지금 가는 중"));
    expect(bannerBody()).toBe("도착했어");
    await nextBanner();
    expect(bannerBody()).toBe("지금 가는 중");
  });
});
