/**
 * An older page goes in above the rows on screen (load-older): the row at the top of the view stays where it was.
 * ThreadView reads that row and its y when the store takes the page (React has not drawn it yet) and puts it back at
 * that y once the page is drawn, whatever the browser's own scroll anchoring did meanwhile. Moving the view by the
 * page's height instead counted the page twice wherever the browser had already anchored (anywhere but the very top):
 * the reader landed 2072 px further down in Chrome and WebKit. The anchoring itself stays on: it is what keeps the view
 * still when the "이전 메시지를 불러오는 중" ring goes in above.
 */
export type OlderAnchor = { row: Element; top: number };

/**
 * The first row any of which shows in the view, and its top. Leaves out the ring and the date line over the first row:
 * both go away with the page (it brings that day's earlier rows), and a row that went away keeps nothing in place.
 */
export function olderAnchor(scroller: Element, content: Element): OlderAnchor | null {
  const top = scroller.getBoundingClientRect().top;
  for (const row of content.children) {
    if (row.classList.contains("thread-older") || row.classList.contains("msg-sep")) continue;
    const r = row.getBoundingClientRect();
    if (r.height && r.bottom > top) return { row, top: r.top };
  }
  return null;
}

/**
 * The scrollTop that puts the anchor row back at its top, or null when the row is no longer in the document. Rounded:
 * scrollTop is whole pixels and engines drop the fraction, so the row lands within half a pixel.
 */
export function keptScrollTop(scrollTop: number, a: OlderAnchor): number | null {
  if (!a.row.isConnected) return null;
  return Math.round(scrollTop + a.row.getBoundingClientRect().top - a.top);
}
