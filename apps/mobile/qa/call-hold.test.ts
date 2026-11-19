import { describe, expect, test } from "bun:test";
import { turnIncomplete } from "@pickle/protocol";
import { CALL_HOLD_MAX_MS, CALL_HOLD_MS, holdMsFrom, lineHold } from "../src/screens/chat/call/lineHold";

/** a hold on a fake clock: `tick(ms)` runs what is due */
function rig(holdMs = 1500) {
  let now = 0;
  const timers = new Map<number, { at: number; f: () => void }>();
  let id = 0;
  const sent: string[] = [];
  const log: string[] = [];
  const h = lineHold({
    holdMs,
    send: (t) => {
      sent.push(t);
      log.push(`send:${t}`);
    },
    onChange: (held) => log.push(`held:${held}`),
    setTimer: (f, ms) => {
      timers.set(++id, { at: now + ms, f });
      return id;
    },
    clearTimer: (t) => timers.delete(t as number),
    now: () => now,
  });
  const tick = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].f();
    }
    now = end;
  };
  return { h, sent, log, tick, at: () => now };
}

describe("the call's unfinished-line hold", () => {
  test("a finished line is sent at once", () => {
    const { h, sent } = rig();
    h.final("내일 서울 날씨 알려 줘");
    expect(sent).toEqual(["내일 서울 날씨 알려 줘"]);
    expect(h.held()).toBe("");
  });
  test("an unfinished line waits 1.5 s, then goes as it is", () => {
    const { h, sent, tick } = rig();
    h.final("내일 회의 자료를");
    expect(sent).toEqual([]);
    expect(h.held()).toBe("내일 회의 자료를");
    tick(1499);
    expect(sent).toEqual([]);
    tick(1);
    expect(sent).toEqual(["내일 회의 자료를"]);
    expect(h.held()).toBe("");
  });
  test("the rest joins it, and a finished whole goes at once", () => {
    const { h, sent, tick } = rig();
    h.final("내일 회의 자료를");
    tick(900);
    h.final("정리해 줘");
    expect(sent).toEqual(["내일 회의 자료를 정리해 줘"]);
    tick(5000);
    expect(sent).toHaveLength(1);
  });
  test("still unfinished after the rest: held again, the wait starts over", () => {
    const { h, sent, tick } = rig();
    h.final("서울 날씨 확인하고");
    tick(1000);
    h.final("그리고");
    expect(h.held()).toBe("서울 날씨 확인하고 그리고");
    tick(1499);
    expect(sent).toEqual([]);
    tick(1);
    expect(sent).toEqual(["서울 날씨 확인하고 그리고"]);
  });
  test("speech meanwhile (an interim result) starts the wait over", () => {
    const { h, sent, tick } = rig();
    h.final("모시야 그 문서를");
    tick(1200);
    h.interim();
    tick(1200);
    expect(sent).toEqual([]);
    h.interim();
    tick(1499);
    expect(sent).toEqual([]);
    tick(1);
    expect(sent).toEqual(["모시야 그 문서를"]);
    // an interim with nothing held changes nothing
    h.interim();
    tick(5000);
    expect(sent).toHaveLength(1);
  });
  test("typing or a mute sends what waits now, the typed text joined to it", () => {
    const { h, sent, tick } = rig();
    h.final("내일 회의 자료를");
    h.flush("요약해 줘");
    expect(sent).toEqual(["내일 회의 자료를 요약해 줘"]);
    tick(5000);
    expect(sent).toHaveLength(1);
    h.final("그 문서를");
    h.flush();
    expect(sent).toEqual(["내일 회의 자료를 요약해 줘", "그 문서를"]);
    h.flush();
    expect(sent).toHaveLength(2);
    h.flush("안녕");
    expect(sent.at(-1)).toBe("안녕");
  });
  test("ending the call drops it", () => {
    const { h, sent, tick } = rig();
    h.final("그러니까");
    h.drop();
    tick(5000);
    expect(sent).toEqual([]);
    expect(h.held()).toBe("");
  });
  test("a held line is sent BEFORE the change is announced (a steer it starts already counts)", () => {
    const { h, log, tick } = rig();
    h.final("내일 회의 자료를");
    tick(1500);
    expect(log).toEqual(["held:내일 회의 자료를", "send:내일 회의 자료를", "held:"]);
  });
  test("speech meanwhile can't hold a line for ever: it goes 10 s after it was first held", () => {
    const { h, sent, tick, at } = rig();
    expect(CALL_HOLD_MAX_MS).toBe(10_000);
    h.final("그럼 내일은"); // a question whose "?" the recogniser dropped
    let when = -1;
    for (let i = 0; i < 15 && when < 0; i++) {
      tick(1000);
      if (sent.length) when = at();
      h.interim(); // noise, or someone else talking, keeps re-arming the wait
    }
    expect(sent).toEqual(["그럼 내일은"]);
    expect(when).toBe(10_000);
  });
  test("the cap counts from the first hold, however many unfinished pieces join it", () => {
    const { h, sent, tick } = rig();
    h.final("서울 날씨 확인하고");
    for (const piece of ["그리고", "부산도", "그 문서를", "음", "그러니까", "혹시", "근데"]) {
      tick(1400);
      h.final(piece);
    }
    // the last piece joined at 9.8 s: 0.2 s left of the cap, not another 1.5 s
    expect(sent).toEqual([]);
    tick(199);
    expect(sent).toEqual([]);
    tick(1);
    expect(sent).toEqual(["서울 날씨 확인하고 그리고 부산도 그 문서를 음 그러니까 혹시 근데"]);
    // the next line is held afresh: its own 1.5 s, its own cap
    h.final("그 문서를");
    tick(1499);
    expect(sent).toHaveLength(1);
    tick(1);
    expect(sent.at(-1)).toBe("그 문서를");
  });
  test("holdMs 0: nothing is ever held", () => {
    const { h, sent } = rig(0);
    h.final("내일 회의 자료를");
    expect(sent).toEqual(["내일 회의 자료를"]);
  });
  test("the rule is the meeting's own (one source: @pickle/protocol turnIncomplete)", () => {
    for (const line of ["모시야 그 문서 좀", "서울 날씨 확인하고", "좋긴 한데", "그래서", "지난주에 정한 거랑", "그게…"]) {
      expect(turnIncomplete(line)).toBe(true);
      const { h, sent } = rig();
      h.final(line);
      expect(sent).toEqual([]);
    }
    for (const line of ["그럼 내일은?", "오늘 회의 내용 정리해 줘.", "고마워", "이번 광고"]) {
      const { h, sent } = rig();
      h.final(line);
      expect(sent).toEqual([line]);
    }
  });
  test("VITE_CALL_HOLD_MS: a number of ms (0 = off); anything else keeps 1.5 s", () => {
    expect(CALL_HOLD_MS).toBe(1500);
    expect(holdMsFrom(undefined)).toBe(1500);
    expect(holdMsFrom("")).toBe(1500);
    expect(holdMsFrom("1200")).toBe(1200);
    expect(holdMsFrom("0")).toBe(0);
    expect(holdMsFrom("abc")).toBe(1500);
    expect(holdMsFrom("-5")).toBe(1500);
    expect(holdMsFrom("99999")).toBe(1500);
  });
});
