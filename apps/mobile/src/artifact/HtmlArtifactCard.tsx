import { MAX_ARTIFACT_HTML_CARD_BYTES, type Artifact, type ArtifactCard as ArtifactRef } from "@pickle/protocol";
import { motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { toApiError } from "../api/client";
import * as ep from "../api/endpoints";
import { SPRING } from "../motion/springs";
import { useTierValue } from "../motion/tier";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { presentSheet } from "../ui/Sheet";
import { HtmlFrame, type FrameLink } from "./HtmlFrame";
import { LinkConfirm } from "./LinkConfirm";
import { htmlBytes } from "./sanitize";
import "./htmlArtifact.css";

/**
 * An html artifact inside the reply: the answer itself, so it is never folded (screens-chat's result-card fold skips
 * it). A solid paper card the width of the turn. It is as tall as its content up to 70% of the screen; past that the
 * bottom fades out under a 전체 화면 button, and the full document opens as a sheet that morphs out of the card.
 * While the content loads, a placeholder holds the height the card had last time (heights are remembered per
 * artifact), so a reply that is already on screen does not jump when it comes back. Links never navigate the frame:
 * the card asks first, showing the whole URL (LinkConfirm).
 */

const PLACEHOLDER_PX = 220;
const CAP = 0.7;

// ── content (one request per artifact, shared by the card and its sheet) ──
const loads = new Map<string, Promise<Artifact>>();
export function loadArtifact(id: string): Promise<Artifact> {
  let p = loads.get(id);
  if (!p) {
    p = ep.artifact(id);
    p.catch(() => loads.delete(id));
    loads.set(id, p);
  }
  return p;
}

// ── remembered heights (content px at the width it was measured) ──
const HKEY = "pickle.htmlArtifactHeights";
function readHeights(): Record<string, [number, number]> {
  try {
    return JSON.parse(localStorage.getItem(HKEY) ?? "{}") as Record<string, [number, number]>;
  } catch {
    return {};
  }
}
export function rememberedHeight(id: string, width: number): number | null {
  const v = readHeights()[id];
  return v && Math.abs(v[1] - width) < 2 ? v[0] : null;
}
function rememberHeight(id: string, h: number, width: number) {
  try {
    const all = readHeights();
    delete all[id];
    all[id] = [h, Math.round(width)];
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k];
    localStorage.setItem(HKEY, JSON.stringify(all));
  } catch {
    // storage full or blocked: the placeholder just uses its default next time
  }
}

const viewport = {
  subscribe(cb: () => void) {
    window.addEventListener("resize", cb);
    return () => window.removeEventListener("resize", cb);
  },
  get: () => window.innerHeight,
};
const useViewportHeight = () => useSyncExternalStore(viewport.subscribe, viewport.get, viewport.get);

type Load = { state: "loading" } | { state: "ready"; artifact: Artifact } | { state: "error"; message: string };

function useArtifact(id: string): Load {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    setLoad({ state: "loading" });
    loadArtifact(id).then(
      (a) => {
        if (!alive) return;
        // the server is the gate (a model's page ≤ 150 KB, a '전부' card its code draws ≤ 300 KB): the larger one here
        if (htmlBytes(a.content) > MAX_ARTIFACT_HTML_CARD_BYTES) setLoad({ state: "error", message: "내용이 너무 커서 여기에 보여 드릴 수 없어요." });
        else setLoad({ state: "ready", artifact: a });
      },
      (e) => alive && setLoad({ state: "error", message: toApiError(e).message }),
    );
    return () => {
      alive = false;
    };
  }, [id]);
  return load;
}

export function HtmlArtifactCard({ card }: { card: ArtifactRef }) {
  const reduce = useTierValue("reduceMotion");
  const vh = useViewportHeight();
  const cap = Math.round(vh * CAP);
  const cardRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const load = useArtifact(card.artifactId);
  const [content, setContent] = useState<number | null>(null);
  const [link, setLink] = useState<FrameLink | null>(null);

  // measured before the first paint, so a remembered height is the placeholder's first size (not a jump to it)
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.round(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const remembered = width ? rememberedHeight(card.artifactId, width) : null;
  const natural = content ?? remembered ?? PLACEHOLDER_PX;
  const shown = Math.min(natural, cap);
  const ready = content !== null;
  const overflow = ready && content! > cap + 1;

  const onHeight = (h: number) => {
    setContent(h);
    if (width) rememberHeight(card.artifactId, h, width);
  };

  const openFull = () => {
    if (load.state !== "ready") return;
    setLink(null);
    const a = load.artifact;
    presentSheet({
      source: cardRef.current,
      title: a.title || card.title,
      titleAlign: "start",
      render: () => <FullDocument artifact={a} />,
    });
  };

  return (
    <motion.div
      ref={cardRef}
      className="hart"
      data-state={load.state === "error" ? "error" : ready ? "ready" : "loading"}
      data-overflow={overflow ? "" : undefined}
      initial={false}
      animate={{ height: load.state === "error" ? "auto" : shown }}
      // only the page's own height springs; the placeholder takes its size at once
      transition={reduce || !ready ? { duration: 0 } : SPRING.morph}
      aria-busy={!ready && load.state === "loading" ? true : undefined}
    >
      {load.state === "ready" && (
        <HtmlFrame html={load.artifact.content} title={load.artifact.title || card.title} onHeight={onHeight} onLink={setLink} className={reduce ? "hframe--instant" : undefined} />
      )}
      {load.state === "loading" && <Skeleton />}
      {load.state === "error" && (
        <p className="hart-error" role="alert">
          <Icon name="exclamation" size={16} /> {load.message}
        </p>
      )}
      {overflow && (
        <div className="hart-more">
          <Button tone="secondary" size="md" onClick={openFull} ariaLabel={`${card.title} 전체 화면으로 보기`}>
            전체 화면
          </Button>
        </div>
      )}
      {link && <LinkConfirm link={link} onDone={() => setLink(null)} placement="card" anchor={cardRef.current} />}
    </motion.div>
  );
}

function Skeleton() {
  return (
    <div className="hart-skel" aria-label="불러오는 중" role="status">
      {[72, 92, 84, 60].map((w, i) => (
        <span key={i} style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

/** the whole document in a sheet (전체 화면, 보관함): uncapped, the sheet scrolls; the sheet's title bar names it, so a
 *  first heading repeating the title is left out; links ask in a bar pinned to its bottom */
export function FullDocument({ artifact }: { artifact: Artifact }) {
  const [link, setLink] = useState<FrameLink | null>(null);
  const reduce = useTierValue("reduceMotion");
  return (
    <div className="hart-full">
      <HtmlFrame html={artifact.content} title={artifact.title} dropTitle onLink={setLink} className={reduce ? "hframe--instant" : undefined} />
      {link && <LinkConfirm link={link} onDone={() => setLink(null)} placement="sheet" />}
    </div>
  );
}
