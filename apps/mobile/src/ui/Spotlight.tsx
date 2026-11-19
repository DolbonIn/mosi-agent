import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { filterKorean, type KoreanResult } from "../lib/hangul";
import { haptic } from "../motion/haptics";
import { SPRING, t } from "../motion/springs";
import { useTierValue } from "../motion/tier";
import { Glass } from "./Glass";
import { capsule } from "./geometry";
import { Icon, type AppIconName } from "./Icon";
import { copy } from "./Text";
import "./Spotlight.css";

/**
 * Tahoe Spotlight search (MOTION-SPEC §3).
 * - Glass capsule bar (52px) with magnifier; the real <input> keeps focus, IME, autofill and a11y, but its glyphs are
 *   drawn by an aria-hidden mirror so newly typed characters rise 2px on `snap`, and an I-beam caret blinks at 1 Hz.
 *   Caret moved / text selected → the mirror hides and the native caret + text take over (editing never breaks).
 * - Results on opaque paper (never glass on glass), filtered with 초성 matching, rows spring in/out (layout + snap),
 *   the top match is the selected row, ↑/↓ move it instantly, Enter (IME-safe) or tap presses and lifts it. The
 *   selection is an accent slab only where there is a cursor to follow (keyboard, fine pointer); on a phone (coarse
 *   pointer) the matched letters carry the signal and the top row shows the enter chevron.
 * - appearance "inline" (the drawer): a plain field instead of the glass bar (there is nothing to refract on paper),
 *   and the rows sit straight on the page instead of a results panel; `renderRow` draws the page's own rows.
 */
export interface SpotlightProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  getSubtitle?: (item: T) => string | undefined;
  getIcon?: (item: T) => AppIconName | undefined;
  getKeywords?: (item: T) => string[] | undefined;
  onSelect: (item: T) => void;
  placeholder?: string;
  autoFocus?: boolean;
  emptyText?: string;
  /** shown under "최근" while the query is empty */
  recent?: readonly T[];
  /** max rows (default 8) */
  limit?: number;
  /** controlled query (optional) */
  query?: string;
  onQueryChange?: (q: string) => void;
  className?: string;
  /** accessible name of the field (default: placeholder) */
  label?: string;
  /** "glass" (default): the glass bar + results on paper. "inline": a plain field, rows straight on the page */
  appearance?: "glass" | "inline";
  /** heading over the recents while the query is empty (default "최근") */
  recentLabel?: string;
  /** a second line under emptyText */
  emptyHint?: string;
  /** draw the row's content (the option wrapper, selection and press stay Spotlight's) */
  renderRow?: (item: T, ctx: { label: ReactNode; selected: boolean; recent: boolean }) => ReactNode;
}

const segmenter: { segment(s: string): Iterable<{ segment: string }> } | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new (Intl as unknown as { Segmenter: new (l: string, o: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter("ko", { granularity: "grapheme" })
    : null;

function graphemes(s: string): string[] {
  if (!s) return [];
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return Array.from(s);
}

const PRESS_MS = 120;

export function Spotlight<T>({
  items,
  getKey,
  getLabel,
  getSubtitle,
  getIcon,
  getKeywords,
  onSelect,
  placeholder = "검색",
  autoFocus,
  emptyText = "결과가 없어요",
  recent,
  limit = 8,
  query: controlled,
  onQueryChange,
  className,
  label,
  appearance = "glass",
  recentLabel = "최근",
  emptyHint,
  renderRow,
}: SpotlightProps<T>) {
  const reduce = useTierValue("reduceMotion");
  const [own, setOwn] = useState("");
  const query = controlled ?? own;
  const setQuery = useCallback(
    (q: string) => {
      if (controlled === undefined) setOwn(q);
      onQueryChange?.(q);
    },
    [controlled, onQueryChange],
  );
  const [focused, setFocused] = useState(false);
  const [atEnd, setAtEnd] = useState(true);
  const [typing, setTyping] = useState(false);
  const [active, setActive] = useState(0);
  const [pressing, setPressing] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const uid = useId().replace(/:/g, "");
  const listId = `spot-${uid}-list`;

  const trimmed = query.trim();
  const results: KoreanResult<T>[] = useMemo(() => {
    if (!trimmed) return (recent ?? []).slice(0, limit).map((item) => ({ item, score: 0, ranges: [] }));
    return filterKorean(items, trimmed, getLabel, getKeywords).slice(0, limit);
  }, [items, trimmed, recent, limit, getLabel, getKeywords]);

  // the top match is selected whenever the query changes
  useEffect(() => setActive(0), [trimmed]);
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));
  const activeItem = results[activeIndex];
  const optionId = (key: string) => `spot-${uid}-opt-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  // debounced live announcement
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setAnnounce(trimmed ? (results.length ? `${results.length}개 결과` : emptyText) : ""), 400);
    return () => clearTimeout(id);
  }, [trimmed, results.length, emptyText]);

  // ── mirror: glyphs typed after the last render rise in ──
  const glyphs = useMemo(() => graphemes(query), [query]);
  const seen = useRef(glyphs.length);
  useEffect(() => {
    seen.current = glyphs.length;
  });

  const syncCaret = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const end = el.value.length;
    setAtEnd(el.selectionStart === end && el.selectionEnd === end);
    if (mirrorRef.current) mirrorRef.current.scrollLeft = el.scrollLeft;
  }, []);

  useEffect(() => {
    const onSel = () => {
      if (document.activeElement === inputRef.current) syncCaret();
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [syncCaret]);

  useLayoutEffect(() => {
    // keep the mirror scrolled like the input when the text overflows
    const el = inputRef.current;
    if (el && mirrorRef.current) mirrorRef.current.scrollLeft = el.scrollLeft;
  }, [query]);

  useEffect(
    () => () => {
      clearTimeout(typingTimer.current);
      clearTimeout(pressTimer.current);
    },
    [],
  );

  const choose = useCallback(
    (index: number) => {
      const r = results[index];
      if (!r) return;
      const key = getKey(r.item);
      setActive(index);
      setPressing(key);
      haptic("selection");
      clearTimeout(pressTimer.current);
      pressTimer.current = setTimeout(() => {
        setPressing(null);
        onSelect(r.item);
      }, reduce ? 0 : PRESS_MS);
    },
    [results, getKey, onSelect, reduce],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        if (!results.length) return;
        e.preventDefault();
        setActive((i) => (Math.min(i, results.length - 1) + 1) % results.length);
        break;
      case "ArrowUp":
        if (!results.length) return;
        e.preventDefault();
        setActive((i) => (Math.min(i, results.length - 1) - 1 + results.length) % results.length);
        break;
      case "Enter":
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        choose(activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        if (query) setQuery("");
        else inputRef.current?.blur();
        break;
    }
  };

  const showMirror = focused ? atEnd : true;
  const showList = trimmed.length > 0 || results.length > 0;

  return (
    <div className={`spot${appearance === "inline" ? " spot--inline" : ""}${className ? ` ${className}` : ""}`}>
      <SpotBar inline={appearance === "inline"}>
        <span className="spot-icon" aria-hidden="true">
          <Icon name="magnifier" size={20} />
        </span>
        <div className={`spot-field${showMirror ? "" : " is-native"}`}>
          <input
            ref={inputRef}
            className="spot-input"
            type="search"
            role="combobox"
            aria-label={label ?? placeholder}
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? optionId(getKey(activeItem.item)) : undefined}
            value={query}
            placeholder={placeholder}
            autoFocus={autoFocus}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="search"
            enterKeyHint="search"
            onChange={(e) => {
              setQuery(e.target.value);
              setTyping(true);
              clearTimeout(typingTimer.current);
              typingTimer.current = setTimeout(() => setTyping(false), 600);
              requestAnimationFrame(syncCaret);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={syncCaret}
            onSelect={syncCaret}
            onScroll={syncCaret}
            onFocus={() => {
              setFocused(true);
              requestAnimationFrame(syncCaret);
            }}
            onBlur={() => setFocused(false)}
          />
          <div ref={mirrorRef} className="spot-mirror" aria-hidden="true">
            {glyphs.map((g, i) => (
              <motion.span
                key={i}
                className="spot-glyph"
                initial={!reduce && i >= seen.current ? { opacity: 0, y: 2 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={SPRING.snap}
              >
                {g}
              </motion.span>
            ))}
            {focused && <span className={`spot-caret${typing ? " is-typing" : ""}`} data-loop="" />}
          </div>
        </div>
        <AnimatePresence initial={false}>
          {query && (
            <motion.button
              key="clear"
              type="button"
              className="spot-clear"
              aria-label="검색어 지우기"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={t("fade")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <span className="spot-clear-dot">
                <Icon name="close" size={12} weight="semibold" />
              </span>
            </motion.button>
          )}
        </AnimatePresence>
      </SpotBar>

      {showList && (
        <div className="spot-results">
          {!trimmed && results.length > 0 && <p className="spot-section">{recentLabel}</p>}
          <div id={listId} role="listbox" aria-label={trimmed ? "검색 결과" : recentLabel === "최근" ? "최근 검색" : recentLabel} className="spot-list">
            <AnimatePresence initial={false} mode="popLayout">
              {results.map((r, i) => {
                const key = getKey(r.item);
                const selected = i === activeIndex;
                const icon = getIcon?.(r.item);
                const subtitle = getSubtitle?.(r.item);
                return (
                  <motion.div
                    key={key}
                    id={optionId(key)}
                    role="option"
                    aria-selected={selected}
                    className="spot-row"
                    layout="position"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0, scale: pressing === key ? 1.03 : 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.12 } }}
                    transition={{ ...(t("snap") as object), scale: t("press"), layout: t("snap") }}
                    onPointerMove={() => {
                      if (!selected) setActive(i);
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(i)}
                  >
                    {renderRow ? (
                      renderRow(r.item, { label: highlight(getLabel(r.item), r.ranges), selected, recent: !trimmed })
                    ) : (
                      <>
                        {icon && (
                          <span className="spot-row-icon" aria-hidden="true">
                            <Icon name={icon} size={20} />
                          </span>
                        )}
                        <span className="spot-row-text">
                          <span className="spot-row-label">{highlight(getLabel(r.item), r.ranges)}</span>
                          {subtitle && <span className="spot-row-sub">{subtitle}</span>}
                        </span>
                        {selected && (
                          <span className="spot-row-enter" aria-hidden="true">
                            <Icon name="chevron-right" size={16} />
                          </span>
                        )}
                      </>
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {trimmed && !results.length && (
              <p className="spot-empty">
                {emptyText}
                {emptyHint && <span className="spot-empty-hint t-copy">{copy(emptyHint)}</span>}
              </p>
            )}
          </div>
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

/** the bar: glass over content (default), or a plain field on paper (inline) */
function SpotBar({ inline, children }: { inline: boolean; children: ReactNode }) {
  if (inline) return <div className="spot-bar spot-bar--field">{children}</div>;
  return (
    <Glass text radius={capsule(52)} className="spot-bar">
      {children}
    </Glass>
  );
}

function highlight(label: string, ranges: [number, number][]): ReactNode {
  if (!ranges.length) return label;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(label.slice(at, s));
    out.push(<mark key={i}>{label.slice(s, e)}</mark>);
    at = e;
  });
  if (at < label.length) out.push(label.slice(at));
  return out;
}
