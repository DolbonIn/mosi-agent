/**
 * The F-A HTML (DD 1935 §5-1, §5-2): one <section class="page"> per slide, 1280 × 720, in the order of the JSON. Every
 * number comes from DeckData through the §0-5 formatter; every chart is a quant renderer with the deck's theme. Each
 * page's footer names the sources its figures and charts came from and the data's as of; the last page carries the
 * disclaimer word for word and the font's licence line (DD 0103-b F).
 */
import {
  DECK_BOARD,
  DECK_CHART,
  DECK_FLOWS,
  DECK_THEME,
  DISCLAIMER,
  DISCLAIMER_PLAYBOOK,
  flowChart,
  gaugeSvg,
  gaugeText,
  grid11Svg,
  kst,
  labelEm,
  levelChart,
  niceTicks,
  num,
  SIGNAL_SHAPES,
  SIGNAL_VIEWBOX,
  textW,
  timelineSvg,
  TRI_WORD,
  type GaugeKind,
  type Signal,
  type Tri,
} from "@pickle/quant";
import { deckCss, FA3 } from "./style";
import { esc, figureParts, figureText, fill, REF_RE } from "./text";
import { presentCaptures } from "./validate";
import type { DeckData, DeckFigure, DeckSpec, Slide, TableSlide } from "./types";

export const PAGE_W = 1280;
export const PAGE_H = 720;
/** the footer line for the font (OFL), once, on the disclaimer page */
export const FONT_LICENCE = "글꼴 Noto Sans KR · SIL OFL 1.1";

const span = (cols: number) => cols * 74 + (cols - 1) * 24;

/** 2026-11-27 08:00 KST */
export function kstStamp(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} KST`;
}

const kstDay = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
/** 2026-11-25 → 11/25 */
export const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

export interface RenderOptions {
  /** the CSS src of the font: url("file:///…/NotoSansKR-VF.ttf") format("truetype") for the PDF pass; the archived
   * HTML keeps only local() (the font is not copied into it, lead 0102) */
  fontSrc?: string;
}

export const LOCAL_FONT_SRC = 'local("Noto Sans KR"), local("NotoSansKR-Regular")';

class Ctx {
  constructor(
    readonly spec: DeckSpec,
    readonly data: DeckData,
  ) {}
  readonly sources = new Set<string>();
  get words() {
    return this.data.words ?? {};
  }
  /** the model's text, filled and escaped; its figures' sources go to the footer */
  t(text: string): string {
    const f = fill(text, this.data.figures, this.words);
    for (const id of f.refs) this.useFigure(id);
    return f.html;
  }
  useFigure(id: string): DeckFigure | null {
    const f = this.data.figures[id];
    if (f) this.sources.add(f.source);
    return f ?? null;
  }
  srcName(id: string): string {
    return this.data.sources[id]?.name ?? id;
  }
  /** "FRED · A", with "11/25 기준" when the figure's day is not the deck's (the deck's short date is M/D, DD 1935 §4) */
  figureBasis(f: DeckFigure): string {
    const s = this.data.sources[f.source];
    const parts = [s?.name ?? f.source, s?.grade ?? ""].filter(Boolean);
    const day = f.asOf.slice(0, 10);
    if (day !== kstDay(this.data.asOf)) parts.push(`${shortDay(day)} 기준`);
    return parts.join(" · ");
  }
  /** a conflicting figure, written beside (B-2): 다른 출처 4.51% · Bloomberg */
  conflict(f: DeckFigure): string {
    if (!f.conflict) return "";
    const other = figureText({ ...f, value: f.conflict.value, estimate: f.estimate });
    return `다른 출처 ${other} · ${this.srcName(f.conflict.source)}`;
  }
}

/** a figure drawn large: the number, with 약 … (추정) smaller beside it */
function bigFigure(f: DeckFigure | null): string {
  if (!f) return "";
  const p = figureParts(f);
  return `${p.pre ? `<span class="pre">${esc(p.pre)}</span>` : ""}${esc(p.main)}${p.post ? `<span class="post">${esc(p.post)}</span>` : ""}`;
}

const markSvg = (s: Signal) => `<svg viewBox="${SIGNAL_VIEWBOX}" aria-hidden="true">${SIGNAL_SHAPES[s]}</svg>`;

/** a condition's chip: 충족 in the gauge's tone, 미충족 neutral, 확인 불가 dashed (never 미충족, A1) */
function triChip(status: Tri, tone: "risk" | "normal"): string {
  if (status === "unknown") return `<span class="chip unknown" data-viz="chip">${markSvg("unknown")}${TRI_WORD.unknown}</span>`;
  if (status === "met") {
    const [bg, ink] = tone === "risk" ? [FA3.chipRisk, FA3.chipRiskInk] : [FA3.chipNormal, FA3.chipNormalInk];
    return `<span class="chip" style="background:${bg};color:${ink}" data-viz="chip">${markSvg("risk")}${TRI_WORD.met}</span>`;
  }
  return `<span class="chip" style="background:${FA3.chipUnknown};color:${FA3.ink3}" data-viz="chip">${markSvg("normal")}${TRI_WORD.unmet}</span>`;
}

/** a gauge with its name, count and unknowns: on one row (the signal board), or with a head row over the cells (the
 * gauges slide's narrow column) */
function gaugeBlock(kind: GaugeKind, g: { met: number; unknown: number; of: number }, mode: "row" | "stack"): string {
  const svg = gaugeSvg(kind, g, DECK_BOARD).svg;
  const unk = g.unknown ? `<span class="unk t-foot">${esc(TRI_WORD.unknown)} ${g.unknown}개</span>` : "";
  const name = `<span class="name t-body">${{ escape: "악화 신호", severe: "심각 신호", recovery: "회복 신호" }[kind]}</span>`;
  const count = `<span class="count">${g.met}/${g.of}</span>`;
  const viz = `<div class="viz" data-viz="gauge">${svg}</div>`;
  const label = ` data-gauge="${kind}" aria-label="${esc(gaugeText(kind, g))}"`;
  return mode === "row" ? `<div class="gauge row"${label}>${name}${viz}${count}${unk}</div>` : `<div class="gauge"${label}><div class="h">${name}${unk}${count}</div>${viz}</div>`;
}

/** the roe-pbr methods as horizontal bars, with its axis, unit, as of and source (FA4 #8) */
export function methodBars(methods: readonly { name: string; value: number }[], o: { width: number; height: number; unit: string; digits: number; caption: string }): string {
  const { width: W, height: H } = o;
  const T = 15;
  const L = Math.min(240, Math.max(...methods.map((m) => labelEm(m.name) * 17)) + 18);
  const vals = methods.map((m) => m.value);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const ticks = niceTicks(lo, hi === lo ? lo + 1 : hi, 5);
  const t0 = Math.min(lo, ticks[0]!);
  const t1 = Math.max(hi, ticks.at(-1)!);
  const valW = Math.max(...methods.map((m) => labelEm(num(m.value, o.digits)) * 17)) + 12;
  const x0 = L;
  const x1 = W - valW;
  const x = (v: number) => x0 + ((v - t0) / (t1 - t0)) * (x1 - x0);
  const top = 40;
  const bottom = H - 34;
  const slot = (bottom - top) / methods.length;
  const bh = Math.min(46, slot * 0.56);
  const s: string[] = [];
  const tx = (px: number, py: number, str: string, size: number, color: string, extra = "") =>
    `<text x="${px.toFixed(1)}" y="${(py + size * 0.35).toFixed(1)}" font-size="${size}" fill="${color}"${extra}>${esc(str)}</text>`;
  s.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" style="font-family:${DECK_BOARD.font};font-variant-numeric:tabular-nums">`);
  s.push(tx(0, 10, o.caption, T, FA3.foot, ' data-role="caption"'));
  for (const t of ticks) {
    s.push(`<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${top - 8}" y2="${bottom}" stroke="${FA3.rule2}" stroke-width="1" data-role="grid"/>`);
    s.push(tx(x(t), bottom + 18, num(t, Number.isInteger(t) ? 0 : 1), T, FA3.foot, ' text-anchor="middle" data-role="tick"'));
  }
  s.push(`<line x1="${x(0).toFixed(1)}" x2="${x(0).toFixed(1)}" y1="${top - 8}" y2="${bottom}" stroke="${FA3.mute2}" stroke-width="1.5" data-role="zero"/>`);
  methods.forEach((m, i) => {
    const cy = top + slot * (i + 0.5);
    const a = x(Math.min(0, m.value));
    const b = x(Math.max(0, m.value));
    s.push(tx(0, cy, m.name, 17, FA3.ink, ' font-weight="700" data-role="label"'));
    s.push(`<rect x="${a.toFixed(1)}" y="${(cy - bh / 2).toFixed(1)}" width="${Math.max(1, b - a).toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${FA3.ink}" data-role="bar"/>`);
    s.push(tx(b + 8, cy, num(m.value, o.digits), 17, FA3.ink, ' font-weight="800" data-role="value"'));
  });
  s.push("</svg>");
  return s.join("");
}

function figureCell(c: Ctx, cell: string): { html: string; figure: boolean } {
  const m = /^\{([A-Za-z0-9_.:-]{1,40})\}$/.exec(cell.trim());
  if (m) {
    const f = c.useFigure(m[1]!);
    if (f) {
      const conf = c.conflict(f);
      return { html: `<span class="fig">${esc(figureText(f))}</span>${conf ? `<span class="conf">${esc(conf)}</span>` : ""}`, figure: true };
    }
  }
  return { html: c.t(cell), figure: false };
}

function table(c: Ctx, s: TableSlide): string {
  const apx = s.kind === "appendix";
  const cols = s.columns;
  const head = cols.map((col) => `<th class="${col.align === "right" ? "r" : ""}">${c.t(col.label)}${col.unit ? ` (${esc(col.unit)})` : ""}</th>`).join("");
  const rows = s.rows.map((r, i) => {
    const tds = cols.map((col) => {
      const cell = figureCell(c, String(r[col.key] ?? ""));
      const right = col.align === "right" || (col.align == null && cell.figure);
      return `<td class="t-table${right ? " r" : ""}">${cell.html}</td>`;
    });
    // the appendix names each row's sources in its own column (FA7)
    if (apx) {
      const refs = Object.values(r).flatMap((v) => [...String(v).matchAll(REF_RE)].map((m) => m[1]!));
      const names = [...new Set(refs.map((id) => c.data.figures[id]).filter(Boolean).map((f) => `${c.srcName(f!.source)} · ${c.data.sources[f!.source]?.grade ?? ""}`))];
      tds.push(`<td class="t-table src">${esc(names.join(", ") || "—")}</td>`);
    }
    return `<tr${s.highlightRow === i ? ' class="hi"' : ""}>${tds.join("")}</tr>`;
  });
  return `<table class="tbl${apx ? " apx" : ""}"><thead><tr>${head}${apx ? "<th>출처</th>" : ""}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

/** each kind's body (DD 1935 §5-2) */
function body(c: Ctx, s: Slide, n: number): string {
  const d = c.data;
  switch (s.kind) {
    case "hero":
      return "";
    case "numbers3":
      return `<div class="n3">${s.items
        .map((it) => {
          const f = c.useFigure(it.ref);
          const main = f ? figureParts(f).main : "";
          const sub = textW(main, 66) > span(4) ? " sub" : "";
          const conf = f ? c.conflict(f) : "";
          return `<div class="n3c" data-ref="${esc(it.ref)}"><div class="num${sub}">${bigFigure(f)}</div><div class="label t-body">${c.t(it.label)}</div><div class="note t-body">${c.t(it.note)}</div><div class="src t-foot">${esc(f ? c.figureBasis(f) : "")}${conf ? ` · ${esc(conf)}` : ""}</div></div>`;
        })
        .join("")}</div>`;
    case "signal-board": {
      const st = d.stages!;
      st.sources.forEach((x) => c.sources.add(x));
      const moved = st.moved ? `<div class="sb-moved t-body"><mark class="hl">${esc(st.moved)}</mark></div>` : "";
      return `<div class="sb-l"><div class="sb-name t-body">탈출 단계</div><div class="sb-stage">${esc(st.escape.label)}</div>${moved}<div class="sb-name t-body">회복 단계</div><div class="sb-stage">${esc(st.recovery.label)}</div><div class="sb-name t-body">시나리오</div><div class="sb-scen">${esc(st.scenario)}</div></div><div class="sb-r">${gaugeBlock("escape", st.escape.gauges.a, "row")}${gaugeBlock("severe", st.escape.gauges.d, "row")}${gaugeBlock("recovery", st.recovery.gauge, "row")}<p class="sb-note t-body">${c.t(s.note)}</p></div>`;
    }
    case "gauges": {
      const st = d.stages!;
      st.sources.forEach((x) => c.sources.add(x));
      const list = st.conditions[s.focus];
      const tone = s.focus === "recovery" ? "normal" : "risk";
      const rows = list
        .map((k) => `<div class="cond" data-cond="${esc(k.id)}">${triChip(k.status, tone)}<span class="rule t-table">${esc(k.id)} ${esc(k.rule)}</span><span class="val t-table">${esc(k.value)}</span></div>`)
        .join("");
      const next = s.focus === "recovery" ? st.next.recovery : st.next.escape;
      return `<div class="gg-list">${rows}</div><div class="gg-side">${gaugeBlock("escape", st.escape.gauges.a, "stack")}${gaugeBlock("severe", st.escape.gauges.d, "stack")}${gaugeBlock("recovery", st.recovery.gauge, "stack")}<div class="card"><div class="t">다음 단계까지</div><p class="next t-body">${esc(next)}</p><p class="note t-body">${c.t(s.note)}</p></div></div>`;
    }
    case "issue+capture": {
      const caps = presentCaptures(s, d)
        .map((cp) => {
          const a = d.captures[cp.assetId]!;
          const meta = [a.outlet, a.account, kst(a.capturedAt), a.grade].filter(Boolean).join(" · ");
          return `<figure class="cap" data-capture="${esc(cp.assetId)}" style="margin:0"><div class="frame"><img src="${esc(a.src)}" width="${a.width}" height="${a.height}" alt="${esc(fill(cp.caption, d.figures, c.words).plain)}" data-viz="capture" data-url="${esc(a.url)}"></div><figcaption class="cc">${c.t(cp.caption)}</figcaption><div class="cm">${esc(meta)}</div></figure>`;
        })
        .join("");
      for (const cp of presentCaptures(s, d)) c.sources.add(`capture:${cp.assetId}`);
      const pts = s.points.map((p) => `<div class="pt card"><div class="lab"><span>${c.t(p.label)}</span><span>${esc(p.grade)}</span></div><p class="txt t-body">${c.t(p.text)}</p></div>`).join("");
      return `<div class="cap-l">${caps}</div><div class="cap-r">${pts}</div>`;
    }
    case "table":
    case "appendix":
      return table(c, s);
    case "grid11": {
      const g = d.core11!;
      g.sources.forEach((x) => c.sources.add(x));
      const r = grid11Svg(g.items, DECK_BOARD);
      return `<div class="viz" data-viz="grid11" data-issues="${r.issues.length}">${r.svg}</div>`;
    }
    case "roe-pbr": {
      const v = d.valuation![s.company]!;
      v.sources.forEach((x) => c.sources.add(x));
      const hero = c.useFigure(v.heroRef);
      const chart = methodBars(v.methods, { width: span(7), height: 416, unit: v.unit, digits: v.digits, caption: `단위 ${v.unit} · ${v.asOf} · ${v.source}` });
      return `<div class="rp-l viz" data-viz="chart">${chart}</div><div class="rp-r"><div class="label t-body">${esc(v.heroLabel)}</div><div class="num">${bigFigure(hero)}</div><div class="src t-foot">${esc(hero ? c.figureBasis(hero) : "")}</div>${s.notes.map((x) => `<p class="note t-body">${c.t(x)}</p>`).join("")}</div>`;
    }
    case "flows": {
      const fl = d.flows![s.symbol]!;
      fl.sources.forEach((x) => c.sources.add(x));
      const notesH = s.notes.length ? 68 : 0;
      const ch = flowChart(fl.chart, DECK_BOARD, { ...DECK_FLOWS, height: 416 - notesH });
      const met = fl.criteria.filter((k) => k.status === "met").length;
      const crit = fl.criteria
        .map((k) => `<div class="cond"><div class="r">${triChip(k.status, "normal")}<span class="rule t-table">${esc(k.rule)}</span></div><span class="val t-table">${esc(k.value)}</span></div>`)
        .join("");
      return `<div class="fl-l viz" data-viz="chart" data-issues="${ch.issues.length}">${ch.svg}</div>${s.notes.length ? `<div class="fl-notes">${s.notes.map((x) => `<p class="t-body">${c.t(x)}</p>`).join("")}</div>` : ""}<div class="fl-r"><div class="t">${esc(fl.threshold.title)}</div><p class="formula t-body">${esc(fl.threshold.formula)}</p><p class="val t-body">${esc(fl.threshold.value)}</p><div class="d8"><div class="t">숏커버 5기준 · ${met}/${fl.criteria.length} ${TRI_WORD.met}</div>${crit}</div></div>`;
    }
    case "level-chart": {
      const lc = d.charts![s.symbol]!;
      lc.sources.forEach((x) => c.sources.add(x));
      const ch = levelChart(lc.input, DECK_THEME, DECK_CHART);
      const right = DECK_CHART.width - ch.plot.x1;
      return `<div class="lc viz" data-viz="level-chart" data-plot="${ch.plot.y0},${ch.plot.y1}" data-issues="${ch.issues.length}">${ch.svg}<div class="lc-note" style="right:${right.toFixed(0)}px">${c.t(s.note)}</div></div>`;
    }
    case "scenarios":
      return `<div class="sc">${s.cols
        .map((col) => {
          const p = col.probRef ? c.useFigure(col.probRef) : null;
          const a = col.amplitudeRef ? c.useFigure(col.amplitudeRef) : null;
          return `<div class="card"><div class="name">${c.t(col.name)}</div>${p ? `<div class="prob">${bigFigure(p)}</div>` : ""}<div class="t">트리거</div>${col.triggers.map((t) => `<p class="trig t-body">${c.t(t)}</p>`).join("")}${a ? `<p class="amp t-body">진폭 ${esc(figureText(a))}</p>` : ""}</div>`;
        })
        .join("")}</div>`;
    case "timeline": {
      const ev = d.events!;
      ev.sources.forEach((x) => c.sources.add(x));
      const list = ev.list.map(({ amplitudeRef, ...e }) => {
        const a = amplitudeRef ? c.useFigure(amplitudeRef) : null;
        return { ...e, amplitude: a ? figureText(a) : null };
      });
      const t = timelineSvg({ events: list, summary: s.headline, asOf: ev.asOf, source: ev.source }, DECK_BOARD);
      return `<div class="viz" data-viz="timeline" data-issues="${t.issues.length}">${t.svg}</div>`;
    }
    case "risks": {
      const k = s.items.length;
      const cols = k === 4 ? 2 : 3;
      const rows = Math.ceil(k / cols);
      return `<div class="rk" style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)">${s.items
        .map((it, i) => {
          const now = c.useFigure(it.ref);
          const th = c.useFigure(it.thresholdRef);
          const conf = now ? c.conflict(now) : "";
          return `<div class="rc"><div class="lab">반증 ${i + 1}</div><p class="txt t-body">${c.t(it.text)}</p><p class="now t-body">임계 <span class="fig">${esc(th ? figureText(th) : "")}</span> · 지금 <span class="fig">${esc(now ? figureText(now) : "")}</span>${conf ? `<span class="conf">${esc(conf)}</span>` : ""}</p></div>`;
        })
        .join("")}</div>`;
    }
    case "if-then":
      return `<table class="tbl"><colgroup><col style="width:38%"><col style="width:36%"><col style="width:26%"></colgroup><thead><tr><th>조건</th><th>그러면</th><th>근거</th></tr></thead><tbody>${s.rows
        .map((r) => `<tr><td class="t-table">${c.t(r.if)}</td><td class="t-table">${c.t(r.then)}</td><td class="t-table">${c.t(r.basis)}</td></tr>`)
        .join("")}</tbody></table>`;
    case "sources": {
      // each line starts with the name the footers use, so a footer's name is found here (DD 1509 1); captures too
      const all = used(c.spec, d);
      const line = (x: string): { grade: string; text: string } => {
        if (x.startsWith("capture:")) {
          const a = d.captures[x.slice(8)]!;
          return { grade: a.grade, text: [a.outlet, a.account, `캡처 ${kst(a.capturedAt)}`, a.url].filter(Boolean).join(" · ") };
        }
        const v = d.sources[x]!;
        return { grade: v.grade, text: [v.name, v.title, v.publisher, v.date, v.url].join(" · ") };
      };
      const lines = all.map(line);
      const groups = (["A", "B+", "B", "C"] as const)
        .map((g) => {
          const items = lines.filter((x) => x.grade === g);
          if (!items.length) return "";
          return `<div class="src-g"><h2>등급 ${g}</h2><ol>${items.map((x) => `<li>${esc(x.text)}</li>`).join("")}</ol></div>`;
        })
        .join("");
      return `<div class="src-cols">${groups}</div>`;
    }
    case "disclaimer":
      return "";
  }
  void n;
  return "";
}

/** every source the deck's pages use, in first-use order (the sources page lists them by grade) */
export function usedSources(spec: DeckSpec, data: DeckData): string[] {
  return used(spec, data).filter((x) => !x.startsWith("capture:"));
}

/** every source and capture ("capture:<id>") the deck's pages draw on, in the order they first appear */
function used(spec: DeckSpec, data: DeckData): string[] {
  const seen = new Set<string>();
  for (const s of spec.slides) {
    if (s.kind === "sources" || s.kind === "disclaimer") continue;
    const c = new Ctx(spec, data);
    body(c, s, 0);
    renderTexts(c, s);
    for (const x of c.sources) if (x.startsWith("capture:") ? data.captures[x.slice(8)] : data.sources[x]) seen.add(x);
  }
  return [...seen];
}

/** the kicker and headline (filled so their figures count as used) */
function renderTexts(c: Ctx, s: Slide): { kicker: string; headline: string } {
  return { kicker: c.t(s.kicker), headline: c.t(s.headline) };
}

/** the footer's left: 출처: FRED, CBOE, 토스증권 · 기준 2026-11-27 08:00 KST, cut to fit beside the page number */
function footLeft(c: Ctx, names: string[]): string {
  const basis = `기준 ${kstStamp(c.data.asOf)}`;
  if (!names.length) return basis;
  const room = 1152 - 120;
  for (let k = names.length; k >= 1; k--) {
    const more = names.length - k;
    const line = `출처: ${names.slice(0, k).join(", ")}${more ? ` 외 ${more}곳` : ""} · ${basis}`;
    if (textW(line, 14) <= room || k === 1) return line;
  }
  return basis;
}

/** the highlight marked (and ringed on the cover); the word it sits in is tied to it, so a particle never starts the
 * next line on its own (방어를 준비할 때|예요): the ring is an inline-block, which opens a break at its sides */
function withHighlight(html: string, plainHighlight: string | undefined, ring: boolean): string {
  if (!plainHighlight) return html;
  const h = esc(plainHighlight);
  const at = html.indexOf(h);
  if (at < 0) return html;
  const inner = `<mark class="hl">${h}</mark>`;
  const before = html.slice(0, at);
  const after = html.slice(at + h.length);
  const lead = /[^\s>]*$/.exec(before)![0];
  const tail = /^[^\s<]*/.exec(after)![0];
  const marked = ring ? `<span class="ring" data-viz="hand-mark">${inner}</span>` : inner;
  const core = lead || tail ? `<span class="tie">${lead}${marked}${tail}</span>` : marked;
  return before.slice(0, before.length - lead.length) + core + after.slice(tail.length);
}

export function renderSlide(spec: DeckSpec, data: DeckData, s: Slide, n: number, total: number): string {
  const c = new Ctx(spec, data);
  const tabs =
    s.kind === "hero" || s.kind === "disclaimer" ? "" : `<nav class="tabs">${spec.sections.map((x) => `<span${x === s.section ? ' class="on"' : ""}>${esc(x)}</span>`).join("")}</nav>`;
  let main: string;
  if (s.kind === "hero") {
    const k = c.t(s.kicker);
    const h = withHighlight(c.t(s.headline), s.headline.includes(s.highlight ?? "\u0000") ? s.highlight : undefined, !!s.mark);
    const l = withHighlight(c.t(s.lead), !s.headline.includes(s.highlight ?? "\u0000") ? s.highlight : undefined, !!s.mark);
    main = `<div class="hero"><div class="k">${k}</div><h1>${h}</h1><p class="lead">${l}</p></div>`;
  } else if (s.kind === "disclaimer") {
    const t = renderTexts(c, s);
    main = `<div class="kicker">${t.kicker}</div><h2 class="headline">${t.headline}</h2><div class="dc"><p data-role="disclaimer">${esc(DISCLAIMER)}</p>${s.playbook ? `<p data-role="disclaimer-playbook">${esc(DISCLAIMER_PLAYBOOK)}</p>` : ""}<p class="when">생성 ${esc(kstStamp(data.generatedAt))} · 데이터 기준 ${esc(kstStamp(data.asOf))}</p></div>`;
  } else {
    const t = renderTexts(c, s);
    main = `<div class="kicker">${t.kicker}</div><h2 class="headline">${t.headline}</h2><div class="body">${body(c, s, n)}</div>`;
  }
  // a capture is named by its outlet; two captures from one outlet name it once
  const names = [...new Set([...c.sources].map((x) => (x.startsWith("capture:") ? (data.captures[x.slice(8)]?.outlet ?? x.slice(8)) : c.srcName(x))))];
  const left = s.kind === "disclaimer" ? FONT_LICENCE : footLeft(c, [...new Set(names)]);
  const foot = `<footer class="foot"><span class="l" data-role="foot-left">${esc(left)}</span><span class="r" data-role="page-no">${n} / ${total}</span></footer>`;
  return `<section class="page" data-n="${n}" data-kind="${s.kind}">${tabs}${main}${foot}</section>`;
}

export function renderDeck(spec: DeckSpec, data: DeckData, opts: RenderOptions = {}): string {
  const total = spec.slides.length;
  const pages = spec.slides.map((s, i) => renderSlide(spec, data, s, i + 1, total)).join("\n");
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>${esc(data.title)}</title>
<style>${deckCss(opts.fontSrc ?? LOCAL_FONT_SRC)}</style></head>
<body>
${pages}
</body></html>
`;
}
