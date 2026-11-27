/**
 * The landing tint (DD 0914 D6, DD 0918 §1): a row a link arrived at gets the fill for a moment, once it is in view and
 * clear of the top bar (its scroll-margin-top), so the tint is not spent while the screen is still scrolling. In
 * 150 ms, held 900 ms, out 400 ms (the CSS on .land-tint / .land-tint-out); with reduced motion it is there at once
 * and gone at once after 1.2 s. Only the background changes: no colour of the text, no border.
 *
 * App-wide in shape (DD 0918: a chat message reached by a link is next), so it takes any element. Today it lives with
 * its first user, the symbol screen (a chat card's 규칙 보기). It returns what clears it early (the screen leaving).
 */
export const LAND = { inMs: 150, holdMs: 900, outMs: 400, reducedMs: 1200 } as const;

export function landOn(el: HTMLElement, reduce: boolean): () => void {
  const timers: number[] = [];
  const start = () => {
    el.classList.add("land-tint");
    if (reduce) {
      timers.push(window.setTimeout(() => el.classList.remove("land-tint"), LAND.reducedMs));
      return;
    }
    timers.push(
      window.setTimeout(() => {
        el.classList.add("land-tint-out");
        el.classList.remove("land-tint");
      }, LAND.inMs + LAND.holdMs),
      window.setTimeout(() => el.classList.remove("land-tint-out"), LAND.inMs + LAND.holdMs + LAND.outMs),
    );
  };
  const root = el.closest<HTMLElement>(".screen-scroll");
  const clear = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  let io: IntersectionObserver | null = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io?.disconnect();
      io = null;
      start();
    },
    { root, rootMargin: `-${Math.round(clear)}px 0px 0px 0px`, threshold: 0.95 },
  );
  io.observe(el);
  return () => {
    io?.disconnect();
    io = null;
    timers.forEach((t) => window.clearTimeout(t));
    el.classList.remove("land-tint", "land-tint-out");
  };
}
