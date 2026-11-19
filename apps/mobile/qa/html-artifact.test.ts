import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { HTML_FRAME_SCRIPT } from "@pickle/protocol";
import { buildSrcdoc, frameCsp, THEME_VARS } from "../src/artifact/srcdoc";

// the pure half of the HTML artifact renderer, the srcdoc wrapper (the sanitiser needs a DOM: html-artifact.spec.mjs
// drives it in Chrome and WebKit; the preview text is @pickle/protocol's htmlText/htmlPreview, tested by the server).
// Synthetic content only.

const input = { css: "h1{color:var(--accent)}", body: "<h1>이번 주 일정</h1><p>하늘 님</p>", theme: "dark" as const, vars: { "--bg": "#1c1c1e", "--text": "#f5f5f7" }, nonce: "abcDEF123_-xyz7890", channel: "ch1", title: "이번 주 일정" };

describe("srcdoc wrapper", () => {
  const doc = buildSrcdoc(input);

  test("the CSP meta is the first thing in head, with this render's nonce", () => {
    expect(doc.startsWith(`<!doctype html><html lang="ko" data-theme="dark" data-ch="ch1"><head><meta http-equiv="Content-Security-Policy" content="${frameCsp(input.nonce)}">`)).toBe(true);
    expect(frameCsp("n1")).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-n1'; base-uri 'none'; form-action 'none'");
  });

  test("exactly one script: the frame script, byte for byte (the app CSP lists its hash), carrying the nonce", () => {
    const scripts = [...doc.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBe(1);
    expect(scripts[0]![1]).toBe(` nonce="${input.nonce}"`);
    expect(scripts[0]![2]).toBe(HTML_FRAME_SCRIPT);
    expect(createHash("sha256").update(HTML_FRAME_SCRIPT).digest("base64")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  test("order: theme variables, base sheet, then the model's CSS (so it can restyle), then the body in #m-root", () => {
    const vars = doc.indexOf("--bg:#1c1c1e");
    const base = doc.indexOf("word-break:keep-all");
    const model = doc.indexOf(input.css);
    const root = doc.indexOf(`<div id="m-root">${input.body}</div>`);
    expect(vars).toBeGreaterThan(0);
    expect(base).toBeGreaterThan(vars);
    expect(model).toBeGreaterThan(base);
    expect(root).toBeGreaterThan(model);
  });

  test("attribute and variable values cannot break out", () => {
    const evil = buildSrcdoc({ ...input, channel: 'x"><script>1</script>', title: "</title><script>2</script>", vars: { "--bg": "red;}</style><script>3</script>", "bad name": "x" } });
    expect([...evil.matchAll(/<script\b/g)].length).toBe(1);
    expect(evil).not.toContain("bad name");
  });

  test("element defaults weigh nothing (:where), so the model's later CSS, a *{margin:0;padding:0} reset included, wins", () => {
    const start = doc.indexOf("*,*::before");
    const base = doc.slice(start, doc.indexOf("</style>", start));
    for (const rule of base.split("}").map((r) => r.trim()).filter(Boolean)) {
      const sel = rule.slice(0, rule.indexOf("{"));
      // only the frame's own hooks keep their weight: the universal box-sizing, html, body, #m-root, .m-scroll, :root vars
      if (/^(\*,\*::before,\*::after|html|body|#m-root.*|\.m-scroll|:root)$/.test(sel)) continue;
      expect(sel.startsWith(":where(")).toBe(true);
    }
    expect(base).toContain(":where(ul,ol){margin:0 0 .75em;padding-left:1.3em}");
    expect(base).toContain(":where(li+li){margin-top:.25em}");
  });

  test("a header cell and <small> never drop under 13 px, a header wraps, and no default text is in --text-3", () => {
    const start = doc.indexOf("*,*::before");
    const base = doc.slice(start, doc.indexOf("</style>", start));
    const th = /:where\(th\)\{([^}]*)\}/.exec(base)?.[1] ?? "";
    // .875em of a 13 px table was 11.375 px; the floor holds whatever the table's size
    expect(th).toContain("font-size:max(13px,.875em)");
    expect(th).not.toContain("nowrap");
    expect(base).not.toContain("var(--text-3)");
    // <small> with no size of its own: the browser's `smaller` (≈ .83) made 11.67 px of a 14 px line
    expect(base).toContain(":where(small){font-size:max(13px,.85em)}");
  });

  test("the guide's variables come from app tokens", () => {
    expect(Object.keys(THEME_VARS)).toEqual(["--bg", "--surface", "--text", "--text-2", "--text-3", "--line", "--accent", "--accent-fill", "--on-accent", "--danger", "--fill"]);
  });
});
