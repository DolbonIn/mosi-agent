import type { BriefingCard as Briefing, CardAction, ID, MessengerCard as Messenger, ResultListCard, ScheduleCard as Schedule, WeatherCard as Weather } from "@pickle/protocol";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useId, useRef, useState } from "react";
import * as ep from "../../../api/endpoints";
import { useTurnRunning } from "../../../api/store";
import { island } from "../../../app/island";
import { nav } from "../../../app/nav";
import { t } from "../../../motion/springs";
import { Icon } from "../../../ui/Icon";
import { ListRow } from "../../../ui/List";
import { useTierValue } from "../../../motion/tier";
import { copy, emWidth, useWidth } from "../../../ui/Text";
import { Toggle } from "../../../ui/Toggle";
import { createStore, useStore } from "../../../lib/createStore";
import { MessengerThreadCard } from "./MessengerThreadCard";

/** Paper cards for read-only results: briefing, weather, results list, messenger, schedule. */

/** schedules removed with the undo banner (the card then says so instead of offering a toggle) */
const undone = createStore<ReadonlySet<string>>(new Set());
export function markScheduleUndone(id: string) {
  undone.set((s) => new Set([...s, id]));
}

/** Run a card action: `send` posts it as the person's reply (no typing); `open` navigates. */
export function runAction(a: CardAction, send: (text: string) => void) {
  if (a.send) return send(a.send);
  if (!a.open) return;
  const target = a.open;
  if (target === "explore" || target === "archive" || target === "profile" || target === "chat") nav.setTab(target);
  else nav.push(target, undefined, { title: a.label });
}

/**
 * Briefing (empty-thread A): the rows ARE the buttons — no chips repeating them, no icon plates (a text-size glyph in
 * label-2). A `send` row posts its words as the person's reply at once; an `open` row navigates (chevron). The picked
 * row rests in label-2 until its answer lands (no double send) while the others stay live — a row tapped during a
 * running turn is steered into it like any composer message (critique P2-2).
 */
export function BriefingCard({ card, threadId, onSend, interactive }: { card: Briefing; threadId: ID; onSend: (text: string) => void; interactive: boolean }) {
  const titleId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const running = useTurnRunning(threadId);
  const ran = useRef(false);
  useEffect(() => {
    if (!picked) return;
    if (running) {
      ran.current = true;
      return;
    }
    if (ran.current) {
      // the turn it started (or was steered into) has ended: its answer is in
      ran.current = false;
      setPicked(null);
      return;
    }
    // no turn ever started (busy, rejected, offline): live again after a moment
    const id = setTimeout(() => !ran.current && setPicked(null), 4000);
    return () => clearTimeout(id);
  }, [picked, running]);

  const run = (a: CardAction) => {
    if (a.send) {
      if (picked === a.label) return;
      ran.current = false;
      setPicked(a.label);
    }
    runAction(a, onSend);
  };

  return (
    <section className="ccard ccard-briefing" aria-labelledby={titleId}>
      <h3 className="ccard-title brief-title" id={titleId}>
        {card.title}
      </h3>
      <div className="brief-rows">
        {card.items.map((it, i) => {
          const a = interactive ? it.action : undefined;
          const sent = !!a && picked === a.label;
          return (
            <ListRow
              key={i}
              className={`brief-row${sent ? " is-sent" : ""}`}
              leading={<Icon name={it.icon} size={20} weight="regular" />}
              title={it.text}
              chevron={!!a?.open}
              onClick={a ? () => run(a) : undefined}
              ariaLabel={sent ? `${it.text}, 답을 기다리는 중` : undefined}
            />
          );
        })}
      </div>
    </section>
  );
}

/**
 * Weather (chat B): the temperature is the hero — place and source on the head line, "9° ☀ 맑음 / 최고 · 최저", then
 * the hours as flat columns under one hairline (no icon plate, no tiles: no card in a card).
 */
export function WeatherCard({ card }: { card: Weather }) {
  const hourly = card.hourly ?? [];
  const hl = [card.high !== undefined ? `최고 ${Math.round(card.high)}°` : null, card.low !== undefined ? `최저 ${Math.round(card.low)}°` : null].filter(Boolean).join(" · ");
  return (
    <section className="ccard ccard-weather" aria-label={`${card.place} 날씨`}>
      <div className="wx-head">
        <h3 className="wx-place">{card.place}</h3>
        {card.source && <span className="ccard-source">{card.source}</span>}
      </div>
      <div className="wx-now">
        <span className="wx-temp tnum">{Math.round(card.now.tempC)}°</span>
        <Icon name={card.now.icon} size={30} weight="regular" className="wx-glyph" />
        <span className="wx-cond">
          <span>{card.now.condition}</span>
          {hl && <span className="wx-hl tnum">{hl}</span>}
        </span>
      </div>
      {hourly.length > 0 && (
        <ol className="wx-hours" aria-label="시간별 예보">
          {hourly.map((h, i) => (
            <li key={i} className="wx-hour">
              <span className="wx-hour-t tnum">{h.hour}</span>
              <Icon name={h.icon} size={20} />
              <span className="wx-hour-v tnum">{Math.round(h.tempC)}°</span>
              {h.pop ? <span className="wx-hour-p tnum">{h.pop}%</span> : <span className="wx-hour-p" aria-hidden="true" />}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * A meta wider than the right column holds (60 % of the row, about 24 narrow characters at footnote size): a web
 * page's snippet ("신사이바시 | 14,800엔 | 22, … - 예약: 인스타그램 DM으로…") or a run of facts ("육류,고기 ·
 * 02-1234-5678 · 350m"), not a time, a deadline, a price or a distance. The right column never wraps, so a snippet
 * there pushed the row off the card and squeezed the source to one letter a line (user report 2026-11-15); a wide one
 * gets its own lines under the source instead. Wide characters (Hangul, kana, CJK) count two: "yna.co.kr · 11/15
 * 09:30" is 23 and stays on the right, "서양음악(클래식) · 11.15~11.30" is 30 and goes under.
 */
export function isWideMeta(meta: string | undefined): boolean {
  if (!meta) return false;
  let w = 0;
  for (const ch of meta) w += (ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
  return w > 24;
}

/**
 * .res-sub's narrowest line in em at text size `scale`, so no tie in it is wider (FOUNDATION › Line breaks: a tie wider
 * than its line takes the line whole and draws its nbsp at the next line's start, "고성군문화복지센터&nbsp; / · 강원" at
 * 320): the row (the list's width `list`, 256 px at 320; 26 less beside the chevron, its 16 px and the 10 px gap), less
 * the gap and 'when' (by `emWidth`, its digits as a tabular "0", at footnote size, at most 60 % of the row), at
 * subhead size
 */
export function subLine(when: string | undefined, chevron: boolean, scale: number, list = 256): number {
  const row = chevron ? list - 26 : list;
  const meta = when ? 12 + Math.min(emWidth(when.replace(/\d/g, "0")) * 13 * scale, row * 0.6) : 0;
  return (row - meta) / (15 * scale);
}

export function ResultsCard({ card }: { card: ResultListCard }) {
  const [all, setAll] = useState(false);
  const scale = useTierValue("textScale");
  // the row's width at hand, so a tie that fits a wider phone's line stays tied there
  const listRef = useRef<HTMLUListElement>(null);
  const list = useWidth(listRef, 256);
  const shown = all ? card.items : card.items.slice(0, 5);
  return (
    <section className="ccard ccard-results" aria-label={card.title}>
      <div className="ccard-head res-head">
        <h3 className="ccard-title">{card.title}</h3>
        {card.source && <span className="ccard-source">{card.source}</span>}
      </div>
      <ul className="res-list" ref={listRef}>
        <AnimatePresence initial={false}>
          {shown.map((it, i) => {
            const snippet = isWideMeta(it.meta);
            const when = snippet ? undefined : it.meta;
            const body = (
              <>
                <span className="res-body">
                  <span className="res-title">{it.title}</span>
                  {/* chat B: what you get on the left in ink, when on the right in one column you can scan down */}
                  {(it.subtitle || when) && (
                    <span className="res-line">
                      {/* a narrow cell beside a long 'when' (133 px at 320): a .t-cell around the copy (FOUNDATION ›
                          Line breaks), so under 160 px it wraps plainly */}
                      <span className="res-sub t-cell">
                        {it.subtitle && <span className="t-copy">{copy(it.subtitle, { line: subLine(when, !!it.url, scale, list) })}</span>}
                      </span>
                      {when && <span className="res-meta tnum">{when}</span>}
                    </span>
                  )}
                  {snippet && <span className="res-snippet">{it.meta}</span>}
                </span>
                {it.url && <Icon name="chevron-right" size={16} className="res-chev" />}
              </>
            );
            return (
              <motion.li key={i} className="res-row" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={t("snap")}>
                {it.url ? (
                  <a className="res-link" href={it.url} target="_blank" rel="noopener noreferrer">
                    {body}
                  </a>
                ) : (
                  <div className="res-link">{body}</div>
                )}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
      {card.items.length > 5 && (
        <button type="button" className="ccard-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "접기" : `${card.items.length - 5}개 더 보기`}
        </button>
      )}
    </section>
  );
}

/** Messenger reads/sends render as a reconstructed chat room (MessengerThreadCard; old stored cards included). */
export function MessengerCard({ card }: { card: Messenger }) {
  return <MessengerThreadCard card={card} />;
}

export function ScheduleCard({ card }: { card: Schedule }) {
  const [enabled, setEnabled] = useState(card.enabled);
  const [busy, setBusy] = useState(false);
  const removed = useStore(undone, (s) => s.has(card.scheduleId));
  if (removed)
    return (
      <section className="ccard ccard-sched is-removed" aria-label={card.title}>
        <div className="ccard-sched__body">
          <span className="ccard-sched__title">{card.title}</span>
          <span className="ccard-sched__when">예약을 취소했어요</span>
        </div>
      </section>
    );
  return (
    <section className="ccard ccard-sched" aria-label={card.title}>
      {/* title / rule + the switch, nothing more: no clock glyph (schedules draft A, P2-4a) */}
      <div className="ccard-sched__body">
        <span className="ccard-sched__title">{card.title}</span>
        <span className="ccard-sched__when tnum">{card.when}</span>
      </div>
      <Toggle
        checked={enabled}
        disabled={busy}
        label={`${card.title} ${enabled ? "끄기" : "켜기"}`}
        onChange={async (on) => {
          setEnabled(on);
          setBusy(true);
          try {
            const s = await ep.patchSchedule(card.scheduleId, { enabled: on });
            setEnabled(s.enabled);
          } catch (e) {
            setEnabled(!on);
            island.errorBanner((e as Error).message, "바꾸지 못했어요");
          } finally {
            setBusy(false);
          }
        }}
      />
    </section>
  );
}
