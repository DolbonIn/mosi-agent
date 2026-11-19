import { useEffect, useMemo, useRef, useState } from "react";
import { tierStore, useTierValue } from "../motion/tier";
import { sanitizeHtml, withoutLeadingTitle, type CleanHtml } from "./sanitize";
import { buildSrcdoc, newNonce, readThemeVars } from "./srcdoc";

/**
 * One HTML artifact in its sandboxed frame. The frame is `sandbox="allow-scripts"` only (never allow-same-origin,
 * forms, popups or top navigation), its document is our srcdoc wrapper (srcdoc.ts) around the sanitised fragment
 * (sanitize.ts), and the only script in it is ours. The frame talks back through postMessage, and this side trusts a
 * message only when it comes from this frame's window and carries this frame's channel id:
 *   - `height`: the content height. Must be a finite number; clamped to 0…MAX_FRAME_PX. The frame is sized to it, so
 *     nothing ever scrolls inside the frame.
 *   - `open`: a tapped link. Only an https URL passes (any other scheme is ignored); the app asks before opening it.
 * A theme or text-size change is posted into the frame (`theme`, no reload).
 */

/**
 * The tallest frame: above any page a card may hold (a '전부' card drawn from up to 500 rows stays under its code's
 * 96k px estimate at the narrowest card, about 86k at 390 wide; a real 258-row card was 22.2k), so the sheet always
 * holds the whole page; a forged height stops here.
 */
export const MAX_FRAME_PX = 100_000;
/** the only links that open: https (the lead's rule; the server keeps no other) */
export const LINK_OK = /^https:$/i;

export interface FrameLink {
  href: string;
  text: string;
  /** where the link was tapped, in the app's viewport (null when the frame sent no usable rect) */
  rect: DOMRect | null;
}

const cleanCache = new Map<string, CleanHtml>();
/** sanitising is a parse: do it once per artifact content */
export function cleanOf(html: string): CleanHtml {
  let c = cleanCache.get(html);
  if (!c) {
    c = sanitizeHtml(html);
    if (cleanCache.size > 40) cleanCache.delete(cleanCache.keys().next().value!);
    cleanCache.set(html, c);
  }
  return c;
}

export function HtmlFrame({
  html,
  title,
  onHeight,
  onLink,
  className,
  dropTitle,
}: {
  html: string;
  title: string;
  /** a sheet that shows the title itself: a first heading saying the same goes */
  dropTitle?: boolean;
  onHeight?: (h: number) => void;
  onLink?: (link: FrameLink) => void;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const theme = useTierValue("theme");
  const textScale = useTierValue("textScale");
  const highContrast = useTierValue("highContrast");
  const [height, setHeight] = useState(0);
  const channel = useMemo(() => newNonce().slice(0, 12), []);
  const clean = useMemo(() => {
    const c = cleanOf(html);
    return dropTitle ? { ...c, body: withoutLeadingTitle(c.body, title) } : c;
  }, [html, dropTitle, title]);
  // the document is built once per content; theme changes are posted, not reloaded
  const srcdoc = useMemo(
    () => buildSrcdoc({ css: clean.css, body: clean.body, theme: tierStore.get().theme, vars: readThemeVars(tierStore.get().theme), nonce: newNonce(), channel, title }),
    [clean, channel, title],
  );
  const cb = useRef({ onHeight, onLink });
  cb.current = { onHeight, onLink };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = ref.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data as { ch?: unknown; type?: unknown; h?: unknown; href?: unknown; text?: unknown; rect?: unknown } | null;
      if (!m || typeof m !== "object" || m.ch !== channel) return;
      if (m.type === "height") {
        if (typeof m.h !== "number" || !Number.isFinite(m.h)) return;
        const h = Math.min(MAX_FRAME_PX, Math.max(0, Math.round(m.h)));
        setHeight(h);
        cb.current.onHeight?.(h);
      } else if (m.type === "open") {
        if (typeof m.href !== "string" || m.href.length > 2048) return;
        let url: URL;
        try {
          url = new URL(m.href);
        } catch {
          return;
        }
        if (!LINK_OK.test(url.protocol) || !url.hostname) return;
        let rect: DOMRect | null = null;
        if (Array.isArray(m.rect) && m.rect.length === 4 && m.rect.every((x) => typeof x === "number" && Number.isFinite(x))) {
          const f = frame.getBoundingClientRect();
          const [x, y, w, h] = m.rect as number[];
          rect = new DOMRect(f.left + x!, f.top + y!, Math.max(1, w!), Math.max(1, h!));
        }
        cb.current.onLink?.({ href: url.href, text: typeof m.text === "string" ? m.text.slice(0, 160) : "", rect });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [channel]);

  // theme / text size / contrast changed after load → post the new variables in
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // wait a frame so <html data-theme> and the tokens have switched before reading them
    const id = requestAnimationFrame(() => {
      ref.current?.contentWindow?.postMessage({ ch: channel, type: "theme", theme, vars: readThemeVars(theme) }, "*");
    });
    return () => cancelAnimationFrame(id);
  }, [theme, textScale, highContrast, channel]);

  return (
    <iframe
      ref={ref}
      className={`hframe${className ? ` ${className}` : ""}`}
      title={title}
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      referrerPolicy="no-referrer"
      scrolling="no"
      style={{ height }}
      data-ready={height > 0 ? "" : undefined}
    />
  );
}
