import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { APP_BOARD, DISCLAIMER, gaugeSvg, gaugeText, SIGNAL_SHAPES, SIGNAL_VIEWBOX, SIGNAL_WORD, UNKNOWN_TEXT, type GaugeKind, type Signal } from "@pickle/quant";
import type { InvestStageGauge, InvestStageHead, InvestStages } from "@pickle/protocol";
import { copy, glued } from "./Text";
import "./Invest.css";

/**
 * 투자's shared parts (DD 1935 §0-4, §1, §0-7). Numbers arrive already formatted by @pickle/quant's formatter (the one
 * the server and the deck use), so no screen formats a number of its own.
 *
 *   <SignalMark signal="risk" />              the mark alone (1em, aria-hidden; the word beside it speaks)
 *   <SignalLabel signal="caution" />          mark + word (경계), both in the signal's colour
 *   <InvestNum value="+2.31%" />             a formatted number, tabular; null → the 확인 불가 mark + words
 *   <IvRows><IvRow label="현재가" value="$32.57" /></IvRows>
 *   <IvFoot>관측 11월 27일 00:45(미 동부 10:45) · 토스증권 · A</IvFoot>
 *   <IvDisclaimer />                         the fixed sentence, word for word, once per message
 *   <IvHero value="$32.57" />                the card's one big number
 *   <ModeWord mode="real" />                 모의 (--label-2) / 실제 (--danger), text only
 *   <IvStages stages={overview.stages} />    the stage board: heads, three gauge rows, the next steps (or one line)
 *   <IvStageHead heads={[e, r]} judged="…" />  the board's head alone (a report's §1, the daily card)
 *   <IvGaugeRows gauges={[w, d]} />          gauge rows alone (a report's §4; IvGaugeRow for one, §5)
 */

/** the signal's shape from the shared set (the deck draws the same SVG) */
export function SignalMark({ signal, className }: { signal: Signal; className?: string }) {
  return (
    <svg
      className={`sigmark ${className ?? ""}`}
      viewBox={SIGNAL_VIEWBOX}
      aria-hidden="true"
      data-signal={signal}
      dangerouslySetInnerHTML={{ __html: SIGNAL_SHAPES[signal] }}
    />
  );
}

/** the mark and its word together: 위험, 경계, 정상, 확인 불가 */
export function SignalLabel({ signal, className }: { signal: Signal; className?: string }) {
  return (
    <span className={`ivsig ${className ?? ""}`} data-signal={signal}>
      <SignalMark signal={signal} />
      {SIGNAL_WORD[signal]}
    </span>
  );
}

/** a number from the shared formatter, tabular; missing → 확인 불가 with its mark, in the number's place (never 0 or "-") */
export function InvestNum({ value, className }: { value: string | null | undefined; className?: string }) {
  if (value == null || value === "")
    return (
      <span className={`ivsig ivunknown ${className ?? ""}`} data-signal="unknown">
        <SignalMark signal="unknown" />
        {UNKNOWN_TEXT}
      </span>
    );
  return <span className={`tnum ${className ?? ""}`}>{figure(value)}</span>;
}

/** a short bracketed part: "(미 동부 10:47)", "(추정, 관측가 기준)" */
const GROUP = /\([^()]{1,24}\)/;
/** an estimate's tail: "(추정)", "(추정, 관측가 기준)" */
const EST_TAIL = /^\(추정[,)]/;

/**
 * one item of a figure: a bracketed part is one box, so a line breaks before its "(" or not at all (DD 2131 ③:
 * "00:47(미 동부 / 10:47)" at 320, text size 130 %); an estimate's tail, "(추정)" or "(추정, …)", is that box in
 * --label-2 (DD 2224, 2131 ③: "약 $1,204.14(추정, 관측가 기준)")
 */
function piece(text: string): ReactNode {
  const m = GROUP.exec(text);
  if (!m || m[0].length === text.length) return glued(text);
  const pre = text.slice(0, m.index);
  const post = text.slice(m.index + m[0].length);
  return (
    <>
      {pre && glued(pre)}
      <span className={!post && EST_TAIL.test(m[0]) ? "ivest" : "ivgroup"}>{m[0]}</span>
      {post && glued(post)}
    </>
  );
}

/**
 * a formatted figure: each " · " item one box, the dot ending the item before (DD 2225 I2: "악화 2/8 · 심각 0/5 ·
 * 회복 / 3/6" at 320, text size 130 %), so a line breaks after a " · " or before a bracketed part; inside a box only
 * when it is wider than the whole line
 */
function figure(value: string): ReactNode {
  const items = value.split(" · ");
  if (items.length === 1) return piece(value);
  return items.map((it, i) => (
    <Fragment key={i}>
      {i > 0 && " "}
      <span className="ivitem">
        {piece(it)}
        {i < items.length - 1 && " ·"}
      </span>
    </Fragment>
  ));
}

/** a card's group of rows: a hairline and 12px above, 6px between rows */
export function IvRows({ children }: { children: ReactNode }) {
  return <div className="ivrows">{children}</div>;
}

/** one row: the word left, the value right (a formatted string, or a node such as a SignalLabel) */
export function IvRow({ label, value }: { label: string; value: string | null | ReactNode }) {
  return (
    <div className="ivrow">
      <span className="ivrow-label">{label}</span>
      <span className="ivrow-value">{typeof value === "string" || value == null ? <InvestNum value={value as string | null} /> : value}</span>
    </div>
  );
}

/** a short bracketed part with the " ·" after it: "(미 동부 10:45) ·" */
const FOOT_GROUP = /\([^()]{1,24}\)(?: ·)?/;

/**
 * the card's foot line: observed time and source (dates and times kept whole by the app's ties). A bracketed part and
 * the " ·" after it are one box (DD 2224: "미 동부 / 10:45)" at 320, text size 130 %), so a line breaks before "(" or
 * after " · ", never inside it.
 */
export function IvFoot({ children }: { children: string }) {
  const m = FOOT_GROUP.exec(children);
  if (!m) return <p className="ivfoot">{glued(children)}</p>;
  const pre = children.slice(0, m.index);
  const post = children.slice(m.index + m[0].length);
  return (
    <p className="ivfoot">
      {pre && glued(pre)}
      <span className="ivfoot-tie">{m[0]}</span>
      {post && glued(post, m[0])}
    </p>
  );
}

/** the fixed closing sentence (A17 = FA9's first), word for word from @pickle/quant; never written by the model */
export function IvDisclaimer() {
  return <p className="ivdisclaimer">{DISCLAIMER}</p>;
}

/** the card's one big number */
export function IvHero({ value }: { value: string | null }) {
  return <div className="ivhero">{value == null ? <InvestNum value={null} /> : figure(value)}</div>;
}

/** 모의 / 실제 as a word (13/600), no chip */
export function ModeWord({ mode }: { mode: "mock" | "real" }) {
  return (
    <span className="ivmode" data-mode={mode}>
      {mode === "real" ? "실제" : "모의"}
    </span>
  );
}

// ───────────────────────────── the stage board (DD 0059 §1-3, DD 0426 §1, DD 0428, DD 0141) ─────────────────────────────

/** what ① says when it has no board it can draw: an older server's stages, or a kind this app does not know (DD 0426 §3) */
export const STAGE_UNKNOWN = "아직 판정이 없어요. 매일 오전 8시에 판정해요.";

/** a stage line's unsettled part: quiet when nothing could be had yet, else the half-circle in --caution (DD 0426 §1) */
function Pending({ text, tone }: { text: string; tone?: InvestStageHead["pendingTone"] }) {
  if (tone === "quiet") return <p className="ivstage-quiet t-copy">{copy(text)}</p>;
  return <Caution text={text} />;
}

/** boxes joined by spaces: the line breaks only between them, each box whole while it fits a line (wider, it wraps inside) */
function Boxes({ parts }: { parts: readonly string[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          <span className="ivstage-part">{p}</span>
        </Fragment>
      ))}
    </>
  );
}

/**
 * "11월 27일 08:00 판정 · 회복 0 → 1단계": a line that breaks only after a " · ", each part whole while it fits a line
 * (320 × 130 % split "회복 0 / → 1단계" as running copy)
 */
function Parts({ text }: { text: string }) {
  const parts = text.split(" · ");
  return <Boxes parts={parts.map((p, i) => (i < parts.length - 1 ? `${p} ·` : p))} />;
}

/**
 * A next line's parts (DD 1719 1): "회복 2단계까지:", then each clause with its comma — it breaks only after ": " and
 * ", ", the way the judgment line does after " · " (320 × 130 % split "회복 신호 / 2개 더" and "2개 / 더(R3 포함)").
 */
export function nextParts(line: string): string[] {
  const i = line.indexOf(": ");
  const head = i < 0 ? [] : [line.slice(0, i + 1)];
  const body = (i < 0 ? line : line.slice(i + 2)).split(", ");
  return [...head, ...body.map((c, k) => (k < body.length - 1 ? `${c},` : c))];
}

/** the half-circle in --caution and a sentence (subhead, --label): an unsettled stage, a missed 08:00 reading */
function Caution({ text }: { text: string }) {
  return (
    <p className="ivstage-caution">
      <SignalMark signal="caution" />
      <span className="t-copy">{copy(text)}</span>
    </p>
  );
}

/**
 * The board's head (DD 0059 §1-3): a row per stage, 탈출 2단계 (title3) with its name beside it (body, --label-2; the
 * name moves to the next line whole when it does not fit). An unsettled stage (탈출 최소 3단계, 회복 판정 보류) has no
 * name and says why right under its own row, once. Under the rows the judgment line, or in its place what was missed.
 */
export function IvStageHead({ heads, judged, stale }: { heads: InvestStageHead[]; judged?: string; stale?: string }) {
  return (
    <div className="ivstage-heads">
      {heads.map((h, i) => (
        <div key={i} className="ivstage-head">
          <p className="ivstage-line">
            <span className="ivstage-text">{h.text}</span>
            {h.name && !h.floor && h.stage != null && (
              <>
                {" "}
                <span className="ivstage-name">{h.name}</span>
              </>
            )}
          </p>
          {h.pending && <Pending text={h.pending} tone={h.pendingTone} />}
        </div>
      ))}
      {stale ? <Caution text={stale} /> : judged ? (
        <p className="ivstage-judged">
          <Parts text={judged} />
        </p>
      ) : null}
    </div>
  );
}

const GAUGE_KIND: Readonly<Record<InvestStageGauge["key"], GaugeKind>> = { worse: "escape", severe: "severe", recover: "recovery" };

/** quant's cells for a gauge (APP_BOARD); counts that do not add up draw none: the words and the count only */
function gaugeBar(kind: GaugeKind, met: number, unknown: number, of: number): { svg: string; width: number } | null {
  try {
    return gaugeSvg(kind, { met, unknown, of }, APP_BOARD);
  } catch {
    return null;
  }
}

/**
 * Gauge rows (DD 0059 §1-3, DD 0141): each 악화 신호, quant's cells (APP_BOARD), 3/8 and `· 확인 불가 1`. While every
 * row fits one line the cells sit between the word and the count; else in every row they go to the line under the
 * word and the count, so the rows of a board keep one shape. Decided on measured widths (each word, count and bar
 * against the rows' width), read again whenever the rows or a text change size. ① draws three; a report's §4 two, §5 one.
 */
export function IvGaugeRows({ gauges }: { gauges: InvestStageGauge[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  const shape = gauges.map((g) => `${g.key}:${g.met}/${g.unknown}/${g.of}:${g.label}`).join(",");
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const rows = [...el.querySelectorAll<HTMLElement>(":scope > .ivgauge")];
    const check = () => {
      const room = el.getBoundingClientRect().width;
      setStacked(
        rows.some((r) => {
          const bar = r.querySelector<HTMLElement>(".ivgauge-bar");
          if (!bar) return false;
          const gap = parseFloat(getComputedStyle(r).columnGap) || 0;
          const [word, tail] = [".ivgauge-word", ".ivgauge-tail"].map((q) => r.querySelector<HTMLElement>(q)?.getBoundingClientRect().width ?? 0);
          return word! + gap + Number(bar.dataset.w) + gap + tail! > room + 0.5;
        }),
      );
    };
    check();
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    });
    ro.observe(el);
    for (const t of el.querySelectorAll(".ivgauge-word, .ivgauge-tail")) ro.observe(t);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [shape]);
  return (
    <div ref={box} className={`ivgauges${stacked ? " is-stacked" : ""}`}>
      {gauges.map((g) => (
        <GaugeRow key={g.key} gauge={g} />
      ))}
    </div>
  );
}

/** one gauge row alone (a report's §5): the rows' measuring with one row */
export function IvGaugeRow({ gauge }: { gauge: InvestStageGauge }) {
  return <IvGaugeRows gauges={[gauge]} />;
}

/** the row as read: quant's sentence, 악화 신호 8개 중 3개 충족, 확인 불가 1개; the drawn parts are hidden */
function GaugeRow({ gauge }: { gauge: InvestStageGauge }) {
  const kind = GAUGE_KIND[gauge.key] ?? "escape";
  const { met, unknown, of } = gauge;
  const bar = useMemo(() => gaugeBar(kind, met, unknown, of), [kind, met, unknown, of]);
  return (
    <div className="ivgauge" role="img" aria-label={gaugeText(kind, { met, unknown, of })} data-gauge={gauge.key}>
      <span className="ivgauge-word" aria-hidden="true">
        {gauge.label}
      </span>
      {bar && <span className="ivgauge-bar" aria-hidden="true" data-w={bar.width} style={{ width: bar.width }} dangerouslySetInnerHTML={{ __html: bar.svg }} />}
      <span className="ivgauge-tail" aria-hidden="true">
        <span className="ivgauge-n tnum">{`${met}/${of}`}</span>
        {unknown > 0 && <span className="ivgauge-unknown">{` · 확인 불가 ${unknown}`}</span>}
      </span>
    </div>
  );
}

/** a judged board this app can draw: both heads and the gauges (an older server's judged board is drawn as none) */
const drawable = (s: InvestStages | null | undefined): s is Extract<InvestStages, { kind: "judged" }> =>
  s?.kind === "judged" && !!s.escape?.text && !!s.recovery?.text && Array.isArray(s.gauges) && Array.isArray(s.next);

/**
 * ① 시장 단계's board (DD 0059 §1-3): the head, the three gauge rows, and the next steps (footnote, --label-2). With no
 * judgment (off, none, a kind this app does not know) one line in the server's words, --label-2: no gauges, no next.
 */
export function IvStages({ stages }: { stages: InvestStages | null | undefined }) {
  if (!drawable(stages)) {
    const line = stages?.kind === "off" ? stages.off : stages?.kind === "none" ? stages.none : STAGE_UNKNOWN;
    return <p className="ivstage-empty t-copy">{copy(line || STAGE_UNKNOWN)}</p>;
  }
  return (
    <div className="ivstages">
      <IvStageHead heads={[stages.escape, stages.recovery]} judged={stages.judgedText} stale={stages.stale} />
      <IvGaugeRows gauges={stages.gauges} />
      {stages.next.length > 0 && (
        <div className="ivstage-next">
          {stages.next.map((n, i) => (
            <p key={i} className="t-copy">
              <Boxes parts={nextParts(n)} />
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
