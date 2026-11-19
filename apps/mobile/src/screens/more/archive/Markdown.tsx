import { Fragment, memo, type ReactNode } from "react";
import { Icon } from "../../../ui/Icon";

/**
 * A small, SAFE markdown renderer for artifacts: it builds React elements only (text is always text — never
 * dangerouslySetInnerHTML), links are limited to http(s)/mailto and open with rel="noopener noreferrer".
 * Blocks: headings, paragraphs (single newlines kept as line breaks — the agent writes that way), fenced code,
 * ordered / unordered / task lists (nested by indentation), tables, blockquotes, horizontal rules.
 * Inline: `code`, **bold** / __bold__, *em*, ~~strike~~, [text](url), bare http(s) links.
 */

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; lines: string[] }
  | { t: "code"; lang: string; text: string }
  | { t: "hr" }
  | { t: "quote"; blocks: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "table"; head: string[]; align: ("left" | "center" | "right" | null)[]; rows: string[][] };

interface ListItem {
  text: string;
  task: null | boolean;
  children: Block[];
}

const RE_FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const RE_H = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const RE_UL = /^(\s*)([-*+])\s+(.*)$/;
const RE_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const RE_TASK = /^\[([ xX])\]\s+(.*)$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const indentOf = (s: string) => {
  let n = 0;
  for (const ch of s) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
};

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const isBlank = (s: string | undefined) => s === undefined || s.trim() === "";

function startsBlock(line: string, next: string | undefined): boolean {
  return RE_FENCE.test(line) || RE_H.test(line) || RE_HR.test(line) || RE_UL.test(line) || RE_OL.test(line) || RE_QUOTE.test(line) || (line.includes("|") && !!next && RE_TABLE_SEP.test(next));
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  return parseLines(lines, 0);
}

function parseLines(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    // fenced code
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) body.push(lines[i++]!);
      i++; // closing fence (or EOF)
      out.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const h = RE_H.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (RE_HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    // table: header row + separator row
    if (line.includes("|") && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]!)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i]!.includes("|")) rows.push(splitRow(lines[i++]!));
      out.push({ t: "table", head, align, rows });
      continue;
    }
    // blockquote
    if (RE_QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i]!)) inner.push(RE_QUOTE.exec(lines[i++]!)![1]!);
      out.push({ t: "quote", blocks: depth < 4 ? parseLines(inner, depth + 1) : [{ t: "p", lines: inner }] });
      continue;
    }
    // lists
    const ul = RE_UL.exec(line);
    const ol = ul ? null : RE_OL.exec(line);
    if (ul || ol) {
      const ordered = !!ol;
      const baseIndent = indentOf(line);
      const start = ol ? Number(ol[2]) : 1;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (isBlank(l)) {
          // a blank line ends the list unless the next line continues it
          const nxt = lines[i + 1];
          if (nxt !== undefined && (indentOf(nxt) > baseIndent || (ordered ? RE_OL : RE_UL).test(nxt)) && indentOf(nxt) >= baseIndent) {
            i++;
            continue;
          }
          break;
        }
        const ind = indentOf(l);
        const m = (ordered ? RE_OL : RE_UL).exec(l);
        if (m && ind === baseIndent) {
          let text = m[3]!;
          let task: null | boolean = null;
          const tk = RE_TASK.exec(text);
          if (tk) {
            task = tk[1] !== " ";
            text = tk[2]!;
          }
          items.push({ text, task, children: [] });
          i++;
          // continuation + nested lines (indented deeper)
          const nested: string[] = [];
          while (i < lines.length && !isBlank(lines[i]) && indentOf(lines[i]!) > baseIndent) nested.push(lines[i++]!);
          if (nested.length) {
            const cur = items[items.length - 1]!;
            const firstNested = nested.findIndex((n) => RE_UL.test(n) || RE_OL.test(n));
            const cont = firstNested < 0 ? nested : nested.slice(0, firstNested);
            if (cont.length) cur.text += "\n" + cont.map((c) => c.trim()).join("\n");
            if (firstNested >= 0 && depth < 4) {
              const minInd = Math.min(...nested.slice(firstNested).filter((n) => !isBlank(n)).map(indentOf));
              cur.children = parseLines(
                nested.slice(firstNested).map((n) => n.slice(Math.min(minInd, indentOf(n)))),
                depth + 1,
              );
            }
          }
          continue;
        }
        if (ind > baseIndent) {
          // stray deeper line: continuation of the last item
          const cur = items[items.length - 1];
          if (cur) cur.text += "\n" + l.trim();
          i++;
          continue;
        }
        break;
      }
      out.push({ t: "list", ordered, start, items });
      continue;
    }
    // paragraph
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i]!, lines[i + 1]))) para.push(lines[i++]!.trim());
    out.push({ t: "p", lines: para });
  }
  return out;
}

// ───────────────────────────── inline ─────────────────────────────

const safeHref = (url: string): string | null => {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
};

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*(?!\s)([\s\S]+?)\*|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"])/g;

export function renderInline(text: string, keyBase = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(INLINE.source, "g");
  let m: RegExpExecArray | null;
  const push = (s: string) => {
    if (!s) return;
    // keep single newlines as line breaks
    const parts = s.split("\n");
    parts.forEach((p, j) => {
      if (j > 0) out.push(<br key={`${keyBase}-br-${n++}`} />);
      if (p) out.push(p);
    });
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    const k = `${keyBase}-${n++}`;
    if (m[2] !== undefined) out.push(<code key={k} className="md-code">{m[2]}</code>);
    else if (m[3] !== undefined) out.push(<strong key={k}>{renderInline(m[3], k)}</strong>);
    else if (m[4] !== undefined) out.push(<strong key={k}>{renderInline(m[4], k)}</strong>);
    else if (m[5] !== undefined) out.push(<s key={k}>{renderInline(m[5], k)}</s>);
    else if (m[6] !== undefined) out.push(<em key={k}>{renderInline(m[6], k)}</em>);
    else if (m[7] !== undefined) {
      const href = safeHref(m[8] ?? "");
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="md-link">
            {renderInline(m[7], k)}
          </a>
        ) : (
          <Fragment key={k}>{renderInline(m[7], k)}</Fragment>
        ),
      );
    } else if (m[9] !== undefined) {
      const href = safeHref(m[9]);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="md-link">
            {m[9]}
          </a>
        ) : (
          m[9]
        ),
      );
    }
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out;
}

// ───────────────────────────── render ─────────────────────────────

function BlockView({ b, k }: { b: Block; k: string }): ReactNode {
  switch (b.t) {
    case "h": {
      const Tag = (`h${Math.min(6, b.level + 1)}` as "h2" | "h3" | "h4" | "h5" | "h6");
      return <Tag className={`md-h md-h${b.level}`}>{renderInline(b.text, k)}</Tag>;
    }
    case "p":
      return <p className="md-p">{renderInline(b.lines.join("\n"), k)}</p>;
    case "code":
      return (
        <pre className="md-pre" tabIndex={0} aria-label={b.lang ? `${b.lang} 코드` : "코드"}>
          <code>{b.text}</code>
        </pre>
      );
    case "hr":
      return <hr className="md-hr" />;
    case "quote":
      return (
        <blockquote className="md-quote">
          {b.blocks.map((c, j) => (
            <BlockView key={j} b={c} k={`${k}-${j}`} />
          ))}
        </blockquote>
      );
    case "list": {
      const isTask = b.items.length > 0 && b.items.every((it) => it.task !== null);
      if (isTask) {
        const done = b.items.filter((it) => it.task).length;
        return (
          <ul className="md-tasks" aria-label={`할 일 ${b.items.length}개 중 ${done}개 완료`}>
            {b.items.map((it, j) => (
              <li key={j} className={`md-task${it.task ? " is-done" : ""}`}>
                <span className="md-task__box" aria-hidden="true">
                  {it.task ? <Icon name="checkmark" size={14} weight="semibold" /> : null}
                </span>
                <span className="md-task__text">
                  <span className="sr-only">{it.task ? "완료: " : "할 일: "}</span>
                  {renderInline(it.text, `${k}-${j}`)}
                  {it.children.map((c, ci) => (
                    <BlockView key={ci} b={c} k={`${k}-${j}-${ci}`} />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        );
      }
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag className={`md-list${b.ordered ? " md-ol" : " md-ul"}`} start={b.ordered && b.start !== 1 ? b.start : undefined}>
          {b.items.map((it, j) => (
            <li key={j} className={it.task !== null ? `md-task-inline${it.task ? " is-done" : ""}` : undefined}>
              {it.task !== null && (
                <span className="md-task__box md-task__box--inline" aria-hidden="true">
                  {it.task ? <Icon name="checkmark" size={12} weight="semibold" /> : null}
                </span>
              )}
              {it.task !== null && <span className="sr-only">{it.task ? "완료: " : "할 일: "}</span>}
              {renderInline(it.text, `${k}-${j}`)}
              {it.children.map((c, ci) => (
                <BlockView key={ci} b={c} k={`${k}-${j}-${ci}`} />
              ))}
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div className="md-table-wrap" tabIndex={0} role="region" aria-label="표">
          <table className="md-table">
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                    {renderInline(c, `${k}-h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {b.head.map((_, j) => (
                    <td key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                      {renderInline(r[j] ?? "", `${k}-${ri}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export const Markdown = memo(function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} k={`b${i}`} />
      ))}
    </div>
  );
});
