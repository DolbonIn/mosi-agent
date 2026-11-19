import { HTML_FRAME_SCRIPT } from "@pickle/protocol";

/**
 * The srcdoc document an HTML artifact renders in. Order matters:
 *   1. the CSP meta is the first thing in <head>, so nothing before it can load or run;
 *   2. the theme (`data-theme`, `color-scheme`, the app's colours as plain CSS variables the model's guide names);
 *   3. the base sheet (system type, 16 px × the app's text scale, keep-all, nothing wider than the frame);
 *   4. the model's cleaned CSS, so it can restyle anything above;
 *   5. the body inside #m-root, whose height the frame script reports;
 *   6. the frame script (HTML_FRAME_SCRIPT), allowed by this document's nonce and by the app CSP's sha256.
 */

/** the CSS variables the model may use (docs: design-director's HTML artifact guide). The app tokens they resolve from
 *  are read off <html> each time, so light/dark/more-contrast follow the app, not the OS. */
export const THEME_VARS = {
  "--bg": "--surface",
  "--surface": "--surface-2",
  "--text": "--label",
  "--text-2": "--label-2",
  "--text-3": "--label-3",
  "--line": "--separator",
  "--accent": "--accent-text",
  "--accent-fill": "--accent-fill",
  "--on-accent": "--on-accent",
  "--danger": "--danger",
  "--fill": "--fill",
} as const;

/**
 * Not app tokens, frame only: text colours that clear AA on both --bg and --surface, because the model puts them on
 * either. --success: light 5.2:1 / 4.7:1, dark 8.4:1. Light --accent #0066cc: 5.57:1 / 4.99:1 (the app's #0071e3 is
 * 4.21:1 on --surface; --accent-fill stays #0071e3, white on it 4.7:1). Dark --accent stays the app's (7.1 / 5.8:1).
 */
const FIXED: Record<"light" | "dark", Record<string, string>> = {
  light: { "--success": "#1e7d34", "--accent": "#0066cc" },
  dark: { "--success": "#30d158" },
};

export type FrameTheme = "light" | "dark";

/** the theme variables as they resolve on the app's <html> right now */
export function readThemeVars(theme: FrameTheme, root: HTMLElement = document.documentElement): Record<string, string> {
  const cs = getComputedStyle(root);
  const out: Record<string, string> = {};
  for (const [name, token] of Object.entries(THEME_VARS)) {
    const v = cs.getPropertyValue(token).trim();
    if (v) out[name] = v;
  }
  Object.assign(out, FIXED[theme]);
  const scale = parseFloat(cs.getPropertyValue("--text-scale")) || 1;
  out["--text-scale"] = String(Math.min(2, Math.max(0.8, scale)));
  out["--m-vh"] = `${Math.round(window.innerHeight) / 100}px`;
  return out;
}

export function newNonce(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => (c === "+" ? "-" : c === "/" ? "_" : ""));
}

export const frameCsp = (nonce: string) =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`;

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const cssValue = (s: string) => s.replace(/[<>;{}]/g, "");

/** the base sheet: Apple-like reading type on paper, nothing wider than the frame (tables scroll in their box) */
/**
 * The base sheet. Element defaults sit in :where() (specificity 0), so the model's own CSS, which comes after, always
 * wins over them, a `*{margin:0;padding:0}` reset included (with plain `ul`/`li+li` selectors the defaults beat that
 * reset and indented every list of a real '전부' card by 1.3em). What the frame itself needs keeps its weight: the
 * html/body type and colours, #m-root's padding, the table scroll box. A header cell is a step smaller than its table
 * but never under the 13 px floor (a 13 px table made 11.4 px headers), and it wraps like any text (a product name in
 * a header no longer widens the table); <small> likewise never goes under 13 px (the browser's own `smaller` made a
 * model's 14 px comment times 11.67 px); an image's alt text stands in --text-2, readable.
 */
const BASE = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;overflow-x:hidden;background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);font-size:calc(16px * var(--text-scale,1));line-height:1.6;word-break:keep-all;overflow-wrap:anywhere;-webkit-font-smoothing:antialiased;font-synthesis-weight:none}
#m-root{display:flow-root;padding:var(--space);min-width:0}
#m-root>:first-child{margin-top:0}#m-root>:last-child{margin-bottom:0}
:where(h1,h2,h3,h4){line-height:1.3;letter-spacing:-0.01em;margin:1.1em 0 .45em;font-weight:600;text-wrap:balance}
:where(h1){font-size:1.375em;letter-spacing:-0.02em}:where(h2){font-size:1.1875em}:where(h3){font-size:1.0625em}:where(h4){font-size:1em}
:where(p){margin:0 0 .75em}:where(ul,ol){margin:0 0 .75em;padding-left:1.3em}:where(li+li){margin-top:.25em}
:where(small,.muted){color:var(--text-2)}:where(small){font-size:max(13px,.85em)}
:where(a){color:var(--accent);text-decoration:none}
:where(hr){border:0;border-top:1px solid var(--line);margin:1em 0}
:where(img,svg,canvas,picture){max-width:100%;height:auto}
:where(pre,code){font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.875em}
:where(pre){white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface);border-radius:var(--radius-sm);padding:.75em}
:where(blockquote){margin:0 0 .75em;padding-left:.9em;border-left:3px solid var(--line);color:var(--text-2)}
.m-scroll{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 0 .75em}
:where(table){border-collapse:collapse;min-width:100%;font-size:.9375em}
:where(th,td){padding:.5em .625em;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
:where(th){font-weight:600;color:var(--text-2);font-size:max(13px,.875em)}
:where(button,input,select,textarea){font:inherit;color:inherit}
:where(.m-noimg){color:var(--text-2)}
`;

export interface SrcdocInput {
  css: string;
  body: string;
  theme: FrameTheme;
  vars: Record<string, string>;
  nonce: string;
  /** per-frame channel id (messages carry it; the script reads it from <html data-ch>) */
  channel: string;
  title: string;
}

export function buildSrcdoc(o: SrcdocInput): string {
  const vars = Object.entries(o.vars)
    .filter(([k]) => /^--[a-z0-9-]+$/.test(k))
    .map(([k, v]) => `${k}:${cssValue(v)}`)
    .join(";");
  return (
    `<!doctype html><html lang="ko" data-theme="${o.theme}" data-ch="${attr(o.channel)}"><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${attr(frameCsp(o.nonce))}">` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${attr(o.title)}</title>` +
    `<style>:root{color-scheme:light dark;--font:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard Variable",Pretendard,"Noto Sans KR",system-ui,sans-serif;--radius:12px;--radius-sm:8px;--space:16px;--space-sm:8px;${vars}}` +
    `:root[data-theme="light"]{color-scheme:light}:root[data-theme="dark"]{color-scheme:dark}${BASE}</style>` +
    `<style>${o.css}</style>` +
    `</head><body><div id="m-root">${o.body}</div>` +
    `<script nonce="${attr(o.nonce)}">${HTML_FRAME_SCRIPT}</script></body></html>`
  );
}
