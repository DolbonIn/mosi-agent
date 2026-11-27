/**
 * Bring a group to the top of its screen's view, clear of the top bar (its scroll-margin-top), as far as the content
 * lets it, at once and without a flash (DD 0103-b D). Only the screen's own scroller moves: scrollIntoView would also
 * scroll the stack's clipped ancestors while a push is sliding in. Done now and once more before the frame is drawn,
 * after the parts that measure themselves in the same commit (a row whose value moves under its title) have grown the
 * content. Returns a cancel for the effect's cleanup.
 */
export function scrollToTop(el: HTMLElement): () => void {
  const go = () => {
    const sc = el.closest<HTMLElement>(".screen-scroll");
    if (!sc || !el.isConnected) return;
    const clear = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - clear;
  };
  go();
  const frame = requestAnimationFrame(go);
  return () => cancelAnimationFrame(frame);
}
