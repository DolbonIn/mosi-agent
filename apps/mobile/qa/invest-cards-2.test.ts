/**
 * The chat's other 투자 cards (DD 1935 §2-3·2-4·2-6, 0059 §2·§3, 0109 §1): rule change, the 08:00 report, D-1 and the
 * deck, from qa/invest-fixtures.ts (the server's cards and builders at 4ba7be7; the deck hand-made), drawn by CardView.
 * The level chart card waits for the shared ui/InvestChart (lead 0931).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card, InvestDeckCard } from "@pickle/protocol";
import { DISCLAIMER } from "@pickle/quant";
import { clearToken, setToken } from "../src/api/client";
import { messagesStore } from "../src/api/store";
import { registerScreen } from "../src/app/nav";
import { CardView } from "../src/screens/chat/cards/CardView";
import { DAILIES, DECKS, EVENTS, RULE_CHANGES } from "./invest-fixtures";

const html = (el: ReactElement) => renderToStaticMarkup(el);
let sent: string[] = [];
const view = (card: Card, interactive = true) =>
  html(createElement(CardView, { card, messageId: "m1", threadId: "t1", tools: [], onSend: (t: string) => sent.push(t), interactive }));
const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/\u00a0/g, " ") // copy()'s ties hold their spaces as no-break spaces
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
const count = (s: string, part: string) => s.split(part).length - 1;
/** paragraphs (not <path>) */
const paras = (s: string) => (s.match(/<p[ >]/g) ?? []).length;
/** the outer HTML of the first element with this class (nested same-tag elements counted) */
function element(out: string, cls: string): string {
  const at = out.search(new RegExp(`<([a-z0-9]+)[^>]*class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"`));
  if (at < 0) return "";
  const tag = /^<([a-z0-9]+)/.exec(out.slice(at))![1]!;
  let depth = 0;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = at;
  for (let m = re.exec(out); m; m = re.exec(out)) {
    if (m[0].endsWith("/>")) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return out.slice(at, m.index + m[0].length);
  }
  return out.slice(at);
}

afterEach(() => {
  sent = [];
  messagesStore.set({});
});

describe("invest_rule_change (DD 1935 §2-3; the server's card, B2b-1)", () => {
  test("a question, only what changes as 지금 → 바꿀 값, the reason and its basis, the result, then 바꾸기 (tap) and 그대로 두기", () => {
    const card = RULE_CHANGES["rc-mock"]!;
    const out = view(card);
    expect(out).toContain('data-card="invest_rule_change"');
    expect(text(element(out, "ccard-title"))).toBe(card.title);
    const rows = element(out, "ivrows");
    expect(count(rows, 'class="ivrow"')).toBe(1);
    expect(text(rows)).toBe("손절$25.80 → $30.50");
    expect(text(element(out, "ivrc-reason"))).toBe(`${card.reason}${card.reasonFoot}`);
    expect(text(element(out, "ivrc-result"))).toBe(card.result);
    expect(out).not.toContain("ivrc-warning");
    const actions = element(out, "ivrc-actions");
    expect(text(actions)).toContain("바꾸기");
    expect(text(actions)).toContain("그대로 두기");
    expect(text(actions)).not.toContain("길게 눌러");
    // 바꾸기 first in the DOM: on the right side by side (row-reverse), on top when stacked
    expect(text(actions).indexOf("바꾸기")).toBeLessThan(text(actions).indexOf("그대로 두기"));
    expect(count(out, DISCLAIMER)).toBe(1);
  });

  test("a real sell rule: the danger line with its full mark, and 길게 눌러 바꾸기 (the hold button)", () => {
    const card = RULE_CHANGES["rc-real"]!;
    const out = view(card);
    const warn = element(out, "ivrc-warning");
    expect(warn).toMatch(/<svg class="sigmark[^"]*"[^>]*data-signal="risk"/);
    expect(text(warn)).toBe(card.warning!);
    expect(text(element(out, "ivrc-actions"))).toContain("길게 눌러 바꾸기");
  });

  test("several: one row each (없음 for a rule put or taken away), the result one line per rule (DD 0452 §4)", () => {
    for (const id of ["rc-many", "rc-mixed"]) {
      const card = RULE_CHANGES[id]!;
      const out = view(card);
      const rows = element(out, "ivrows");
      expect(count(rows, 'class="ivrow"')).toBe(card.changes.length);
      for (const c of card.changes) expect(text(rows)).toContain(`${c.label}${c.from} → ${c.to}`);
      const result = element(out, "ivrc-result");
      // the server's lines with their "\n" between them, each its own run (pre-line draws the break)
      expect(text(result)).toBe(card.result);
      expect(count(text(result), "\n")).toBe(card.result.split("\n").length - 1);
    }
  });

  test("a request with no reason in that turn (DD 0717): no reason line, the request foot alone (still the foot: DD 2225 N2)", () => {
    const card = RULE_CHANGES["rc-noreason"]!;
    const reason = element(view(card), "ivrc-reason");
    expect(paras(reason)).toBe(1);
    expect(text(reason)).toBe(card.reasonFoot);
    expect(reason).not.toContain("ivrc-reason-text");
    expect(reason).toContain('<p class="ivfoot">');
    // with a reason, the reason line has its own class (its look is not "the first child")
    expect(element(view(RULE_CHANGES["rc-mock"]!), "ivrc-reason")).toMatch(/^<div class="ivrc-reason"><p class="ivrc-reason-text">/);
  });

  test("a change is two flex items, the old value and → the new one: nothing comes between \"$\" and its number (DD 2225 N1)", () => {
    for (const card of Object.values(RULE_CHANGES)) {
      const out = view(card);
      for (const c of card.changes) {
        const at = out.indexOf(`<span class="ivrow-label">${c.label}</span>`);
        expect(at).toBeGreaterThan(-1);
        const value = element(out.slice(at), "ivrc-change");
        // the direct children: <span>old</span>, a space (not drawn in a flex box), <span>→ new</span>
        const inner = value.replace(/^<span class="tnum ivrc-change">/, "").replace(/<\/span>$/, "");
        const kids: string[] = [];
        let depth = 0;
        let start = 0;
        for (const m of inner.matchAll(/<(\/?)span\b[^>]*>/g)) {
          if (!m[1]) {
            if (depth === 0) start = m.index!;
            depth++;
          } else if (--depth === 0) kids.push(inner.slice(start, m.index! + m[0].length));
        }
        expect(kids.length).toBe(2);
        expect(inner).toBe(`${kids[0]} ${kids[1]}`);
        expect(text(kids[0]!)).toBe(c.from);
        expect(text(kids[1]!)).toBe(`→ ${c.to}`);
      }
    }
  });

  test("decided: the buttons give way to one line (바꿨어요 · time, 그대로 뒀어요, expired, stale)", () => {
    const want: Record<string, RegExp> = {
      "rc-applied": /^바꿨어요 · (\d{2}:\d{2}|\d+월 \d+일 \d{2}:\d{2})$/,
      "rc-kept": /^그대로 뒀어요$/,
      "rc-expired": /^시간이 지나서 그대로 뒀어요$/,
      "rc-stale": /^그사이 규칙이 바뀌어서 적용하지 않았어요$/,
    };
    for (const [id, re] of Object.entries(want)) {
      const out = view(RULE_CHANGES[id]!);
      expect(out).not.toContain("ivrc-actions");
      expect(text(element(out, "ivrc-done"))).toMatch(re);
    }
  });

  test("not interactive (a shared view): the buttons are there but cannot be pressed", () => {
    const out = view(RULE_CHANGES["rc-mock"]!, false);
    const actions = element(out, "ivrc-actions");
    expect(count(actions, "disabled")).toBeGreaterThanOrEqual(2);
  });
});

describe("invest_daily (DD 1935 §2-4, 0059 §2; the server's card, B2c-1)", () => {
  test("the first judgment: head and time, one caution line, the stage line in two groups, the pending line, no move line, three lines, the tally in the 11지표 row's place (said once) and 신호, foot and the closing sentence", () => {
    const card = DAILIES["daily-first"]!;
    const out = view(card);
    expect(out).toContain('data-card="invest_daily"');
    expect(text(element(out, "ivcard-head"))).toBe(`${card.title}${card.atText}`);
    const high = element(out, "ivdaily-high");
    expect(paras(high)).toBe(1);
    expect(high).toMatch(/data-tone="caution"><svg class="sigmark[^"]*"[^>]*data-signal="caution"/);
    const stage = element(out, "ivdaily-stage-line");
    expect(count(stage, 'class="ivdaily-stage-part"')).toBe(2);
    expect(text(stage).replace(/\s+/g, " ").trim()).toBe(card.stageLine);
    // the space between the groups is outside their boxes (inside, at an inline-block's end, it is not drawn)
    expect(stage).toMatch(/·(<\/span>)+ <span class="ivdaily-stage-part">/);
    expect(text(element(out, "ivdaily-pending"))).toBe(card.pending!);
    expect(out).not.toContain("ivdaily-sub");
    expect(paras(element(out, "ivcard-notes"))).toBe(3);
    const rows = element(out, "ivrows");
    expect(count(rows, 'class="ivrow"')).toBe(2);
    const tally = element(rows, "ivtally");
    expect(count(tally, 'class="ivtally-item"')).toBe(4);
    for (const sig of ["risk", "caution", "normal", "unknown"]) expect(tally).toMatch(new RegExp(`data-signal="${sig}"`));
    expect(text(tally).replace(/\s+/g, " ")).toBe("위험 2경계 0정상 4확인 불가 5");
    // the server's words for the same tally are not drawn again
    expect(text(out)).not.toContain(card.rows[0]!.value);
    expect(text(rows)).toContain(`11지표`);
    expect(text(rows)).toContain(`신호${card.rows[1]!.value}`);
    expect(out).not.toContain("ivdaily-actions");
    expect(out).not.toContain("ivdaily-events");
    expect(text(element(out, "ivfoot"))).toBe(card.foot);
    expect(count(out, DISCLAIMER)).toBe(1);
  });

  test("a move up: two lines and 외 n건, the move line with the caution mark (DD 0828 1a), 일정 under the rows (three, the head with its count: DD 0109), 덱 만드는 중 (disabled)", () => {
    const card = DAILIES["daily-move"]!;
    const out = view(card);
    const high = element(out, "ivdaily-high");
    expect(paras(high)).toBe(2);
    expect(text(high)).toContain(`${card.highlights[1]!.text} 외 1건`);
    // said once, at the end of the last line (lead 2235b M5)
    expect(count(high, "외 1건")).toBe(1);
    expect(high).toMatch(/<span class="ivdaily-more"> 외 1건<\/span><\/p><\/div>$/);
    const sub = element(out, "ivdaily-sub");
    // two boxes split at " · " (the " ·" on the first), the mark in the first before its first word, and in each box
    // "→" glued to the new value: a line never ends on "→" (DD 2225 N5)
    expect(sub).toMatch(/data-tone="caution"><span class="ivdaily-sub-part"><svg class="sigmark[^"]*"[^>]*data-signal="caution"/);
    expect(count(sub, 'class="ivdaily-sub-part"')).toBe(2);
    expect(sub).toContain('<span class="t-glue">→ 탈출 3단계 ·</span></span> <span class="ivdaily-sub-part">');
    expect(sub).toContain('<span class="t-glue">→ 1단계</span></span></p>');
    expect(text(sub)).toBe(card.stageSub!);
    const stage = element(out, "ivdaily-stage");
    expect(stage.indexOf("ivdaily-pending")).toBeLessThan(stage.indexOf("ivdaily-sub"));
    const ev = element(out, "ivdaily-events");
    expect(text(element(ev, "ivdaily-events-head"))).toBe(card.events!.head);
    // the head names no day (2b77223): 일정 and the count of every event, three drawn
    expect(card.events!.head).toBe("일정 4개");
    expect(count(ev, 'class="ivrow"')).toBe(3);
    for (const r of card.events!.rows) expect(text(ev)).toContain(`${r.title}${r.value}`);
    // the market's time in brackets is one box: a line breaks before "(", never inside it
    // …and past its line it breaks only at its spaces: each word its own span (WebKit broke "16:20" in one text node, DD 2225 N4)
    expect(ev).toContain('<span class="ivfoot-tie"><span class="ivwhen-word">(미</span> <span class="ivwhen-word">동부</span> <span class="ivwhen-word">16:20)</span></span>');
    expect(out.indexOf("ivdaily-events")).toBeGreaterThan(out.indexOf('class="ivrows"'));
    expect(out.indexOf("ivdaily-events")).toBeLessThan(out.indexOf("ivdaily-actions"));
    const actions = element(out, "ivdaily-actions");
    expect(text(actions)).toBe("덱 만드는 중");
    expect(actions).toContain("disabled");
  });

  test("escape stage 4: the danger line with the full mark, a recovery line plain (no mark), the move line with the full mark, the data-gap line with the half mark, 덱 보기", () => {
    const card = DAILIES["daily-danger"]!;
    const out = view(card);
    const high = element(out, "ivdaily-high");
    expect(high).toMatch(/data-tone="danger"><svg class="sigmark[^"]*"[^>]*data-signal="risk"/);
    expect(text(high)).toContain(card.highlights[1]!.text);
    expect(high).not.toMatch(/data-tone="plain"><svg/);
    expect(element(out, "ivdaily-sub")).toMatch(/data-tone="danger"><span class="ivdaily-sub-part"><svg class="sigmark[^"]*"[^>]*data-signal="risk"[^>]*>.*<\/svg>탈출 3 <span class="t-glue">→ 4단계<\/span><\/span><\/p>$/);
    const gap = element(out, "ivdaily-gap");
    expect(gap).toMatch(/<svg class="sigmark[^"]*"[^>]*data-signal="caution"/);
    expect(text(gap)).toBe(card.dataGap!);
    // the gap line before the model's lines (the protocol's order)
    expect(out.indexOf("ivdaily-gap")).toBeLessThan(out.indexOf("ivcard-notes"));
    expect(text(element(out, "ivdaily-actions"))).toBe("덱 보기");
  });

  test("after a US holiday with no summary (DD 0733 3): the holiday line under the head, the no-summary line with the half mark instead of three lines, the move line plain", () => {
    const card = DAILIES["daily-holiday"]!;
    const out = view(card);
    expect(text(element(out, "ivdaily-holiday"))).toBe(card.holidayNote!);
    expect(out.indexOf("ivdaily-holiday")).toBeGreaterThan(out.indexOf("ivcard-head"));
    expect(out.indexOf("ivdaily-holiday")).toBeLessThan(out.indexOf("ivdaily-stage"));
    expect(out).not.toContain("ivdaily-high");
    expect(out).not.toContain("ivcard-notes");
    const none = element(out, "ivdaily-nosummary");
    expect(none).toMatch(/<svg class="sigmark[^"]*"[^>]*data-signal="caution"/);
    expect(text(none)).toBe(card.summaryNote!);
    const sub = element(out, "ivdaily-sub");
    expect(text(sub)).toBe("어제와 같아요");
    expect(sub).not.toContain("sigmark");
  });

  test("the head opens 보고서 only once that screen is in the app", () => {
    const card = DAILIES["daily-first"]!;
    expect(view(card)).not.toContain("ivdaily-headbtn");
    registerScreen("investReport", () => null);
    expect(view(card)).toContain('<button type="button" class="ccard-head ivcard-head ivdaily-headbtn"');
    expect(view(card, false)).not.toContain("ivdaily-headbtn");
  });
});

describe("invest_event: the D-1 card (DD 0109 §1; the server's eventCard)", () => {
  test("one event: its heading as the title, when (KST, the market's time in brackets), 출처 · 등급, the closing sentence; no button", () => {
    const card = EVENTS["event-one"]!;
    const out = view(card);
    expect(out).toContain('data-card="invest_event"');
    expect(card.title).toBe("NVDA 3분기 실적 발표");
    expect(text(element(out, "ivevent-title"))).toBe(card.title);
    expect(card.rows[0]!.when).toBe("11월 28일 06:20(미 동부 16:20)");
    expect(text(element(out, "ivevent-when"))).toBe(card.rows[0]!.when);
    expect(element(out, "ivevent-when")).toContain('<span class="ivfoot-tie"><span class="ivwhen-word">(미</span> <span class="ivwhen-word">동부</span> <span class="ivwhen-word">16:20)</span></span>');
    expect(text(element(out, "ivfoot"))).toBe("NVIDIA IR · A");
    expect(count(out, DISCLAIMER)).toBe(1);
    expect(out).not.toContain("<button");
    // the one-event card, not a list of one: the heading once, as the title (lead 2235b M13)
    expect(out).toContain('class="ivevent-one"');
    expect(out).not.toContain("ivevent-row");
    expect(card.rows[0]!.title).toBe(card.title);
    expect(count(text(out), card.title)).toBe(1);
  });

  test("several on one day: one card 일정 N개, each event its heading, when and 출처 · 등급 (시각 미정 as the server says it)", () => {
    const card = EVENTS["event-many"]!;
    const out = view(card);
    expect(text(element(out, "ivevent-title"))).toBe("일정 3개");
    expect(count(out, 'class="ivevent-row"')).toBe(3);
    for (const r of card.rows) expect(text(out)).toContain(`${r.title}${r.when}${r.foot}`);
    expect(card.rows.map((r) => r.when)).toContain("미 동부 11월 27일 · 시각 미정");
    // the words after the last " · " are one box (a line breaks after "·", not inside 시각 미정)
    expect(out).toMatch(/·(<\/span>)? <span class="ivfoot-tie"><span class="ivwhen-word">시각<\/span> <span class="ivwhen-word">미정<\/span><\/span>/);
    expect(count(out, DISCLAIMER)).toBe(1);
  });
});

describe("invest_deck (DD 1935 §2-6, 0059 §3)", () => {
  test("ready: the first slide box with its hairline, the name, meta, summary lines, foot and the closing sentence; the whole head opens the PDF", () => {
    const card = DECKS["deck-ready"]!;
    const out = view(card);
    expect(out).toContain('data-state="ready"');
    const open = element(out, "ivdeck-open");
    expect(open.startsWith("<button")).toBe(true);
    expect(open).toContain('class="ivdeck-thumb"');
    expect(text(element(out, "ivdeck-name"))).toBe(card.name);
    expect(text(element(open, "ivfoot"))).toBe(card.meta!);
    expect(paras(element(out, "ivcard-notes"))).toBe(3);
    expect(count(out, DISCLAIMER)).toBe(1);
    expect(out).not.toContain("ProgressBar");
  });

  test("the first slide: the server's raw path gets the session token (no cookie session: agent-runtime 0221); any other url is drawn as it came", () => {
    setToken("qa-tok");
    try {
      const out = view(DECKS["deck-ready"]!);
      expect(out).toContain('<img src="/api/attachments/att_thumb_1127/raw?token=qa-tok"');
      const other = view({ ...DECKS["deck-ready"]!, thumbUrl: "https://cdn.example.net/s1.png" } as Card);
      expect(other).toContain('<img src="https://cdn.example.net/s1.png"');
    } finally {
      clearToken();
    }
  });

  test("the deck's file (agent-runtime 0221) opens it even without attachmentId", () => {
    const card = { ...DECKS["deck-ready"]!, attachmentId: undefined, file: { id: "att_deck_f", filename: "심층판.pdf", size: 812_000, createdAt: 1 } } as Card;
    expect(element(view(card), "ivdeck-open").startsWith("<button")).toBe(true);
    expect(element(view({ ...DECKS["deck-ready"]!, attachmentId: undefined } as Card), "ivdeck-open").startsWith("<div")).toBe(true);
  });

  test("making: 만드는 중 · n/m장 with its bar, a still empty box, nothing to open", () => {
    const card = DECKS["deck-making"]!;
    const out = view(card);
    expect(text(out)).toContain("만드는 중 · 12/28장");
    // said once (DD 2225 N3): the name in the title only, the progress line once, and it names the bar
    expect(count(text(out), card.name)).toBe(1);
    expect(count(text(out), "만드는 중")).toBe(1);
    expect(out).toMatch(/role="progressbar" aria-label="만드는 중 · 12\/28장"/);
    expect(element(out, "ivdeck-open").startsWith("<div")).toBe(true);
    expect(out).not.toContain("<img");
    expect(out).not.toContain("ivcard-notes");
    // the protocol lets any state carry the file and summary lines (no server builds deck cards yet): while it is made
    // the deck still opens nothing and says nothing more (DD 1935 §2-6; lead 2235b M10, M12)
    const early: InvestDeckCard = { ...card, attachmentId: "att_deck_early", file: { id: "att_deck_early", filename: "덱.pdf", size: 10, createdAt: 1 }, summary: ["아직 만드는 중인 요약"] } as InvestDeckCard;
    const outEarly = view(early);
    expect(element(outEarly, "ivdeck-open").startsWith("<div")).toBe(true);
    expect(outEarly).not.toContain("<button");
    expect(outEarly).not.toContain("ivcard-notes");
    expect(outEarly).not.toContain("아직 만드는 중인 요약");
  });

  test("failed: 덱을 만들지 못했어요, the reason, 다시 만들기 (sends a line); not interactive: no button", () => {
    const card = DECKS["deck-failed"]!;
    const out = view(card);
    expect(text(element(out, "ccard-title"))).toBe("덱을 만들지 못했어요");
    expect(text(out)).toContain(card.failReason!);
    expect(text(element(out, "ivdaily-actions"))).toBe("다시 만들기");
    expect(view(card, false)).not.toContain("다시 만들기");
  });

  test("덱 보기 on the report finds the deck card of the same message", () => {
    const deck = DECKS["deck-ready"]! as InvestDeckCard;
    messagesStore.set({ t1: { items: [{ id: "m1", cards: [DAILIES["daily-danger"]!, deck] }], draft: null, streaming: false, loading: false, loaded: true } as never });
    const out = view(DAILIES["daily-danger"]!);
    expect(element(out, "ivdaily-actions")).not.toContain("disabled");
  });
});
