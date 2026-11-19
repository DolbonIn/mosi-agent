/*
 * 모시 draft comparison viewer: 현재 | A | B per feature, critique panel, live iframes, overlay wipe.
 * No build, no framework, no network beyond this folder. Data sources (see FORMAT.md):
 *   manifest.json                 features (title, owner, critique, score, 현재 screens)
 *   _status.json                  feature folders and their files with mtimes (serve.ts; static copy in the bundle)
 *   <feature>/meta.json           variants (FORMAT.md). Optional: drafts made with _kit/ are also discovered from
 *                                 <variant>[-<state>].html + its #kit-meta block + png/<base>-<theme>[-webkit].png
 *   <feature>/notes.md            trade-offs and recommendation
 * In the publish bundle every text file comes from bundle-data.json and live mocks are inlined (srcdoc).
 */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const W = 390;
  const H = 844;
  const RESERVED_HASH = new Set(["settings", "sidebar", "customize", "upgrade", "downloads"]);

  let CFG = {
    shots: "../impeccable/shots/",
    critique: "../impeccable/critique/",
    inventory: "../impeccable/slop-inventory.md",
    status: "_status.json",
    engines: ["chromium", "webkit"],
    poll: 10000,
    data: null,
  };
  try {
    CFG = Object.assign(CFG, JSON.parse($("#viewer-config").textContent));
  } catch (e) {
    /* defaults */
  }

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("dv:" + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("dv:" + k, JSON.stringify(v));
      } catch (e) {
        /* private mode */
      }
    },
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const S = {
    manifest: [],
    status: null, // { features: { f: { rel: mtime } } }
    statusOk: true,
    metas: {}, // f -> { meta, ver, err }
    notes: {}, // f -> { text, ver }
    kit: {}, // "f/file.html" -> { data, ver }
    crit: {}, // f -> parsed critique
    inv: null, // parsed slop inventory
    sigs: {}, // f -> status signature
    cur: null,
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
    mode: store.get("mode", "shot"),
    engine: store.get("engine", "chromium"),
    compare: store.get("compare", "side"),
    focus: -1,
    scrollTo: null, // one-shot panel scroll target: "slop" | "question" | "questions" | issue id
    q: null, // highlighted critique question number (fixes critique:Q<n>)
    xi: null, // another feature's Priority Issue (fixes <feature>:P<n>): { f, id }
    screen: {}, // f -> 현재 screen key
    state: {}, // f -> draft state key
    tab: store.get("tab", "critique"),
    hl: null,
    slop: null,
    wipe: 50,
    expandAll: false,
    lastPoll: null,
    B: null, // bundle data
    canPick: !CFG.data, // picks need serve.ts; the static bundle is read-only
    picks: {}, // server picks.json: feature -> { choice, memo, submittedAt, status, owner?, commit?, note?, history }
    picksText: "",
    local: store.get("picks", {}), // unsent picks: feature -> { choice, memo }
    submitting: false,
  };
  if (!CFG.engines.includes(S.engine)) S.engine = CFG.engines[0];

  /* ── fetch layer (bundle-aware) ──────────────────────────────────── */
  async function getText(url) {
    if (S.B) {
      const key = decodeURIComponent(url.split("?")[0]);
      if (Object.prototype.hasOwnProperty.call(S.B.files, key)) return S.B.files[key];
      if (Object.prototype.hasOwnProperty.call(S.B.live, key)) return S.B.live[key];
      throw new Error("not in bundle: " + key);
    }
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status + " " + url);
    return r.text();
  }
  const getJSON = async (url) => JSON.parse(await getText(url));
  const verQ = (v) => (v ? `?v=${v}` : "");

  /* ── tiny safe markdown: headings, lists, code, bold, italics, tables; everything else escaped ── */
  function inline(s) {
    const codes = [];
    let t = String(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    t = esc(t);
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1");
    t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*\w])\*(?![\s*])(.+?)\*(?![*\w])/g, "$1<em>$2</em>");
    t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
    return t;
  }
  function md(src, opts = {}) {
    const L = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    const st = [];
    let para = [];
    const shift = opts.shift ?? 2;
    const flushP = () => {
      if (para.length) {
        out.push(`<p>${inline(para.join(" "))}</p>`);
        para = [];
      }
    };
    const closeTo = (n) => {
      while (st.length && st[st.length - 1].n > n) out.push(`</li></${st.pop().t}>`);
    };
    const isItem = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
    for (let i = 0; i < L.length; i++) {
      const line = L[i];
      if (/^\s*```/.test(line)) {
        flushP();
        closeTo(-1);
        const buf = [];
        i++;
        while (i < L.length && !/^\s*```/.test(L[i])) buf.push(L[i++]);
        out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
        continue;
      }
      if (!line.trim()) {
        flushP();
        let j = i + 1;
        while (j < L.length && !L[j].trim()) j++;
        if (st.length && !(j < L.length && (isItem(L[j]) || /^\s{2,}\S/.test(L[j])))) closeTo(-1);
        continue;
      }
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*$/))) {
        flushP();
        closeTo(-1);
        const lv = Math.min(6, m[1].length + shift);
        out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) && !st.length) {
        flushP();
        out.push("<hr>");
        continue;
      }
      if (/^\s*\|/.test(line) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}/.test(L[i + 1])) {
        flushP();
        closeTo(-1);
        const cells = (l) =>
          l
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < L.length && /^\s*\|/.test(L[i])) rows.push(cells(L[i++]));
        i--;
        out.push(
          `<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table></div>`,
        );
        continue;
      }
      if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
        flushP();
        const n = m[1].length;
        const t = /\d/.test(m[2]) ? "ol" : "ul";
        if (!st.length || n > st[st.length - 1].n) {
          out.push(`<${t}><li>`);
          st.push({ t, n });
        } else {
          closeTo(n);
          if (!st.length) {
            out.push(`<${t}><li>`);
            st.push({ t, n });
          } else if (st[st.length - 1].t !== t) {
            out.push(`</li></${st.pop().t}><${t}><li>`);
            st.push({ t, n });
          } else out.push("</li><li>");
        }
        out.push(inline(m[3]));
        continue;
      }
      if (st.length && /^\s+\S/.test(line)) {
        out.push(" " + inline(line.trim()));
        continue;
      }
      if ((m = line.match(/^\s*>\s?(.*)$/))) {
        flushP();
        closeTo(-1);
        out.push(`<blockquote>${inline(m[1])}</blockquote>`);
        continue;
      }
      if (st.length) closeTo(-1);
      para.push(line.trim());
    }
    flushP();
    closeTo(-1);
    return out.join("");
  }

  /* ── critique + inventory parsing ────────────────────────────────── */
  function sectionsOf(text) {
    const sections = {};
    let name = "_head";
    let buf = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^## (.+)$/);
      if (m) {
        sections[name] = buf.join("\n");
        name = m[1].trim();
        buf = [];
      } else buf.push(line);
    }
    sections[name] = buf.join("\n");
    return sections;
  }
  function parseCritique(src) {
    const text = String(src).replace(/\r\n?/g, "\n");
    const sections = sectionsOf(text);
    const find = (p) => Object.keys(sections).find((k) => k.startsWith(p));
    const issues = [];
    const count = {};
    let cur = null;
    for (const line of (sections[find("Priority Issues")] || "").split("\n")) {
      const m = line.match(/^\*\*\[(P\d)\]\s*(.+?)\*\*\s*$/);
      if (m) {
        count[m[1]] = (count[m[1]] || 0) + 1;
        cur = { sev: m[1], id: `${m[1]}-${count[m[1]]}`, title: m[2], body: [], src: "A" };
        issues.push(cur);
      } else if (cur) cur.body.push(line);
    }
    const bsec = sections[find("Assessment B")] || "";
    const bline = bsec.split("\n").find((l) => /B caught, A missed/.test(l)) || "";
    const after = bline.replace(/^.*?B caught, A missed:?\**:?\s*/, "");
    const re = /\*\*\[(P\d)\]\s*([^*]*?)\*\*:?\s*([\s\S]*?)(?=\s*\*\*\[P\d\]|$)/g;
    let m;
    while ((m = re.exec(after))) {
      const sev = m[1];
      count[sev] = (count[sev] || 0) + 1;
      let desc = m[3].trim();
      let title = m[2].trim();
      if (!title) {
        const cut = desc.search(/[.;:](\s|$)/);
        title = cut > 0 ? desc.slice(0, cut) : desc;
        desc = cut > 0 ? desc.slice(cut + 1).trim() : "";
      }
      issues.push({ sev, id: `${sev}-${count[sev]}`, title, body: [desc], src: "B" });
    }
    issues.sort((a, b) => a.sev.localeCompare(b.sev) || Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]));
    // "Questions to Consider": top-level list items, numbered from 1 (fixes may say critique:Q<n>)
    const questions = [];
    for (const line of (sections[find("Questions")] || "").split("\n")) {
      const qm = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
      if (qm) questions.push(qm[1]);
      else if (questions.length && /^\s+\S/.test(line)) questions[questions.length - 1] += " " + line.trim();
    }
    const tm = text.match(/\*\*Total\*\*\s*\|\s*\*\*(.+?)\*\*\s*\|\s*\*\*(.+?)\*\*/);
    const title = (text.match(/^# Critique:\s*(.+)$/m) || [])[1] || "";
    return { title, score: tm ? tm[1] : null, band: tm ? tm[2] : null, issues, questions, sections, raw: text };
  }
  function parseInventory(src) {
    const text = String(src).replace(/\r\n?/g, "\n");
    const out = [];
    const rows = [];
    let cur = null;
    let h2 = "";
    let head = null;
    for (const line of text.split("\n")) {
      const h = line.match(/^###\s+(\d+\.\d+)\s+(.+)$/);
      const t2 = line.match(/^##\s+(.+)$/);
      if (h) {
        cur = { no: h[1], title: h[2], body: [] };
        out.push(cur);
        head = null;
        continue;
      }
      if (t2) {
        cur = null;
        h2 = t2[1];
        head = null;
        continue;
      }
      if (cur) cur.body.push(line);
      if (/^\|/.test(line)) {
        if (/^\|\s*:?-{2,}/.test(line)) continue;
        if (!head) {
          head = line;
          continue;
        }
        const first = line.replace(/^\|\s*/, "").split("|")[0].trim();
        rows.push({ id: first.replace(/`/g, ""), line, head, where: cur ? `§${cur.no} ${cur.title}` : h2 });
      } else if (line.trim()) head = /^\|/.test(line) ? head : null;
    }
    out.rows = rows;
    return out;
  }
  function rowAsList(r) {
    const cells = (l) =>
      l
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
    const h = cells(r.head);
    return cells(r.line)
      .map((c, i) => `- **${h[i] || ""}:** ${c}`)
      .join("\n");
  }
  function invRow(name) {
    if (!S.inv || !S.inv.rows) return null;
    const n = String(name).replace(/^slop:/i, "").trim();
    if (!/^[A-Z]{2,3}(-R)?-?\d+$/i.test(n) && !/^[a-z][a-z0-9-]+$/.test(n)) return null;
    return S.inv.rows.find((r) => r.id.toLowerCase() === n.toLowerCase()) || null;
  }
  const SLOP_KEYS = [
    ["3.4", /emoji|이모지/],
    ["3.12", /sparkle|jargon|reassur|say-once|kicker|filler|copy|문구|안심/],
    ["3.5", /gradient|purple|그라데이션|그라디언트/],
    ["3.10", /glow|shadow|그림자|lift/],
    ["3.11", /glass|글래스/],
    ["3.1", /icon|tile|plate|아이콘|타일/],
    ["3.7", /chip|pill|칩/],
    ["3.2", /card|nested|stack|recess|panel|카드/],
    ["3.6", /radius|radii|round|라운드/],
    ["3.3", /contrast|grey|gray|대비/],
    ["3.13", /accent|colou?r|hue|blue|색/],
    ["3.12", /copy|filler|reassur|repeat|kicker|say-once|문구|안심/],
    ["3.9", /redundant|header|duplicate|중복/],
    ["3.8", /row|subtitle/],
    ["3.14", /render|alias|quality/],
  ];
  function slopSection(name) {
    if (!S.inv) return null;
    const n = name.toLowerCase();
    const byCode = S.inv.find((s) => s.title.toLowerCase().includes("`" + n + "`") || s.title.toLowerCase().includes(n));
    if (byCode) return byCode;
    const hit = SLOP_KEYS.find(([, re]) => re.test(n));
    return hit ? S.inv.find((s) => s.no === hit[0]) || null : null;
  }

  /* ── features and draft model ────────────────────────────────────── */
  function features() {
    const list = S.manifest.map((m) => Object.assign({}, m));
    const known = new Set(list.map((m) => m.feature));
    for (const f of Object.keys((S.status && S.status.features) || {}).sort()) {
      if (known.has(f)) continue;
      const meta = (S.metas[f] && S.metas[f].meta) || {};
      const critique = meta.critique ? String(meta.critique).split("/").pop() : null;
      list.push({ feature: f, title: meta.title || f, owner: meta.owner || "", score: meta.score || "", critique, screens: [], extra: true });
    }
    return list;
  }
  const featureOf = (f) => features().find((x) => x.feature === f);
  const shotKey = (file) =>
    String(file)
      .split("/")
      .pop()
      .replace(/^(chromium|webkit)-(light|dark)-/, "")
      .replace(/\.(jpe?g|png)$/i, "");
  const filesOf = (f) => (S.status && S.status.features && S.status.features[f]) || null;

  function resolveShot(f, files, rel) {
    if (!rel) return null;
    if (!files) return rel;
    if (files[rel] !== undefined) return rel;
    const low = rel.toLowerCase();
    return Object.keys(files).find((k) => k.toLowerCase() === low) || null;
  }
  function findShot(f, files, base, theme, engine) {
    if (!files || !base) return null;
    const sfx = engine === "webkit" ? "-webkit" : "";
    const cands = [
      `${base}-${theme}${sfx}.jpg`,
      `${base}-${theme}${sfx}.png`,
      `png/${base}-${theme}${sfx}.png`,
      `png/${base}-${theme}${sfx}.jpg`,
      `shots/${base}-${theme}${sfx}.jpg`,
      `shots/${base}-${theme}${sfx}.png`,
    ];
    for (const c of cands) {
      const hit = resolveShot(f, files, c);
      if (hit) return hit;
    }
    return null;
  }
  const HTML_RE = /^([a-z])(?:[-_]([^/]+))?\.html$/i;
  const SHOT_RE = /^(?:png\/|shots\/)?([a-z])(?:[-_](.+?))?-(light|dark)(-webkit)?\.(?:png|jpe?g)$/i;
  const slug = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-");

  /*
   * One draft = variants (A, B …), each with states. A state is one screen of the mock: key "" is the main one.
   * Sources, merged in this order: files on disk (X.html, X-<state>.html, X[-<state>]-<theme>[-webkit].jpg|png,
   * png/…), then meta.json (variant fields = main state; variants[].states[] and variants[].extraShots[] = more states).
   */
  function model(f) {
    const files = filesOf(f);
    const meta = (S.metas[f] && S.metas[f].meta) || null;
    const names = files ? Object.keys(files) : [];
    const kitOf = (html) => (html && S.kit[`${f}/${html}`] && S.kit[`${f}/${html}`].data) || null;
    const V = new Map(); // id -> { id, states: Map(key -> raw) , meta }
    const vget = (id) => {
      id = String(id).toUpperCase();
      if (!V.has(id)) V.set(id, { id, states: new Map(), order: [] });
      return V.get(id);
    };
    const sget = (v, key) => {
      if (!v.states.has(key)) {
        v.states.set(key, { key });
        v.order.push(key);
      }
      return v.states.get(key);
    };
    const exists = (rel) => !!rel && (!files || files[rel] !== undefined);
    for (const n of names) {
      let m;
      if ((m = n.match(HTML_RE)) && !n.includes("/")) sget(vget(m[1]), slug(m[2] || ""));
      else if ((m = n.match(SHOT_RE))) sget(vget(m[1]), slug(m[2] || ""));
    }
    const metaVariants = meta && Array.isArray(meta.variants) ? meta.variants.filter((v) => v && v.id) : [];
    const vMeta = {};
    let mi = 0;
    for (const mv of metaVariants) {
      const v = vget(mv.id);
      vMeta[v.id] = mv;
      const main = sget(v, "");
      main.html = mv.html || main.html;
      main.shots = mv.shots || main.shots;
      main.current = meta.current;
      main.fixes = Array.isArray(mv.fixes) ? mv.fixes : main.fixes;
      main.summary = mv.summary || main.summary;
      for (const ms of Array.isArray(mv.states) ? mv.states : []) {
        const raw = ms.id || ms.key || ms.name || (ms.html ? ms.html.replace(/\.html$/i, "") : "");
        const key = slug(String(raw).replace(new RegExp(`^${v.id}[-_]`, "i"), ""));
        const st = sget(v, key);
        if (st.mi === undefined) st.mi = mi++;
        Object.assign(st, { html: ms.html || st.html, shots: ms.shots || st.shots, current: ms.current || st.current });
        if (ms.name) st.label = ms.name;
        if (Array.isArray(ms.fixes)) st.fixes = ms.fixes;
        if (ms.summary) st.summary = ms.summary;
      }
      for (const es of Array.isArray(mv.extraShots) ? mv.extraShots : []) {
        const file = es.light || es.dark || "";
        const m = file.match(SHOT_RE);
        const key = slug((m && m[2]) || es.id || es.label || "extra");
        const st = sget(v, key);
        if (st.mi === undefined) st.mi = mi++;
        st.shots = Object.assign({}, st.shots, { light: es.light, dark: es.dark });
        if (es.label) st.label = es.label;
        if (es.current) st.current = es.current;
        if (es.html) st.html = es.html;
      }
    }
    const ids = [...V.keys()].sort((a, b) => {
      const ia = metaVariants.findIndex((x) => String(x.id).toUpperCase() === a);
      const ib = metaVariants.findIndex((x) => String(x.id).toUpperCase() === b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    const variants = [];
    for (const id of ids) {
      const v = V.get(id);
      const mv = vMeta[id];
      const rank = (k) => (k === "" ? -1 : v.states.get(k).mi !== undefined ? v.states.get(k).mi : 1000);
      const keys = [...v.order].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      const states = [];
      for (const key of keys) {
        const raw = v.states.get(key);
        const ownHtml = key ? `${id}-${key}.html` : `${id}.html`;
        const lowHtml = key ? `${id.toLowerCase()}-${key}.html` : `${id.toLowerCase()}.html`;
        let html = raw.html || (exists(ownHtml) ? ownHtml : exists(lowHtml) ? lowHtml : null);
        let query = "";
        if (!html) {
          const base = exists(`${id}.html`) ? `${id}.html` : exists(`${id.toLowerCase()}.html`) ? `${id.toLowerCase()}.html` : null;
          if (base) {
            html = base;
            if (key) query = `state=${encodeURIComponent(key)}`;
          }
        }
        const baseName = key ? `${id}-${key}` : id;
        const kit = kitOf(html);
        const shots = {};
        for (const theme of ["light", "dark"]) {
          for (const engine of ["chromium", "webkit"]) {
            const k = engine === "webkit" ? `${theme}-webkit` : theme;
            const given = raw.shots && raw.shots[k];
            shots[k] =
              (given && resolveShot(f, files, given)) ||
              findShot(f, files, baseName, theme, engine) ||
              findShot(f, files, baseName.toLowerCase(), theme, engine);
          }
        }
        if (!html && !shots.light && !shots.dark) continue;
        // a state drawn by the base HTML (?state=) must not inherit the base's kit compare
        const compare = (raw.current || (kit && !query && kit.compare) || []).map(shotKey);
        states.push({
          key,
          label: raw.label || "",
          html,
          query,
          shots,
          compare: compare.filter((k, i) => compare.indexOf(k) === i),
          kit,
          fixes: raw.fixes || (kit && kit.fixes) || null,
          summary: raw.summary || null,
        });
      }
      if (!states.length) continue;
      const k0 = (states.find((s) => s.kit) || {}).kit;
      variants.push({
        id,
        name: (mv && mv.name) || (k0 && k0.title) || "",
        summary: (mv && mv.summary) || (k0 && Array.isArray(k0.rationale) ? k0.rationale[0] : "") || "",
        fixes: (mv && Array.isArray(mv.fixes) ? mv.fixes : null) || (k0 && k0.fixes) || [],
        states,
      });
    }
    const stateKeys = [];
    const stateLabels = {};
    for (const v of variants)
      for (const s of v.states) {
        if (!stateKeys.includes(s.key)) stateKeys.push(s.key);
        if (s.label && !stateLabels[s.key]) stateLabels[s.key] = s.label;
      }
    const current = meta && Array.isArray(meta.current) ? meta.current.map(shotKey) : [];
    const rec = meta && meta.recommended ? String(meta.recommended).toUpperCase() : null;
    return {
      files,
      meta,
      err: S.metas[f] && S.metas[f].err,
      variants,
      stateKeys,
      stateLabels,
      current: current.filter((k, i) => current.indexOf(k) === i),
      recommended: rec,
      motion: meta && meta.motion,
    };
  }

  function statusOf(f) {
    const m = model(f);
    if (m.err && !m.variants.length) return { cls: "st-err", text: "meta.json 확인 필요" };
    if (m.variants.length) {
      if (m.recommended) return { cls: "st-rec", text: `추천 ${m.recommended}` };
      return { cls: "st-ready", text: `${m.variants.map((v) => v.id).join("·")} 준비됨` };
    }
    if (m.files) return { cls: "", text: "작업 중" };
    return { cls: "", text: "시안 없음" };
  }

  /* ── picks (APPLY.md) ─────────────────────────────────────────────── */
  const STATUS_KO = { submitted: "제출됨", applying: "적용 중", review: "확인 중", applied: "적용됨", blocked: "막힘" };
  const choiceKo = (c) => (c === "current" ? "현재 유지" : String(c));
  function pickIds(f) {
    const meta = S.metas[f] && S.metas[f].meta;
    const ids = meta && Array.isArray(meta.variants) ? meta.variants.filter((v) => v && typeof v.id === "string").map((v) => v.id.toUpperCase()) : [];
    return ids.filter((id, i) => ids.indexOf(id) === i);
  }
  const pickable = (f) => S.canPick && !!featureOf(f) && !featureOf(f).extra;
  function pendingOf(f) {
    const l = S.local[f];
    if (!l || !l.choice || !pickable(f)) return null;
    const srv = S.picks[f];
    if (srv && srv.choice === l.choice && (srv.memo || "") === (l.memo || "").trim()) return null;
    return l;
  }
  const pendingList = () => Object.keys(S.local).filter((f) => pendingOf(f));
  function pruneLocal() {
    for (const f of Object.keys(S.local)) {
      const l = S.local[f];
      const srv = S.picks[f];
      const same = srv && l.choice === srv.choice && (l.memo || "").trim() === (srv.memo || "");
      if ((!l.choice && !(l.memo || "").trim()) || same) delete S.local[f];
    }
    store.set("picks", S.local);
  }
  function pickLabel(f) {
    if (!pickable(f)) return null;
    const p = pendingOf(f);
    if (p) return { cls: "st-pend", text: `${choiceKo(p.choice)} 선택 · 제출 전` };
    const srv = S.picks[f];
    if (srv && srv.choice) return { cls: `st-pick st-${srv.status}`, text: `${choiceKo(srv.choice)} · ${STATUS_KO[srv.status] || srv.status}` };
    return null;
  }
  function serverLine(srv) {
    if (!srv) return "";
    const when = (iso) => {
      const d = new Date(iso);
      return isNaN(d) ? "" : d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    };
    const who = srv.owner ? ` · ${esc(srv.owner)}` : "";
    let line = `<strong>${esc(choiceKo(srv.choice))}</strong> · `;
    if (srv.status === "applied")
      line += `적용됨${srv.commit ? ` · <code>${esc(srv.commit.slice(0, 7))}</code>` : ""} · <a href="http://127.0.0.1:5173/" target="_blank" rel="noopener">미리보기에서 보기</a>`;
    else if (srv.status === "blocked") line += `막힘${srv.note ? ` · ${esc(srv.note)}` : ""}`;
    else line += `${esc(STATUS_KO[srv.status] || srv.status)}${who}`;
    if (srv.status === "submitted" && srv.submittedAt) line += ` · ${esc(when(srv.submittedAt))}`;
    if (Array.isArray(srv.history) && srv.history.length) line += ` · 이전 선택 ${srv.history.map((h) => esc(choiceKo(h.choice))).join(", ")}`;
    return line;
  }

  function screensOf(f) {
    const fe = featureOf(f) || {};
    const m = model(f);
    const keys = [...(fe.screens || [])];
    for (const k of m.current) if (!keys.includes(k)) keys.push(k);
    for (const v of m.variants) for (const s of v.states) for (const k of s.compare) if (!keys.includes(k)) keys.push(k);
    if (S.B && S.B.shots) return keys.filter((k) => S.B.shots.includes(k));
    return keys;
  }
  function activeState(f, m) {
    if (!m.stateKeys.length) return null;
    const sel = S.state[f];
    if (sel !== undefined && m.stateKeys.includes(sel)) return sel;
    // default: the state that compares to meta.current, else the first
    for (const v of m.variants) for (const s of v.states) if (m.current.length && s.compare.includes(m.current[0])) return s.key;
    return m.stateKeys[0];
  }
  function activeScreen(f, m) {
    const list = screensOf(f);
    const sel = S.screen[f];
    if (sel && list.includes(sel)) return sel;
    const st = activeState(f, m);
    for (const v of m.variants) {
      const s = v.states.find((x) => x.key === st);
      if (s && s.compare.length && list.includes(s.compare[0])) return s.compare[0];
    }
    if (m.current.length && list.includes(m.current[0])) return m.current[0];
    const fe = featureOf(f) || {};
    if (fe.primary && list.includes(fe.primary)) return fe.primary;
    return list[0] || null;
  }
  // 현재 captures that exist (impeccable/shots/index.json); null = unknown, assume present
  const curExists = (key, engine, theme) => !key || S.B || !S.shotIdx || S.shotIdx.has(`${engine}-${theme}-${key}`);
  async function loadShotIndex() {
    if (S.B || !CFG.shots) return false;
    const t = await getText(CFG.shots + "index.json").catch(() => null);
    if (t === null || t === S.shotIdxText) return false;
    try {
      const j = JSON.parse(t);
      S.shotIdx = new Set((j.shots || []).map((x) => String(x.file || "").replace(/\.(jpe?g|png)$/i, "")));
      S.shotIdxText = t;
      return true;
    } catch (e) {
      return false;
    }
  }
  // bundle: light | dark are packed side by side in one JPEG, addressed as url#L / url#R
  const curShot = (key, engine, theme) =>
    CFG.packed ? `${CFG.shots}${engine}-${key}.jpg#${theme === "dark" ? "R" : "L"}` : `${CFG.shots}${engine}-${theme}-${key}.jpg`;
  const imgTag = (url, alt) => {
    const half = String(url).match(/#([LR])$/);
    return `<img src="${esc(url)}" alt="${esc(alt)}" draggable="false"${half ? ` class="half" style="object-position:${half[1] === "L" ? "0%" : "100%"} 0"` : ""}>`;
  };
  const draftURL = (f, rel, files) => `${f}/${rel.split("/").map(encodeURIComponent).join("/")}${verQ(files && files[rel])}`;

  /* ── data loading + polling ──────────────────────────────────────── */
  async function loadStatus() {
    if (!CFG.status) return null;
    try {
      const st = await getJSON(CFG.status);
      S.statusOk = true;
      return st;
    } catch (e) {
      S.statusOk = false;
      return null;
    }
  }
  async function probeMetas(list) {
    // static hosting without _status.json: try <feature>/meta.json directly
    const features = {};
    await Promise.all(
      list.map(async (fe) => {
        try {
          const txt = await getText(`${fe.feature}/meta.json`);
          const meta = JSON.parse(txt);
          features[fe.feature] = { "meta.json": hash(txt) };
          S.metas[fe.feature] = { meta, ver: hash(txt) };
        } catch (e) {
          /* none yet */
        }
      }),
    );
    return { features, probed: true };
  }
  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }
  async function refreshFeature(f, files, deep) {
    if (!files) {
      delete S.metas[f];
      delete S.notes[f];
      return;
    }
    const jobs = [];
    if (files["meta.json"] !== undefined && (!S.metas[f] || S.metas[f].ver !== files["meta.json"])) {
      jobs.push(
        getText(`${f}/meta.json${verQ(files["meta.json"])}`).then(
          (t) => {
            try {
              S.metas[f] = { meta: JSON.parse(t), ver: files["meta.json"] };
            } catch (e) {
              S.metas[f] = Object.assign({}, S.metas[f], { err: "JSON", ver: files["meta.json"] });
            }
          },
          () => {},
        ),
      );
    } else if (files["meta.json"] === undefined) delete S.metas[f];
    if (files["notes.md"] !== undefined && (!S.notes[f] || S.notes[f].ver !== files["notes.md"])) {
      jobs.push(getText(`${f}/notes.md${verQ(files["notes.md"])}`).then((t) => (S.notes[f] = { text: t, ver: files["notes.md"] }), () => {}));
    } else if (files["notes.md"] === undefined) delete S.notes[f];
    if (deep) {
      for (const h of Object.keys(files).filter((n) => !n.includes("/") && /^[a-z](?:[-_][^/]+)?\.html$/i.test(n))) {
        const k = `${f}/${h}`;
        if (S.kit[k] && S.kit[k].ver === files[h]) continue;
        jobs.push(
          getText(`${f}/${encodeURIComponent(h)}${verQ(files[h])}`).then(
            (t) => {
              const m = t.match(/<script[^>]*id=["']kit-meta["'][^>]*>([\s\S]*?)<\/script>/i);
              let data = null;
              try {
                data = m ? JSON.parse(m[1]) : null;
              } catch (e) {
                data = null;
              }
              S.kit[k] = { data, ver: files[h] };
            },
            () => {},
          ),
        );
      }
    }
    await Promise.all(jobs);
  }

  async function poll(first) {
    try {
      const man = await getJSON("manifest.json").catch(() => null);
      if (Array.isArray(man)) S.manifest = man;
      let st = await loadStatus();
      if (!st) st = await probeMetas(S.manifest);
      const prevSigs = S.sigs;
      S.status = st;
      const all = new Set([...Object.keys(st.features || {}), ...Object.keys(prevSigs)]);
      const changed = new Set();
      await Promise.all(
        [...all].map(async (f) => {
          const files = (st.features || {})[f] || null;
          const sig = files ? JSON.stringify(files) : "";
          if (st.probed) {
            S.sigs[f] = sig;
            if (sig !== prevSigs[f]) changed.add(f);
            return;
          }
          if (sig !== prevSigs[f] || (f === S.cur && files && !kitLoaded(f, files))) {
            await refreshFeature(f, files, f === S.cur);
            S.sigs[f] = sig;
            changed.add(f);
          }
        }),
      );
      for (const f of Object.keys(S.sigs)) if (!(f in (st.features || {})) && !st.probed) delete S.sigs[f];
      let picksChanged = false;
      let curPickChanged = false;
      if (S.canPick) {
        const t = await getText("picks.json").catch(() => null);
        if (t !== null && t !== S.picksText) {
          let next = null;
          try {
            next = JSON.parse(t) || {};
          } catch (e) {
            next = null; // mid-write or hand-edited: keep the last good copy
          }
          if (next && typeof next === "object") {
            curPickChanged = JSON.stringify(next[S.cur] || null) !== JSON.stringify(S.picks[S.cur] || null);
            S.picks = next;
            S.picksText = t;
            picksChanged = true;
            pruneLocal();
          }
        }
      }
      const idxChanged = await loadShotIndex();
      S.lastPoll = new Date();
      if (first) {
        selectFromHash(true);
        return;
      }
      renderRail();
      if (changed.has(S.cur)) {
        renderBar();
        renderScreens();
        renderStage();
        renderPanel();
      } else if (curPickChanged || idxChanged) {
        if (idxChanged) renderScreens();
        renderStage();
      }
      if (changed.has(S.cur) || picksChanged) renderPick();
      updateSubmit();
    } catch (e) {
      console.warn("draft viewer poll", e);
    } finally {
      const note = $("#poll-note");
      if (note && S.B) note.textContent = `스냅숏 · ${new Date(S.B.at || Date.now()).toLocaleString("ko-KR", { hour12: false })}`;
      else if (note && S.lastPoll) note.textContent = `10초마다 확인 · ${S.lastPoll.toLocaleTimeString("ko-KR", { hour12: false })}`;
    }
  }
  function kitLoaded(f, files) {
    return Object.keys(files)
      .filter((n) => !n.includes("/") && /^[a-z](?:[-_][^/]+)?\.html$/i.test(n))
      .every((h) => S.kit[`${f}/${h}`] && S.kit[`${f}/${h}`].ver === files[h]);
  }
  async function ensureCritique(f) {
    if (S.crit[f]) return S.crit[f];
    const fe = featureOf(f) || {};
    const name = fe.critique || (fe.extra ? null : `${f}.md`);
    if (!name) return (S.crit[f] = { title: "", issues: [], sections: {}, raw: "", missing: true });
    try {
      S.crit[f] = parseCritique(await getText(CFG.critique + name));
    } catch (e) {
      S.crit[f] = { title: "", issues: [], sections: {}, raw: "", missing: true };
    }
    return S.crit[f];
  }
  async function ensureInventory() {
    if (S.inv) return;
    try {
      S.inv = parseInventory(await getText(CFG.inventory));
    } catch (e) {
      S.inv = [];
    }
  }

  /* ── selection + routing ─────────────────────────────────────────── */
  const hashFor = (f) => (RESERVED_HASH.has(f) || f.startsWith("comment-") ? `${f}-page` : f);
  const fromHash = (h) => {
    const list = features();
    return (list.find((x) => hashFor(x.feature) === h) || list.find((x) => x.feature === h) || {}).feature;
  };
  function selectFromHash(first) {
    const h = decodeURIComponent(location.hash.replace(/^#/, ""));
    const f = fromHash(h) || store.get("cur", null);
    select(featureOf(f) ? f : (features()[0] || {}).feature, { first, keepHash: !!fromHash(h) });
  }
  async function select(f, opts = {}) {
    if (!f) return;
    const changed = f !== S.cur;
    S.cur = f;
    store.set("cur", f);
    if (changed) {
      S.hl = null;
      S.slop = null;
      S.q = null;
      S.xi = null;
      S.focus = -1;
    }
    if (!opts.keepHash && location.hash.replace(/^#/, "") !== hashFor(f)) {
      try {
        history.replaceState(null, "", "#" + hashFor(f));
      } catch (e) {
        location.hash = hashFor(f);
      }
    }
    renderRail();
    renderBar();
    renderScreens();
    renderStage();
    renderPanel();
    renderPick(true);
    const files = filesOf(f);
    const jobs = [ensureCritique(f), ensureInventory()];
    if (files && !kitLoaded(f, files)) jobs.push(refreshFeature(f, files, true));
    await Promise.all(jobs);
    if (S.cur !== f) return;
    renderBar();
    renderScreens();
    renderStage();
    renderPanel();
    renderPick();
    if (changed && !opts.first) {
      const row = $(`.f-row[data-f="${CSS.escape(f)}"]`);
      if (row) row.scrollIntoView({ block: "nearest" });
    }
  }
  function step(d) {
    const list = features();
    const i = list.findIndex((x) => x.feature === S.cur);
    const n = list[(i + d + list.length) % list.length];
    if (n) select(n.feature);
  }

  /* ── render: rail ────────────────────────────────────────────────── */
  let railSig = "";
  function renderRail() {
    const list = features();
    const rows = list.map((fe) => ({ fe, st: pickLabel(fe.feature) || statusOf(fe.feature), draft: statusOf(fe.feature) }));
    const sig = JSON.stringify([S.cur, rows.map((r) => [r.fe.feature, r.fe.title, r.fe.score, r.st.text])]);
    const drafted = rows.filter((r) => model(r.fe.feature).variants.length && !r.fe.extra).length;
    const recs = rows.filter((r) => r.draft.cls === "st-rec" && !r.fe.extra).length;
    $("#rail-sum").textContent = `시안 ${drafted}/${S.manifest.length} · 추천 ${recs}`;
    if (sig === railSig) return;
    railSig = sig;
    $("#f-list").innerHTML = rows
      .map(
        ({ fe, st }) => `<li><button type="button" class="f-row" data-f="${esc(fe.feature)}" aria-current="${fe.feature === S.cur}">
          <span class="f-title">${esc(fe.title)}</span>
          <span class="f-sub">${fe.score ? `<span class="tnum">${esc(fe.score)}</span> · ` : ""}<span class="${st.cls}">${esc(st.text)}</span></span>
        </button></li>`,
      )
      .join("");
    $("#picker").innerHTML = rows
      .map(
        ({ fe, st }) =>
          `<option value="${esc(fe.feature)}"${fe.feature === S.cur ? " selected" : ""}>${esc(fe.title)} · ${esc(fe.score || "")} · ${esc(st.text)}</option>`,
      )
      .join("");
  }

  /* ── render: bar + toggles ───────────────────────────────────────── */
  function renderBar() {
    const fe = featureOf(S.cur) || {};
    const m = model(S.cur);
    const crit = S.crit[S.cur];
    $("#f-title").textContent = fe.title || S.cur || "";
    const bits = [S.cur];
    if (fe.owner) bits.push(`담당 ${fe.owner}`);
    const score = (crit && crit.score) || fe.score;
    if (score) bits.push(`비평 ${score}${(crit && crit.band) || fe.band ? ` ${(crit && crit.band) || fe.band}` : ""}`);
    if (m.err) bits.push("meta.json을 읽지 못했어요");
    $("#f-meta").textContent = bits.join(" · ");
    document.title = `${fe.title || S.cur} · 모시 시안 비교`;
    const hasDraft = m.variants.length > 0 || hasApplied(m);
    const anyHtml = m.variants.some((v) => v.states.some((s) => s.html && (!S.B || S.B.live[`${S.cur}/${s.html}`])));
    for (const seg of $$(".seg")) {
      const key = seg.dataset.key;
      if (key === "engine") seg.hidden = CFG.engines.length < 2;
      for (const b of $$("button", seg)) {
        b.setAttribute("aria-checked", String(S[key] === b.dataset.v));
        b.disabled =
          (key === "compare" && b.dataset.v === "overlay" && !hasDraft) || (key === "mode" && b.dataset.v === "live" && hasDraft && !anyHtml);
        b.title = b.disabled ? (key === "compare" ? "시안이 있어야 겹쳐 볼 수 있어요" : "이 시안에는 라이브 HTML이 없어요") : "";
      }
    }
  }
  function setOpt(key, v) {
    if (S[key] === v) return;
    S[key] = v;
    if (key === "theme") {
      document.documentElement.dataset.theme = v;
      store.set("theme", v);
    } else store.set(key, v);
    renderBar();
    renderStage();
  }

  /* ── render: screen + state pickers ──────────────────────────────── */
  function renderScreens() {
    const f = S.cur;
    const m = model(f);
    const list = screensOf(f);
    const scr = activeScreen(f, m);
    const st = activeState(f, m);
    const scrLabel = (k) => k.replace(/^(\d+)-/, "$1 ");
    let html = "";
    if (m.stateKeys.length > 1) {
      const chips = m.stateKeys
        .map((k) => {
          const s = m.variants.map((v) => v.states.find((x) => x.key === k && x.compare.length)).find(Boolean);
          const num = s ? s.compare[0].slice(0, 2) : "";
          const label = m.stateLabels[k] || k || "기본";
          const tip = s ? `현재 ${s.compare[0]}와 비교` : `${label} · 짝인 현재 화면이 meta.json에 없어요`;
          return `<button type="button" class="scr" data-state="${esc(k)}" aria-pressed="${k === st}" title="${esc(tip)}">${esc(label)}${num ? ` <span class="basis tnum">${esc(num)}</span>` : ""}</button>`;
        })
        .join("");
      html += `<div class="scr-group" role="group" aria-labelledby="lbl-states"><span class="screens-label" id="lbl-states">시안 상태</span>${chips}</div>`;
    }
    const basis = new Set(m.current);
    for (const v of m.variants) for (const s of v.states) if (s.key === st) s.compare.forEach((k) => basis.add(k));
    const missing = (k) => !curExists(k, S.engine, S.theme);
    if (m.stateKeys.length > 1 || list.length > 5) {
      // many screens: one native select, so the row never hides chips off-screen
      const opts = list
        .map(
          (k) =>
            `<option value="${esc(k)}"${k === scr ? " selected" : ""}>${esc(scrLabel(k))}${basis.has(k) && m.variants.length ? " · 기준" : ""}${missing(k) ? " · 캡처 없음" : ""}</option>`,
        )
        .join("");
      html += list.length
        ? `<label class="scr-pick"><span class="screens-label">현재 화면</span><span class="scr-sel"><select id="scr-select" data-screen-select>${opts}</select></span></label>`
        : "";
    } else {
      html += `<div class="scr-group" role="group" aria-labelledby="lbl-screens"><span class="screens-label" id="lbl-screens">현재 화면</span>${list
        .map(
          (k) =>
            `<button type="button" class="scr" data-screen="${esc(k)}" aria-pressed="${k === scr}" title="${esc(k)}${basis.has(k) ? " · 시안 비교 기준" : ""}${missing(k) ? " · 캡처 없음" : ""}">${esc(scrLabel(k))}${basis.has(k) && m.variants.length ? ` <span class="basis">기준</span>` : ""}</button>`,
        )
        .join("")}</div>`;
    }
    $("#screens").innerHTML = html;
  }
  // choose a 현재 screen: keep the active state if it compares to it, else the first state that does
  function pickScreen(k) {
    const f = S.cur;
    const m = model(f);
    S.screen[f] = k;
    const st = activeState(f, m);
    const keeps = m.variants.some((v) => v.states.some((s) => s.key === st && s.compare.includes(k)));
    if (!keeps)
      for (const v of m.variants) {
        const s = v.states.find((x) => x.compare.includes(k));
        if (s) {
          S.state[f] = s.key;
          break;
        }
      }
    renderScreens();
    renderStage();
  }
  // choose a state: 현재 follows that state's `current` (or the default screen when it has none)
  function pickState(k) {
    const f = S.cur;
    const m = model(f);
    S.state[f] = k;
    const s = m.variants.map((v) => v.states.find((x) => x.key === k && x.compare.length)).find(Boolean);
    if (s) S.screen[f] = s.compare[0];
    else delete S.screen[f];
    renderScreens();
    renderStage();
  }
  function stepState(d) {
    const m = model(S.cur);
    if (m.stateKeys.length < 2) return;
    const i = m.stateKeys.indexOf(activeState(S.cur, m));
    pickState(m.stateKeys[(i + d + m.stateKeys.length) % m.stateKeys.length]);
    const b = $(`#screens [data-state="${CSS.escape(activeState(S.cur, model(S.cur)))}"]`);
    if (b) b.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /* ── render: stage ───────────────────────────────────────────────── */
  const APPLIED_RE = /^applied-(light|dark)\.(jpe?g|png)$/i;
  const hasApplied = (m) => !!(m.files && Object.keys(m.files).some((n) => APPLIED_RE.test(n)));
  function appliedShot(f, m) {
    if (!m.files) return null;
    const rel = resolveShot(f, m.files, `applied-${S.theme}.jpg`) || resolveShot(f, m.files, `applied-${S.theme}.png`);
    return rel ? draftURL(f, rel, m.files) : null;
  }
  function columns(f, m) {
    const applied = hasApplied(m);
    if (!m.variants.length)
      return applied ? [{ kind: "cur" }, { kind: "applied" }] : [{ kind: "cur", theme: "light" }, { kind: "cur", theme: "dark" }, { kind: "pending" }];
    const cols = [{ kind: "cur" }, ...m.variants.map((v) => ({ kind: "var", v }))];
    if (applied) {
      // 적용 후 sits right after the picked column (현재 유지 → after 현재)
      const ch = S.picks[f] && S.picks[f].choice;
      let at = ch === "current" ? 0 : cols.findIndex((c) => c.kind === "var" && c.v.id === ch);
      if (at < 0) at = cols.length - 1;
      cols.splice(at + 1, 0, { kind: "applied" });
    }
    return cols;
  }
  function stateFor(v, key) {
    return v.states.find((s) => s.key === key) || v.states[0];
  }
  function variantShot(f, m, s) {
    const k = S.engine === "webkit" ? `${S.theme}-webkit` : S.theme;
    const rel = s.shots[k] || s.shots[S.theme];
    if (!rel) return null;
    if (S.B) {
      const r = S.B.rename[`${f}/${rel}`] || rel;
      const [p, h] = r.split("#");
      return draftURL(f, p, null) + (h ? `#${h}` : "");
    }
    return draftURL(f, rel, m.files);
  }
  function liveFrame(f, s, title) {
    if (!s.html) return `<div class="frame-note"><strong>HTML 없음</strong><span>meta.json의 html을 확인하세요</span></div>`;
    const key = `${f}/${s.html}`;
    if (S.B) {
      if (!S.B.live[key]) return `<div class="frame-note"><strong>라이브 없음</strong><span>번들에 HTML이 없어요</span></div>`;
      return `<div class="live"><iframe data-srcdoc="${esc(key)}" data-q="${esc(s.query || "")}" data-theme="${S.theme}" title="${esc(title)}" tabindex="-1"></iframe></div>`;
    }
    const files = filesOf(f);
    const url = `${f}/${encodeURIComponent(s.html)}?theme=${S.theme}${s.query ? `&${s.query}` : ""}${files && files[s.html] ? `&v=${files[s.html]}` : ""}`;
    return `<div class="live"><iframe src="${esc(url)}" data-theme="${S.theme}" title="${esc(title)}" tabindex="-1" loading="lazy"></iframe></div>`;
  }
  function chipsFor(f, fixes) {
    if (!fixes || !fixes.length) return "";
    const crit = S.crit[f];
    return `<div class="chips">${fixes
      .map((x) => {
        const raw = String(x);
        if (/^slop:/i.test(raw)) {
          const name = raw.replace(/^slop:/i, "");
          const sec = slopSection(name);
          return `<button type="button" class="chip${sec || !S.inv ? "" : " unknown"}" data-slop="${esc(name)}" aria-pressed="${S.slop === name}" title="${esc(sec ? `slop §${sec.no} ${sec.title.replace(/`/g, "")}` : "slop-inventory에서 못 찾았어요")}">${esc(name)}</button>`;
        }
        const xm = raw.match(/^([a-z][\w-]*):(P\d(?:-\d+)?)$/i);
        if (xm && featureOf(xm[1]) && !featureOf(xm[1]).extra) {
          const f2 = xm[1];
          const id = xm[2].toUpperCase();
          const c2 = S.crit[f2];
          if (!c2) xwant.add(f2);
          const iss = c2 && c2.issues.find((i) => i.id === id);
          const t2 = featureOf(f2).title || f2;
          const on = S.xi && S.xi.f === f2 && S.xi.id === id;
          return `<button type="button" class="chip${iss || !c2 ? "" : " unknown"}" data-xf="${esc(f2)}" data-xid="${esc(id)}" aria-pressed="${!!on}" title="${esc(
            iss ? `${t2} 비평 ${id}: ${iss.title}` : c2 ? `${t2} 비평에서 ${id}를 못 찾았어요` : `${t2} 비평 ${id}`,
          )}">${esc(t2)} ${esc(id)}</button>`;
        }
        const qm = raw.match(/^critique:Q(\d+)$/i);
        if (qm) {
          const n = Number(qm[1]);
          const q = crit && crit.questions ? crit.questions[n - 1] : null;
          return `<button type="button" class="chip${q || !crit ? "" : " unknown"}" data-q="${n}" aria-pressed="${S.q === n}" title="${esc(q ? `질문 ${n}: ${q.replace(/[*`]/g, "")}` : "critique Questions에서 못 찾았어요")}">질문 ${n}</button>`;
        }
        if (/^[a-z][\w-]*:/i.test(raw) && !/^P\d/i.test(raw)) return `<span class="chip tag" title="critique의 기타 항목">${esc(raw)}</span>`;
        const inv = invRow(raw);
        if (inv) return `<button type="button" class="chip" data-slop="${esc(raw)}" aria-pressed="${S.slop === raw}" title="${esc(`slop ${inv.id}`)}">${esc(raw)}</button>`;
        const id = normId(raw);
        const iss = crit && crit.issues.find((i) => i.id === id);
        return `<button type="button" class="chip${iss || !crit ? "" : " unknown"}" data-fix="${esc(id)}" aria-pressed="${S.hl === id}" title="${esc(iss ? iss.title : "critique에서 못 찾았어요")}">${esc(id)}</button>`;
      })
      .join("")}</div>`;
  }
  function normId(raw) {
    const m = String(raw)
      .trim()
      .toUpperCase()
      .match(/^\[?(P\d)\]?(?:\s*[-#.·_ ]\s*(\d+))?$/);
    if (!m) return String(raw).trim();
    if (m[2]) return `${m[1]}-${m[2]}`;
    const crit = S.crit[S.cur];
    const same = crit ? crit.issues.filter((i) => i.sev === m[1]) : [];
    return same.length === 1 ? same[0].id : m[1];
  }

  function renderStage() {
    const f = S.cur;
    const stage = $("#stage");
    if (!f) {
      stage.innerHTML = "";
      return;
    }
    const m = model(f);
    const fe = featureOf(f) || {};
    const scr = activeScreen(f, m);
    const st = activeState(f, m);
    const cols = columns(f, m);
    if (S.focus >= cols.length) S.focus = -1;
    const engLabel = S.engine === "webkit" ? "WebKit" : "Chrome";
    const themeLabel = (t) => (t === "dark" ? "다크" : "라이트");

    const curFrame = (key, theme) =>
      key && curExists(key, S.engine, theme)
        ? imgTag(curShot(key, S.engine, theme), `현재 ${key} ${themeLabel(theme)}`)
        : `<div class="frame-note"><strong>현재 캡처 없음</strong>${key ? `<span>${esc(key)} (${engLabel} ${themeLabel(theme)})이 shots에 없어요</span>` : ""}</div>`;
    const unpaired = !!st && !S.screen[f] && !m.variants.some((v) => v.states.some((s) => s.key === st && s.compare.length));
    const targets = cols.map((c, i) => ({ c, i })).filter((x) => x.c.kind === "var" || x.c.kind === "applied");
    if (S.compare === "overlay" && targets.length) {
      const sel = targets.find((x) => x.i === S.focus) || targets[0];
      const curImg = curFrame(scr, S.theme);
      const varFrame = (v, live) => {
        const s = stateFor(v, st);
        if (live && S.mode === "live") return liveFrame(f, s, `${v.id} 라이브`);
        const u = variantShot(f, m, s);
        return u ? imgTag(u, `${v.id} ${themeLabel(S.theme)}`) : `<div class="frame-note"><strong>캡처 없음</strong></div>`;
      };
      let baseLabel = "현재";
      let base = curImg;
      let topLabel;
      let top;
      let note;
      if (sel.c.kind === "applied") {
        const ch = S.picks[f] && S.picks[f].choice;
        const pv = m.variants.find((v) => v.id === ch);
        if (pv) {
          baseLabel = pv.id;
          base = varFrame(pv, false);
        }
        topLabel = "적용 후";
        const u = appliedShot(f, m);
        top = u ? imgTag(u, `적용 후 ${themeLabel(S.theme)}`) : `<div class="frame-note"><strong>적용 후 캡처 없음</strong></div>`;
        note = `${baseLabel === "현재" ? `현재 ${scr || ""}` : `${baseLabel} 시안`} ↔ 적용 후 · ${themeLabel(S.theme)}`;
      } else {
        const v = sel.c.v;
        const s = stateFor(v, st);
        topLabel = `${v.id}${v.name ? ` · ${v.name}` : ""}`;
        top = varFrame(v, true);
        note = `현재 ${scr || ""} · ${engLabel} ${themeLabel(S.theme)}  ↔  ${v.id}${s.key ? ` · ${s.label || s.key}` : ""}`;
      }
      stage.innerHTML = `<div class="wipe" style="--wipe:${S.wipe}%">
        <div class="wipe-tags"><span>${esc(baseLabel)}</span><span>${esc(topLabel)}</span></div>
        <div class="frame" id="wipe-frame">
          <div class="wipe-base">${base}</div>
          <div class="wipe-top">${top}</div>
          <div class="wipe-line"></div>
        </div>
        <div class="wipe-ctl">
          <span>${esc(baseLabel)}</span>
          <input type="range" id="wipe" min="0" max="100" step="1" value="${S.wipe}" aria-label="겹쳐 보기 위치">
          <span>${esc(sel.c.kind === "applied" ? "적용 후" : sel.c.v.id)}</span>
          <div class="seg" role="radiogroup" aria-label="겹칠 대상">${targets
            .map((x) => `<button type="button" role="radio" data-ov="${x.i}" aria-checked="${x.i === sel.i}">${esc(x.c.kind === "applied" ? "적용 후" : x.c.v.id)}</button>`)
            .join("")}</div>
        </div>
        <p class="cap-sub wipe-note">${esc(note)} · 프레임을 끌어도 돼요</p>
      </div>`;
      layout();
      hookIframes();
      return;
    }

    const html = cols
      .map((c, i) => {
        const focus = i === S.focus ? " data-focus" : "";
        if (c.kind === "cur") {
          const theme = c.theme || S.theme;
          const img = curFrame(scr, theme);
          const head = c.theme ? `현재 · ${themeLabel(c.theme)}` : "현재";
          return `<figure class="col" data-i="${i}"${focus}>
            <div class="frame">${img}</div>
            <figcaption class="cap">
              <div class="cap-head"><span class="cap-id">${head}</span></div>
              <p class="cap-sub">${esc(scr || "")} · ${engLabel}${c.theme ? "" : ` ${themeLabel(theme)}`}</p>
              ${unpaired ? `<p class="cap-sub warn">이 상태와 짝인 현재 화면이 meta.json에 없어 기본 화면을 보여요</p>` : ""}
            </figcaption></figure>`;
        }
        if (c.kind === "pending") {
          const owner = fe.owner ? `담당 ${esc(fe.owner)}` : "";
          const ph = (id) =>
            `<div class="frame ph"><div class="frame-note"><strong>${id} 시안 준비 중</strong><span>${owner}</span></div></div>`;
          return `<figure class="col" data-i="${i}"${focus}>
            <div class="ph-stack">${ph("A")}${ph("B")}</div>
            <figcaption class="cap">
              <div class="cap-head"><span class="cap-id">A · B</span></div>
              <p class="cap-sub">${esc(f)}/meta.json이 생기면 10초 안에 나타나요</p>
            </figcaption></figure>`;
        }
        if (c.kind === "applied") {
          const u = appliedShot(f, m);
          const srv = S.picks[f];
          const bits = [];
          if (srv) bits.push(`${choiceKo(srv.choice)} 선택`);
          if (srv && srv.commit) bits.push(srv.commit.slice(0, 7));
          if (srv && STATUS_KO[srv.status]) bits.push(STATUS_KO[srv.status]);
          return `<figure class="col" data-i="${i}"${focus}>
            <div class="frame">${u ? imgTag(u, `적용 후 ${themeLabel(S.theme)}`) : `<div class="frame-note"><strong>${themeLabel(S.theme)} 캡처 없음</strong></div>`}</div>
            <figcaption class="cap">
              <div class="cap-head"><span class="cap-id">적용 후</span></div>
              <p class="cap-sub">${esc(bits.join(" · ") || "실제 앱 캡처")}</p>
            </figcaption></figure>`;
        }
        const v = c.v;
        const s = stateFor(v, st);
        let inner;
        if (S.mode === "live") inner = liveFrame(f, s, `${v.id} 라이브 ${themeLabel(S.theme)}`);
        else {
          const u = variantShot(f, m, s);
          inner = u
            ? imgTag(u, `${v.id} ${v.name} ${themeLabel(S.theme)}`)
            : `<div class="frame-note"><strong>${themeLabel(S.theme)} 캡처 없음</strong><span>${s.html ? "라이브로 볼 수 있어요" : ""}</span></div>`;
        }
        const rec = m.recommended === v.id ? `<span class="cap-rec">추천</span>` : "";
        const fixes = s.fixes || v.fixes;
        const summary = s.summary || v.summary;
        return `<figure class="col" data-i="${i}"${focus}>
          <div class="frame">${inner}</div>
          <figcaption class="cap">
            <div class="cap-head"><span class="cap-id">${esc(v.id)}</span>${v.name ? `<span class="cap-name">${esc(v.name)}</span>` : ""}${rec}</div>
            ${m.stateKeys.length > 1 ? `<p class="cap-sub">${esc(s.label || m.stateLabels[s.key] || s.key || "기본")}${s.key !== st ? " (이 상태가 없어 대신 표시)" : ""}</p>` : ""}
            ${summary ? `<p class="cap-sum">${esc(summary)}</p>` : ""}
            ${chipsFor(f, fixes)}
          </figcaption></figure>`;
      })
      .join("");
    stage.innerHTML = `<div class="cols">${html}</div>`;
    layout();
    hookIframes();
    if (xwant.size) {
      const list = [...xwant];
      xwant.clear();
      Promise.all(list.map((x) => ensureCritique(x))).then(() => {
        if (S.cur === f) renderStage();
      });
    }
  }
  const xwant = new Set(); // other features' critiques that chips refer to
  function hookIframes() {
    for (const fr of $$("#stage iframe")) {
      const theme = fr.dataset.theme;
      const apply = () => {
        try {
          const d = fr.contentDocument;
          if (d && d.documentElement) d.documentElement.dataset.theme = theme;
        } catch (e) {
          /* cross-origin: the ?theme= query already set it */
        }
      };
      fr.addEventListener("load", apply);
      if (fr.dataset.srcdoc && S.B) {
        // bundle: the mock is inlined; bundle.ts routes its location.search reads through window.__DV_SEARCH
        const q = `?theme=${theme}${fr.dataset.q ? `&${fr.dataset.q}` : ""}`;
        const doc = S.B.live[fr.dataset.srcdoc] || "";
        fr.srcdoc = doc.replace(/<head([^>]*)>/i, (h) => `${h}<script>window.__DV_SEARCH=${JSON.stringify(q).replace(/</g, "\\u003c")}</script>`);
      }
    }
  }

  /* frame size: fit the columns into the stage */
  function layout() {
    const stage = $("#stage");
    const wipe = !!$(".wipe", stage);
    const n = wipe ? 1 : Math.max(1, $$(".col", stage).length);
    const narrow = matchMedia("(max-width: 820px)").matches;
    const wide = matchMedia("(min-width: 1200px)").matches;
    const cs = getComputedStyle(stage);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const gap = narrow ? 14 : 24;
    const capH = wipe ? 130 : 150;
    let fw;
    if (narrow) {
      fw = Math.min((innerWidth - 32 - gap) / 2, ((innerHeight - 260) * W) / H, 330);
      if (wipe) fw = Math.min(innerWidth - 32, ((innerHeight - 220) * W) / H, 380);
    } else {
      const availW = stage.clientWidth - padX - gap * (n - 1);
      const availH = wide ? stage.clientHeight - capH : Math.max(420, innerHeight - 190) - capH;
      fw = Math.min(availW / n, (availH * W) / H, wipe ? 460 : 400);
    }
    fw = Math.max(150, Math.floor(fw));
    stage.style.setProperty("--fw", fw + "px");
    stage.style.setProperty("--k", String(fw / W));
  }

  /* ── render: panel ───────────────────────────────────────────────── */
  function renderPanel() {
    const f = S.cur;
    const fe = featureOf(f) || {};
    const crit = S.crit[f];
    const m = model(f);
    const score = (crit && crit.score) || fe.score || "";
    const band = (crit && crit.band) || fe.band || "";
    const counts = {};
    if (crit) for (const i of crit.issues) counts[i.sev] = (counts[i.sev] || 0) + 1;
    $("#p-head").innerHTML = `<div class="p-score"><span class="p-num tnum">${esc(score || "—")}</span><span class="p-band">${esc(band)}</span></div>
      <p class="p-counts tnum">${
        crit
          ? crit.missing
            ? "critique 파일을 찾지 못했어요"
            : Object.keys(counts)
                .sort()
                .map((k) => `${k} ${counts[k]}`)
                .join(" · ") || "Priority Issues 없음"
          : "비평 불러오는 중"
      }</p>`;
    for (const t of $$(".tab")) t.setAttribute("aria-selected", String(t.dataset.tab === S.tab));
    const body = $("#p-body");
    if (S.tab === "notes") body.innerHTML = notesHTML(f, m);
    else if (S.tab === "full") body.innerHTML = crit ? `<div class="md">${md(crit.raw.replace(/^Method:.*\n/, ""), { shift: 2 })}</div>` : `<p class="empty">불러오는 중</p>`;
    else body.innerHTML = critiqueHTML(f, m, crit);
    const target = S.scrollTo;
    S.scrollTo = null;
    if (S.tab === "full" && target === "questions") {
      const h = $$("h3, h4, h5", body).find((e) => /^Questions/.test(e.textContent));
      if (h) {
        let list = h.nextElementSibling;
        while (list && !/^(UL|OL)$/.test(list.tagName) && !/^H\d$/.test(list.tagName)) list = list.nextElementSibling;
        const li = list && /^(UL|OL)$/.test(list.tagName) && S.q ? list.children[S.q - 1] : null;
        if (li) li.classList.add("q-hl");
        requestAnimationFrame(() => (li || h).scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" }));
      }
    }
    if (S.tab === "critique" && target) {
      const el =
        target === "slop" ? $(".slop", body) : target === "question" ? $("#q-box", body) : target === "xbox" ? $("#x-box", body) : $(`#issue-${CSS.escape(target)}`);
      if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" }));
    }
  }
  function critiqueHTML(f, m, crit) {
    if (!crit) return `<p class="empty">불러오는 중</p>`;
    let html = "";
    if (S.slop && invRow(S.slop)) {
      const r = invRow(S.slop);
      html += `<section class="slop"><div class="slop-head"><strong>slop: ${esc(S.slop)}</strong><button type="button" class="link" data-close-slop>닫기</button></div><p class="cap-sub">slop-inventory · ${inline(r.where)}</p><div class="md">${md(rowAsList(r))}</div></section>`;
    } else if (S.slop) {
      const sec = slopSection(S.slop);
      html += `<section class="slop"><div class="slop-head"><strong>slop: ${esc(S.slop)}</strong><button type="button" class="link" data-close-slop>닫기</button></div>${
        sec
          ? `<p class="cap-sub">slop-inventory §${esc(sec.no)} ${inline(sec.title)}</p><div class="md">${md(sec.body.join("\n"), { shift: 3 })}</div>`
          : `<p class="cap-sub">slop-inventory.md에서 이 이름을 찾지 못했어요</p>`
      }</section>`;
    }
    if (S.xi) {
      const c2 = S.crit[S.xi.f];
      const t2 = (featureOf(S.xi.f) || {}).title || S.xi.f;
      const iss = c2 && c2.issues.find((i) => i.id === S.xi.id);
      html += `<section class="slop" id="x-box"><div class="slop-head"><strong>${esc(t2)} 비평 · ${esc(S.xi.id)}</strong><button type="button" class="link" data-close-x>닫기</button></div>${
        iss
          ? `<p class="cap-sub">다른 기능의 critique(${esc(S.xi.f)}.md)가 다루는 상태예요</p><p class="x-title">${inline(iss.title)}</p><div class="md">${md(iss.body.join("\n"), { shift: 3 })}</div><button type="button" class="link" data-goto-x>${esc(t2)} 비평으로 이동</button>`
          : `<p class="cap-sub">${c2 ? `${esc(S.xi.f)}.md에 ${esc(S.xi.id)}가 없어요` : "불러오는 중"}</p>`
      }</section>`;
    }
    if (S.q) {
      const q = crit.questions ? crit.questions[S.q - 1] : null;
      const who = m.variants.filter((v) => [...(v.fixes || []), ...v.states.flatMap((st) => st.fixes || [])].some((x) => String(x).toLowerCase() === `critique:q${S.q}`)).map((v) => v.id);
      html += `<section class="slop" id="q-box"><div class="slop-head"><strong>질문 ${S.q}</strong><button type="button" class="link" data-close-q>닫기</button></div>${
        q
          ? `<p class="cap-sub">critique · Questions to Consider${who.length ? ` · ${esc(who.join("·"))}가 답했다고 표시` : ""}</p><div class="md"><p>${inline(q)}</p></div><button type="button" class="link" data-goto-q>전체 비평에서 보기</button>`
          : `<p class="cap-sub">이 critique의 Questions에 ${S.q}번 질문이 없어요</p>`
      }</section>`;
    }
    const by = {};
    for (const v of m.variants) {
      const ids = new Set();
      for (const x of v.fixes || []) ids.add(normId(x));
      for (const s of v.states) for (const x of s.fixes || []) ids.add(normId(x));
      for (const id of ids) (by[id] = by[id] || []).push(v.id);
    }
    html += `<div class="p-tools"><h3>Priority Issues</h3><button type="button" class="link" data-expand>${S.expandAll ? "모두 접기" : "모두 펼치기"}</button></div>`;
    if (!crit.issues.length) html += `<p class="empty">${crit.missing ? "critique 파일이 없어요" : "이 비평에는 Priority Issues가 없어요"}</p>`;
    html += crit.issues
      .map((i) => {
        const open = S.expandAll || S.hl === i.id ? " open" : "";
        const who = by[i.id] ? `<span class="i-by"><b>${by[i.id].join("·")}</b>가 고쳤다고 표시</span>` : i.src === "B" ? `<span class="i-by">detector(B)가 추가</span>` : "";
        return `<details class="issue${S.hl === i.id ? " hl" : ""}" id="issue-${esc(i.id)}"${open}>
          <summary><span class="sev ${esc(i.sev.toLowerCase())}">${esc(i.id)}</span><span class="i-title">${inline(i.title)}</span>${who}</summary>
          <div class="md">${md(i.body.join("\n"), { shift: 3 })}</div>
        </details>`;
      })
      .join("");
    return html;
  }
  function notesHTML(f, m) {
    let html = "";
    if (m.recommended || m.motion) {
      html += `<div class="md">`;
      if (m.recommended) html += `<p><strong>추천</strong> ${esc(m.recommended)}</p>`;
      if (m.motion) html += `<p><strong>모션</strong> ${inline(Array.isArray(m.motion) ? m.motion.join(" · ") : m.motion)}</p>`;
      html += `</div>`;
    }
    const n = S.notes[f];
    if (n) html += `<div class="md">${md(n.text, { shift: 2 })}</div>`;
    const kits = [];
    for (const v of m.variants)
      for (const s of v.states)
        if (s.kit && (s.kit.rationale || s.kit.motion))
          kits.push(
            `<h4>${esc(v.id)}${s.key ? ` · ${esc(s.key)}` : ""}${s.kit.title ? ` · ${esc(s.kit.title)}` : ""}</h4>${
              Array.isArray(s.kit.rationale) ? `<ol>${s.kit.rationale.map((r) => `<li>${inline(r)}</li>`).join("")}</ol>` : ""
            }${Array.isArray(s.kit.motion) && s.kit.motion.length ? `<p><strong>모션 유지</strong> ${s.kit.motion.map(inline).join(" · ")}</p>` : ""}`,
          );
    if (kits.length) html += `<div class="md"><h3>시안 메모 (kit-meta)</h3>${kits.join("")}</div>`;
    if (!html) html = `<p class="empty">${m.variants.length ? "notes.md가 아직 없어요" : "시안이 아직 없어요. 비평 탭에서 Priority Issues를 볼 수 있어요."}</p>`;
    return html;
  }

  /* ── render: pick card + submit ─────────────────────────────────── */
  let pickSig = "";
  function renderPick(force) {
    const el = $("#pick");
    const f = S.cur;
    if (!f || !pickable(f)) {
      el.hidden = true;
      el.innerHTML = "";
      pickSig = "";
      return;
    }
    el.hidden = false;
    const m = model(f);
    const ids = pickIds(f);
    const sig = JSON.stringify([f, ids, ids.map((id) => (m.variants.find((v) => v.id === id) || {}).name || ""), m.recommended]);
    if (force || sig !== pickSig || !$("#pick-form", el)) {
      pickSig = sig;
      const opt = (value, label, sub, rec) =>
        `<label class="opt"><input type="radio" name="pick" value="${esc(value)}"><span class="opt-t">${label}${sub ? ` <span class="opt-sub">${esc(sub)}</span>` : ""}</span>${rec ? `<span class="opt-rec">추천</span>` : ""}</label>`;
      el.innerHTML = `<h3 class="pick-h" id="pick-h">어떤 안으로 할까요</h3>
        <p class="pick-srv" id="pick-srv"></p>
        <form class="pick-form" id="pick-form" novalidate>
          <div class="opts" role="radiogroup" aria-labelledby="pick-h">
            ${opt("current", "현재 유지", "", false)}
            ${ids
              .map((id) => {
                const v = m.variants.find((x) => x.id === id);
                return opt(id, `<b>${esc(id)}</b>`, v && v.name ? v.name : "", m.recommended === id);
              })
              .join("")}
          </div>
          ${ids.length ? "" : `<p class="pick-note">시안이 아직 없어서 지금은 현재 유지만 고를 수 있어요.</p>`}
          <label class="memo-l" for="memo">고칠 점 (선택)</label>
          <textarea id="memo" name="memo" maxlength="500" rows="2" aria-describedby="memo-count pick-local"></textarea>
          <div class="memo-meta"><span id="pick-local" class="pick-local"></span><span id="memo-count" class="tnum">0/500</span></div>
        </form>`;
    }
    syncPick();
  }
  function syncPick() {
    const f = S.cur;
    const el = $("#pick");
    if (!f || el.hidden) return;
    const l = S.local[f];
    const srv = S.picks[f];
    const choice = (l && l.choice) || (srv && srv.choice) || null;
    for (const r of $$('input[name="pick"]', el)) {
      r.checked = r.value === choice;
      r.closest(".opt").toggleAttribute("data-on", r.checked);
    }
    const memo = $("#memo", el);
    if (memo && document.activeElement !== memo) memo.value = l && typeof l.memo === "string" ? l.memo : (srv && srv.memo) || "";
    if (memo) $("#memo-count", el).textContent = `${memo.value.length}/500`;
    $("#pick-srv", el).innerHTML = srv ? serverLine(srv) : "아직 제출한 선택이 없어요.";
    const p = pendingOf(f);
    $("#pick-local", el).textContent = p
      ? `${choiceKo(p.choice)} 선택 · 제출 전이에요`
      : l && l.choice === null && (l.memo || "").trim()
        ? "안을 고르면 고칠 점과 함께 제출돼요"
        : "";
  }
  function setLocal(f, patch) {
    const srv = S.picks[f];
    const prev = S.local[f] || { choice: srv ? srv.choice : null, memo: srv ? srv.memo || "" : "" };
    S.local[f] = Object.assign({}, prev, patch);
    pruneLocal();
    renderRail();
    syncPick();
    updateSubmit();
  }
  function updateSubmit() {
    const bar = $("#submit-bar");
    if (!S.canPick) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    document.body.classList.add("can-pick");
    const n = pendingList().length;
    const b = $("#submit");
    b.disabled = n === 0 || S.submitting;
    b.setAttribute("aria-busy", String(S.submitting));
    b.textContent = S.submitting ? `제출하는 중… (${n}개)` : `선택 ${n}개 제출하기`;
  }
  function setMsg(kind, text) {
    $("#submit-ok").textContent = kind === "ok" ? text : "";
    $("#submit-err").textContent = kind === "err" ? text : "";
  }
  async function submitPicks() {
    const list = pendingList();
    if (!list.length || S.submitting) return;
    S.submitting = true;
    setMsg(null, "");
    updateSubmit();
    try {
      const body = { picks: list.map((f) => ({ feature: f, choice: S.local[f].choice, memo: (S.local[f].memo || "").trim() })) };
      let r;
      try {
        r = await fetch("api/picks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      } catch (e) {
        throw new Error("서버에 연결하지 못했어요");
      }
      let res = null;
      try {
        res = await r.json();
      } catch (e) {
        res = null;
      }
      if (r.status !== 200 || !res || !res.ok) throw new Error((res && res.error) || `서버 응답 ${r.status}`);
      for (const f of list) {
        if (res.picks && res.picks[f]) S.picks[f] = res.picks[f];
        delete S.local[f];
      }
      store.set("picks", S.local);
      setMsg("ok", "제출했어요. 적용되면 여기에 표시돼요.");
    } catch (e) {
      setMsg("err", `제출하지 못했어요: ${e.message}. 고른 안은 그대로 남아 있어요.`);
    } finally {
      S.submitting = false;
      updateSubmit();
      renderRail();
      syncPick();
      renderStage();
    }
  }

  /* ── events ──────────────────────────────────────────────────────── */
  document.addEventListener("change", (e) => {
    if (e.target.name === "pick" && e.target.closest("#pick")) setLocal(S.cur, { choice: e.target.value });
    if (e.target.id === "scr-select") pickScreen(e.target.value);
  });
  document.addEventListener("submit", (e) => e.preventDefault());
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, figure.col");
    if (!t) return;
    if (t.matches(".f-row")) return select(t.dataset.f);
    if (t.id === "submit") return submitPicks();
    if (t.closest(".seg") && t.dataset.v) return setOpt(t.closest(".seg").dataset.key, t.dataset.v);
    if (t.dataset.ov) {
      S.focus = Number(t.dataset.ov);
      return renderStage();
    }
    if (t.dataset.screen !== undefined) return pickScreen(t.dataset.screen);
    if (t.dataset.state !== undefined) return pickState(t.dataset.state);
    if (t.dataset.fix) {
      S.hl = S.hl === t.dataset.fix ? null : t.dataset.fix;
      S.scrollTo = S.hl;
      S.tab = "critique";
      store.set("tab", S.tab);
      renderStage();
      return renderPanel();
    }
    if (t.dataset.slop) {
      S.slop = S.slop === t.dataset.slop ? null : t.dataset.slop;
      S.scrollTo = S.slop ? "slop" : null;
      S.tab = "critique";
      store.set("tab", S.tab);
      renderStage();
      return renderPanel();
    }
    if (t.dataset.xf) {
      const on = S.xi && S.xi.f === t.dataset.xf && S.xi.id === t.dataset.xid;
      S.xi = on ? null : { f: t.dataset.xf, id: t.dataset.xid };
      S.scrollTo = S.xi ? "xbox" : null;
      S.tab = "critique";
      store.set("tab", S.tab);
      renderStage();
      renderPanel();
      if (S.xi) ensureCritique(S.xi.f).then(() => renderPanel());
      return;
    }
    if (t.hasAttribute("data-close-x")) {
      S.xi = null;
      renderStage();
      return renderPanel();
    }
    if (t.hasAttribute("data-goto-x") && S.xi) {
      const { f: f2, id } = S.xi;
      select(f2).then(() => {
        S.hl = id;
        S.scrollTo = id;
        S.tab = "critique";
        store.set("tab", S.tab);
        renderStage();
        renderPanel();
      });
      return;
    }
    if (t.dataset.q) {
      const n = Number(t.dataset.q);
      S.q = S.q === n ? null : n;
      S.scrollTo = S.q ? "question" : null;
      S.tab = "critique";
      store.set("tab", S.tab);
      renderStage();
      return renderPanel();
    }
    if (t.hasAttribute("data-close-q")) {
      S.q = null;
      renderStage();
      return renderPanel();
    }
    if (t.hasAttribute("data-goto-q")) {
      S.tab = "full";
      S.scrollTo = "questions";
      store.set("tab", S.tab);
      return renderPanel();
    }
    if (t.hasAttribute("data-close-slop")) {
      S.slop = null;
      renderStage();
      return renderPanel();
    }
    if (t.hasAttribute("data-expand")) {
      S.expandAll = !S.expandAll;
      return renderPanel();
    }
    if (t.matches(".tab")) {
      S.tab = t.dataset.tab;
      store.set("tab", S.tab);
      return renderPanel();
    }
    if (t.matches("figure.col")) {
      const i = Number(t.dataset.i);
      if (i !== S.focus) {
        S.focus = i;
        for (const c of $$("#stage .col")) c.toggleAttribute("data-focus", Number(c.dataset.i) === i);
      }
    }
  });
  $("#picker").addEventListener("change", (e) => select(e.target.value));
  document.addEventListener("input", (e) => {
    if (e.target.id === "wipe") setWipe(Number(e.target.value));
    if (e.target.id === "memo") setLocal(S.cur, { memo: e.target.value.slice(0, 500) });
  });
  function setWipe(p) {
    S.wipe = Math.max(0, Math.min(100, p));
    const w = $(".wipe");
    if (w) w.style.setProperty("--wipe", S.wipe + "%");
    const r = $("#wipe");
    if (r && Number(r.value) !== S.wipe) r.value = String(Math.round(S.wipe));
  }
  let dragging = false;
  document.addEventListener("pointerdown", (e) => {
    const fr = e.target.closest("#wipe-frame");
    if (!fr) return;
    dragging = true;
    fr.setPointerCapture(e.pointerId);
    const r = fr.getBoundingClientRect();
    setWipe(((e.clientX - r.left) / r.width) * 100);
  });
  document.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const fr = $("#wipe-frame");
    if (!fr) return;
    const r = fr.getBoundingClientRect();
    setWipe(((e.clientX - r.left) / r.width) * 100);
  });
  document.addEventListener("pointerup", () => (dragging = false));
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea" || e.target.isContentEditable) return;
    const k = e.key;
    if (k === "ArrowRight" || k === "ArrowLeft") {
      e.preventDefault();
      return step(k === "ArrowRight" ? 1 : -1);
    }
    if (k === "1" || k === "2" || k === "3" || k === "4") {
      const i = Number(k) - 1;
      const n = $$("#stage .col").length || model(S.cur).variants.length + 1;
      if (i >= n) return;
      S.focus = i;
      if ($(".wipe")) return renderStage();
      for (const c of $$("#stage .col")) c.toggleAttribute("data-focus", Number(c.dataset.i) === i);
      const col = $(`#stage .col[data-i="${i}"]`);
      if (col) col.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced ? "auto" : "smooth" });
      return;
    }
    if (e.code === "BracketLeft" || e.code === "BracketRight" || k === "[" || k === "]") {
      e.preventDefault();
      return stepState(e.code === "BracketRight" || k === "]" ? 1 : -1);
    }
    const lk = /^[a-z]$/i.test(k) ? k.toLowerCase() : /^Key[A-Z]$/.test(e.code || "") ? e.code.slice(3).toLowerCase() : k;
    if (lk === "d") return setOpt("theme", S.theme === "dark" ? "light" : "dark");
    if (lk === "l") {
      const b = $('.seg[data-key="mode"] button[data-v="live"]');
      if (S.mode === "live") return setOpt("mode", "shot");
      if (b && !b.disabled) return setOpt("mode", "live");
      return;
    }
    if (lk === "o") {
      const b = $('.seg[data-key="compare"] button[data-v="overlay"]');
      if (S.compare === "overlay") return setOpt("compare", "side");
      if (b && !b.disabled) return setOpt("compare", "overlay");
      return;
    }
    if (lk === "e" && CFG.engines.length > 1) return setOpt("engine", S.engine === "webkit" ? "chromium" : "webkit");
  });
  addEventListener("hashchange", () => {
    const f = fromHash(decodeURIComponent(location.hash.replace(/^#/, "")));
    if (f && f !== S.cur) select(f, { keepHash: true });
  });
  let rz = 0;
  addEventListener("resize", () => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(layout);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !S.B) poll(false);
  });

  /* ── boot ────────────────────────────────────────────────────────── */
  async function boot() {
    if (CFG.data) {
      try {
        S.B = await (await fetch(CFG.data, { cache: "no-store" })).json();
        S.B.files = S.B.files || {};
        S.B.live = S.B.live || {};
        S.B.rename = S.B.rename || {};
      } catch (e) {
        S.B = null;
        console.warn("bundle data missing, falling back to files", e);
      }
    }
    await poll(true);
    updateSubmit();
    if (!S.B) setInterval(() => document.visibilityState === "visible" && poll(false), CFG.poll || 10000);
  }
  window.DraftViewer = { md, parseCritique, parseInventory, state: S, model };
  boot();
})();
