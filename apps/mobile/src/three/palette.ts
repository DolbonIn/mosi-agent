/**
 * Wallpaper model (MOTION-SPEC §0 "Wallpaper"): one calm surface (`--bg`) plus one soft light from above, tinted by
 * the agent's colour. The CSS in Wallpaper.css paints it; this file is its JS twin, so the adaptive legibility veil
 * (veilFor) reads the same colours the screen shows. qa/wallpaper.test.ts keeps the two in step.
 *
 *   light = color-mix(in oklab, <agent swatch> MIX, NEUTRAL)        agent swatch = hsl(hue 80% 58%) (the profile dots)
 *   alpha = raised-cosine falloff over an ellipse centred on the top edge (rx 150 % of width, ry 46 % of height)
 *   pixel = base · (1 − alpha) + light · alpha                      (sRGB compositing, as the browser does)
 * The dither grain over the light's region (± ~1 level, Wallpaper.css) is left out: it is noise, not colour.
 * Positions are device-relative (u, v in 0..1, v down).
 */
export type Rgb = [number, number, number]; // 0..1 sRGB

export interface Theme {
  base: string; // = --bg
  neutral: string; // --wp-light-neutral: the light with no agent colour
  mix: number; // --wp-light-mix: the agent colour's share of the light (0..1)
}

export const THEMES: Record<"light" | "dark", Theme> = {
  light: { base: "#f5f5f7", neutral: "#ffffff", mix: 0.1 },
  dark: { base: "#0a0a0c", neutral: "#141417", mix: 0.12 },
};

/** the light's ellipse (CSS `radial-gradient(150% 46% at 50% 0%, …)`) */
export const LIGHT = { rx: 1.5, ry: 0.46, cx: 0.5, cy: 0 };
/** mask stops [t, alpha]: a raised cosine ½(1 + cos πt) sampled at 0, .2 … 1 — no visible edge at either end */
export const STOPS: [number, number][] = [
  [0, 1],
  [0.2, 0.905],
  [0.4, 0.655],
  [0.6, 0.345],
  [0.8, 0.095],
  [1, 0],
];

export const hexRgb = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/** the agent swatch (AgentScreen `.agent-hue`, Avatar `mid`): hsl(hue 80% 58%) */
export function agentRgb(hue: number): Rgb {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = 0.8;
  const l = 0.58;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
}

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function oklab([r, g, b]: Rgb): Rgb {
  const [lr, lg, lb] = [toLin(r), toLin(g), toLin(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp01(toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

/** `color-mix(in oklab, <agent> mix, neutral)`; no hue → the neutral light */
export function lightRgb(dark: boolean, hue?: number | null): Rgb {
  const t = THEMES[dark ? "dark" : "light"];
  const n = hexRgb(t.neutral);
  if (hue == null) return n;
  const [a, b] = [oklab(agentRgb(hue)), oklab(n)];
  return fromOklab([a[0] * t.mix + b[0] * (1 - t.mix), a[1] * t.mix + b[1] * (1 - t.mix), a[2] * t.mix + b[2] * (1 - t.mix)]);
}

/** mask alpha of the light at a device-relative point (piecewise linear between STOPS, like the CSS gradient) */
export function lightAlpha(u: number, v: number): number {
  const t = Math.hypot((u - LIGHT.cx) / LIGHT.rx, (v - LIGHT.cy) / LIGHT.ry);
  if (t >= 1) return 0;
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, a1] = STOPS[i]!;
    const [t0, a0] = STOPS[i - 1]!;
    if (t <= t1) return a0 + ((a1 - a0) * (t - t0)) / (t1 - t0);
  }
  return 0;
}

/** Wallpaper colour at a device-relative point. */
export function wallpaperColorAt(u: number, v: number, dark: boolean, hue?: number | null): Rgb {
  const base = hexRgb(THEMES[dark ? "dark" : "light"].base);
  const light = lightRgb(dark, hue);
  const a = lightAlpha(u, v);
  return [base[0] * (1 - a) + light[0] * a, base[1] * (1 - a) + light[1] * a, base[2] * (1 - a) + light[2] * a];
}

export const luminance = (rgb: Rgb) => 0.2126 * toLin(rgb[0]) + 0.7152 * toLin(rgb[1]) + 0.0722 * toLin(rgb[2]);

// the veil does not know the agent's hue: it takes the worst hue for the theme (darkest light under dark labels,
// brightest under light labels), so it is never lighter than it must be
const SWEEP = Array.from({ length: 24 }, (_, i) => i * 15);
const worst: { light?: number; dark?: number } = {};
function worstHue(dark: boolean): number {
  const k = dark ? "dark" : "light";
  if (worst[k] === undefined) {
    const lum = (h: number) => luminance(lightRgb(dark, h));
    worst[k] = SWEEP.reduce((b, h) => ((dark ? lum(h) > lum(b) : lum(h) < lum(b)) ? h : b), SWEEP[0]!);
  }
  return worst[k]!;
}

/**
 * Adaptive legibility veil for glass carrying text (MOTION-SPEC §1): opacity from the wallpaper luminance under the
 * rect. Light theme (dark labels) lifts dark patches with a white veil; dark theme (light labels) dims bright patches.
 * On the calm wallpaper it is 0 everywhere, for every hue (qa/wallpaper.test.ts); it stays as the guard should the
 * light ever get stronger.
 */
export function veilFor(rect: { left: number; top: number; width: number; height: number }, device: { width: number; height: number }, dark: boolean): number {
  if (!device.width || !device.height) return 0;
  const hue = worstHue(dark);
  let lum = 0;
  for (const px of [0.25, 0.5, 0.75]) {
    const u = (rect.left + rect.width * px) / device.width;
    const v = (rect.top + rect.height * 0.5) / device.height;
    lum += luminance(wallpaperColorAt(u, v, dark, hue));
  }
  lum /= 3;
  if (dark) return Math.min(0.35, Math.max(0, (lum - 0.06) * 1.6));
  return Math.min(0.32, Math.max(0, (0.6 - lum) * 0.9));
}
