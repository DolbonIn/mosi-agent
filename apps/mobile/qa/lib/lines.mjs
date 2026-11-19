// Shared line checker for Korean copy (FOUNDATION.md › Line breaks). One in-page function rebuilds each text block's
// lines per character (a one-character Range each: Korean without keep-all breaks inside words, and a word's Range
// spans two lines, so word Ranges misread lines) and reports the breaks a reader trips on:
//   open-end        a line (not the last) ends on an opening bracket or quote: "봐요("
//   close-start     a line (not the first) starts with a closing bracket or quote, "·", ".", ",", "!", "?", ":" or ";"
//                   (spaces, nbsp and joiners skipped: WebKit's pretty breaks between ")" and a nbsp)
//   particle        a line ends on a closing bracket or quote while its word goes on, a letter or digit next in the
//                   source: "기억해 줘” / 처럼" (UAX #14 lets both engines break after ” ’ before Hangul, keep-all or not)
//   unit            a line ends on a number and the next starts with its unit or counter: "회비 3만 / 원은" (ui/Text.tsx
//                   ties the two; the same unit list, and the unit's word may only go on with a particle or punctuation)
//   number          a word holding a number cut inside, next to a digit or after a sign that follows one ("최대 3. / 3만
//                   원이", "3.3% / 이고"), while the word (space to space) fits the block: under keep-all WebKit breaks
//                   at . , : / –, Chrome after - and – and between % and Hangul. The <wbr> points (after "·", before
//                   "(") are breaks to keep, not cuts
//   url             a word holding a domain ("microsoft.com/devicelogin에", "user@example.com") cut inside, while the
//                   word fits the block: WebKit breaks after "." and "/" ("microsoft. / com"); ui/Text.tsx ties the word
//   det             a one-syllable determiner standing alone at a line's end, its word opening the next: "한 / 번",
//                   "새 / 메시지" (ui/Text.tsx ties them forward; the same lists, kept in step by a unit test)
//   per             a one-syllable period noun at a line's end and its amount opening the next ("월 / 최대", "주 / 3회"),
//                   or an area noun and "단위" ("구 / 단위까지만")
//   aux             a one-syllable auxiliary verb opening a line, the -아/-어 form it leans on ending the one before:
//                   "예약해 / 둔", "적어 / 줘" (tied back)
//   orphan          two lines or more, and the last holds two characters or fewer, counted as grapheme clusters
//                   (👍🏻 is one): "요."; a last line of nothing but emoji is not one ("🍜🍜", the chat's bubbleFit agrees)
//   emoji-split     two emoji side by side in the source, no space between, on different lines: "줘 🍜 / 🍜" (Chrome
//                   breaks between emoji)
//   sentence-split  a text of two sentences or more where a sentence that would fit on one line runs over two
//   overflow        a line's last glyph ends more than 0.5 px past its block's content box (a nowrap tie too wide)
//                   (0.5 px of slack for WebKit's whole-px Ranges: see the rule)
//   line-gain       a copy block (pretty, or sentence blocks .t-s) takes more lines than the same text with plain
//                   wrap: from opts.narrowPx (160) up, one more line is allowed for two sentences or more, none for one;
//                   below it none at all (the foundation turns pretty and sentence blocks off in a narrow .t-cell)
// r.narrow lists the copy blocks narrower than opts.narrowPx: a layout question (a detail or chips beside a long
// line at 320) for the screen's owner, not a finding.
// Widths are compared in layout px (a block under a running scale transform reads the same as at rest), and the
// whitespace-only text nodes React makes between pieces count, so a copy() block splits into its sentences.
// A block (or an ancestor) marked data-lines="prose" is flowing prose, a chat reply say: every rule but sentence-split.
//
// Use from a spec:
//   import { checkLines } from "./lib/lines.mjs";
//   const r = await checkLines(page, { scope: ".sheet-panel" });          // every text block under the scope
//   const r = await checkLines(page, { select: ".list-row-sub" });        // just these elements
//   r.units: blocks with findings ({ path, own, classes, levels, text, width, lines, findings }); r.scanned /
//   r.multiline: how many blocks were measured (own: the block's classes; classes: its and its ancestors'; levels: per
//   element, the block first)
//
// A text block is the nearest ancestor of a text node that is not laid out inline (display inline, inline-block or
// contents), so a sentence span (an inline-block) counts with its paragraph. Skipped: blocks that never wrap (nowrap,
// pre), single-line truncation (text-overflow: ellipsis), blocks narrower than 4 px (sr-only) and blocks outside the
// viewport's width or not visible (pages behind a pushed screen).
//
// Repro pages: inline style="…" with a double-quoted font name ("SF Pro Text") ends the attribute, and the font,
// keep-all and text-wrap after it drop without a word. Use single quotes and look at one screenshot first.

/** in the page (page.evaluate(linesInPage, opts)): opts.scope (selector; default body) or opts.select (selector);
 * opts.narrowPx (default 160): the copy-block width below which pretty and sentence blocks must not add a line */
export function linesInPage(opts = {}) {
  const NARROW = opts.narrowPx ?? 160;
  const OPEN = /[([{“‘「『〈《]$/;
  const CLOSE = /^[)\]}”’」』〉》·.,!?:;]/;
  const CLOSE_END = /[)\]}”’」』〉》]/;
  const WORDY = /[\p{L}\p{N}]/u;
  // as ui/Text.tsx (keep the two in step): a word ending in a number, and a unit or counter word
  const NUM_END = /\d(?:[.,]\d+)*[만천억조]?$/;
  const UNIT =
    /^(?:원|달러|엔|위안|유로|개월|개|명|곳|건|번|회|차|분|초|시간|일|주|년|살|세|층|호|장|권|잔|병|대|마리|점|평|배|인분|인|박|가지|단계|줄|쪽|km|cm|mm|m|kg|g|L|ml|KB|MB|GB|TB|%|℃|도)(?=$|[^\p{L}]|(?:은|는|이|가|을|를|에서|에게|에는|에도|에|의|도|와|과|로|으로|만|까지|부터|씩|쯤|짜리|째|예요|이에요|입니다|이고|이나|이면|이라|당|간|가량|여|정도|마다|보다|처럼|밖에|뿐)(?:$|[^\p{L}]))/u;
  // as ui/Text.tsx (keep the two in step): one-syllable words and the word they lean on. Forward: a determiner standing
  // alone, a period noun before an amount, an area noun before "단위". Back: an auxiliary verb after a -아/-어 form (its
  // last syllable read decomposed, NFD)
  const DET = /^(?:이|그|저|새|헌|각|몇|온|총|약|한|두|세|네|첫)$/;
  const DET_NEXT = /^[\p{L}\p{N}]/u;
  const PER = /^(?:월|연|년|주|일|회)$/;
  const PER_NEXT = /^(?:최대|최소|최고|평균|단위|(?:약|총)(?!\p{L})|\d)/u;
  const AREA = /^(?:시|군|구|동|읍|면)$/;
  const AREA_NEXT = /^단위/;
  const AUX_PREV = /[\u1161\u1165\u1167\u1162\u116a\u116f\u116b]$/u;
  const AUX = /^(?:둔|둘|둬|뒀|준|줄|줘|줬|본|볼|봐|봤)(?![\p{L}\p{N}])/u;
  // as ui/Text.tsx (keep the two in step): a domain, a letter or digit, a point and two Latin letters or more
  const URL_IN = /[\p{L}\p{N}]\.[A-Za-z]{2,}/u;
  // grapheme clusters (an emoji with a skin tone, a ZWJ family or a flag is one); an emoji is a cluster holding a
  // default-emoji code point, a VS16, a keycap or a regional indicator ("™" alone is text)
  const seg = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("ko", { granularity: "grapheme" }) : null;
  const graphemes = (s) => (seg ? [...seg.segment(s)].map((x) => x.segment) : [...s]);
  const EMOJI = /\p{Emoji_Presentation}|\uFE0F|\u20E3|\p{Regional_Indicator}/u;
  const SPACE = /[\s​⁠﻿]/g;
  const squeeze = (s) => s.replace(SPACE, "");
  const inline = new Set(["inline", "inline-block", "contents"]);
  const roots = opts.select ? [] : [...document.querySelectorAll(opts.scope || "body")];
  const visible = (el) => {
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const blockOf = (node) => {
    let el = node.parentElement;
    while (el && el !== document.body && inline.has(getComputedStyle(el).display)) el = el.parentElement;
    return el;
  };
  // the blocks and their text nodes, in document order
  const blocks = new Map();
  const add = (block, node) => {
    if (!blocks.has(block)) blocks.set(block, []);
    blocks.get(block).push(node);
  };
  if (opts.select) {
    for (const el of document.querySelectorAll(opts.select)) {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) add(el, n);
    }
  } else {
    for (const root of roots) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        // whitespace-only nodes stay: React renders the spaces between tied pieces and between sentence spans as nodes
        // of their own, and without them "가요. 나요." reads as one sentence and every copy() block skips the sentence rule
        acceptNode: (n) => (n.parentElement?.closest("script, style, svg, noscript, template") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const b = blockOf(n);
        if (b) add(b, n);
      }
    }
  }
  const path = (el) => {
    const out = [];
    for (let e = el; e && e !== document.body && out.length < 6; e = e.parentElement) {
      const c = [...e.classList].slice(0, 2).join(".");
      out.unshift(c ? `${e.tagName.toLowerCase()}.${c}` : e.tagName.toLowerCase());
    }
    return out.join(" > ");
  };
  const classChain = (el) => {
    const out = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) out.push(...e.classList);
    return out;
  };
  const levelsOf = (el) => {
    const out = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) out.push([...e.classList]);
    return out;
  };
  const canvas = document.createElement("canvas").getContext("2d");
  const widthOf = (text, el) => {
    const cs = getComputedStyle(el);
    canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const ls = parseFloat(cs.letterSpacing) || 0;
    return canvas.measureText(text).width + ls * [...text].length;
  };
  // a block's characters (per code point) and its lines (grouped by vertical centre); a clamped block stops at its bottom
  const layout = (nodes, bottom) => {
    const chars = [];
    const lines = [];
    const twice = [];
    for (const node of nodes) {
      const t = node.textContent;
      let i = 0;
      for (const ch of t) {
        const len = ch.length;
        const rg = document.createRange();
        rg.setStart(node, i);
        rg.setEnd(node, i + len);
        i += len;
        const sized = [...rg.getClientRects()].filter((q) => q.width > 0 || q.height > 0);
        const r = sized[0];
        const blank = !squeeze(ch);
        if (!r || (blank && r.width === 0)) {
          chars.push({ ch, line: lines.length ? lines.length - 1 : 0, w: 0, el: node.parentElement, blank });
          continue;
        }
        if (r.top >= bottom - 1) return { chars, lines, twice };
        const cy = (r.top + r.bottom) / 2;
        // one character laid out on two lines at once: WebKit's pretty with nowrap inline runs put "찾아" at the end
        // of one line and the start of the next, and drew it twice (k_place_search, 263 px, before ties were boxes)
        if (!blank && sized.slice(1).some((q) => Math.abs((q.top + q.bottom) / 2 - cy) > q.height / 2)) twice.push(chars.length);
        let li = lines.findIndex((l) => Math.abs(l.cy - cy) < Math.max(3, 0.35 * Math.min(l.h, r.height)));
        if (li < 0) {
          lines.push({ cy, h: r.height, right: -Infinity, ink: false });
          li = lines.length - 1;
        }
        if (!blank) {
          lines[li].right = Math.max(lines[li].right, r.right);
          lines[li].ink = true;
        }
        chars.push({ ch, line: li, w: r.width, el: node.parentElement, blank });
      }
    }
    return { chars, lines, twice };
  };
  // copy rules on a block: pretty on it, or sentence blocks (inline-block .t-s) in it
  const prettyOn = (el) => /pretty/.test(getComputedStyle(el).textWrapStyle || getComputedStyle(el).textWrap || "");
  const sentenceBlocks = (block) => [...block.querySelectorAll(".t-s")].filter((e) => blockOf(e) === block);
  // the same block laid out with plain wrap (pretty off, sentence blocks inline), then put back. Only the wrap STYLE
  // goes: the `text-wrap` shorthand also sets text-wrap-mode, and on a tie (.t-tie: nowrap, pretty inherited)
  // it untied the pieces, so the plain count came out short and pretty "gained" a line it never added
  const styleLonghand = CSS.supports("text-wrap-style", "auto");
  const nowrap = (el) => {
    const cs = getComputedStyle(el);
    return cs.textWrapMode === "nowrap" || /^(nowrap|pre)$/.test(cs.whiteSpace);
  };
  const plainLines = (block, nodes, bottom) => {
    const touched = [block, ...block.querySelectorAll("*")].filter((e) => prettyOn(e) || e.matches(".t-s"));
    const saved = touched.map((e) => [e, e.getAttribute("style")]);
    for (const e of touched) {
      if (styleLonghand) e.style.setProperty("text-wrap-style", "auto", "important");
      else if (!nowrap(e)) e.style.setProperty("text-wrap", "wrap", "important");
      if (e.matches(".t-s")) e.style.setProperty("display", "inline", "important");
    }
    const n = layout(nodes, bottom).lines.filter((l) => l.ink).length;
    for (const [e, style] of saved) {
      if (style === null) e.removeAttribute("style");
      else e.setAttribute("style", style);
    }
    return n;
  };
  const narrow = [];
  let scanned = 0;
  let multiline = 0;
  const units = [];
  for (const [block, nodes] of blocks) {
    const cs = getComputedStyle(block);
    const rect = block.getBoundingClientRect();
    if (rect.width < 4 || rect.right <= 0 || rect.left >= innerWidth || !visible(block)) continue;
    if (/^(nowrap|pre)$/.test(cs.whiteSpace) || cs.textWrapMode === "nowrap" || cs.textOverflow === "ellipsis") continue;
    const clamped = cs.webkitLineClamp && cs.webkitLineClamp !== "none";
    // rects come transformed (a sheet still scaling in), padding and canvas widths in layout px: sx converts
    const sx = block.offsetWidth > 0 ? rect.width / block.offsetWidth : 1;
    const contentRight = rect.right - ((parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderRightWidth) || 0)) * sx;
    const contentWidth = contentRight - (rect.left + ((parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0)) * sx);
    // characters: per code point, with the line each sits on
    const { chars, lines, twice } = layout(nodes, clamped ? rect.bottom : Infinity);
    if (!lines.length) continue;
    scanned++;
    // lines in reading order (by their centre), and each character's line renumbered to match
    const order = lines.map((l, i) => [l.cy, i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    const rank = new Map(order.map((li, k) => [li, k]));
    for (const c of chars) c.line = rank.get(c.line) ?? c.line;
    const sorted = order.map((i) => lines[i]);
    const text = sorted.map(() => "");
    for (const c of chars) text[c.line] = (text[c.line] ?? "") + c.ch;
    const shown = text.map((s) => s.replace(/\s+/g, " ").trim()).filter((s, k) => squeeze(s) || k === 0);
    if (shown.length > 1) multiline++;
    const findings = [];
    shown.forEach((l, k) => {
      const bare = l.replace(/^[\s​⁠﻿]+|[\s​⁠﻿]+$/g, "");
      if (k < shown.length - 1 && OPEN.test(bare)) findings.push({ rule: "open-end", line: l });
      if (k > 0 && CLOSE.test(bare)) findings.push({ rule: "close-start", line: l });
    });
    const tail = graphemes(squeeze(shown[shown.length - 1]));
    if (shown.length > 1 && tail.length <= 2 && !tail.every((g) => EMOJI.test(g))) findings.push({ rule: "orphan", line: shown[shown.length - 1] });
    // a closing bracket or quote at a line's end with its word going on in the next ("줘” / 처럼")
    chars.forEach((c, k) => {
      const n = chars[k + 1];
      if (n && !c.blank && !n.blank && n.line !== c.line && CLOSE_END.test(c.ch) && WORDY.test(n.ch)) findings.push({ rule: "particle", line: (text[c.line] ?? "").replace(/\s+/g, " ").trim() });
    });
    // a number at a line's end with its unit or counter opening the next ("3만 / 원은")
    shown.forEach((l, k) => {
      if (k === shown.length - 1) return;
      const a = l.split(" ").pop();
      const b = shown[k + 1].split(" ")[0];
      if (NUM_END.test(a) && UNIT.test(b)) findings.push({ rule: "unit", line: `${a} / ${b}` });
    });
    // a one-syllable word cut from the word it leans on, a space between them in the source: forward ("한 / 번",
    // "월 / 최대", "구 / 단위") and back ("예약해 / 둔")
    {
      const flat = chars.map((c) => c.ch).join("").replace(/\s+/g, " ");
      shown.forEach((l, k) => {
        if (k === shown.length - 1) return;
        const a = l.split(" ").pop();
        const b = shown[k + 1].split(" ")[0];
        if (!a || !b || !flat.includes(`${a} ${b}`)) return;
        if (DET.test(a) && DET_NEXT.test(b)) findings.push({ rule: "det", line: `${a} / ${b}` });
        if ((PER.test(a) && PER_NEXT.test(b)) || (AREA.test(a) && AREA_NEXT.test(b))) findings.push({ rule: "per", line: `${a} / ${b}` });
        if (AUX_PREV.test(a.normalize("NFD")) && AUX.test(b)) findings.push({ rule: "aux", line: `${a} / ${b}` });
      });
    }
    // characters on two lines at once, as runs ("찾아")
    let run = null;
    for (const i of twice) {
      if (run && run.end === i - 1) Object.assign(run, { end: i, line: run.line + chars[i].ch });
      else findings.push((run = { rule: "twice", line: chars[i].ch, end: i }));
    }
    for (const f of findings) delete f.end;
    // 0.5 px of slack, and no less: WebKit rounds a Range over part of a text node (a character, a word) outward to
    // whole px from the line's start ('부' [183, 199] with its ink ending at 198.208); only a Range reaching the node's
    // end, at the line box's edge, stays fractional. Chrome keeps fractions everywhere. So in WebKit a line set within
    // 1 px of its box reads 0.5–1 px over without overflowing. The chat's bubbleFit edge() relies on this 0.5: it never
    // makes a bubble more than 0.5 px shorter than the next whole px. Lowering it means revisiting edge() too
    sorted.forEach((l, k) => {
      if (!clamped && l.right > contentRight + 0.5) findings.push({ rule: "overflow", line: (text[k] ?? "").trim(), by: Math.round((l.right - contentRight) * 10) / 10 });
    });
    const all = chars.map((c) => c.ch).join("");
    // emoji side by side on two lines ("🍜 / 🍜"): each cluster sits on the line of its first code point
    if (seg) {
      const at = new Map();
      let off = 0;
      chars.forEach((c, k) => {
        at.set(off, k);
        off += c.ch.length;
      });
      let prev = null;
      for (const { segment, index } of seg.segment(all)) {
        const k = at.get(index);
        const cur = k === undefined ? null : { g: segment, line: chars[k].line, emoji: EMOJI.test(segment) };
        if (prev?.emoji && cur?.emoji && prev.line !== cur.line) findings.push({ rule: "emoji-split", line: `${prev.g} / ${cur.g}` });
        prev = cur;
      }
    }
    // a word holding a number cut inside ("3. / 3만", "3.3% / 이고"), the word narrower than the block
    {
      const off = [];
      let n = 0;
      for (const c of chars) {
        off.push(n);
        n += c.ch.length;
      }
      const DIGIT = /\d/;
      chars.forEach((c, k) => {
        const nx = chars[k + 1];
        if (!nx || c.blank || nx.blank || nx.line === c.line || c.ch === "·" || nx.ch === "(") return;
        const pv = chars[k - 1];
        if (!(DIGIT.test(c.ch) || DIGIT.test(nx.ch) || (/[.,:/–\-%‰°℃]/.test(c.ch) && pv && DIGIT.test(pv.ch)))) return;
        const from = all.slice(0, off[k + 1]).search(/\S*$/);
        const word = all.slice(from).match(/^\S*/)[0];
        if (c.el && widthOf(word, c.el) * sx <= contentWidth - 1) findings.push({ rule: "number", line: `${all.slice(from, off[k + 1])} / ${word.slice(off[k + 1] - from)}` });
      });
      // a word holding a domain cut anywhere inside ("microsoft. / com/devicelogin에"), the word narrower than the block
      chars.forEach((c, k) => {
        const nx = chars[k + 1];
        if (!nx || c.blank || nx.blank || nx.line === c.line || c.ch === "·" || nx.ch === "(") return;
        const from = all.slice(0, off[k + 1]).search(/\S*$/);
        const word = all.slice(from).match(/^\S*/)[0];
        if (URL_IN.test(word) && c.el && widthOf(word, c.el) * sx <= contentWidth - 1) findings.push({ rule: "url", line: `${all.slice(from, off[k + 1])} / ${word.slice(off[k + 1] - from)}` });
      });
    }
    // sentences: split on . ! ? followed by a space; the lines each one's characters sit on
    const pieces = block.closest('[data-lines="prose"]') ? [] : all.split(/(?<=[.!?])\s+/).filter((p) => squeeze(p));
    if (pieces.length > 1) {
      const at = [];
      let n = 0;
      for (const c of chars) {
        at.push(n);
        n += c.ch.length;
      }
      let from = 0;
      for (const p of pieces) {
        const start = all.indexOf(p, from);
        if (start < 0) break;
        from = start + p.length;
        const on = new Set();
        let el = null;
        chars.forEach((c, k) => {
          if (at[k] >= start && at[k] < from && !c.blank) {
            on.add(c.line);
            el ??= c.el;
          }
        });
        if (on.size > 1 && el && widthOf(p.trim(), el) * sx <= contentWidth - 1) findings.push({ rule: "sentence-split", line: p.trim() });
      }
    }
    // copy rules adding lines (see line-gain above); narrow copy blocks listed for their owners
    const sentenceSpans = sentenceBlocks(block).filter((e) => getComputedStyle(e).display === "inline-block");
    const copyBlock = block.classList.contains("t-copy") || prettyOn(block) || sentenceBlocks(block).length > 0;
    const layoutWidth = contentWidth / sx;
    if (copyBlock && layoutWidth < NARROW) narrow.push({ path: path(block), own: [...block.classList], classes: classChain(block), levels: levelsOf(block), text: all.replace(/\s+/g, " ").trim().slice(0, 60), width: Math.round(layoutWidth * 10) / 10, lines: shown });
    if ((prettyOn(block) || sentenceSpans.length) && !clamped) {
      const plain = plainLines(block, nodes, Infinity);
      const now = sorted.filter((l) => l.ink).length;
      const nSentences = all.split(/(?<=[.!?])\s+/).filter((p) => squeeze(p)).length;
      const allowed = layoutWidth < NARROW ? 0 : nSentences > 1 ? 1 : 0;
      if (now - plain > allowed) findings.push({ rule: "line-gain", line: `${plain} → ${now} lines (${nSentences > 1 ? `${nSentences} sentences` : "one sentence"}, ${Math.round(layoutWidth)} px)` });
    }
    if (findings.length || opts.all) units.push({ path: path(block), own: [...block.classList], classes: classChain(block), levels: levelsOf(block), text: all.replace(/\s+/g, " ").trim().slice(0, 60), width: Math.round((contentWidth / sx) * 10) / 10, lines: shown, findings });
  }
  return { scanned, multiline, units, narrow };
}

/** the in-page check on a Playwright page */
export function checkLines(page, opts = {}) {
  return page.evaluate(linesInPage, opts);
}

/** one line per finding, for logs */
export function describe(units) {
  const out = [];
  for (const u of units) for (const f of u.findings) out.push(`${f.rule}${f.by ? ` +${f.by}px` : ""}: "${f.line}" in ${u.path} (${u.lines.length} lines: ${u.lines.join(" / ")})`);
  return out;
}
