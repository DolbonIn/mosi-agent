import type { ApprovalCard, KeepFor, Message, ThreadKind, ToolActivity } from "@pickle/protocol";
import type { AppIconName } from "../../ui/Icon";

/** Shared helpers for the chat screens: Korean time labels, approval risk tiers, tool sources, thread kinds. */

const pad = (n: number) => String(n).padStart(2, "0");

/** "오전 7:08" */
export function clockKo(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ampm} ${h12}:${pad(d.getMinutes())}`;
}

/** "오전 8:22 – 9:04" (iOS): 오전/오후 is said once, and again only when the range crosses noon or midnight */
export function clockRangeKo(from: number, to: number): string {
  const [a, b] = [new Date(from), new Date(to)];
  const half = (d: Date) => (d.getHours() < 12 ? 0 : 1);
  const once = sameDay(a, b) && half(a) === half(b);
  return `${clockKo(from)} – ${once ? clockKo(to).replace(/^오[전후] /, "") : clockKo(to)}`;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "오늘 오전 7:08" · "어제 오후 3:12" · "11월 9일 오후 3:12" */
export function dayClockKo(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const day = sameDay(d, today) ? "오늘" : sameDay(d, yesterday) ? "어제" : d.getFullYear() === today.getFullYear() ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${day} ${clockKo(ms)}`;
}

/** "방금" · "3분 전" · "2시간 전" · "어제" · "11월 9일" */
export function agoKo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86_400) return `${Math.floor(s / 3600)}시간 전`;
  const d = new Date(ms);
  if (sameDay(d, new Date(now - 86_400_000))) return "어제";
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** "12초" · "1분 4초" */
export function durationKo(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}분 ${r}초` : `${m}분`;
}

/** a separator before this message when the gap to the previous one is ≥ 10 minutes (or it is the first) */
export function needsSeparator(prev: Message | undefined, cur: Message): boolean {
  if (!prev) return true;
  return cur.createdAt - prev.createdAt >= 10 * 60_000;
}

// ── approvals by risk (MOTION-SPEC §8.6) ──
export type Risk = "low" | "medium" | "high";

const HIGH_TOOLS = new Set(["sys_phone_call", "sys_schedule_delete", "msg_delete", "pay", "payment"]);
const LOW_TOOLS = new Set(["sys_schedule_create", "sys_remember"]);

export function riskOf(card: ApprovalCard, tools: ToolActivity[] = []): Risk {
  if (typeof card.amount === "number") return "high";
  const pending = tools.find((t) => t.state === "needs_approval") ?? tools[tools.length - 1];
  const name = pending?.name ?? "";
  if (HIGH_TOOLS.has(name) || /pay|delete|call/.test(name)) return "high";
  if (LOW_TOOLS.has(name)) return "low";
  if (/전화|결제|삭제|송금|지우/.test(card.title)) return "high";
  return "medium";
}

/** the tool that raised an approval (for the preview header) */
export function approvalTool(tools: ToolActivity[] = []): ToolActivity | undefined {
  return tools.find((t) => t.state === "needs_approval");
}

// ── thread kinds ──
export const KIND_ICON: Record<ThreadKind, AppIconName> = {
  main: "chat",
  task: "checklist",
  call: "phone-out",
  friend: "people",
  schedule: "clock",
};

export const KEEP_FOR: { value: KeepFor; label: string }[] = [
  { value: "1h", label: "1시간" },
  { value: "1d", label: "1일" },
  { value: "7d", label: "7일" },
  { value: "30d", label: "30일" },
  { value: "forever", label: "계속" },
];
export const keepForLabel = (k: KeepFor) => KEEP_FOR.find((x) => x.value === k)?.label ?? k;

/** Korean object particle: 깽이 → 깽이를 / 진우 → 진우를 (handles a final consonant) */
export function josa(word: string, withBatchim: string, without: string): string {
  const ch = word.charCodeAt(word.length - 1);
  if (ch < 0xac00 || ch > 0xd7a3) return `${word}${without}`;
  return `${word}${(ch - 0xac00) % 28 ? withBatchim : without}`;
}

export const MAX_CHARS = 4000;

export function prefersReducedMotion(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.motion === "reduce";
}
