// Regenerates ../marks.tsx from the official source SVGs in this folder (path data copied verbatim, only placed/scaled).
// Run from anywhere: node apps/mobile/src/assets/brands/source/gen.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "../marks.tsx");
const src = (f) => path.join(HERE, f);
const read = (f) => fs.readFileSync(f, "utf8");
const attr = (s, name) => [...s.matchAll(new RegExp(`\\s${name}="([^"]+)"`, "g"))].map((m) => m[1]);
const paths = (s) => [...s.matchAll(/<path\b([^>]*?)\/?>/g)].map((m) => m[1]);
const get = (a, n) => (a.match(new RegExp(`\\b${n}="([^"]+)"`)) || [])[1];

// KakaoTalk (simple-icons, CC0): drop the outer rounded-square subpath, keep bubble + TALK
const kakaoD = attr(read(src("kakaotalk.simple-icons.svg")), "d")[0];
const kakaoParts = kakaoD.split(/(?<=z)(?=M)/i);
if (!/^M22\.125 0H1\.875/.test(kakaoParts[0])) throw new Error("unexpected kakao path");
const kakaoBubble = kakaoParts.slice(1).join("");
// Slack (slack.com production mark)
const slack = paths(read(src("slack.mark.svg"))).map((a) => ({ d: get(a, "d"), fill: get(a, "fill") }));
// Discord (discord.com/branding symbol)
const discordD = attr(read(src("discord.symbol.svg")), "d")[0];
// Telegram (telegram.org/img/t_logo.svg): the plane
const tg = paths(read(src("telegram.t_logo.svg"))).map((a) => get(a, "d"))[0];
// LINE (simple-icons, path from line.me/en/logo)
const lineD = attr(read(src("line.simple-icons.svg")), "d")[0];
// Instagram (Meta IG brand asset pack 2023, white glyph)
const igD = attr(read(src("instagram.glyph-white.svg")), "d")[0];
// WhatsApp (Meta WhatsApp brand resource centre 2026, white glyph)
const wa = attr(read(src("whatsapp.glyph-white.svg")), "d");
// Teams (Microsoft fabric CDN brand icon)
const teamsSrc = read(src("teams_48x1.svg"));
const teamsGrad = teamsSrc.match(/<linearGradient[\s\S]*?<\/linearGradient>/)[0];
const teamsBody = teamsSrc.replace(/^[\s\S]*?<\/defs>/, "").replace(/<\/svg>\s*$/, "").replace('<path fill="none" d="M0 0h48v48H0z"/>', "");

const jsxify = (s) => s.replace(/stop-color=/g, "stopColor=").replace(/fill-rule=/g, "fillRule=").replace(/clip-rule=/g, "clipRule=").replace(/\/>/g, " />");
const teamsJsx = jsxify(teamsBody).replace(/url\(#a\)/g, "url(#${id}-a)").replace(/<(path|circle|rect)\b/g, "<$1");
const teamsGradJsx = jsxify(teamsGrad).replace('id="a"', "id={`${id}-a`}");

const out = `/* GENERATED from the official sources listed in ./README.md (generator: ./source/gen.mjs). Path data is
 * copied verbatim; only placement and scale inside the 100×100 tile are ours. Do not edit the marks by hand. */
import type { ReactNode } from "react";
import webexUrl from "./webex.webp?no-inline"; // its own file: fetched only when a Webex tile renders
import type { BrandId } from "./BrandIcon";

/** each mark draws inside a 0 0 100 100 tile whose background colour comes from brand-icon.css */
export const MARKS: Record<BrandId, (id: string) => ReactNode> = {
  kakaotalk: () => (
    <path transform="scale(4.1667)" fill="#3C1E1E" fillRule="evenodd" d="${kakaoBubble}" />
  ),
  slack: () => (
    <g transform="translate(20 20) scale(1.1111)">
${slack.map((p) => `      <path fill="${p.fill}" d="${p.d}" />`).join("\n")}
    </g>
  ),
  discord: () => <path transform="translate(19 26.75) scale(.96875)" fill="#fff" d="${discordD}" />,
  telegram: () => <path transform="scale(.78125)" fill="#fff" d="${tg}" />,
  line: () => <path transform="translate(15 17.1) scale(2.9167)" fill="#fff" d="${lineD}" />,
  instagram: () => <path transform="translate(18 18) scale(.064) translate(-2.5 -2.5)" fill="#fff" d="${igD}" />,
  teams: (id) => (
    <g transform="translate(15.02 14.3) scale(1.4884)">
      <defs>${teamsGradJsx}</defs>
      ${teamsJsx.replace(/\$\{id\}/g, "${id}").replace(/fill="url\(#\$\{id\}-a\)"/g, "fill={`url(#${id}-a)`}")}
    </g>
  ),
  webex: () => <image href={webexUrl} x="10" y="10" width="80" height="80" />,
  whatsapp: () => (
    <g transform="translate(19 19) scale(.086111)" fill="#fff">
${wa.map((d) => `      <path d="${d}" />`).join("\n")}
    </g>
  ),
};
`;
fs.writeFileSync(OUT, out);
console.log("wrote", OUT, out.length, "bytes");
