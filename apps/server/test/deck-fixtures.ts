/**
 * The deck's three fixed samples (DD 0059 §6-1), synthetic data and no model: (a) an ordinary day, (b) a day with
 * missing data (three of the eleven indicators 확인 불가, one capture gone from the store), (c) a stage-move day (escape
 * 2 → 3, the highlighted line). 28 slides each, in FA6's order. Every figure, source and capture here is made up and
 * says so (합성).
 */
import { ESCAPE_A_RULES, ESCAPE_D_RULES, escapeStage, RECOVERY_RULES, recoveryStage, SHORT_COVER_RULES, type Bar, type ChartLevel, type Condition, type Core11Result, type FlowDay, type Grid11Item, type Signal, type Tri } from "@pickle/quant";
import type { Assessed, InputKey } from "../src/invest/stages";
import { deckStages, headPhrase } from "../src/deck/stages";
import { deflateSync } from "node:zlib";
import { figureText } from "../src/deck/text";
import { shortDay } from "../src/deck/render";
import type { DeckCapture, DeckData, DeckEvent, DeckFigure, DeckSpec } from "../src/deck/types";

export type FixtureKind = "a" | "b" | "c";

/** 2026-11-27 08:00 KST */
export const FIXTURE_AS_OF = Date.UTC(2026, 10, 26, 23, 0);

/** CRC-32 (PNG chunks) */
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** a small RGB canvas: rectangles, discs and thick lines, written out as a PNG */
class Canvas {
  readonly px: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    bg: string,
  ) {
    this.px = new Uint8Array(w * h * 3);
    this.rect(0, 0, w, h, bg);
  }
  private rgb(c: string): [number, number, number] {
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  }
  rect(x: number, y: number, w: number, h: number, c: string) {
    const [r, g, b] = this.rgb(c);
    for (let j = Math.max(0, Math.round(y)); j < Math.min(this.h, Math.round(y + h)); j++)
      for (let i = Math.max(0, Math.round(x)); i < Math.min(this.w, Math.round(x + w)); i++) this.px.set([r, g, b], (j * this.w + i) * 3);
  }
  disc(cx: number, cy: number, rad: number, c: string) {
    const [r, g, b] = this.rgb(c);
    for (let j = Math.max(0, Math.floor(cy - rad)); j <= Math.min(this.h - 1, Math.ceil(cy + rad)); j++)
      for (let i = Math.max(0, Math.floor(cx - rad)); i <= Math.min(this.w - 1, Math.ceil(cx + rad)); i++) if ((i - cx) ** 2 + (j - cy) ** 2 <= rad * rad) this.px.set([r, g, b], (j * this.w + i) * 3);
  }
  line(pts: [number, number][], thick: number, c: string) {
    for (let k = 1; k < pts.length; k++) {
      const [[x0, y0], [x1, y1]] = [pts[k - 1]!, pts[k]!];
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
      for (let t = 0; t <= n; t++) this.disc(x0 + ((x1 - x0) * t) / n, y0 + ((y1 - y0) * t) / n, thick / 2, c);
    }
  }
  png(): Uint8Array {
    const raw = new Uint8Array(this.h * (this.w * 3 + 1));
    for (let j = 0; j < this.h; j++) raw.set(this.px.subarray(j * this.w * 3, (j + 1) * this.w * 3), j * (this.w * 3 + 1) + 1);
    const chunk = (type: string, data: Uint8Array) => {
      const body = new Uint8Array(4 + data.length);
      body.set(new TextEncoder().encode(type));
      body.set(data, 4);
      const out = new Uint8Array(12 + data.length);
      const v = new DataView(out.buffer);
      v.setUint32(0, data.length);
      out.set(body, 4);
      v.setUint32(8 + data.length, crc32(body));
      return out;
    };
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, this.w);
    v.setUint32(4, this.h);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) (out.set(p, at), (at += p.length));
    return out;
  }
}

/** text as grey bars: a synthetic picture says nothing (every capture here is made up) */
function textBars(cv: Canvas, x: number, y: number, widths: number[], h: number, step: number, c: string) {
  widths.forEach((w, i) => cv.rect(x, y + i * step, w, h, c));
}

function postPicture(w: number, h: number, lines: number): Canvas {
  const cv = new Canvas(w, h, "#FFFFFF");
  cv.disc(96, 96, 46, "#9AA7B8");
  cv.rect(170, 66, 280, 28, "#2B2F36");
  cv.rect(170, 106, 190, 20, "#A0A6AE");
  textBars(cv, 60, 190, [960, 900, 940, 620, 880, 520].slice(0, lines), 24, 50, "#3C4048");
  const top = 190 + lines * 50 + 30;
  const ph = h - top - 150;
  cv.rect(60, top, w - 120, ph, "#EEF1F5");
  const n = 12;
  for (let i = 0; i < n; i++) {
    const bh = ((Math.sin(i * 1.7) + 1.4) / 2.4) * (ph - 80);
    cv.rect(100 + (i * (w - 200)) / n, top + ph - 40 - bh, (w - 200) / n - 18, bh, i === n - 1 ? "#C8102E" : "#4A6FA5");
  }
  cv.rect(0, h - 110, w, 2, "#E2E5EA");
  for (let i = 0; i < 4; i++) cv.disc(110 + i * 240, h - 55, 18, "#B8BEC6");
  return cv;
}

function broadcastPicture(): Canvas {
  const [w, h] = [1600, 900];
  const cv = new Canvas(w, h, "#1D2A3A");
  cv.rect(80, 90, 920, 560, "#24364C");
  const pts: [number, number][] = [];
  for (let i = 0; i < 30; i++) {
    const x = 120 + i * 29;
    const o = 360 + Math.sin(i / 3) * 90 - i * 3;
    const c = o + Math.cos(i * 1.3) * 40;
    cv.rect(x, Math.min(o, c), 16, Math.max(6, Math.abs(c - o)), c < o ? "#3FAE7A" : "#D9534F");
    pts.push([x + 8, (o + c) / 2]);
  }
  cv.line(pts, 4, "#F2C14E");
  cv.rect(1040, 90, 480, 560, "#2E4460");
  textBars(cv, 1080, 140, [400, 360, 380, 300, 340, 260, 320], 22, 62, "#DCE3EC");
  cv.rect(0, 690, w, 120, "#C8102E");
  textBars(cv, 60, 718, [900, 620], 26, 44, "#FFFFFF");
  cv.rect(0, 810, w, 90, "#0E1620");
  textBars(cv, 40, 842, [1500], 22, 0, "#7D8794");
  return cv;
}

function chartPicture(): Canvas {
  const [w, h] = [1600, 900];
  const cv = new Canvas(w, h, "#FFFFFF");
  for (let i = 0; i <= 5; i++) cv.rect(120, 120 + i * 130, 1400, 2, "#E5E7EB");
  cv.rect(120, 120, 2, 650, "#9CA3AF");
  cv.rect(120, 770, 1400, 2, "#9CA3AF");
  const pts: [number, number][] = Array.from({ length: 60 }, (_, i) => [130 + i * 23.5, 520 - Math.sin(i / 7) * 120 - (i > 45 ? (i - 45) * 14 : 0) + Math.cos(i * 2.1) * 18]);
  cv.line(pts, 5, "#2563EB");
  textBars(cv, 120, 50, [520], 30, 0, "#111827");
  textBars(cv, 120, 820, [300, 260], 18, 0, "#6B7280");
  return cv;
}

const synthCache = new Map<string, { src: string; width: number; height: number }>();
/**
 * DD 1704 6: synthetic pictures at real capture shapes for the built samples — a post 1080 × 1350 (portrait), a reply
 * 1080 × 1080, a broadcast 1600 × 900 (landscape) and a chart 1600 × 900 — so the frames' fit and crop can be judged.
 * Grey bars stand for text: nothing in them is real.
 */
export function synthCapture(id: string): { src: string; width: number; height: number } {
  const hit = synthCache.get(id);
  if (hit) return hit;
  const cv = id === "cap-post" ? postPicture(1080, 1350, 6) : id === "cap-reply" ? postPicture(1080, 1080, 3) : id === "cap-broadcast" ? broadcastPicture() : chartPicture();
  const out = { src: `data:image/png;base64,${Buffer.from(cv.png()).toString("base64")}`, width: cv.w, height: cv.h };
  synthCache.set(id, out);
  return out;
}

/** a valid 1 × 1 PNG: the unit tests need a capture, not a picture */
export const DOT_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

function addDays(t: string, n: number): string {
  const d = new Date(`${t}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** trading days back from 2026-11-26 (weekdays only) */
function tradingDays(n: number): string[] {
  const out: string[] = [];
  let t = "2026-11-26";
  while (out.length < n) {
    const wd = new Date(`${t}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) out.unshift(t);
    t = addDays(t, -1);
  }
  return out;
}

/** deterministic noise */
function rng(seed: number) {
  let x = seed;
  return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function bars(seed: number, start: number, n = 280): Bar[] {
  const r = rng(seed);
  const days = tradingDays(n);
  let c = start;
  return days.map((t, i) => {
    const drift = Math.sin(i / 11) * 0.012 + (i > 230 ? -0.004 : 0.002);
    const o = c;
    c = Math.max(start * 0.3, c * (1 + drift + (r() - 0.5) * 0.03));
    const hi = Math.max(o, c) * (1 + r() * 0.012);
    const lo = Math.min(o, c) * (1 - r() * 0.012);
    return { t, o, h: hi, l: lo, c, v: 1_000_000 + Math.round(r() * 600_000) };
  });
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function levels(b: Bar[]): ChartLevel[] {
  const last = b.at(-1)!.c;
  return [
    { kind: "stop", price: round2(last * 0.9) },
    { kind: "support", price: round2(last * 0.95) },
    { kind: "buyZone", price: round2(last * 0.96), hi: round2(last * 0.98) },
    { kind: "resistance", price: round2(last * 1.06) },
    { kind: "target1", price: round2(last * 1.1) },
  ];
}

function flowDays(seed: number): FlowDay[] {
  const r = rng(seed);
  return tradingDays(24).map((t) => {
    const foreign = Math.round((r() - 0.55) * 16000);
    const institution = Math.round((r() - 0.45) * 9000);
    return { t, foreign, institution, individual: Math.round(-(foreign + institution) + (r() - 0.5) * 3000), nonArb: Math.round((r() - 0.45) * 5000) };
  });
}

function capture(id: string, outlet: string, account: string | undefined, hoursBefore: number, grade: DeckCapture["grade"], src: string, w: number, h: number): DeckCapture {
  return { src, width: w, height: h, outlet, ...(account ? { account } : {}), url: `example.invalid/${id}`, capturedAt: FIXTURE_AS_OF - hoursBefore * 3_600_000, grade };
}

const fig = (value: number | null, format: DeckFigure["format"], source: string, extra: Partial<DeckFigure> = {}): DeckFigure => ({ value, format, source, asOf: "2026-11-26", ...extra });

/** quant's conditions, as assessStages would give them, from a status per id */
const conditions = (rules: Readonly<Record<string, string>>, status: Record<string, Tri>): Condition[] =>
  Object.entries(rules).map(([id, rule]) => ({ id, rule, status: status[id] ?? "unmet", figures: {}, asOf: "2026-11-26" }));

/** quant's core-11 result behind the grid's items: the counts, the unknowns that may be 🔴, indicator 3's risk */
export function coreOf(items: readonly Grid11Item[]): Core11Result {
  const counts: Record<Signal, number> = { normal: 0, caution: 0, risk: 0, unknown: 0 };
  for (const it of items) counts[it.signal]++;
  const hy = items.find((it) => it.no === 3)!.signal;
  return {
    items: items.map((it) => ({ no: it.no, name: it.name, signal: it.signal, value: null, asOf: null, reason: "", extras: {}, mayBeRisk: it.signal === "unknown" })),
    counts,
    riskPossible: items.filter((it) => it.signal === "unknown").length,
    hyRisk: hy === "risk" ? "met" : hy === "unknown" ? "unknown" : "unmet",
  };
}

/** the day's reading by quant's own stage rules (escapeStage, recoveryStage), as the judgment row keeps it */
export function assessedOf(items: readonly Grid11Item[], a: Record<string, Tri>, d: Record<string, Tri>, r: Record<string, Tri>): Assessed {
  const core = coreOf(items);
  const [ca, cd, cr] = [conditions(ESCAPE_A_RULES, a), conditions(ESCAPE_D_RULES, d), conditions(RECOVERY_RULES, r)];
  return { core, a: ca, d: cd, r: cr, escape: escapeStage(core, ca, cd), recovery: recoveryStage(cr, core, ca, cd) } as Assessed;
}

/**
 * One sample. `captureSrc` lets a probe pass real pictures of synthetic captures (the unit tests use a dot).
 */
export function deckFixture(kind: FixtureKind, captureSrc: (id: string) => { src: string; width: number; height: number } = () => ({ src: DOT_PNG, width: 1, height: 1 })): { spec: DeckSpec; data: DeckData } {
  const b = kind === "b";
  const c = kind === "c";
  const soxlBars = bars(7, 38);
  const koruBars = bars(19, 44);
  const soxlLast = soxlBars.at(-1)!.c;
  const koruLast = koruBars.at(-1)!.c;
  const soxlLv = levels(soxlBars);
  const koruLv = levels(koruBars);
  const lv = (l: ChartLevel[], k: string) => l.find((x) => x.kind === k)!.price;

  const figures: Record<string, DeckFigure> = {
    ust10y: fig(4.53, "rate", "fred", kind === "a" ? { conflict: { value: 4.51, source: "news" } } : {}),
    us2y_spread: fig(0.12, "pp", "fred"),
    // (c) 3.92: over A1's 3.5 but under D1's 4.0, as its statuses say (A1 met, D1 not)
    hy: fig(c ? 3.92 : 3.76, "spread", "fred", { asOf: "2026-11-25" }),
    vix: fig(c ? 27.4 : 24.1, "index", "cboe"),
    sp500: fig(6012.45, "index", "toss"),
    sp500_chg: fig(c ? -1.84 : 0.42, "pct", "toss"),
    ndx: fig(21304.9, "index", "toss"),
    ndx_chg: fig(c ? -2.31 : 0.61, "pct", "toss"),
    kospi: fig(2512.34, "index", "krx"),
    kospi_chg: fig(c ? -1.12 : -0.35, "pct", "krx"),
    usdkrw: fig(1398, "krw", "toss"),
    usdkrw_chg: fig(0.21, "pct", "toss"),
    wti: fig(68.4, "usd", "toss"),
    wti_chg: fig(-0.8, "pct", "toss"),
    gold: fig(2650.1, "usd", "toss"),
    gold_chg: fig(0.33, "pct", "toss"),
    nonarb: fig(-2.1, "count", "krx", { unit: "조원", digits: 1 }),
    foreign_kospi: fig(-8130, "count", "krx", { unit: "억원" }),
    unemployment: fig(4.3, "rate", "bls", { digits: 1, asOf: "2026-11-07" }),
    core_cpi: fig(b ? null : 0.1, "rate", "bls", { digits: 1, asOf: "2026-11-13" }),
    breadth: fig(52.4, "rate", "calc", { digits: 1 }),
    unknown11: fig(b ? 3 : 1, "count", "calc", { unit: "개" }),
    soxl: fig(round2(soxlLast), "usd", "toss"),
    soxl_sup: fig(lv(soxlLv, "support"), "usd", "calc"),
    soxl_res: fig(lv(soxlLv, "resistance"), "usd", "calc"),
    soxl_stop: fig(lv(soxlLv, "stop"), "usd", "calc"),
    koru: fig(round2(koruLast), "usd", "toss"),
    koru_sup: fig(lv(koruLv, "support"), "usd", "calc"),
    koru_res: fig(lv(koruLv, "resistance"), "usd", "calc"),
    koru_stop: fig(lv(koruLv, "stop"), "usd", "calc"),
    soxs: fig(8.12, "usd", "toss"),
    soxs_sup: fig(7.7, "usd", "calc"),
    soxs_res: fig(8.9, "usd", "calc"),
    soxs_stop: fig(7.3, "usd", "calc"),
    asp_decline: fig(-14, "pct", "calc", { digits: 1, estimate: true }),
    hbm_share: fig(38, "rate", "ir", { digits: 0, estimate: true }),
    conv_chg: fig(-21.5, "pct", "calc", { digits: 1, estimate: true }),
    blend_chg: fig(-11.6, "pct", "calc", { digits: 1, estimate: true }),
    prob_a: fig(25, "rate", "calc", { digits: 0, estimate: true }),
    prob_b: fig(50, "rate", "calc", { digits: 0, estimate: true }),
    prob_c: fig(25, "rate", "calc", { digits: 0, estimate: true }),
    amp_a: fig(1.5, "pm", "calc", { estimate: true }),
    amp_b: fig(2.5, "pm", "calc", { estimate: true }),
    amp_c: fig(4, "pm", "calc", { estimate: true }),
    ev_pce: fig(1.5, "pm", "calc", { estimate: true }),
    ev_ism: fig(1, "pm", "calc", { estimate: true }),
    ev_jobs: fig(2, "pm", "calc", { estimate: true }),
    ev_cpi: fig(2.5, "pm", "calc", { estimate: true }),
    ev_fomc: fig(3, "pm", "calc", { estimate: true }),
    ev_earn: fig(6, "pm", "calc", { estimate: true }),
    vix_th: fig(25, "index", "rule"),
    hy_th: fig(3.5, "spread", "rule", { digits: 1 }),
    ust_th: fig(5, "rate", "rule", { digits: 1 }),
    kospi_th: fig(2400, "index", "rule", { digits: 0 }),
    usdkrw_th: fig(1450, "krw", "rule"),
    breadth_th: fig(60, "rate", "rule", { digits: 0 }),
  };

  const sources: DeckData["sources"] = {
    fred: { name: "FRED", title: "미 국채·하이일드 시계열(합성)", publisher: "합성 데이터", date: "2026-11-26", url: "example.invalid/fred", grade: "A" },
    cboe: { name: "CBOE", title: "VIX 일별 종가(합성)", publisher: "합성 데이터", date: "2026-11-26", url: "example.invalid/cboe", grade: "A" },
    toss: { name: "토스증권", title: "시세 조회(합성)", publisher: "합성 데이터", date: "2026-11-26", url: "example.invalid/toss", grade: "A" },
    krx: { name: "KRX", title: "투자자별 매매동향(합성)", publisher: "합성 데이터", date: "2026-11-26", url: "example.invalid/krx", grade: "A" },
    bls: { name: "BLS", title: "고용·물가 발표(합성)", publisher: "합성 데이터", date: "2026-11-13", url: "example.invalid/bls", grade: "A" },
    ir: { name: "합성 IR", title: "분기 실적 자료(합성)", publisher: "합성 회사", date: "2026-10-30", url: "example.invalid/ir", grade: "B+" },
    news: { name: "합성 매체", title: "시장 기사(합성)", publisher: "합성 매체", date: "2026-11-26", url: "example.invalid/news", grade: "B" },
    calc: { name: "모시 계산", title: "모시 계산(합성 입력)", publisher: "모시", date: "2026-11-27", url: "example.invalid/calc", grade: "B" },
    rule: { name: "판정 규칙", title: "탈출·회복 판정 규칙", publisher: "모시", date: "2026-11-27", url: "example.invalid/rules", grade: "A" },
  };

  const pic = (id: string) => captureSrc(id);
  const captures: Record<string, DeckCapture> = {};
  const addCap = (id: string, outlet: string, account: string | undefined, h: number, g: DeckCapture["grade"]) => {
    const p = pic(id);
    captures[id] = capture(id, outlet, account, h, g, p.src, p.width, p.height);
  };
  addCap("cap-post", "합성 SNS", "@sample_analyst", 9, "B");
  if (!b) addCap("cap-reply", "합성 SNS", "@sample_reply", 8, "C");
  addCap("cap-broadcast", "합성 방송", "합성 경제 뉴스", 11, "B");
  addCap("cap-chart", "FRED", undefined, 10, "A");

  const VALUES = ["4.53%", "+0.12%p", c ? "+0.77%p" : "+0.41%p", "1.20%", "4.30%", "확인 불가", "52.4%", "하향 0/7", "−2.1조", "0.1%", c ? "2/4 < 20%" : "1/4 < 20%"];
  const BASIS = ["> 5%이면 위험", "> 0이면 위험", "6개월 최저 대비", "1개월 ≥ 5% 위험", "4.1% + 0.3%p", "−5% 초과 위험", "< 60%이면 위험", "전체 하향 시 위험", "순매도 지속", "MoM ≥ 0.3% 위험", "개별 < 20% 위험"];
  // (a)(b): CAPEX (no. 11, A6) is one company of four, a caution, and foreign selling (no. 9) the third risk → stage 2 holds
  // with A1 the one A met (DD 1704 2); (c): two of four, a risk, and A6 met
  const SIG = ["normal", "risk", c ? "risk" : "caution", "normal", "caution", "unknown", "risk", "normal", c ? "caution" : "risk", "normal", c ? "risk" : "caution"] as const;
  const NAMES = ["미국 10년물 금리", "2년물 − 기준금리 상단", "하이일드 스프레드", "엔화 절상률(엔캐리)", "미국 실업률", "삼전·하닉 이익 컨센서스", "S&P500 시장 폭", "M7 이익 전망", "외국인 코스피 순매매", "미국 근원 CPI", "빅테크 AI CAPEX"];
  // (b): two more missing beside the one every sample lacks (no. 6) → three 확인 불가; no. 10 is the core CPI the
  // figures also lack (core_cpi null, A4 확인 불가)
  const missing = new Set(b ? [9, 10] : []);
  // the grid says what a figure says when it has one (DD 1509 7): same id, same value, same day
  const FROM: Record<number, string> = { 0: "ust10y", 4: "unemployment", 6: "breadth", 8: "foreign_kospi", 9: "core_cpi" };
  const items: Grid11Item[] = NAMES.map((name, i) => {
    const gone = missing.has(i) || SIG[i] === "unknown";
    const f = FROM[i] != null ? figures[FROM[i]!]! : null;
    return {
      no: i + 1,
      name,
      signal: gone ? "unknown" : SIG[i]!,
      value: gone ? "확인 불가" : f ? figureText(f) : VALUES[i]!,
      basis: BASIS[i]!,
      asOf: gone ? "자료 없음" : `${f ? shortDay(f.asOf) : "11/26"} 기준`,
    };
  });

  // the conditions, each status what its value says (DD 1704 1): (a) stage 2 with A1 alone, recovery 1 with R2·R5·R6;
  // (b) A4 and A6 not read today (core CPI and CAPEX missing) → 최소 2단계; (c) A1·A2·A3·A6 and D3 → stage 3
  const vix = `VIX ${figureText(figures.vix!)}`;
  const aStatus: Record<string, Tri> = { A1: "met", A2: c ? "met" : "unmet", A3: c ? "met" : "unmet", A4: b ? "unknown" : "unmet", A5: "unmet", A6: b ? "unknown" : c ? "met" : "unmet", A7: "unmet", A8: "unmet" };
  const dStatus: Record<string, Tri> = { D1: "unmet", D2: "unmet", D3: c ? "met" : "unmet", D4: "unmet", D5: b ? "unknown" : "unmet" };
  const rStatus: Record<string, Tri> = { R1: "unmet", R2: "met", R3: "unmet", R4: "unmet", R5: b ? "unknown" : "met", R6: "met" };
  // A1 says the spread's level as the grid's no. 3 and the figure do (unsigned %p, DD 1520) and its rise over the low
  const hyLine = `${figureText(figures.hy!)} · 6개월 최저보다 ${VALUES[2]}`;
  const values: Record<string, string> = {
    A1: hyLine,
    A2: c ? `${vix} · 2일째` : vix,
    A3: c ? "200일선 아래 3일째" : "200일선 아래 2일째",
    A4: b ? "확인 불가" : `MoM ${figureText(figures.core_cpi!)}`,
    A5: `${figureText(figures.ust10y!)} · 0일`,
    A6: b ? "자료 없음" : VALUES[10]!,
    A7: "삼의 법칙 0.27 · 4주 평균 22.4만 건",
    A8: "200일선 위",
    D1: hyLine,
    D2: vix,
    D3: c ? "200일선 5.2% 아래" : "200일선 2.1% 아래",
    D4: "삼의 법칙 0.27",
    D5: b ? "자료 없음" : c ? "NFCI −0.31" : "NFCI −0.48",
    R1: c ? `${vix} · 0일` : `${vix} · 3일째`,
    R2: `${figureText(figures.hy!)} · 20거래일 최고보다 0.60%p 좁음`,
    R3: "200일선 아래",
    R4: `시장 폭 ${figureText(figures.breadth!)}`,
    R5: b ? "2년물 > 상단 · 근원 CPI 확인 불가" : `근원 CPI MoM ${figureText(figures.core_cpi!)}`,
    R6: "코스피 200일선 위",
  };
  // (b): the two inputs behind A4 and A6 did not come today (the app's caution reason)
  const missingToday = new Set<InputKey>(b ? ["coreCpiMoM", "capex"] : []);
  const stages = deckStages(assessedOf(items, aStatus, dStatus, rStatus), {
    values,
    scenario: c ? "C 침체 경계" : "B 둔화",
    ...(c ? { moved: "탈출 2단계 → 3단계" } : {}),
    sources: ["fred", "cboe", "bls", "krx", "rule"],
    missing: (k) => (missingToday.has(k) ? "today" : null),
  });

  const events: DeckEvent[] = [
    { at: "2026-11-27T22:30:00+09:00", title: "미국 10월 PCE", consensus: "0.2%", bull: "근원 0.2% 이하", bear: "근원 0.3% 이상", amplitudeRef: "ev_pce" },
    { at: "2026-12-01T09:00:00+09:00", title: "한국 11월 수출", consensus: null, bull: "반도체 +20% 이상", bear: "반도체 둔화", },
    { at: "2026-12-03T00:00:00+09:00", title: "ISM 제조업", consensus: "48.5", bull: "50 회복", bear: "47 아래", amplitudeRef: "ev_ism" },
    { at: "2026-12-05T22:30:00+09:00", title: "미국 11월 고용보고서", consensus: "15만 명", bull: "실업률 4.2% 이하", bear: "실업률 4.4% 이상", amplitudeRef: "ev_jobs" },
    { at: "2026-12-10T22:30:00+09:00", title: "미국 11월 CPI", consensus: "0.3%", bull: "근원 0.2%", bear: "근원 0.4%", amplitudeRef: "ev_cpi" },
    { at: "2026-12-11T04:00:00+09:00", title: "FOMC 금리 결정", consensus: "동결", bull: "인하 신호", bear: "점도표 상향", amplitudeRef: "ev_fomc" },
    { at: "2026-12-17T06:00:00+09:00", title: "반도체 B 실적", consensus: null, bull: "가이던스 상향", bear: "재고 증가", amplitudeRef: "ev_earn" },
    { at: "2026-12-19T15:30:00+09:00", title: "선물·옵션 동시 만기", consensus: null, bull: null, bear: "프로그램 매도 출회", },
  ];

  const flowsOf = (seed: number, label: string) => ({
    chart: { days: flowDays(seed), summary: `최근 20거래일 ${label} 수급(합성)`, unit: "단위 억원", asOf: "11월 26일 기준", source: "KRX · 합성" },
    threshold: { title: "D7 숏커버 임계", formula: "P/P0 = 1.40 × (1 − e)", value: c ? "지금 1.08 · 임계 1.32" : "지금 1.18 · 임계 1.32" },
    criteria: SHORT_COVER_RULES.map((r, i) => ({ rule: r.rule, status: (b && i === 1 ? "unknown" : i === 0 || i === 3 ? "met" : "unmet") as Tri, value: b && i === 1 ? "자료 없음" : ["3일째 순매수", "20일 전보다 −0.4%p", "되돌림 18%", "비차익 3일째 순매수", "하닉 순매도"][i]! })),
    sources: ["krx"],
  });

  const data: DeckData = {
    title: "11월 27일 일일 심층판",
    asOf: FIXTURE_AS_OF,
    generatedAt: FIXTURE_AS_OF + 12 * 60_000,
    figures,
    words: { escape_label: headPhrase(stages.escape.head), recovery_label: headPhrase(stages.recovery.head) },
    sources,
    captures,
    core11: { items, sources: ["fred", "cboe", "bls", "krx", "calc"] },
    stages,
    flows: { KOSPI: flowsOf(5, "코스피"), 삼성전자: flowsOf(23, "삼성전자") },
    charts: {
      SOXL: { input: { bars: soxlBars, levels: soxlLv, summary: "SOXL 60거래일 레벨 차트(합성)", unit: "단위 달러", asOf: "11월 26일 종가", source: "토스증권 · 합성", currency: "USD" }, sources: ["toss", "calc"] },
      KORU: { input: { bars: koruBars, levels: koruLv, summary: "KORU 60거래일 레벨 차트(합성)", unit: "단위 달러", asOf: "11월 26일 종가", source: "토스증권 · 합성", currency: "USD" }, sources: ["toss", "calc"] },
    },
    valuation: {
      "반도체 A": {
        methods: [
          { name: "고든 ROE", value: -18.2 },
          { name: "정상 PER", value: -12.5 },
          { name: "PBR 밴드", value: -9.8 },
          { name: "EV/EBITDA", value: -15.1 },
        ],
        unit: "%",
        digits: 1,
        asOf: "11월 26일 종가",
        source: "합성 IR · 모시 계산",
        heroRef: "asp_decline",
        heroLabel: "내재 ASP 하락률",
        sources: ["ir", "calc"],
      },
    },
    events: { list: events, asOf: "11월 26일 08:00 기준", source: "각 기관 일정 · 합성", sources: ["bls", "news"] },
  };

  const spec: DeckSpec = {
    sections: ["결론", "이슈", "지표", "펀더멘털", "수급", "레벨", "대응", "부록"],
    summary: [
      c ? "{escape_label}로 올라갔어요." : "{escape_label}를 이어 가요.",
      "하이일드 스프레드는 {hy}이고 VIX는 {vix}예요.",
      "외국인은 코스피에서 {foreign_kospi}를 순매도했어요.",
      b ? "확인 불가 지표가 {unknown11}라 판정의 근거가 얇아요." : "반도체 A의 내재 ASP 하락률은 {asp_decline}로 계산돼요.",
    ],
    slides: [
      {
        kind: "hero",
        kicker: "11월 27일 일일 심층판",
        headline: c ? "탈출 단계가 한 칸 올라 방어 준비 단계예요" : "신용 경계는 그대로, 반도체는 바닥을 시험 중",
        lead: c ? "하이일드가 {hy}로 넓어지고 VIX가 {vix}에 닿아 악화 신호가 하나 더 켜졌어요." : "하이일드 스프레드가 {hy}로 올라 경계가 이어지고, 반도체 수급은 외국인 매도가 줄어드는 쪽이에요.",
        highlight: c ? "방어 준비 단계" : "경계가 이어지고",
        mark: true,
      },
      {
        kind: "numbers3",
        section: "결론",
        kicker: "오늘의 결론",
        headline: "세 숫자가 오늘의 판정을 정해요",
        items: [
          { ref: "hy", label: "하이일드", note: "6개월 최저보다 넓어진 채예요" },
          { ref: "vix", label: "VIX", note: c ? "경계선 위로 올라섰어요" : "경계선 아래에 머물러요" },
          { ref: "ust10y", label: "미 10년물", note: "위험선까지 여유가 있어요" },
        ],
      },
      { kind: "signal-board", section: "결론", kicker: "단계 판정", headline: c ? "탈출은 방어 준비, 회복은 아직 바닥" : "탈출은 경계, 회복은 바닥 탐색", note: b ? "확인 불가 조건이 풀리면 탈출 단계가 정해져요." : "단계는 매일 아침 다시 판정해요." },
      {
        kind: "issue+capture",
        section: "이슈",
        kicker: "핵심 이슈",
        headline: "신용 우려가 다시 퍼지고 있어요",
        captures: [
          { assetId: "cap-post", caption: "신용 스프레드 확대를 짚은 게시물(합성)" },
          { assetId: "cap-reply", caption: "같은 글에 달린 반박 답글(합성)" },
        ],
        points: [
          { label: "사실", text: "하이일드 스프레드가 {hy}로 넓어졌어요.", grade: "A" },
          { label: "반박", text: "부도율은 아직 오르지 않았다는 답글이 있어요.", grade: "C" },
          { label: "판정", text: "스프레드는 사실이고, 부도 확산은 확인되지 않았어요.", grade: "B" },
        ],
      },
      {
        kind: "issue+capture",
        section: "이슈",
        kicker: "핵심 이슈",
        headline: "방송에서도 같은 걱정을 다뤘어요",
        captures: [{ assetId: "cap-broadcast", caption: "신용 시장을 다룬 방송 화면(합성)" }],
        points: [
          { label: "사실", text: "방송은 회사채 발행이 줄었다고 전했어요.", grade: "B" },
          { label: "판정", text: "발행 감소는 공시 자료로 다시 확인할 일이에요.", grade: "B" },
        ],
      },
      {
        kind: "numbers3",
        section: "이슈",
        kicker: "숫자로 보는 이슈",
        headline: "수급은 아직 매도 쪽이에요",
        items: [
          { ref: "foreign_kospi", label: "외국인", note: "코스피에서 순매도했어요" },
          { ref: "nonarb", label: "비차익", note: "프로그램 매도가 이어졌어요" },
          { ref: "usdkrw", label: "달러/원", note: "원화 약세가 이어져요" },
        ],
      },
      {
        kind: "issue+capture",
        section: "이슈",
        kicker: "핵심 이슈",
        headline: "스프레드 추세는 넓어지는 쪽이에요",
        captures: [{ assetId: "cap-chart", caption: "하이일드 스프레드 추이 차트(합성)" }],
        points: [
          { label: "사실", text: "스프레드는 {hy}로 석 달 사이 가장 넓어요.", grade: "A" },
          { label: "판정", text: "추세는 넓어지는 쪽이고 아직 위험선 아래예요.", grade: "B" },
        ],
      },
      {
        kind: "table",
        section: "지표",
        kicker: "지수·자산 총괄",
        headline: "위험자산은 엇갈리고 달러는 강해요",
        columns: [
          { key: "asset", label: "자산" },
          { key: "value", label: "값", align: "right" },
          { key: "chg", label: "전일 대비", align: "right" },
        ],
        rows: [
          { asset: "S&P 500", value: "{sp500}", chg: "{sp500_chg}" },
          { asset: "나스닥 100", value: "{ndx}", chg: "{ndx_chg}" },
          { asset: "코스피", value: "{kospi}", chg: "{kospi_chg}" },
          { asset: "달러/원", value: "{usdkrw}", chg: "{usdkrw_chg}" },
          { asset: "WTI", value: "{wti}", chg: "{wti_chg}" },
          { asset: "금", value: "{gold}", chg: "{gold_chg}" },
        ],
        highlightRow: 2,
      },
      { kind: "grid11", section: "지표", kicker: "핵심 11지표", headline: b ? "확인 불가 셋이 판정을 흐려요" : c ? "위험 넷, 경계 둘이 켜져 있어요" : "위험 셋, 경계 셋이 켜져 있어요" },
      {
        kind: "table",
        section: "지표",
        kicker: "임계까지 거리",
        headline: "위험선에 가까운 지표는 둘이에요",
        columns: [
          { key: "name", label: "지표" },
          { key: "now", label: "지금", align: "right" },
          { key: "th", label: "임계", align: "right" },
          { key: "read", label: "읽기" },
        ],
        rows: [
          { name: "미 10년물", now: "{ust10y}", th: "{ust_th}", read: "여유 있음" },
          { name: "하이일드", now: "{hy}", th: "{hy_th}", read: "임계 위" },
          { name: "VIX", now: "{vix}", th: "{vix_th}", read: c ? "임계 위" : "임계 근처" },
          { name: "시장 폭", now: "{breadth}", th: "{breadth_th}", read: "임계 아래" },
          { name: "코스피", now: "{kospi}", th: "{kospi_th}", read: "여유 있음" },
          { name: "달러/원", now: "{usdkrw}", th: "{usdkrw_th}", read: "여유 있음" },
        ],
      },
      { kind: "gauges", section: "지표", kicker: "탈출 조건 A", headline: c ? "악화 신호가 넷으로 늘었어요" : "악화 신호는 하나가 켜져 있어요", focus: "escape", note: c ? "다음으로 켜질 수 있는 것은 D1과 D2예요." : "다음으로 켜질 수 있는 것은 A2와 A3예요." },
      { kind: "gauges", section: "지표", kicker: "회복 조건 R", headline: b ? "회복 신호는 아직 둘이에요" : "회복 신호는 아직 셋이에요", focus: "recovery", note: "R3가 켜지기 전에는 추세 회복으로 보지 않아요." },
      { kind: "roe-pbr", section: "펀더멘털", kicker: "펀더멘털 역산", headline: "주가는 ASP 하락을 미리 반영했어요", company: "반도체 A", notes: ["네 방법 모두 하락을 가리켜요.", "고든 ROE 방법이 가장 비관적이에요."] },
      {
        kind: "table",
        section: "펀더멘털",
        kicker: "ASP 분해",
        headline: "범용 가격 하락이 대부분이에요",
        columns: [
          { key: "item", label: "항목" },
          { key: "v", label: "값", align: "right" },
          { key: "note", label: "읽기" },
        ],
        rows: [
          { item: "HBM 비중", v: "{hbm_share}", note: "분기 자료 기준" },
          { item: "범용 가격 변화", v: "{conv_chg}", note: "역산한 값" },
          { item: "혼합 ASP 변화", v: "{blend_chg}", note: "두 값을 섞은 값" },
          { item: "내재 하락률", v: "{asp_decline}", note: "주가가 반영한 값" },
        ],
        highlightRow: 3,
      },
      {
        kind: "numbers3",
        section: "펀더멘털",
        kicker: "역산 결론",
        headline: "가격이 반영한 하락은 깊어요",
        items: [
          { ref: "asp_decline", label: "내재 하락률", note: "네 방법의 가운데 값이에요" },
          { ref: "hbm_share", label: "HBM 비중", note: "분기 자료로 추정했어요" },
          { ref: "conv_chg", label: "범용 가격", note: "혼합 값에서 되짚었어요" },
        ],
      },
      { kind: "flows", section: "수급", kicker: "코스피 수급", headline: "외국인 매도는 줄고 있어요", symbol: "KOSPI", notes: ["외국인 매도 폭이 지난주보다 줄었어요.", "비차익은 사흘째 순매수예요."] },
      { kind: "flows", section: "수급", kicker: "삼성전자 수급", headline: "숏커버 기준은 둘만 켜졌어요", symbol: "삼성전자", notes: ["보유율은 아직 회복하지 않았어요."] },
      { kind: "level-chart", section: "레벨", kicker: "SOXL 레벨", headline: "SOXL은 지지선 위에서 버텨요", symbol: "SOXL", note: "지지는 20일선, 저항은 직전 고점이에요" },
      { kind: "level-chart", section: "레벨", kicker: "KORU 레벨", headline: "KORU는 매수 검토 구간 위예요", symbol: "KORU", note: "손절선은 직전 저점 아래예요" },
      {
        kind: "table",
        section: "레벨",
        kicker: "ETF 레벨 요약",
        headline: "세 ETF 모두 손절선 위에 있어요",
        columns: [
          { key: "etf", label: "ETF" },
          { key: "now", label: "현재가", align: "right" },
          { key: "sup", label: "지지", align: "right" },
          { key: "res", label: "저항", align: "right" },
          { key: "stop", label: "손절", align: "right" },
        ],
        rows: [
          { etf: "SOXL", now: "{soxl}", sup: "{soxl_sup}", res: "{soxl_res}", stop: "{soxl_stop}" },
          { etf: "KORU", now: "{koru}", sup: "{koru_sup}", res: "{koru_res}", stop: "{koru_stop}" },
          { etf: "SOXS", now: "{soxs}", sup: "{soxs_sup}", res: "{soxs_res}", stop: "{soxs_stop}" },
        ],
      },
      {
        kind: "scenarios",
        section: "대응",
        kicker: "시나리오",
        headline: "둔화가 가장 그럴듯해요",
        cols: [
          { name: "A 연착륙", ...(b ? {} : { probRef: "prob_a" }), triggers: ["고용 둔화가 완만해요", "근원 물가가 내려와요"], amplitudeRef: "amp_a" },
          { name: "B 둔화", ...(b ? {} : { probRef: "prob_b" }), triggers: ["실업률이 천천히 올라요", "기업 이익 전망이 낮아져요", "스프레드가 더 넓어져요"], amplitudeRef: "amp_b" },
          { name: "C 침체", ...(b ? {} : { probRef: "prob_c" }), triggers: ["삼의 법칙이 켜져요", "하이일드가 위험선을 넘어요"], amplitudeRef: "amp_c" },
        ],
      },
      { kind: "timeline", section: "대응", kicker: "이벤트 타임라인", headline: "다음 달 중순까지 큰 일정이 여덟이에요" },
      {
        kind: "risks",
        section: "대응",
        kicker: "반증 조건",
        headline: "이 판정이 틀리는 네 가지 경우",
        items: [
          { text: "VIX가 임계 아래로 닷새 머물면 경계를 거둬요", ref: "vix", thresholdRef: "vix_th" },
          { text: "하이일드가 임계 아래로 내려오면 신용 우려가 줄어요", ref: "hy", thresholdRef: "hy_th" },
          { text: "시장 폭이 임계를 넘으면 상승이 넓어진 거예요", ref: "breadth", thresholdRef: "breadth_th" },
          { text: "미 10년물이 임계를 넘으면 금리 부담이 커져요", ref: "ust10y", thresholdRef: "ust_th" },
        ],
      },
      {
        kind: "if-then",
        section: "대응",
        kicker: "조건 분기",
        headline: "조건이 바뀌면 이렇게 봐요",
        rows: [
          { if: "VIX가 임계 위로 오르면", then: "레버리지 신규 진입 보류를 검토", basis: "탈출 단계 규칙" },
          { if: "하이일드가 더 넓어지면", then: "현금 비중 점검을 검토", basis: "A1 조건" },
          { if: "외국인 순매수가 사흘 이어지면", then: "숏커버 여부를 관찰", basis: "D8 기준" },
          { if: "SOXL이 지지선 아래로 내려가면", then: "손절 규칙대로 관찰", basis: "레벨 차트" },
          { if: "CPI가 예상보다 높으면", then: "금리 민감 자산 비중 점검", basis: "A4 조건" },
        ],
      },
      {
        kind: "appendix",
        section: "부록",
        kicker: "부록 A",
        headline: "상세 수치 하나",
        columns: [
          { key: "k", label: "지표" },
          { key: "v", label: "값", align: "right" },
          { key: "n", label: "비고" },
        ],
        rows: [
          { k: "미 10년물", v: "{ust10y}", n: "일별 종가" },
          { k: "2년물 스프레드", v: "{us2y_spread}", n: "기준금리 상단 대비" },
          { k: "하이일드", v: "{hy}", n: "하루 늦게 나와요" },
          { k: "VIX", v: "{vix}", n: "일별 종가" },
          { k: "실업률", v: "{unemployment}", n: "월간 발표" },
          { k: "근원 CPI", v: "{core_cpi}", n: "전월 대비" },
          { k: "시장 폭", v: "{breadth}", n: "200일선 위 비율" },
          { k: "외국인 순매매", v: "{foreign_kospi}", n: "코스피" },
          { k: "비차익", v: "{nonarb}", n: "코스피" },
        ],
      },
      {
        kind: "appendix",
        section: "부록",
        kicker: "부록 A",
        headline: "상세 수치 둘",
        columns: [
          { key: "k", label: "종목" },
          { key: "v", label: "현재가", align: "right" },
          { key: "s", label: "손절", align: "right" },
        ],
        rows: [
          { k: "SOXL", v: "{soxl}", s: "{soxl_stop}" },
          { k: "KORU", v: "{koru}", s: "{koru_stop}" },
          { k: "SOXS", v: "{soxs}", s: "{soxs_stop}" },
          { k: "S&P 500", v: "{sp500}", s: "—" },
          { k: "나스닥 100", v: "{ndx}", s: "—" },
          { k: "WTI", v: "{wti}", s: "—" },
          { k: "금", v: "{gold}", s: "—" },
        ],
      },
      { kind: "sources", section: "부록", kicker: "부록 B", headline: "출처" },
      { kind: "disclaimer", kicker: "면책", headline: "읽기 전에 알아 둘 것", playbook: false },
    ],
  };
  return { spec, data };
}
