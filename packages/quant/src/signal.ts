/**
 * The four signal marks (DD 1935 §0-4): shape plus word, never an emoji and never colour alone. The app's SignalMark and
 * the deck draw the same SVG. Each shape fills a 16 × 16 view box in currentColor:
 * - 위험: a filled circle.
 * - 경계: a ring with its right half filled.
 * - 정상: a 1.5 px ring.
 * - 확인 불가: a dashed ring.
 * 확인 불가 is not 정상. It is counted on its own and never shown as 0 or "-".
 */
import type { Signal, Tri } from "./types";

export const SIGNAL_WORD: Readonly<Record<Signal, string>> = { risk: "위험", caution: "경계", normal: "정상", unknown: "확인 불가" };

/** a condition's word (the gauges' chips) */
export const TRI_WORD: Readonly<Record<Tri, string>> = { met: "충족", unmet: "미충족", unknown: "확인 불가" };

export const SIGNAL_VIEWBOX = "0 0 16 16";

/** the inside of each mark's <svg>, in currentColor */
export const SIGNAL_SHAPES: Readonly<Record<Signal, string>> = {
  risk: '<circle cx="8" cy="8" r="6" fill="currentColor"/>',
  caution: '<circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.75a5.25 5.25 0 0 1 0 10.5z" fill="currentColor"/>',
  normal: '<circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  unknown: '<circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.1 2.1"/>',
};

/** a whole mark as an SVG string (the deck, server-side HTML); 1em square, hidden from assistive tech (the word beside
 * it speaks) */
export function signalMarkSvg(signal: Signal, opts: { size?: string; color?: string } = {}): string {
  const size = opts.size ?? "1em";
  const style = opts.color ? ` style="color:${opts.color}"` : "";
  return `<svg viewBox="${SIGNAL_VIEWBOX}" width="${size}" height="${size}" aria-hidden="true"${style}>${SIGNAL_SHAPES[signal]}</svg>`;
}

/** the summary cell's line, every signal named, zeros included: 위험 3 · 경계 2 · 정상 5 · 확인 불가 1 */
export function signalSummary(counts: Readonly<Record<Signal, number>>): string {
  return (["risk", "caution", "normal", "unknown"] as Signal[]).map((s) => `${SIGNAL_WORD[s]} ${counts[s]}`).join(" · ");
}
