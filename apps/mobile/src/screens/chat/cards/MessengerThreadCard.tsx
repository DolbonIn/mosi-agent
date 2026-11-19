import type { MessengerCard, MessengerMessage } from "@pickle/protocol";
import { animate, motion } from "framer-motion";
import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useScroller } from "../../../app/Screen";
import { BrandIcon } from "../../../assets/brands/BrandIcon";
import { t } from "../../../motion/springs";
import { useTierValue } from "../../../motion/tier";
import { Icon, type AppIconName } from "../../../ui/Icon";
import { tied } from "../../../ui/Text";
import { holdScroll } from "../scrollHold";
import { clockKo } from "../util";
import "./MessengerThreadCard.css";

/**
 * A messenger read (msg_read / msg_send) as a small chat room.
 *
 * Collapsed (default): the room title, "카카오톡 · 안 읽음 7 · 메시지 16개 · 오후 7:12–7:30", and only the 1–3 messages
 * the server picked as the ones that matter, as small bubbles. "대화 펼치기" opens the reconstructed room in place:
 * others on the left (round initial, name on the first bubble of a run), mine on the right, the time on the last bubble
 * of a run, date separators, centred system lines, compact placeholders for media, quoted replies; the last 30
 * messages first, "이전 대화 더 보기" for the rest.
 *
 * Motion (MOTION-SPEC): the room opens in place. The toggle stays under the finger, and on the first frame the card
 * shows, fully opaque, the band the highlights filled, now holding the room's latest messages; then the card's top
 * edge rises on `morph` (its body grows, bottom-aligned, while the scroll follows frame by frame), so the room grows
 * up from where the highlights were like a chat that opens at its latest message. The rows never move and nothing
 * inside the card is ever unpainted: no clip, no fade, no offset. Collapsing is a return: the highlights are complete
 * on the first frame (no re-entrance).
 *
 * Old stored cards (only `messages`) render through the same room after a client-side cleanup.
 */

export const PROVIDER_NAME: Record<string, string> = {
  slack: "슬랙",
  slackbot: "슬랙",
  kakaotalk: "카카오톡",
  discord: "디스코드",
  discordbot: "디스코드",
  telegram: "텔레그램",
  telegrambot: "텔레그램",
  line: "라인",
  instagram: "인스타그램",
  teams: "팀즈",
  webex: "웹엑스",
};

const PAGE = 30;
/** consecutive messages from one sender within this gap form one run (name once, time once) */
const RUN_GAP = 5 * 60_000;

// ───────────────────────────── data ─────────────────────────────

const JSONISH = /^\s*[{[]\s*"[A-Za-z_]+"\s*:/;
const NOISE = /^[\sㅋㅎㅠㅜ~!?.^;,]+$/;

/** Pre-2026-11-12 cards: author/text rows → a thread (serialised payloads dropped, bare numeric authors numbered). */
function fromLegacy(card: MessengerCard): { thread: MessengerMessage[]; highlights: string[] } {
  const ids = new Map<string, string>();
  const unnamed = new Map<string, string>();
  const thread: MessengerMessage[] = [];
  for (const [i, m] of card.messages.entries()) {
    const text = (m.text ?? "").trim();
    if (!text || JSONISH.test(text)) continue;
    const isMe = m.author === "나";
    let name = m.author;
    if (/^\d{6,}$/.test(m.author)) {
      name = unnamed.get(m.author) ?? `멤버 ${unnamed.size + 1}`;
      unnamed.set(m.author, name);
    }
    const sender = isMe ? "me" : (ids.get(m.author) ?? `p${ids.size + 1}`);
    ids.set(m.author, sender);
    const attach = text === "(첨부)";
    thread.push({
      id: `l${i}`,
      ...(m.at ? { at: m.at } : {}),
      senderId: sender,
      senderName: isMe ? "나" : name,
      isMe,
      kind: attach ? "other" : "text",
      text: attach ? "" : text,
      ...(attach ? { attachment: { label: "첨부" } } : {}),
    });
  }
  // old cards carry no server pick: a small version of it (skip placeholders and noise, prefer asks/@/dates/money)
  const scored = thread
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.kind === "text" && Array.from(m.text).length >= 6 && !NOISE.test(m.text) && !PLACEHOLDER.test(m.text))
    .map(({ m, i }) => ({ m, i, s: LEGACY_HINTS.reduce((a, re) => a + (re.test(m.text) ? 2 : 0), 0) + (2 * (i + 1)) / thread.length }));
  const best = scored.sort((a, b) => b.s - a.s || b.i - a.i).slice(0, 2).sort((a, b) => a.i - b.i);
  return { thread, highlights: best.map((x) => x.m.id) };
}

const PLACEHOLDER = /^\(?(사진|동영상|파일|이모티콘|첨부|음성메시지|사진 \d+장)\)?$/;
const LEGACY_HINTS = [/[?？]/, /@\S/, /(부탁|주세요|해\s?줘|알려|확인)/, /\d+\s?(월|일|시|분)|오늘|내일|주말|[월화수목금토일]요일/, /\d[\d,]*\s?(원|만\s?원)|회비|입금|계좌/, /https?:\/\//];

const TAG_PART = /^(남|여|남자|여자|M|F|\d{2}|\d[0-9*]|\d{2,4}\s*년생|\d0\s*대)$/i;
/** Old cards' raw joined member list ("A/남/68년생/사진, B, C, D, E") → "A, B 외 3명" (new cards get this from the server). */
function legacyTitle(target: string): string {
  const names = target.split(/,\s*/).filter(Boolean);
  if (names.length < 3) return target;
  const short = names.map((n) => {
    const parts = n.split("/").map((x) => x.trim());
    return parts.length > 1 && parts[0] && TAG_PART.test(parts[1] ?? "") ? parts[0] : n.trim();
  });
  return `${short.slice(0, 2).join(", ")} 외 ${short.length - 2}명`;
}

type Row =
  | { t: "date"; key: string; label: string }
  | { t: "system"; key: string; m: MessengerMessage }
  | { t: "msg"; key: string; m: MessengerMessage; first: boolean; last: boolean; tag: boolean };

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
const dayLabel = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK[d.getDay()]}요일`;
};

function sameRun(a: MessengerMessage | undefined, b: MessengerMessage | undefined): boolean {
  if (!a || !b || a.kind === "system" || b.kind === "system") return false;
  if (a.senderId !== b.senderId || a.isMe !== b.isMe) return false;
  if (!a.at || !b.at) return true;
  return Math.abs(b.at - a.at) < RUN_GAP && dayKey(a.at) === dayKey(b.at);
}

/** Messages → rows with date separators and run boundaries (name on the first bubble, time on the last). */
function toRows(msgs: MessengerMessage[]): Row[] {
  const rows: Row[] = [];
  const named = new Set<string>();
  let day = "";
  msgs.forEach((m, i) => {
    if (m.at && dayKey(m.at) !== day) {
      day = dayKey(m.at);
      rows.push({ t: "date", key: `d${m.id}`, label: dayLabel(m.at) });
    }
    if (m.kind === "system") {
      rows.push({ t: "system", key: m.id, m });
      return;
    }
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    const first = !sameRun(prev, m) || (!!m.at && !!prev?.at && dayKey(prev.at) !== dayKey(m.at));
    const last = !sameRun(m, next);
    // the profile tag ("남/68년생/사진") once per sender: on their first name label in the room
    const tag = first && !m.isMe && !named.has(m.senderId);
    if (tag) named.add(m.senderId);
    rows.push({ t: "msg", key: m.id, m, first, last, tag });
  });
  return rows;
}

/** "오후 7:12–7:30" · "오전 11:50–오후 1:10" · "11월 11일 오후 9:00–11월 12일 오후 7:30" */
function rangeKo(msgs: MessengerMessage[]): string {
  const times = msgs.map((m) => m.at).filter((x): x is number => !!x);
  if (!times.length) return "";
  const a = Math.min(...times);
  const b = Math.max(...times);
  const ca = clockKo(a);
  const cb = clockKo(b);
  if (dayKey(a) !== dayKey(b)) {
    const md = (ms: number) => `${new Date(ms).getMonth() + 1}월 ${new Date(ms).getDate()}일`;
    return `${md(a)} ${ca}–${md(b)} ${cb}`;
  }
  if (ca === cb) return ca;
  return ca.slice(0, 2) === cb.slice(0, 2) ? `${ca}–${cb.slice(3)}` : `${ca}–${cb}`;
}

/** "김도윤/남/68년생/사진" with short "김도윤" → "남/68년생/사진" */
function tagOf(m: MessengerMessage): string {
  if (!m.senderFull || !m.senderFull.startsWith(m.senderName)) return "";
  return m.senderFull
    .slice(m.senderName.length)
    .replace(/^\s*[/(_|[]\s*/, "")
    .replace(/[)\]]\s*$/, "")
    .trim();
}

const initial = (name: string) => Array.from(name.replace(/^[^\p{L}\p{N}]+/u, ""))[0]?.toLocaleUpperCase("ko") ?? "?";

const MEDIA_ICON: Partial<Record<MessengerMessage["kind"], AppIconName>> = { photo: "photo", video: "film", file: "doc" };

// ───────────────────────────── pieces ─────────────────────────────

const URL_SPLIT = /(https?:\/\/[^\s<>"']+)/g;

/**
 * The card's narrowest lines, in em, at text size 0.9, 1, 1.1, 1.2 and 1.3 (320 wide, the same in both engines): mine
 * beside its time, the room's in a highlight (its name above it) and in a row (the avatar beside it). No tie is wider
 * (tied()'s clamp). A tie wider than its line wraps inside its box: the 4-line preview counts that box as one line (a
 * 12-character cap showed 5 lines in my highlight at 320, and 6 at text size 1.3), and in the open room the box drops
 * to a line of its own.
 */
const NARROW_EM = {
  mine: [10.3, 8.8, 7.7, 6.7, 5.9],
  highlight: [12.5, 10.9, 9.5, 8.4, 7.5],
  row: [9.5, 8.2, 7.1, 6.2, 5.4],
} as const;

/** the narrowest line for a text size; one between two measured sizes reads the larger size (its lines are narrower) */
export function narrowEm(where: keyof typeof NARROW_EM, scale: number): number {
  const step = Math.round(scale * 100) / 10 - 9; // 0.9 → 0, 1.3 → 4
  return NARROW_EM[where][Math.min(4, Math.max(0, Math.ceil(step - 1e-9)))]!;
}

/**
 * A line at a time: the lines stay as the person wrote them (tied() reads a newline as a space, and a "·" opening a
 * line, "준비물\n· 물", would ride up onto the line before).
 */
const tiedLines = (text: string, clamp: number) =>
  text.split("\n").map((line, i) => (
    <Fragment key={i}>
      {i > 0 ? "\n" : null}
      {tied(line, { clamp })}
    </Fragment>
  ));

/**
 * Text with http(s) links made tappable (nothing else is interpreted). The rest has its tight spots tied
 * (FOUNDATION › Line breaks: a number and its unit, a quote and the word it touches, "·", "("), so keep-all does not
 * break "회비 3만 / 원은" (430), none wider than `clamp` em (the narrowest line it sits on). Not inside a link: a tie
 * is a box and takes no underline.
 */
export function Linked({ text, clamp }: { text: string; clamp: number }) {
  const parts = text.split(URL_SPLIT);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow" className="mt-link">
            {p}
          </a>
        ) : (
          <Fragment key={i}>{tiedLines(p, clamp)}</Fragment>
        ),
      )}
    </>
  );
}

/** The inside of one bubble: quoted reply, media placeholder, text. */
function BubbleBody({ m, clamp }: { m: MessengerMessage; clamp?: boolean }) {
  const scale = useTierValue("textScale");
  const icon = MEDIA_ICON[m.kind];
  const label = m.attachment?.label ?? (m.kind === "emoticon" ? "이모티콘" : "");
  const placeholder = m.kind !== "text" && m.kind !== "reply" && m.kind !== "link" && label;
  return (
    <>
      {m.replyTo && (
        <span className="mt-quote">
          <span className="mt-quote-who">{m.replyTo.senderName === "나" ? "나에게 답장" : `${m.replyTo.senderName}에게 답장`}</span>
          <span className="mt-quote-text">{m.replyTo.text}</span>
        </span>
      )}
      {placeholder && (
        <span className="mt-media">
          {icon && <Icon name={icon} size={16} weight="medium" />}
          <span>{label}</span>
        </span>
      )}
      {/* what someone wrote in the room: prose (FOUNDATION › Line breaks), broken as they wrote it */}
      {m.text && (
        <span className={clamp ? "mt-text is-clamped" : "mt-text"} data-lines="prose">
          <Linked text={m.text} clamp={narrowEm(m.isMe ? "mine" : clamp ? "highlight" : "row", scale)} />
        </span>
      )}
    </>
  );
}

const isDeleted = (m: MessengerMessage) => m.kind === "other" && !m.text && m.attachment?.label === "삭제된 메시지";

function bubbleClass(m: MessengerMessage, first: boolean): string {
  const media = (m.kind === "photo" || m.kind === "video" || m.kind === "file" || m.kind === "emoticon" || m.kind === "other") && !m.text;
  return ["mt-bubble", m.isMe ? "is-me" : "is-peer", first ? "is-first" : "", media ? "is-media" : "", isDeleted(m) ? "is-deleted" : ""].filter(Boolean).join(" ");
}

/** What a screen reader hears for one message: "김도윤, 오후 7:15, 사진: …" */
function spoken(m: MessengerMessage): string {
  const who = m.isMe ? "나" : m.senderName || "알 수 없음";
  const when = m.at ? `, ${clockKo(m.at)}` : "";
  const what = [m.replyTo ? `${m.replyTo.senderName}에게 답장` : "", m.attachment && !m.text ? m.attachment.label : ""].filter(Boolean).join(", ");
  return `${who}${when}${what ? `, ${what}` : ""}: `;
}

function MessageRow({ row }: { row: Extract<Row, { t: "msg" }> }) {
  const { m, first, last } = row;
  const tag = row.tag ? tagOf(m) : "";
  return (
    <li className={`mt-row ${m.isMe ? "is-me" : "is-peer"}${first ? " is-first" : ""}${last ? " is-last" : ""}`}>
      <span className="sr-only">{spoken(m)}</span>
      {!m.isMe && (
        <span className="mt-avatar" aria-hidden="true">
          {first ? initial(m.senderName) : null}
        </span>
      )}
      <span className="mt-col">
        {!m.isMe && first && (
          <span className="mt-name" aria-hidden="true">
            {m.senderName}
            {tag && <span className="mt-tag"> {tag}</span>}
          </span>
        )}
        <span className="mt-line">
          <span className={bubbleClass(m, first)}>
            <BubbleBody m={m} />
          </span>
          {last && m.at && (
            <time className="mt-time tnum" dateTime={new Date(m.at).toISOString()} aria-hidden="true">
              {clockKo(m.at)}
            </time>
          )}
        </span>
      </span>
    </li>
  );
}

function Room({ thread, showAll, onShowAll }: { thread: MessengerMessage[]; showAll: boolean; onShowAll: () => void }) {
  const shown = showAll ? thread : thread.slice(-PAGE);
  const hidden = thread.length - shown.length;
  const rows = useMemo(() => toRows(shown), [shown]);
  return (
    <>
      {hidden > 0 && (
        <button type="button" className="mt-older" onClick={onShowAll}>
          이전 대화 더 보기 <span className="tnum">{hidden}</span>
        </button>
      )}
      <ol className="mt-list" aria-label={`대화 내용, 메시지 ${shown.length}개`}>
        {rows.map((r) =>
          r.t === "date" ? (
            <li key={r.key} className="mt-date">
              <span>{r.label}</span>
            </li>
          ) : r.t === "system" ? (
            <li key={r.key} className="mt-system">
              {r.m.text}
            </li>
          ) : (
            <MessageRow key={r.key} row={r} />
          ),
        )}
      </ol>
    </>
  );
}

function Highlight({ m }: { m: MessengerMessage }) {
  return (
    <li className={`mt-hl ${m.isMe ? "is-me" : "is-peer"}`}>
      <span className="sr-only">{spoken(m)}</span>
      {!m.isMe && (
        <span className="mt-name" aria-hidden="true">
          {m.senderName}
        </span>
      )}
      <span className="mt-line">
        <span className={bubbleClass(m, true)}>
          <BubbleBody m={m} clamp />
        </span>
        {m.at && (
          <time className="mt-time tnum" dateTime={new Date(m.at).toISOString()} aria-hidden="true">
            {clockKo(m.at)}
          </time>
        )}
      </span>
    </li>
  );
}

// ───────────────────────────── card ─────────────────────────────

export function MessengerThreadCard({ card }: { card: MessengerCard }) {
  const provider = PROVIDER_NAME[card.provider] ?? card.provider;
  const { thread, highlights } = useMemo(
    () => (card.thread ? { thread: card.thread, highlights: card.highlights ?? [] } : fromLegacy(card)),
    [card],
  );
  const title = card.room?.title || (card.thread ? card.target : legacyTitle(card.target));
  const fullTitle = card.room?.fullTitle ?? (!card.thread && title !== card.target ? card.target : undefined);
  const picked = useMemo(() => {
    const set = new Set(highlights);
    const hl = thread.filter((m) => set.has(m.id));
    return hl.length ? hl : thread.filter((m) => m.kind !== "system").slice(-1);
  }, [thread, highlights]);
  const expandable = thread.length > picked.length;

  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const reduce = useTierValue("reduceMotion");
  const scroller = useScroller();
  const bodyId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);
  const bandH = useRef(0);
  const opening = useRef(false);

  // keep the toggle where the finger is: the room grows upward from it (and folds back down into it)
  const remember = () => {
    anchor.current = toggle.current?.getBoundingClientRect().top ?? null;
    bandH.current = body.current?.getBoundingClientRect().height ?? 0;
  };
  useLayoutEffect(() => {
    const before = anchor.current;
    anchor.current = null;
    const grow = opening.current;
    opening.current = false;
    const el = scroller?.current;
    const btn = toggle.current;
    const b = body.current;
    if (before === null || !el || !btn) return;
    // put the toggle back where it was; this growth is placed here, so the thread must not also jump to its end
    // because it was pinned there
    const pin = () => {
      holdScroll(el, 250);
      const d = btn.getBoundingClientRect().top - before;
      if (Math.abs(d) > 0.5) el.scrollTop += d;
    };
    const full = b?.getBoundingClientRect().height ?? 0;
    if (!grow || reduce || !b || full - bandH.current < 1) {
      pin();
      return;
    }
    // opening: the body starts at the band the highlights filled, bottom-aligned, so its latest messages sit where the
    // highlights were, and grows to the whole room on `morph` while the scroll follows frame by frame. The card's
    // edge moves, the rows never do, and everything inside the edge is painted: no clip, no fade, no empty band
    b.dataset.growing = "";
    b.style.height = `${bandH.current}px`;
    const anchoring = el.style.overflowAnchor;
    el.style.overflowAnchor = "none"; // ours is the only anchoring: the browser's would correct the same move twice
    pin();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      delete b.dataset.growing;
      b.style.height = "";
      el.style.overflowAnchor = anchoring;
    };
    const a = animate(bandH.current, full, {
      ...t("morph"),
      onUpdate: (v) => {
        if (ended) return;
        b.style.height = `${Math.min(v, full)}px`; // the spring's overshoot would open a gap above the room
        pin();
      },
    });
    void a.then(() => {
      if (ended) return;
      end();
      pin();
    });
    return () => {
      a.stop();
      end();
    };
  }, [open, showAll, scroller, reduce]);

  const count = card.total ?? thread.filter((m) => m.kind !== "system").length;
  const range = rangeKo(thread);
  const unread = card.room?.unread;
  // segments never split inside ("안 읽음 7" stays whole); a narrow card wraps between them. 안 읽음 comes right after
  // the app (chat A), so when the line wraps it is the time range, the least needed part, that moves down
  const meta = (card.action === "sent" ? [`${provider}에 보냄`, range] : [provider, unread ? `안 읽음 ${unread}` : "", `메시지 ${count}개`, range]).filter(Boolean);
  const members = card.room?.memberCount;
  const roster = open && (fullTitle || members) ? [fullTitle, members ? `${members}명` : ""].filter(Boolean).join(" · ") : "";

  return (
    <section className="ccard mt-card" aria-label={`${provider} ${title} 대화`} data-open={open || undefined}>
      <header className="mt-head">
        <h3 className="mt-title">{title}</h3>
        <p className="mt-meta tnum">
          {/* the real app mark, small and inline with the provider name (no icon tile in the head) */}
          <BrandIcon provider={card.provider} size={16} radius={4} className="mt-brand" />
          {meta.map((x, i) => (
            <Fragment key={i}>
              {i > 0 && " · "}
              <span className="mt-seg">{x}</span>
            </Fragment>
          ))}
        </p>
        {roster && <p className="mt-roster">{roster}</p>}
      </header>

      <div id={bodyId} ref={body} className="mt-body">
        {!open ? (
          picked.length ? (
            <ul className="mt-hls" aria-label={expandable ? "중요한 메시지" : "메시지"}>
              {picked.map((m) => (
                <Highlight key={m.id} m={m} />
              ))}
            </ul>
          ) : (
            <p className="mt-empty">읽을 메시지가 없어요</p>
          )
        ) : (
          <div className="mt-room">
            <Room
              thread={thread}
              showAll={showAll}
              onShowAll={() => {
                remember();
                setShowAll(true);
              }}
            />
          </div>
        )}
      </div>

      {expandable && (
        <button
          ref={toggle}
          type="button"
          className="mt-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            remember();
            opening.current = !open;
            setOpen((v) => !v);
          }}
        >
          <span>{open ? "접기" : "대화 펼치기"}</span>
          <motion.span className="mt-chev" animate={{ rotate: open ? 180 : 0 }} transition={t("snap")} aria-hidden="true">
            <Icon name="chevron-down" size={16} weight="medium" />
          </motion.span>
        </button>
      )}
    </section>
  );
}
