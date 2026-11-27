/**
 * The rendered-page check (DD 1935 §5-3, DD 0059 §6-2): what the JSON check cannot see, measured in the browser on the
 * laid-out pages. `pageCheck` runs inside the page (it is sent as its own source text, so it uses nothing from outside
 * itself); `PAGE_CHECK` is the expression to evaluate. Rule names are DD's: FA4-2, FA4-3, FA4-4, FA4-8, FA4-11 and
 * B2-hero64, B2-captures, B2-overlap, B2-clip, B2-levels, B2-disclaimer, B2-ofl.
 */

export interface DomFail {
  /** the slide number, from 1 */
  n: number;
  rule: string;
  what: string;
  selector?: string;
}

export interface DomReport {
  pages: number;
  kinds: string[];
  fails: DomFail[];
  minFontPx: number;
  overlaps: number;
  clipped: number;
  levelLinesOutside: number;
  /** captures whose picture loaded */
  captures: number;
  /** font faces the page loaded, by family */
  fonts: string[];
}

export interface PageCheckOptions {
  disclaimer: string;
  /** the disclaimer's playbook sentence when the deck asked for it, else null */
  playbook: string | null;
  licence: string;
  /** FA3's colours, #RRGGBB */
  palette: string[];
  fontFamily: string;
}

/** runs in the page: every rule over every section.page */
export function pageCheck(o: PageCheckOptions): DomReport {
  const fails: DomFail[] = [];
  const pal = new Set(o.palette.map((c) => c.toUpperCase()));
  let minFontPx = Infinity;
  let overlaps = 0;
  let clipped = 0;
  let levelLinesOutside = 0;
  let captures = 0;
  const hex2 = (x: number) => Math.round(x).toString(16).padStart(2, "0").toUpperCase();
  // a computed colour → #RRGGBB, or null for none/transparent
  const colour = (c: string): string | null => {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(c.trim());
    if (!m) return null;
    const a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a === 0) return null;
    return "#" + hex2(+m[1]!) + hex2(+m[2]!) + hex2(+m[3]!);
  };
  const sel = (el: Element): string => {
    const parts: string[] = [];
    let e: Element | null = el;
    while (e && !(e.tagName === "SECTION" && e.classList.contains("page"))) {
      const cls = [...e.classList].slice(0, 2).map((c) => "." + c).join("");
      const p: Element | null = e.parentElement;
      const nth = p ? [...p.children].indexOf(e) + 1 : 1;
      parts.unshift(`${e.tagName.toLowerCase()}${cls}:nth-child(${nth})`);
      e = p;
    }
    return parts.join(" > ");
  };
  // the floor a text's size is held to: the nearest marker among its ancestors (FA2, FA8)
  const floorOf = (el: Element): [number, string] => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      // a second source's value under a figure (.conf) is a note too
      if (e.classList.contains("foot") || e.classList.contains("t-foot") || e.classList.contains("conf")) return [14, "각주"];
      if (e.classList.contains("tbl") || e.classList.contains("t-table")) return [15, "표"];
      if (e.classList.contains("t-body")) return [19, "본문"];
      if (e.tagName === "SECTION") break;
    }
    return [12, "글자"];
  };
  const pages = [...document.querySelectorAll("section.page")];
  const kinds = pages.map((p) => p.getAttribute("data-kind") ?? "");
  pages.forEach((page, pi) => {
    const n = pi + 1;
    const fail = (rule: string, what: string, el?: Element) => fails.push(el ? { n, rule, what, selector: sel(el) } : { n, rule, what });
    const pr = page.getBoundingClientRect();
    const inSvg = (el: Element) => el instanceof SVGElement;
    // ---- text: sizes, boxes
    type Box = { owner: number; el: Element; l: number; t: number; r: number; b: number; el2: { t: number; b: number } };
    const boxes: Box[] = [];
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    let owner = 0;
    const seenSvgText = new Set<Element>();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      const el = node.parentElement!;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      owner++;
      let px = parseFloat(cs.fontSize);
      if (inSvg(el)) {
        const svg = (el as SVGElement).ownerSVGElement;
        const m = svg?.getScreenCTM();
        if (m) px *= Math.hypot(m.a, m.b);
        // one box per <text> element
        const t = el.closest("text") ?? el;
        if (seenSvgText.has(t)) continue;
        seenSvgText.add(t);
        const r = t.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const c = (r.top + r.bottom) / 2;
          boxes.push({ owner, el: t, l: r.left, t: r.top, r: r.right, b: r.bottom, el2: { t: c - px / 2, b: c + px / 2 } });
        }
      } else {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.width < 0.5 || r.height < 0.5) continue;
          const c = (r.top + r.bottom) / 2;
          boxes.push({ owner, el, l: r.left, t: r.top, r: r.right, b: r.bottom, el2: { t: c - px / 2, b: c + px / 2 } });
        }
      }
      px = Math.round(px * 100) / 100;
      if (px < minFontPx) minFontPx = px;
      const [floor, word] = floorOf(el);
      if (px < 12) fail("FA4-2", `글자 ${px}px(12px 아래)`, el);
      else if (px < floor) fail("FA4-2", `${word} 글자 ${px}px(${floor}px 아래)`, el);
    }
    // ---- B2-clip: outside the page, past the margins, onto the footer band
    for (const x of boxes) {
      const inFoot = !!x.el.closest(".foot");
      if (x.l < pr.left - 0.5 || x.r > pr.right + 0.5 || x.t < pr.top - 0.5 || x.b > pr.bottom + 0.5) {
        clipped++;
        fail("B2-clip", "글자가 장 밖으로 나가요", x.el);
      } else if (x.l < pr.left + 64 - 0.5 || x.r > pr.left + 1216 + 0.5) {
        clipped++;
        fail("B2-clip", "글자가 좌우 여백(64px)에 들어가요", x.el);
      } else if (!inFoot && x.el2.b > pr.top + 676) {
        clipped++;
        fail("B2-clip", "글자가 푸터 줄에 닿아요", x.el);
      }
    }
    for (const el of [page, ...page.querySelectorAll("*")]) {
      const cs = getComputedStyle(el);
      if (inSvg(el) || !/(hidden|clip|auto|scroll)/.test(cs.overflowX + cs.overflowY)) continue;
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
        clipped++;
        fail("B2-clip", `넘친 내용이 잘려요(${el.scrollWidth}×${el.scrollHeight} > ${el.clientWidth}×${el.clientHeight})`, el);
      }
    }
    // ---- B2-overlap: two texts' em boxes crossing
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.owner === b.owner) continue;
        const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
        const h = Math.min(a.el2.b, b.el2.b) - Math.max(a.el2.t, b.el2.t);
        if (w > 1 && h > 1) {
          overlaps++;
          fail("B2-overlap", `글자가 겹쳐요: "${(a.el.textContent ?? "").trim().slice(0, 16)}" / "${(b.el.textContent ?? "").trim().slice(0, 16)}"`, a.el);
        }
      }
    }
    // ---- FA4-2: table cells of five lines or more
    for (const td of page.querySelectorAll(".tbl td, .tbl th")) {
      const range = document.createRange();
      range.selectNodeContents(td);
      const tops: number[] = [];
      for (const r of range.getClientRects()) {
        if (r.width < 0.5) continue;
        const c = (r.top + r.bottom) / 2;
        if (!tops.some((t) => Math.abs(t - c) < 4)) tops.push(c);
      }
      if (tops.length >= 5) fail("FA4-2", `표 칸이 ${tops.length}줄이에요(5줄 이상)`, td);
    }
    // ---- FA4-3: pictures only as charts, captures, signal chips
    for (const el of page.querySelectorAll("svg, img")) {
      if (el.parentElement?.closest("svg")) continue;
      const viz = el.closest("[data-viz]")?.getAttribute("data-viz");
      const ok = el.tagName === "IMG" ? el.getAttribute("data-viz") === "capture" : viz != null && viz !== "capture" && viz !== "hand-mark";
      if (!ok) fail("FA4-3", `차트·캡처·신호 칩이 아닌 ${el.tagName.toLowerCase()}`, el);
    }
    // ---- FA4-4: gradients, glass, heavy shadows, colours outside FA3
    for (const el of page.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (/gradient\(/.test(cs.backgroundImage)) fail("FA4-4", "장 배경 밖의 그라디언트", el);
      const bf = cs.getPropertyValue("backdrop-filter") || cs.getPropertyValue("-webkit-backdrop-filter");
      if (bf && bf !== "none") fail("FA4-4", "backdrop-filter", el);
      if (cs.boxShadow && cs.boxShadow !== "none") {
        for (const sh of cs.boxShadow.split(/,(?![^(]*\))/)) {
          const lens = sh.replace(/rgba?\([^)]*\)/, "").trim().split(/\s+/).filter((x) => /px$/.test(x)).map(parseFloat);
          if ((lens[2] ?? 0) > 8) fail("FA4-4", `그림자 흐림 ${lens[2]}px(8px 넘음)`, el);
        }
      }
      // only what is painted: an svg or g carries the initial black fill without drawing it
      const used: string[] = [];
      if (inSvg(el)) {
        const t = el.tagName;
        const stroked = cs.stroke !== "none" && parseFloat(cs.strokeWidth) > 0;
        if (/^(rect|circle|ellipse|path|polygon|polyline|text|tspan)$/.test(t)) used.push(cs.fill);
        if (/^(rect|circle|ellipse|path|polygon|polyline|line|text|tspan)$/.test(t) && stroked) used.push(cs.stroke);
        if (t === "stop") used.push(cs.getPropertyValue("stop-color"));
      } else {
        const hasText = [...el.childNodes].some((c) => c.nodeType === 3 && c.nodeValue!.trim());
        if (hasText) used.push(cs.color);
        used.push(cs.backgroundColor);
        for (const side of ["top", "right", "bottom", "left"]) {
          if (parseFloat(cs.getPropertyValue(`border-${side}-width`)) > 0 && cs.getPropertyValue(`border-${side}-style`) !== "none") used.push(cs.getPropertyValue(`border-${side}-color`));
        }
      }
      for (const u of used) {
        const h = colour(u);
        if (h && !pal.has(h)) {
          fail("FA4-4", `FA3 밖의 색 ${h}`, el);
          break;
        }
      }
    }
    // ---- FA4-8: a chart says its unit, basis and source in its own text; a page of figures names its sources
    // a chart with a value axis: 단위 … · as of · source; the timeline (a time axis only): as of · source
    for (const v of page.querySelectorAll('[data-viz="chart"], [data-viz="level-chart"], [data-viz="timeline"]')) {
      const parts = (v.querySelector('text[data-role="caption"]')?.textContent ?? "").split(" · ").filter((x) => x.trim());
      const timeline = v.getAttribute("data-viz") === "timeline";
      const unit = timeline || /^단위 \S/.test(parts[0] ?? "");
      const asOf = parts.slice(timeline ? 0 : 1).findIndex((x) => /\d{1,2}월 \d{1,2}일/.test(x));
      if (!unit || asOf !== 0 || parts.length < (timeline ? 2 : 3)) fail("FA4-8", timeline ? "타임라인에 기준·출처 줄이 없어요" : "차트에 단위·기준·출처 줄이 없어요", v);
    }
    const footL = page.querySelector(".foot .l")?.textContent ?? "";
    const isLast = n === pages.length;
    if (!isLast && (page.querySelector(".fig") || page.querySelector('[data-viz]:not([data-viz="chip"]):not([data-viz="hand-mark"])')) && !footL.startsWith("출처: ")) {
      fail("FA4-8", "숫자나 차트가 있는데 푸터에 출처가 없어요", page.querySelector(".foot") ?? page);
    }
    // ---- FA4-11, B2-captures: every capture loaded, with caption, source, time and grade
    for (const fig of page.querySelectorAll("figure.cap")) {
      const img = fig.querySelector("img") as HTMLImageElement | null;
      if (!img || !img.complete || img.naturalWidth === 0) fail("FA4-11", "캡처 그림을 읽지 못했어요", fig);
      else captures++;
      if (!(fig.querySelector(".cc")?.textContent ?? "").trim()) fail("FA4-11", "캡처에 캡션이 없어요", fig);
      const meta = fig.querySelector(".cm")?.textContent ?? "";
      if (!/\d{1,2}:\d{2}/.test(meta) || meta.split("·").length < 3) fail("FA4-11", "캡처에 출처·시각·등급이 없어요", fig);
      if (!img?.getAttribute("data-url")) fail("FA4-11", "캡처에 원래 주소가 없어요", fig);
    }
    // ---- B2-hero64
    for (const h of page.querySelectorAll(".hero h1")) {
      const px = parseFloat(getComputedStyle(h).fontSize);
      if (px < 64) fail("B2-hero64", `표지 제목 ${px}px(64px 아래)`, h);
    }
    // ---- B2-levels: level lines inside the plot
    for (const v of page.querySelectorAll('[data-viz="level-chart"]')) {
      const [y0, y1] = (v.getAttribute("data-plot") ?? "").split(",").map(Number);
      if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
      for (const ln of v.querySelectorAll("[data-level]")) {
        const ys = ln.tagName === "rect" ? [+ln.getAttribute("y")!, +ln.getAttribute("y")! + +ln.getAttribute("height")!] : [+ln.getAttribute("y1")!, +ln.getAttribute("y2")!];
        if (ys.some((y) => !(y >= y0! - 0.5 && y <= y1! + 0.5))) {
          levelLinesOutside++;
          fail("B2-levels", `${ln.getAttribute("data-level")} 선이 축 밖이에요`, ln);
        }
      }
    }
    // ---- B2-ofl: the licence line only in the last page's footer, 14px #7B8089 on the baseline at 700
    const lic = [...page.querySelectorAll(".foot span")].find((s) => s.textContent === o.licence);
    if (isLast) {
      if (!lic) fail("B2-ofl", "마지막 장 푸터에 글꼴 표기가 없어요", page.querySelector(".foot") ?? page);
      else {
        const cs = getComputedStyle(lic);
        // not a span: the footer's span rule would take it out of the line
        const probe = document.createElement("i");
        probe.style.cssText = "position:static;display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";
        lic.appendChild(probe);
        const base = probe.getBoundingClientRect().bottom - pr.top;
        probe.remove();
        if (parseFloat(cs.fontSize) !== 14) fail("B2-ofl", `글꼴 표기 ${cs.fontSize}(14px)`, lic);
        if (colour(cs.color) !== "#7B8089") fail("B2-ofl", `글꼴 표기 색 ${colour(cs.color)}(#7B8089)`, lic);
        if (Math.abs(base - 700) > 0.5) fail("B2-ofl", `글꼴 표기 기준선 y ${base.toFixed(1)}(700)`, lic);
      }
    } else if ((page.textContent ?? "").includes("SIL OFL")) fail("B2-ofl", "글꼴 표기는 마지막 장에만 있어요", page);
    // ---- B2-disclaimer: the last page says it word for word
    if (isLast) {
      const ps = [...page.querySelectorAll(".dc p:not(.when)")].map((p) => p.textContent);
      const want = o.playbook ? [o.disclaimer, o.playbook] : [o.disclaimer];
      if (ps.length !== want.length || ps.some((t, i) => t !== want[i])) fail("B2-disclaimer", "마지막 장의 면책 문장이 글자 그대로가 아니에요", page);
    }
  });
  const fonts = [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/^"|"$/g, ""));
  if (!fonts.includes(o.fontFamily) || !document.fonts.check(`19px "${o.fontFamily}"`)) fails.push({ n: 0, rule: "B2-font", what: `${o.fontFamily} 글꼴을 읽지 못했어요` });
  return { pages: pages.length, kinds, fails, minFontPx: minFontPx === Infinity ? 0 : minFontPx, overlaps, clipped, levelLinesOutside, captures, fonts: [...new Set(fonts)] };
}

/** the expression the page evaluates: the check's own source, called with its options */
export function pageCheckExpression(o: PageCheckOptions): string {
  return `(${pageCheck.toString()})(${JSON.stringify(o)})`;
}
