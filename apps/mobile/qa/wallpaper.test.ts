import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { LIGHT, STOPS, THEMES, hexRgb, lightAlpha, lightRgb, luminance, veilFor, wallpaperColorAt, type Rgb } from "../src/three/palette";

// The wallpaper is painted by CSS (three/Wallpaper.css + the wallpaper tokens) and read by the legibility veil through
// its JS twin (three/palette.ts). These keep the two in step and hold the calm-wallpaper promises of MOTION-SPEC §0.
const src = path.resolve(import.meta.dir, "../src");
const tokens = fs.readFileSync(path.join(src, "styles/tokens.css"), "utf8");
const css = fs.readFileSync(path.join(src, "three/Wallpaper.css"), "utf8");
const block = (sel: RegExp) => tokens.slice(tokens.search(sel)).split("\n}")[0]!;
const rootLight = block(/:root \{/);
const rootDark = block(/:root\[data-theme="dark"\] \{/);
const prop = (b: string, name: string) => b.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();

const HUES = [8, 32, 48, 150, 200, 265, 320]; // AgentScreen swatches
const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
const grid = () => {
  const pts: [number, number][] = [];
  for (let u = 0; u <= 1.0001; u += 0.05) for (let v = 0; v <= 1.0001; v += 0.025) pts.push([u, v]);
  return pts;
};

describe("wallpaper: CSS and its JS twin agree", () => {
  test("base, neutral light and agent share match the tokens", () => {
    expect(prop(rootLight, "--bg")?.toLowerCase()).toBe(THEMES.light.base);
    expect(prop(rootDark, "--bg")?.toLowerCase()).toBe(THEMES.dark.base);
    expect(prop(rootLight, "--wp-light-neutral")?.toLowerCase()).toBe(THEMES.light.neutral);
    expect(prop(rootDark, "--wp-light-neutral")?.toLowerCase()).toBe(THEMES.dark.neutral);
    expect(prop(rootLight, "--wp-light-mix")).toBe(`${Math.round(THEMES.light.mix * 100)}%`);
    expect(prop(rootDark, "--wp-light-mix")).toBe(`${Math.round(THEMES.dark.mix * 100)}%`);
    expect(tokens).not.toMatch(/--wp-(blue|teal|violet|peach|strength|base)\b/);
  });

  test("ellipse, falloff stops and grain match Wallpaper.css", () => {
    const stops = STOPS.slice(1, -1)
      .map(([t, a]) => `rgb(0 0 0 / ${a}) ${Math.round(t * 100)}%`)
      .join(", ");
    const gradient = `radial-gradient(${LIGHT.rx * 100}% ${LIGHT.ry * 100}% at ${LIGHT.cx * 100}% ${LIGHT.cy * 100}%, #000 0%, ${stops}, transparent 100%)`;
    expect(css.split(gradient).length - 1).toBe(2); // -webkit-mask-image and mask-image
    expect(css).toContain("color-mix(in oklab, hsl(var(--wp-hue) 80% 58%) var(--wp-light-mix), var(--wp-light-neutral))");
    // dither grain: mid-grey, alpha ≤ .04 · 0.8 − .008 = .024 → at most ~3 levels anywhere, ~1 on average
    const m = css.match(/0 0 0 0 \.5 0 0 0 \.04 (-[\d.]+)'\/%3E/);
    expect(m).not.toBeNull();
    expect(STOPS.every(([t, a]) => Math.abs(a - 0.5 * (1 + Math.cos(Math.PI * t))) < 0.001)).toBe(true);
  });

  test("the light is gone by half the height and never reaches below it", () => {
    expect(lightAlpha(0.5, 0)).toBe(1);
    expect(lightAlpha(0.5, LIGHT.ry)).toBe(0);
    for (const [u, v] of grid()) if (v >= 0.5) expect(lightAlpha(u, v)).toBe(0);
  });
});

describe("wallpaper: calm and legible", () => {
  test("one restrained tint: the light stays within a hair of the base for every agent colour", () => {
    for (const dark of [false, true]) {
      const base = hexRgb(THEMES[dark ? "dark" : "light"].base);
      for (const h of [...HUES, null]) {
        const top = wallpaperColorAt(0.5, 0, dark, h);
        const dist = Math.max(...top.map((c, i) => Math.abs(c - base[i]!))) * 255;
        expect(dist).toBeLessThan(dark ? 34 : 16); // channel distance at the brightest point (dark: yellow agents)
        expect(lightRgb(dark, h).every((c) => c >= 0 && c <= 1)).toBe(true);
      }
    }
  });

  test("labels keep ≥ 7:1 on the bare wallpaper everywhere (glass only adds to it)", () => {
    const label = { light: hexRgb("#1d1d1f"), dark: hexRgb("#f5f5f7") };
    for (const dark of [false, true])
      for (const h of [...HUES, null])
        for (const [u, v] of grid()) expect(ratio(label[dark ? "dark" : "light"], wallpaperColorAt(u, v, dark, h))).toBeGreaterThan(7);
  });

  test("the legibility veil is 0 everywhere on the calm wallpaper", () => {
    const device = { width: 390, height: 844 };
    for (const dark of [false, true])
      for (let top = 0; top < 844; top += 20)
        for (const [left, width] of [
          [16, 48],
          [171, 48],
          [100, 190],
          [16, 358],
        ] as const)
          expect(veilFor({ left, top, width, height: 48 }, device, dark)).toBe(0);
  });
});
