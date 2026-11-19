/**
 * A card that grows in place under the person's finger (a messenger room opening, older messages loading above a
 * toggle) keeps its own anchor: it moves the scroll position itself so the row that was tapped stays put. The thread
 * must not then "follow the latest" over it, which it does whenever it is pinned near the end and its content grows
 * (ThreadView). `holdScroll` tells it, for this growth only, that the scroll position is already right.
 */
const held = new WeakMap<HTMLElement, number>();

export function holdScroll(scroller: HTMLElement, ms = 400): void {
  held.set(scroller, performance.now() + ms);
}

export function scrollHeld(scroller: HTMLElement): boolean {
  return (held.get(scroller) ?? 0) > performance.now();
}
