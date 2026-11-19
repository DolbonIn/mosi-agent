import type { Artifact, DashboardWidget } from "@pickle/protocol";
import { htmlPreview } from "@pickle/protocol";

/**
 * 보관함 text rules, pure (no React, no CSS) so qa/archive-text.test.ts can hold them: the dashboard JSON reader, the
 * markdown → plain text pass, the card preview, the "title said twice" trim and the "label  amount" split.
 */

export function parseDashboard(src: string): DashboardWidget[] | null {
  try {
    const j = JSON.parse(src) as unknown;
    const list = Array.isArray(j) ? j : j && typeof j === "object" ? (j as { widgets?: unknown }).widgets : null;
    if (!Array.isArray(list)) return null;
    return list.filter((w): w is DashboardWidget => {
      if (!w || typeof w !== "object") return false;
      const t = (w as { type?: unknown }).type;
      if (t === "stat") return typeof (w as { value?: unknown }).value === "string" || typeof (w as { value?: unknown }).value === "number";
      if (t === "bars") return Array.isArray((w as { points?: unknown }).points);
      if (t === "list") return Array.isArray((w as { items?: unknown }).items);
      return false;
    });
  } catch {
    return null;
  }
}

/**
 * Plain text for previews / copy (markdown syntax removed). A "*" right before VS16 or U+20E3 is the keycap "*️⃣"
 * (as in the chat's markdown.tsx): it stays, and it never opens or closes bold or italic.
 */
export function stripMarkdown(src: string): string {
  return src
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*(```|~~~).*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/\*\*(?![\uFE0F\u20E3])|__|~~|`/g, "")
    .replace(/\*(?![\uFE0F\u20E3])(\S(?:[^*]|\*(?=[\uFE0F\u20E3]))*)\*(?![\uFE0F\u20E3])/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** the heading and the title without marks; the keycaps "*️⃣" and "#️⃣" keep their "*" and "#" */
const norm = (s: string) => s.replace(/[\s_`]|[*#](?![\uFE0F\u20E3])/g, "");

/**
 * The sheet already shows the title, so a leading "# …" that says it again goes: the same words, or one of the two
 * starting with the other ("# 11월 12일 주간회의" under "11월 12일 주간회의 회의록").
 */
export function withoutTitle(src: string, title: string): string {
  const m = /^\s*#{1,2}\s+(.+?)\s*#*\s*(\n|$)/.exec(src);
  if (!m) return src;
  const h = norm(m[1]!);
  const t = norm(title);
  if (h.length < 2 || !t) return src;
  return h === t || t.startsWith(h) || h.startsWith(t) ? src.slice(m[0].length).replace(/^\s*\n/, "") : src;
}

/** "배달의민족 182,000원" → ["배달의민족", "182,000원"]; an item without a trailing amount → [item] */
export function splitAmount(item: string): [string] | [string, string] {
  const s = item.trim();
  const m = /^(.*\S)\s+([+\-−]?[₩$]?\d[\d,]*(?:\.\d+)?\s?[^\s\d]{0,3})$/.exec(s);
  return m ? [m[1]!, m[2]!] : [s];
}

const SEP = " · ";
const TASK = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s/;

/**
 * A card's two preview lines, read like a sentence: content lines joined with " · " and headings left out (the card
 * title says what it is; section names are structure). A checklist leads with its progress, then its open items. A
 * dashboard reads "label value · delta · list label + first item".
 */
export function previewOf(a: Pick<Artifact, "kind"> & { content?: string }): string {
  const src = a.content ?? "";
  if (a.kind === "html") return htmlPreview(src, (a as { title?: string }).title);
  if (a.kind === "dashboard") {
    const w = parseDashboard(src);
    if (!w?.length) return "";
    const parts: string[] = [];
    for (const x of w) {
      if (x.type === "stat") {
        parts.push(`${x.label} ${x.value}`);
        if (x.delta?.trim()) parts.push(x.delta.trim());
      } else if (x.type === "list" && x.items.length) parts.push(`${x.label} ${splitAmount(String(x.items[0]))[0]}`);
    }
    return (parts.length ? parts : w.map((x) => x.label)).join(SEP);
  }
  const body = src
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim() && !HEADING.test(l));
  const head: string[] = [];
  let lines = body;
  if (a.kind === "checklist") {
    const tasks = body.map((l) => TASK.exec(l)).filter((m): m is RegExpExecArray => !!m);
    if (tasks.length) {
      const done = tasks.filter((m) => m[1] !== " ").length;
      const open = tasks.filter((m) => m[1] === " ");
      head.push(`${tasks.length}개 중 ${done}개 완료`);
      lines = (open.length ? open : tasks).map((m) => m[2]!);
    }
  }
  // the card clamps to two lines; 200 characters is more than enough to fill them
  return [...head, ...lines.map((l) => stripMarkdown(l)).filter(Boolean)].join(SEP).slice(0, 200);
}
