/**
 * Concentric geometry (MOTION-SPEC §1): inner radius = outer radius − padding, everywhere.
 * Capsules for standalone buttons (r = h/2), circles for icon-only controls.
 */
export function concentric(outerRadius: number, inset: number): number {
  return Math.max(outerRadius - inset, 0);
}

export const capsule = (height: number) => height / 2;

/** The radii table (mirrors tokens.css). */
export const R = Object.freeze({
  device: 55,
  sheet: 38,
  sheetInner: concentric(38, 10), // 28
  card: 24,
  tile: concentric(24, 12), // 12
  group: 20,
  tabbar: 34,
  droplet: concentric(34, 6), // 28
  composer: 28,
  send: concentric(28, 6), // 22
  control: 22, // 44px capsule
  topbar: 24, // 48px capsule
  field: 14,
  plate: 8, // 30px list plate / leading slot
  banner: 36, // banner glass; its 44px controls are concentric(36, 14) = 22
});

export const MIN_TARGET = 44;

/** SVG path of a rounded rect (used for clip-path unions and the island). */
export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const f = (n: number) => Math.round(n * 100) / 100;
  return (
    `M${f(x + rr)},${f(y)}H${f(x + w - rr)}A${f(rr)},${f(rr)} 0 0 1 ${f(x + w)},${f(y + rr)}` +
    `V${f(y + h - rr)}A${f(rr)},${f(rr)} 0 0 1 ${f(x + w - rr)},${f(y + h)}` +
    `H${f(x + rr)}A${f(rr)},${f(rr)} 0 0 1 ${f(x)},${f(y + h - rr)}` +
    `V${f(y + rr)}A${f(rr)},${f(rr)} 0 0 1 ${f(x + rr)},${f(y)}Z`
  );
}

/** clip-path inset() string from a source rect inside a box (sheet/banner morphs). */
export function insetFrom(src: { left: number; top: number; width: number; height: number }, box: { left: number; top: number; width: number; height: number }, radius: number): string {
  const top = Math.max(0, src.top - box.top);
  const left = Math.max(0, src.left - box.left);
  const right = Math.max(0, box.left + box.width - (src.left + src.width));
  const bottom = Math.max(0, box.top + box.height - (src.top + src.height));
  return `inset(${top}px ${right}px ${bottom}px ${left}px round ${radius}px)`;
}
