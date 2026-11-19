import type { IconName } from "@pickle/protocol";
import type { CSSProperties, ReactNode } from "react";

/**
 * ONE SF-Symbols-like icon set (MOTION-SPEC §0): 24×24 grid, round caps and joins, strokes that render 1.75 px at
 * 22 px (medium 2.0, semibold 2.3). Covers every protocol `IconName` plus the foundation's extras. Brand marks are
 * generic monochrome glyphs (no logotypes). Icons crossing a morph keep their optical size: scale the container,
 * never the glyph stroke.
 */
export type AppIconName =
  | IconName
  | "arrow-up"
  | "chevron-down"
  | "chevron-up"
  | "minus"
  | "exclamation"
  | "info"
  | "mic-off"
  | "speaker-off"
  | "ticket"
  | "wallet"
  | "gear"
  | "share"
  | "copy"
  | "pencil"
  | "refresh"
  | "location"
  | "globe"
  | "line"
  | "instagram"
  | "teams"
  | "check-circle"
  | "x-circle"
  | "pause-circle"
  | "waveform"
  | "at"
  | "checklist"
  | "video"
  | "moon";

export type IconWeight = "regular" | "medium" | "semibold";

/** px at 22 → user units on the 24 grid */
const STROKE: Record<IconWeight, number> = {
  regular: (1.75 * 24) / 22,
  medium: (2.0 * 24) / 22,
  semibold: (2.3 * 24) / 22,
};

const dot = (cx: number, cy: number, r = 1.35) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;
const ring = <circle cx="12" cy="12" r="8.5" />;

function gearPath(): string {
  const teeth = 8;
  const R = 8.7;
  const r = 6.7;
  const w = Math.PI / teeth;
  const f = (n: number) => Math.round(n * 100) / 100;
  const p = (a: number, rad: number) => `${f(12 + Math.cos(a) * rad)},${f(12 + Math.sin(a) * rad)}`;
  let d = "";
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2 - Math.PI / 2;
    d += `${i === 0 ? "M" : "L"}${p(a - 0.5 * w, r)}L${p(a - 0.28 * w, R)}L${p(a + 0.28 * w, R)}L${p(a + 0.5 * w, r)}`;
    d += `A${r},${r} 0 0 1 ${p(a + 1.5 * w, r)}`;
  }
  return `${d}Z`;
}
const GEAR = gearPath();

const PATHS: Record<AppIconName, ReactNode> = {
  // navigation & chrome
  chat: <path d="M12 4.75c4.56 0 8.25 2.98 8.25 6.65s-3.69 6.65-8.25 6.65c-.86 0-1.68-.1-2.46-.3L5.25 19.5l1-3.55C4.69 14.74 3.75 13.15 3.75 11.4c0-3.67 3.69-6.65 8.25-6.65Z" />,
  compass: (
    <>
      {ring}
      <path d="m15.4 8.6-2.05 4.75-4.75 2.05 2.05-4.75 4.75-2.05Z" />
    </>
  ),
  archive: (
    <>
      <rect x="3.75" y="5" width="16.5" height="4.25" rx="1.3" />
      <path d="M5.25 9.25v8A1.75 1.75 0 0 0 7 19h10a1.75 1.75 0 0 0 1.75-1.75v-8M10 12.75h4" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8.25" r="3.5" />
      <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8.75" r="3.1" />
      <path d="M3.5 19.25a5.5 5.5 0 0 1 11 0" />
      <circle cx="16.6" cy="9.25" r="2.5" />
      <path d="M15.6 13.9a4.75 4.75 0 0 1 4.9 4.85" />
    </>
  ),
  search: (
    <>
      <circle cx="10.75" cy="10.75" r="6.5" />
      <path d="m15.6 15.6 4.4 4.4" />
    </>
  ),
  magnifier: (
    <>
      <circle cx="10.75" cy="10.75" r="6.5" />
      <path d="m15.6 15.6 4.4 4.4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  menu: <path d="M5 8.75h14M5 15.25h14" />,
  ellipsis: (
    <>
      {dot(6, 12, 1.6)}
      {dot(12, 12, 1.6)}
      {dot(18, 12, 1.6)}
    </>
  ),
  checkmark: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  "chevron-right": <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  "chevron-left": <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />,
  "chevron-down": <path d="m5.5 9.5 6.5 6.5 6.5-6.5" />,
  "chevron-up": <path d="m5.5 14.5 6.5-6.5 6.5 6.5" />,
  "arrow-up": <path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5" />,
  send: <path d="M20.25 3.75 3.75 10.6l6.6 2.95 2.95 6.7 6.95-16.5ZM10.35 13.55l9.9-9.8" />,
  share: <path d="M8.5 8.75H7a1.5 1.5 0 0 0-1.5 1.5v8.25A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-8.25a1.5 1.5 0 0 0-1.5-1.5h-1.5M12 3.75v10.5M8.5 7.25 12 3.75l3.5 3.5" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.25" />
      <path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  pencil: <path d="M15.25 5.5 18.5 8.75 9 18.25l-4.25 1 1-4.25 9.5-9.5ZM13.25 7.5l3.25 3.25" />,
  refresh: <path d="M19.75 12a7.75 7.75 0 1 1-7.75-7.75c2.17 0 4.24.86 5.8 2.36l1.95 1.89M19.75 4.25V8.5H15.5" />,
  link: <path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.54 3.54 0 0 0-5-5l-1 1M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.54 3.54 0 0 0 5 5l1-1" />,
  paperclip: <path d="m19 11.5-6.6 6.55a4.25 4.25 0 0 1-6-6l7-7a2.85 2.85 0 0 1 4 4l-7 7a1.45 1.45 0 0 1-2.05-2.05L14.75 7.6" />,
  trash: <path d="M4.5 6.5h15M9.5 6.5V5A1.5 1.5 0 0 1 11 3.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5l.8 12.1A1.5 1.5 0 0 0 8.8 20h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12.1M10 10.5v6M14 10.5v6" />,
  gear: (
    <>
      <path d={GEAR} />
      <circle cx="12" cy="12" r="2.75" />
    </>
  ),
  eye: (
    <>
      <path d="M2.75 12S6 5.75 12 5.75 21.25 12 21.25 12 18 18.25 12 18.25 2.75 12 2.75 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),

  // status
  exclamation: (
    <>
      {ring}
      <path d="M12 7.75v5" />
      {dot(12, 16.1, 1.15)}
    </>
  ),
  info: (
    <>
      {ring}
      <path d="M12 11v5.25" />
      {dot(12, 7.9, 1.15)}
    </>
  ),
  "check-circle": (
    <>
      {ring}
      <path d="m8.25 12.25 2.5 2.5 5-5.25" />
    </>
  ),
  "x-circle": (
    <>
      {ring}
      <path d="M9.25 9.25l5.5 5.5M14.75 9.25l-5.5 5.5" />
    </>
  ),
  "pause-circle": (
    <>
      {ring}
      <path d="M10 9v6M14 9v6" />
    </>
  ),
  clock: (
    <>
      {ring}
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  bolt: <path d="M13 3 5.5 13.5H11l-1 7.5 7.5-10.5H12L13 3Z" />,
  sparkles: (
    <>
      <path d="M10.5 3.5c.5 3.7 2.1 5.4 5.8 5.9-3.7.5-5.3 2.2-5.8 5.9-.5-3.7-2.1-5.4-5.8-5.9 3.7-.5 5.3-2.2 5.8-5.9Z" />
      <path d="M17.5 14.25c.3 1.9 1.1 2.75 3 3.05-1.9.3-2.7 1.15-3 3.05-.3-1.9-1.1-2.75-3-3.05 1.9-.3 2.7-1.15 3-3.05Z" />
    </>
  ),
  star: <path d="M12 3.8 14.5 9l5.7.8-4.1 4 1 5.7L12 16.8l-5.1 2.7 1-5.7-4.1-4L9.5 9 12 3.8Z" />,
  heart: <path d="M12 19.5s-7.5-4.6-7.5-10A4.25 4.25 0 0 1 12 6.9a4.25 4.25 0 0 1 7.5 2.6c0 5.4-7.5 10-7.5 10Z" />,

  // communication & media
  mic: (
    <>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
    </>
  ),
  "mic-off": (
    <>
      <path d="M15 10.5v-4a3 3 0 0 0-5.6-1.5M9 9v2.5a3 3 0 0 0 4.6 2.55" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 10.6 5.05M18.5 11.5a6.5 6.5 0 0 1-.45 2.4M12 18v2.5M4.5 4.5l15 15" />
    </>
  ),
  phone: <path d="M6.6 4.25h2.6c.4 0 .75.27.85.66l.8 3.1c.1.4-.02.82-.32 1.1l-1.48 1.4a12.2 12.2 0 0 0 4.44 4.44l1.4-1.48c.28-.3.7-.42 1.1-.32l3.1.8c.39.1.66.45.66.85v2.6c0 .9-.73 1.6-1.62 1.6A15.75 15.75 0 0 1 5 5.87c0-.9.71-1.62 1.6-1.62Z" />,
  "phone-out": (
    <>
      <path d="M6.6 4.25h2.6c.4 0 .75.27.85.66l.8 3.1c.1.4-.02.82-.32 1.1l-1.48 1.4a12.2 12.2 0 0 0 4.44 4.44l1.4-1.48c.28-.3.7-.42 1.1-.32l3.1.8c.39.1.66.45.66.85v2.6c0 .9-.73 1.6-1.62 1.6A15.75 15.75 0 0 1 5 5.87c0-.9.71-1.62 1.6-1.62Z" />
      <path d="M15.25 3.75h5v5M20.25 3.75 14.5 9.5" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.25" />
      <path d="m4.25 7.25 7.75 5.75 7.75-5.75" />
    </>
  ),
  speaker: <path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1ZM15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" />,
  "speaker-off": <path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1ZM16 9.5l5 5M21 9.5l-5 5" />,
  wave: <path d="M2.75 12c1.55-3.1 3.1-3.1 4.62 0s3.08 3.1 4.63 0 3.08-3.1 4.62 0 3.08 3.1 4.63 0" />,
  waveform: <path d="M4 10.25v3.5M8 7v10M12 4.5v15M16 8v8M20 10.25v3.5" />,
  /** mention (@): the inner ring, then the tail running round into the outer arc */
  at: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M15.5 8.75v4.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8" />
    </>
  ),
  /** a task: two ticked rows and one still open */
  checklist: (
    <>
      <path d="m4.25 6.75 1.65 1.65 2.85-2.9M4.25 12.75l1.65 1.65 2.85-2.9M11.5 7h8.25M11.5 13h8.25M11.5 19h8.25" />
      {dot(6.5, 19, 1.25)}
    </>
  ),
  /** video call: camera body and its lens wedge */
  video: (
    <>
      <rect x="3.25" y="6.5" width="12.5" height="11" rx="2.25" />
      <path d="m15.75 10.25 4.1-2.45a.6.6 0 0 1 .9.52v7.36a.6.6 0 0 1-.9.52l-4.1-2.45" />
    </>
  ),
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" />,
  play: <path d="M8 5.6v12.8c0 .6.65.97 1.17.65l10.2-6.4a.76.76 0 0 0 0-1.3L9.17 4.95A.76.76 0 0 0 8 5.6Z" fill="currentColor" />,
  pause: (
    <>
      <rect x="6.75" y="5.25" width="3.5" height="13.5" rx="1.1" fill="currentColor" />
      <rect x="13.75" y="5.25" width="3.5" height="13.5" rx="1.1" fill="currentColor" />
    </>
  ),
  photo: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.75" />
      <path d="m4.25 17.25 4.5-4 3.5 3 3.25-2.75 4.25 3.75" />
    </>
  ),
  film: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.25" />
      <path d="M7.5 5v14M16.5 5v14M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4" />
    </>
  ),
  doc: (
    <>
      <path d="M7 3.5h6.5L18.5 8.5v10.25a1.75 1.75 0 0 1-1.75 1.75H7.25A1.75 1.75 0 0 1 5.5 18.75V5A1.5 1.5 0 0 1 7 3.5Z" />
      <path d="M13.5 3.5v5h5M8.75 12.75h6.5M8.75 16.25h4.5" />
    </>
  ),
  chart: <path d="M4.5 19.5h15M7.5 16v-4M12 16V7M16.5 16v-6" />,

  // places, things, money
  house: <path d="M4 10.75 12 4.25l8 6.5M6 9.25v9.5a1 1 0 0 0 1 1h3.5v-5.5h3v5.5H17a1 1 0 0 0 1-1v-9.5" />,
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v3.5M15.5 3.5v3.5" />
    </>
  ),
  cloud: <path d="M7.5 18.5h9a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 6.6 11.2a3.65 3.65 0 0 0 .9 7.3Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.75" />
      <path d="M12 2.75v1.5M12 19.75v1.5M2.75 12h1.5M19.75 12h1.5M5.46 5.46l1.06 1.06M17.48 17.48l1.06 1.06M5.46 18.54l1.06-1.06M17.48 6.52l1.06-1.06" />
    </>
  ),
  // night hours in the weather card (chat B): a crescent on the same grid and stroke as `sun`
  moon: <path d="M19.25 14.6A7.75 7.75 0 0 1 9.4 4.75a7.75 7.75 0 1 0 9.85 9.85Z" />,
  shield: (
    <>
      <path d="M12 3.5 5 6.2v5.3c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6.2L12 3.5Z" />
      <circle cx="12" cy="10.75" r="1.6" />
      <path d="M12 12.35v2.65" />
    </>
  ),
  lock: (
    <>
      <rect x="5.5" y="10.5" width="13" height="9.5" rx="2.25" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.25v2" />
    </>
  ),
  key: (
    <>
      <circle cx="8.25" cy="15.75" r="3.75" />
      <path d="M10.9 13.1 19.5 4.5M16.75 7.25l2.5 2.5M14.5 9.5l2 2" />
    </>
  ),
  card: (
    <>
      <rect x="3.5" y="6" width="17" height="12.5" rx="2.25" />
      <path d="M3.5 10.25h17M7 15h3" />
    </>
  ),
  wallet: (
    <>
      <rect x="3.5" y="6.75" width="17" height="12.75" rx="2.5" />
      <path d="M6 6.75 15.4 4.1a1 1 0 0 1 1.27.96v1.69M15.25 11.25h5.25v4.5h-5.25a2.25 2.25 0 0 1 0-4.5Z" />
    </>
  ),
  ticket: <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4V7.5ZM14.5 6.5v1.5M14.5 11.25v1.5M14.5 16v1.5" />,
  bell: <path d="M12 3.75A5.25 5.25 0 0 0 6.75 9v4.2L5 16.25h14l-1.75-3.05V9A5.25 5.25 0 0 0 12 3.75ZM9.75 19a2.3 2.3 0 0 0 4.5 0" />,
  paintbrush: <path d="M19.75 4.25c-2.3.55-6.85 4.4-8.75 7.15l1.6 1.6c2.75-1.9 6.6-6.45 7.15-8.75ZM10.6 12.75c-2.25-.25-4.1 1.35-4.3 3.65-.12 1.35-.72 2.35-1.8 3.1 3.65.95 7.55-.55 7.55-4.25" />,
  coins: (
    <>
      <ellipse cx="12" cy="7" rx="7" ry="2.75" />
      <path d="M5 7v5c0 1.52 3.13 2.75 7 2.75s7-1.23 7-2.75V7M5 12v5c0 1.52 3.13 2.75 7 2.75s7-1.23 7-2.75v-5" />
    </>
  ),
  won: <path d="m5 6 2.75 12L12 8.5 16.25 18 19 6M3.75 10.25h16.5M3.75 13.75h16.5" />,
  bag: <path d="M5.5 8.25h13l-1.05 11.15A1.75 1.75 0 0 1 15.7 21H8.3a1.75 1.75 0 0 1-1.75-1.6L5.5 8.25ZM9 10.25V7a3 3 0 0 1 6 0v3.25" />,
  gift: (
    <>
      <rect x="4" y="8" width="16" height="4" rx="1" />
      <path d="M5.5 12v6.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V12M12 8v12M12 8c-1.5-3.5-5.5-4-5.5-1.75C6.5 8 10 8 12 8Zm0 0c1.5-3.5 5.5-4 5.5-1.75C17.5 8 14 8 12 8Z" />
    </>
  ),
  plane: <path d="M20.75 12c0-.78-.66-1.4-1.47-1.4h-4.5L10.5 3.75H8.4l2.15 6.85H6.1L4.4 8.5H2.9l1.05 3.5-1.05 3.5h1.5l1.7-2.1h4.45L8.4 20.25h2.1l4.28-6.85h4.5c.81 0 1.47-.62 1.47-1.4Z" />,
  map: <path d="M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2-6-2ZM9 4.5v13M15 6.5v13" />,
  location: (
    <>
      <path d="M12 20.5s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0c0 4.9-6.5 10.5-6.5 10.5Z" />
      <circle cx="12" cy="10" r="2.4" />
    </>
  ),
  globe: (
    <>
      {ring}
      <path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5M12 3.5C9.7 5.9 8.5 8.7 8.5 12s1.2 6.1 3.5 8.5" />
    </>
  ),
  train: (
    <>
      <rect x="6" y="3.5" width="12" height="13" rx="3" />
      <path d="M6 10h12M8.5 20l1.5-3.5M15.5 20 14 16.5" />
      {dot(9.25, 13.25, 1.05)}
      {dot(14.75, 13.25, 1.05)}
    </>
  ),
  bus: (
    <>
      <rect x="5" y="3.5" width="14" height="14" rx="2.5" />
      <path d="M5 11h14M8 6.5h8M7.75 17.5v2.5M16.25 17.5v2.5" />
      {dot(8.5, 14.25, 1.05)}
      {dot(15.5, 14.25, 1.05)}
    </>
  ),

  // services (generic monochrome glyphs, no logotypes)
  kakao: (
    <>
      <path d="M12 4.75c4.7 0 8.5 2.85 8.5 6.35s-3.8 6.35-8.5 6.35c-.62 0-1.22-.05-1.8-.14L6.6 19.6l.95-3.45C5.1 15.05 3.5 13.2 3.5 11.1c0-3.5 3.8-6.35 8.5-6.35Z" />
      {dot(8.5, 11.1, 1.05)}
      {dot(12, 11.1, 1.05)}
      {dot(15.5, 11.1, 1.05)}
    </>
  ),
  slack: <path d="M9.5 4.25v15.5M14.5 4.25v15.5M4.25 9.5h15.5M4.25 14.5h15.5" />,
  discord: (
    <>
      <path d="M8 7h8a4 4 0 0 1 4 4v1.5a3.5 3.5 0 0 1-6.2 2.2L13 14h-2l-.8.7A3.5 3.5 0 0 1 4 12.5V11a4 4 0 0 1 4-4Z" />
      {dot(9.5, 10.75, 1.1)}
      {dot(14.5, 10.75, 1.1)}
    </>
  ),
  telegram: (
    <>
      {ring}
      <path d="m7.25 11.85 9.25-3.85-1.65 8.3-3.15-2.4-1.6 1.6v-2.6l4.15-3.55" />
    </>
  ),
  line: (
    <>
      <path d="M12 4.5c4.7 0 8.5 2.95 8.5 6.6 0 3.65-3.8 6.6-8.5 6.6h-.6L8.5 20v-2.75c-2.95-1-5-3.4-5-6.15 0-3.65 3.8-6.6 8.5-6.6Z" />
      <path d="M8.75 9.75h6.5M8.75 12.75h4" />
    </>
  ),
  instagram: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4.75" />
      <circle cx="12" cy="12" r="3.75" />
      {dot(16.6, 7.4, 1.05)}
    </>
  ),
  teams: (
    <>
      <rect x="3.5" y="7.5" width="11" height="10.5" rx="2.25" />
      <path d="M6.5 11h5M6.5 14.25h3.25" />
      <circle cx="17.5" cy="7.5" r="2" />
      <path d="M16.75 11.5h2.25a1.5 1.5 0 0 1 1.5 1.5v2.25a2.75 2.75 0 0 1-3.75 2.56" />
    </>
  ),
};

/** Every name, in display order (the gallery renders them all). */
export const ICON_NAMES = Object.keys(PATHS) as AppIconName[];

export interface IconProps {
  name: AppIconName | (string & {});
  size?: number;
  weight?: IconWeight;
  color?: string;
  className?: string;
  /** accessible name; without it the icon is decorative (aria-hidden) */
  title?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = 22, weight = "regular", color = "currentColor", className, title, style }: IconProps) {
  const glyph = (PATHS as Record<string, ReactNode>)[name] ?? null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE[weight]}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={color === "currentColor" ? { flex: "none", ...style } : { flex: "none", color, ...style }}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {glyph}
    </svg>
  );
}
