// One-off: rasterise the official Webex app-icon SVG (90 KB of layered gradients) to a 3x WebP, unaltered.
// node raster-webex.mjs <webex-app-icon-color-container.svg> ../webex 160   → ../webex.webp (+ .png, delete it)
import { chromium } from "playwright";
import fs from "node:fs";
const [src, out, px] = process.argv.slice(2);
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage();
const data = await p.evaluate(async ({ s, px }) => {
  const img = new Image(); img.src = s; await img.decode();
  const c = document.createElement("canvas"); c.width = c.height = px;
  const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, px, px);
  return { webp: c.toDataURL("image/webp", 0.9), png: c.toDataURL("image/png") };
}, { s: "data:image/svg+xml;base64," + fs.readFileSync(src).toString("base64"), px: Number(px) });
fs.writeFileSync(out + ".webp", Buffer.from(data.webp.split(",")[1], "base64"));
fs.writeFileSync(out + ".png", Buffer.from(data.png.split(",")[1], "base64"));
await b.close();
