/**
 * The checks the slide JSON must pass before a page is drawn (DD 1935 §5-2 limits, §5-3 rows that JSON can decide, B-2).
 * A broken rule goes back to the model once with these words (§5-2: one rewrite at most); the DOM checks (font sizes,
 * overlaps, clipping) come after rendering. Every text of the model's is counted as read, with its figures filled.
 */
import { textW, type LevelKind } from "@pickle/quant";
import { chars, fill, isSentence, lintModelText, REF_RE } from "./text";
import { DECK_KINDS, GRADES, type DeckData, type DeckFail, type DeckSpec, type Slide } from "./types";

export const DECK_MIN = 24;
export const DECK_MAX = 30;
export const TABLE_ROWS = 6;
/** FA7 allows 14 rows; at 17 px with 7.5 px padding a row is 35 px, and the body (416) holds a header and ten */
export const APPENDIX_ROWS = 10;
export const TIMELINE_EVENTS = 8;
/** B-2: the level chart shows every one of these */
export const LEVELS_NEEDED: readonly LevelKind[] = ["support", "resistance", "buyZone", "target1", "stop"];

/** a text of the model's on a slide, with its limit */
interface ModelText {
  field: string;
  text: string;
  max: number;
}

/** every text the model wrote on a slide, with its limit (DD 1935 §5-2) */
export function modelTexts(s: Slide): ModelText[] {
  const out: ModelText[] = [
    { field: "kicker", text: s.kicker, max: 16 },
    { field: "headline", text: s.headline, max: 30 },
  ];
  const add = (field: string, text: unknown, max: number) => {
    if (typeof text === "string") out.push({ field, text, max });
  };
  switch (s.kind) {
    case "hero":
      add("lead", s.lead, 80);
      break;
    case "numbers3":
      (s.items ?? []).forEach((it, i) => {
        add(`items[${i}].label`, it.label, 10);
        add(`items[${i}].note`, it.note, 30);
      });
      break;
    case "signal-board":
    case "gauges":
    case "level-chart":
      add("note", s.note, 40);
      break;
    case "issue+capture":
      (s.captures ?? []).forEach((c, i) => add(`captures[${i}].caption`, c.caption, 40));
      (s.points ?? []).forEach((p, i) => {
        add(`points[${i}].label`, p.label, 8);
        add(`points[${i}].text`, p.text, 50);
      });
      break;
    case "table":
    case "appendix":
      (s.columns ?? []).forEach((c, i) => add(`columns[${i}].label`, c.label, 10));
      (s.rows ?? []).forEach((r, i) => Object.entries(r ?? {}).forEach(([k, v]) => add(`rows[${i}].${k}`, v, 24)));
      break;
    case "roe-pbr":
    case "flows":
      (s.notes ?? []).forEach((n, i) => add(`notes[${i}]`, n, 40));
      break;
    case "scenarios":
      (s.cols ?? []).forEach((c, i) => {
        add(`cols[${i}].name`, c.name, 12);
        (c.triggers ?? []).forEach((t, k) => add(`cols[${i}].triggers[${k}]`, t, 30));
      });
      break;
    case "risks":
      (s.items ?? []).forEach((it, i) => add(`items[${i}].text`, it.text, 40));
      break;
    case "if-then":
      (s.rows ?? []).forEach((r, i) => {
        add(`rows[${i}].if`, r.if, 30);
        add(`rows[${i}].then`, r.then, 30);
        add(`rows[${i}].basis`, r.basis, 30);
      });
      break;
    default:
      break;
  }
  return out;
}

/** the figure ids a slide names outside its texts */
function slideRefs(s: Slide): { field: string; id: string }[] {
  switch (s.kind) {
    case "numbers3":
      return (s.items ?? []).map((it, i) => ({ field: `items[${i}].ref`, id: it.ref }));
    case "scenarios":
      return (s.cols ?? []).flatMap((c, i) => [
        ...(c.probRef ? [{ field: `cols[${i}].probRef`, id: c.probRef }] : []),
        ...(c.amplitudeRef ? [{ field: `cols[${i}].amplitudeRef`, id: c.amplitudeRef }] : []),
      ]);
    case "risks":
      return (s.items ?? []).flatMap((it, i) => [
        { field: `items[${i}].ref`, id: it.ref },
        { field: `items[${i}].thresholdRef`, id: it.thresholdRef },
      ]);
    default:
      return [];
  }
}

const count = (n: unknown, lo: number, hi: number) => Array.isArray(n) && n.length >= lo && n.length <= hi;

/** the captures a slide can draw (an asset the store no longer has is left out, and said) */
export function presentCaptures(s: Slide, data: DeckData): { assetId: string; caption: string }[] {
  return s.kind === "issue+capture" ? (s.captures ?? []).filter((c) => data.captures[c.assetId]) : [];
}

export function validateDeck(spec: DeckSpec, data: DeckData): DeckFail[] {
  const fails: DeckFail[] = [];
  const fail = (rule: string, what: string, n?: number, kind?: string) => fails.push({ ...(n ? { n } : {}), ...(kind ? { kind } : {}), rule, what });
  if (!spec || !Array.isArray(spec.slides) || !Array.isArray(spec.sections) || !Array.isArray(spec.summary)) {
    fail("schema", "sections, summary, slides가 모두 배열이어야 해요");
    return fails;
  }
  const words = data.words ?? {};

  // sections (tabs) and the summary lines
  if (!count(spec.sections, 4, 8)) fail("schema", `sections는 4–8개예요(지금 ${spec.sections.length}개)`);
  if (new Set(spec.sections).size !== spec.sections.length) fail("schema", "sections 이름이 겹쳐요");
  spec.sections.forEach((name, i) => {
    if (typeof name !== "string" || !name.trim()) fail("schema", `sections[${i}]가 비었어요`);
    else {
      if (chars(name) > 8) fail("limit", `sections[${i}] "${name}"은 8자까지예요`);
      for (const f of lintModelText(name)) fail(f.rule, `sections[${i}]: ${f.what}`);
    }
  });
  const tabsW = spec.sections.reduce((w, x) => w + textW(String(x ?? ""), 19), 0) + 28 * Math.max(0, spec.sections.length - 1);
  if (tabsW > 1152) fail("limit", "탭 줄이 1152px보다 넓어요(섹션 이름을 줄여요)");
  if (!count(spec.summary, 3, 5)) fail("schema", `summary는 3–5줄이에요(지금 ${spec.summary.length}줄)`);
  spec.summary.forEach((line, i) => {
    const f = fill(String(line ?? ""), data.figures, words);
    if (f.missing.length) fail("schema", `summary[${i}]: 없는 데이터 id ${f.missing.map((m) => `{${m}}`).join(", ")}`);
    if (chars(f.plain) > 60) fail("limit", `summary[${i}]는 60자까지예요(지금 ${chars(f.plain)}자)`);
    for (const x of lintModelText(String(line ?? ""))) fail(x.rule, `summary[${i}]: ${x.what}`);
  });

  const slides = spec.slides;
  const N = slides.length;
  if (N < DECK_MIN || N > DECK_MAX) fail("B2-pages", `장 수는 ${DECK_MIN}–${DECK_MAX}장이에요(지금 ${N}장)`);
  let captures = 0;

  slides.forEach((s, i) => {
    const n = i + 1;
    const kind = s?.kind;
    if (!s || !(DECK_KINDS as readonly string[]).includes(kind)) {
      fail("schema", `모르는 kind "${String(kind)}"`, n);
      return;
    }
    const at = (rule: string, what: string) => fail(rule, what, n, kind);
    const tabbed = kind !== "hero" && kind !== "disclaimer";
    if (tabbed && !spec.sections.includes(s.section ?? "")) at("schema", `section "${s.section ?? ""}"이 sections에 없어요`);
    if (!tabbed && s.section) at("schema", `${kind} 장에는 section이 없어요(탭 없음)`);

    // the texts: limits, references, and what the model may not write
    let long = 0;
    for (const t of modelTexts(s)) {
      if (typeof t.text !== "string" || !t.text.trim()) {
        at("schema", `${t.field}가 비었어요`);
        continue;
      }
      const f = fill(t.text, data.figures, words);
      if (f.missing.length) at("schema", `${t.field}: 없는 데이터 id ${f.missing.map((m) => `{${m}}`).join(", ")}`);
      const len = chars(f.plain);
      if (len > t.max) at("limit", `${t.field}는 ${t.max}자까지예요(지금 ${len}자)`);
      if (len > 40 && isSentence(f.plain)) long++;
      for (const x of lintModelText(t.text)) at(x.rule, `${t.field}: ${x.what}`);
    }
    if (long >= 3) at("FA4-1", `40자가 넘는 문장이 ${long}개예요(2개까지)`);
    for (const r of slideRefs(s)) if (!data.figures[r.id]) at("schema", `${r.field}: 없는 데이터 id {${r.id}}`);

    // each kind's own shape, and the data it needs
    switch (s.kind) {
      case "hero":
        if (s.highlight && !(s.headline.includes(s.highlight) || s.lead.includes(s.highlight))) at("schema", "highlight는 헤드라인이나 리드의 일부여야 해요");
        if (s.mark && !s.highlight) at("schema", "mark는 highlight를 둘러요(highlight가 없어요)");
        break;
      case "numbers3":
        if (!count(s.items, 3, 3)) at("schema", "items는 꼭 3개예요");
        break;
      case "signal-board":
        if (!data.stages) at("schema", "단계 데이터가 없어요");
        break;
      case "gauges":
        if (!data.stages) at("schema", "단계 데이터가 없어요");
        if (!["escape", "severe", "recovery"].includes(s.focus)) at("schema", "focus는 escape, severe, recovery 중 하나예요");
        break;
      case "issue+capture": {
        if (!count(s.captures, 1, 2)) at("schema", "captures는 1–2장이에요");
        if (!count(s.points, 2, 3)) at("schema", "points는 2–3개예요");
        (s.points ?? []).forEach((p, k) => {
          if (!GRADES.includes(p.grade)) at("schema", `points[${k}].grade는 A, B+, B, C 중 하나예요`);
        });
        const here = presentCaptures(s, data);
        if ((s.captures ?? []).length && !here.length) at("FA4-11", "보여 줄 캡처가 없어요(캡처 저장소에 없는 asset)");
        captures += here.length;
        break;
      }
      case "table":
      case "appendix": {
        const max = s.kind === "table" ? TABLE_ROWS : APPENDIX_ROWS;
        if (!count(s.columns, 2, s.kind === "table" ? 6 : 5)) at("schema", `columns는 2–${s.kind === "table" ? 6 : 5}개예요`);
        if (!count(s.rows, 1, max)) at(s.kind === "table" ? "FA7" : "schema", `rows는 ${max}행까지예요(지금 ${(s.rows ?? []).length}행)${s.kind === "table" ? ", 넘으면 appendix로 보내요" : ""}`);
        const keys = new Set((s.columns ?? []).map((c) => c.key));
        (s.rows ?? []).forEach((r, k) => {
          for (const key of keys) if (!(key in (r ?? {}))) at("schema", `rows[${k}]에 ${key} 칸이 없어요`);
        });
        if (s.highlightRow != null && !(Number.isInteger(s.highlightRow) && s.highlightRow >= 0 && s.highlightRow < (s.rows ?? []).length)) at("schema", "highlightRow가 행 밖이에요");
        break;
      }
      case "grid11":
        if (!data.core11 || data.core11.items.length !== 11) at("schema", "11지표 데이터가 없어요");
        break;
      case "roe-pbr":
        if (!data.valuation?.[s.company]) at("schema", `역산 데이터에 ${s.company}가 없어요`);
        if (!count(s.notes, 2, 2)) at("schema", "notes는 2줄이에요");
        break;
      case "flows":
        if (!data.flows?.[s.symbol]) at("schema", `수급 데이터에 ${s.symbol}가 없어요`);
        if (!count(s.notes, 0, 2)) at("schema", "notes는 2줄까지예요");
        break;
      case "level-chart": {
        const c = data.charts?.[s.symbol];
        if (!c) at("schema", `차트 데이터에 ${s.symbol}가 없어요`);
        else {
          const have = new Set(c.input.levels.filter((l) => Number.isFinite(l.price)).map((l) => l.kind));
          const lack = LEVELS_NEEDED.filter((k) => !have.has(k));
          if (lack.length) at("B2-levels", `레벨 차트에 ${lack.join(", ")}이 없어요`);
        }
        break;
      }
      case "scenarios":
        if (!count(s.cols, 3, 3)) at("schema", "cols는 꼭 3개예요");
        (s.cols ?? []).forEach((c, k) => {
          if (!count(c.triggers, 1, 3)) at("schema", `cols[${k}].triggers는 1–3개예요`);
        });
        break;
      case "timeline":
        if (!data.events?.list.length) at("schema", "이벤트 데이터가 없어요");
        else if (data.events.list.length > TIMELINE_EVENTS) at("schema", `이벤트가 ${data.events.list.length}개예요(${TIMELINE_EVENTS}개까지, 나머지는 appendix로 보내요)`);
        for (const e of data.events?.list ?? []) if (e.amplitudeRef && !data.figures[e.amplitudeRef]) at("schema", `이벤트 "${e.title}"의 진폭 ${e.amplitudeRef}가 figures에 없어요`);
        break;
      case "risks":
        if (!count(s.items, 3, 5)) at("B2-risks", "risks는 3–5개예요(반증 조건 3개 이상)");
        break;
      case "if-then":
        if (!count(s.rows, 1, 6)) at("FA7", "if-then은 6행까지예요");
        break;
      case "disclaimer":
        if (typeof s.playbook !== "boolean") at("schema", "playbook은 true나 false예요");
        break;
      default:
        break;
    }
  });

  // B-2: a figure another source disputes is written with the other value, which only a figure's own slot does
  // (numbers3, a table cell, a risk); named only inside a sentence, the conflict would go unsaid
  const inSentences = new Set<string>();
  const inSlots = new Set<string>();
  for (const s of slides) {
    if (!s || !(DECK_KINDS as readonly string[]).includes(s.kind)) continue;
    for (const r of slideRefs(s)) inSlots.add(r.id);
    if (s.kind === "table" || s.kind === "appendix")
      for (const row of s.rows ?? []) for (const v of Object.values(row ?? {})) {
        const m = /^\{([A-Za-z0-9_.:-]{1,40})\}$/.exec(String(v).trim());
        if (m) inSlots.add(m[1]!);
      }
    for (const t of modelTexts(s)) if (typeof t.text === "string") for (const m of t.text.matchAll(REF_RE)) inSentences.add(m[1]!);
  }
  for (const line of spec.summary) for (const m of String(line ?? "").matchAll(REF_RE)) inSentences.add(m[1]!);
  for (const id of inSentences) if (data.figures[id]?.conflict && !inSlots.has(id)) fail("B2-conflict", `{${id}}는 다른 출처와 값이 달라요. numbers3, 표, risks 칸에 한 번은 써요(두 값을 함께 적어요)`);

  // the deck as a whole (FA4 #7, #12; B-2)
  if (N) {
    if (slides[0]?.kind !== "hero") fail("B2-order", "첫 장은 hero예요");
    if (slides[N - 1]?.kind !== "disclaimer") fail("B2-disclaimer", "마지막 장은 disclaimer예요");
    if (slides.filter((s) => s?.kind === "disclaimer").length !== 1) fail("B2-disclaimer", "disclaimer는 마지막 장 하나뿐이에요");
    if (slides.filter((s) => s?.kind === "hero").length !== 1) fail("B2-order", "hero는 첫 장 하나뿐이에요");
    const first3 = slides.slice(0, 3).map((s) => s?.kind);
    if (!first3.includes("numbers3")) fail("FA4-12", "numbers3가 첫 3장 안에 있어야 해요");
    for (let i = 2; i < N; i++) {
      const k = slides[i]?.kind;
      if (k !== "appendix" && k === slides[i - 1]?.kind && k === slides[i - 2]?.kind) fail("FA4-7", `같은 kind ${k}가 3장 연속이에요(2장까지)`, i + 1, k);
    }
    const byKind = new Map<string, number>();
    for (const s of slides) if (s?.kind) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
    if (N >= DECK_MIN && byKind.size < 8) fail("FA4-7", `kind가 ${byKind.size}종류예요(8종류 이상)`);
    for (const [k, c] of byKind) if (c / N > 0.25) fail("FA4-7", `${k}가 ${c}장으로 전체의 25%를 넘어요`);
    const back = (byKind.get("appendix") ?? 0) + (byKind.get("sources") ?? 0);
    if (back / N > 0.25) fail("FA4-12", `appendix와 sources가 ${back}장으로 전체의 25%를 넘어요`);
    if (!byKind.has("risks")) fail("B2-risks", "risks 장이 없어요");
    if (captures < 3) fail("B2-captures", `실제 캡처가 ${captures}장이에요(3장 이상)`);
  }
  return fails;
}
