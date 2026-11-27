/**
 * The F-A page (FA1–FA3, DD 1935 §5-1), in CSS: 1280 × 720, cream with a 46 px grid and a vignette, Noto Sans KR with
 * keep-all and tabular figures, the tab row at y 48, the kicker at 92, the headline from 118, the body from 240 to 656,
 * the footer rule at 676 with its text's baseline at 700. Sizes and colours are FA2/FA3's own values.
 */

/** FA3: the only colours a page may use (the DOM check holds every computed colour to this list) */
export const FA3 = {
  paper: "#FAF8F3",
  ink: "#12233F",
  ink2: "#3C4451",
  ink3: "#5A616C",
  table: "#262C36",
  mute: "#8C9099",
  mute2: "#A8A79E",
  foot: "#7B8089",
  rule: "#D9D3C4",
  rule2: "#E4DED0",
  red: "#A62B21",
  blue: "#1B48D6",
  gold: "#8A6512",
  marker: "#FFE066",
  card: "#FFFDF6",
  cardBlue: "#F4F7FF",
  cardRed: "#FFF7F4",
  chipRisk: "#F6D9D3",
  chipRiskInk: "#8C2318",
  chipCaution: "#F8E6C8",
  chipCautionInk: "#7C4A00",
  chipNormal: "#D8EDDF",
  chipNormalInk: "#0B6042",
  chipUnknown: "#E7E3D7",
} as const;

/** the hand-drawn circle (one per slide at most): an open loop, stretched around the highlighted words */
const RING =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100" preserveAspectRatio="none"><path d="M18 56C12 26 70 8 156 9c86 1 136 18 134 44-2 28-66 42-146 40C66 91 10 78 14 50 17 33 40 22 74 17" fill="none" stroke="${FA3.red}" stroke-width="3.2" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`,
  );

export function deckCss(fontSrc: string): string {
  const c = FA3;
  return `@font-face{font-family:"Noto Sans KR VF";src:${fontSrc};font-weight:100 900;font-style:normal}
@page{size:1280px 720px;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:${c.paper}}
body{font-family:"Noto Sans KR VF","Noto Sans KR","Apple SD Gothic Neo",sans-serif;word-break:keep-all;overflow-wrap:normal;font-variant-numeric:tabular-nums;color:${c.ink};-webkit-print-color-adjust:exact;print-color-adjust:exact;-webkit-font-smoothing:antialiased}
h1,h2,p{margin:0}
.page{position:relative;width:1280px;height:720px;overflow:hidden;break-after:page;page-break-after:always;background-color:${c.paper};background-image:radial-gradient(ellipse 90% 85% at 50% 46%,rgba(250,248,243,0) 60%,rgba(92,74,40,.075) 100%),linear-gradient(rgba(18,35,63,.034) 1px,transparent 1px),linear-gradient(90deg,rgba(18,35,63,.034) 1px,transparent 1px);background-size:100% 100%,46px 46px,46px 46px;background-position:0 0,0 0,0 0}
.page:last-child{break-after:auto;page-break-after:auto}
.tabs{position:absolute;left:64px;top:48px;display:flex;gap:28px;font-size:19px;font-weight:700;letter-spacing:-.5px;line-height:24px;color:${c.mute2};white-space:nowrap}
.tabs .on{color:${c.ink}}
.kicker{position:absolute;left:64px;top:92px;font-size:17px;font-weight:800;letter-spacing:2.2px;line-height:20px;color:${c.mute};white-space:nowrap}
.headline{position:absolute;left:64px;top:118px;width:1152px;font-size:50px;font-weight:900;letter-spacing:-2.3px;line-height:1.1;color:${c.ink}}
.body{position:absolute;left:64px;top:240px;width:1152px;height:416px}
.foot{position:absolute;left:64px;top:676px;width:1152px;height:44px;border-top:1.5px solid ${c.rule}}
.foot span{position:absolute;top:9px;font-size:14px;line-height:18px;color:${c.foot};white-space:nowrap;letter-spacing:-.2px}
.foot .l{left:0}.foot .r{right:0}
.t-body{font-size:19px;line-height:1.42;letter-spacing:-.3px}
.t-table{font-size:15px}
.t-foot{font-size:14px;line-height:1.35;color:${c.foot};letter-spacing:-.2px}
.fig{font-variant-numeric:tabular-nums;white-space:nowrap}
mark.hl{background:${c.marker};color:inherit;padding:0 .08em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.ring{position:relative;display:inline-block}
.tie{white-space:nowrap}
.ring::after{content:"";position:absolute;left:-.32em;right:-.32em;top:-.16em;bottom:-.2em;background:url("${RING}") no-repeat center/100% 100%;pointer-events:none}
.viz{display:block}
.viz svg{display:block}
.card{background:${c.card};border:1px solid ${c.rule2};border-radius:10px}
.chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px 0 8px;border-radius:12px;font-size:15px;font-weight:700;line-height:1;white-space:nowrap;letter-spacing:-.2px}
.chip svg{width:15px;height:15px;flex:none}
.chip.unknown{background:transparent;border:1px dashed ${c.mute};color:${c.ink3}}
/* hero */
.hero{position:absolute;left:64px;top:128px;width:1152px}
.hero .k{font-size:17px;font-weight:800;letter-spacing:2.2px;line-height:20px;color:${c.mute}}
.hero h1{margin-top:22px;font-size:72px;font-weight:900;letter-spacing:-3.4px;line-height:1.1;color:${c.ink}}
.hero .lead{margin-top:28px;width:1000px;font-size:25px;font-weight:500;letter-spacing:-.6px;line-height:1.5;color:${c.ink2}}
/* numbers3 */
.n3{display:grid;grid-template-columns:repeat(3,368px);column-gap:24px;padding-top:28px}
.n3c{border-top:2px solid ${c.ink};padding-top:22px}
.n3 .num{font-size:66px;font-weight:900;letter-spacing:-3.4px;line-height:1;color:${c.ink};white-space:nowrap}
.n3 .num.sub{font-size:52px;letter-spacing:-2.6px}
.n3 .num .pre,.n3 .num .post,.n3 .num .conf{font-size:25px;font-weight:600;letter-spacing:-.6px;color:${c.ink3}}
.n3 .label{margin-top:20px;font-weight:700;color:${c.ink}}
.n3 .note{margin-top:6px;font-weight:500;color:${c.ink2}}
.n3 .src{margin-top:14px}
/* signal board */
.sb-l{position:absolute;left:0;top:0;width:466px}
.sb-r{position:absolute;left:490px;top:0;width:662px;height:416px;padding-top:30px}
.sb-name{font-weight:700;color:${c.mute}}
.sb-stage{font-size:52px;font-weight:900;letter-spacing:-2.6px;line-height:1.1;color:${c.ink};margin-bottom:22px}
.sb-moved{margin:-14px 0 20px;font-weight:700;color:${c.ink}}
.sb-scen{font-size:26px;font-weight:800;letter-spacing:-.6px;line-height:1.3;color:${c.ink}}
.gauge.row{display:grid;grid-template-columns:118px 266px 64px auto;column-gap:18px;align-items:center;margin-bottom:34px}
.gauge.row .count{font-size:26px;font-weight:800;letter-spacing:-.6px;color:${c.ink};text-align:right}
.gauge.row .name{font-weight:700;color:${c.ink}}
.gauge .h{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.gauge .h .name{font-weight:700;color:${c.ink}}
.gauge .h .count{font-size:26px;font-weight:800;letter-spacing:-.6px;color:${c.ink}}
.sb-note{position:absolute;left:0;bottom:0;width:662px;font-weight:500;color:${c.ink2}}
/* gauges: the condition list takes the left eight columns (A5/A6 rules run to fifty characters), the gauges and what
   the next stage needs the right four */
.gg-list{position:absolute;left:0;top:0;width:760px}
.gg-list .cond{display:grid;grid-template-columns:104px 1fr 176px;column-gap:12px;align-items:start;padding:6px 0;border-top:1px solid ${c.rule2}}
.gg-list .cond:last-child{border-bottom:1px solid ${c.rule2}}
.gg-list .cond .chip{margin-top:-2px;justify-self:start}
.gg-list .cond .val{text-align:right}
.cond .rule{font-size:15px;font-weight:600;color:${c.ink};line-height:1.32;letter-spacing:-.2px}
.cond .val{font-size:15px;color:${c.ink3};line-height:1.32;letter-spacing:-.2px}
.gg-side{position:absolute;left:784px;top:0;width:368px}
.gg-side .gauge{margin-bottom:18px}
.gg-side .gauge .h{margin-bottom:8px}
.gg-side .gauge .h .unk{margin-left:auto;margin-right:12px}
.gg-side .card{margin-top:4px;padding:16px 20px}
.gg-side .t{font-size:15px;font-weight:800;color:${c.mute};letter-spacing:.4px;margin-bottom:6px}
.gg-side .next{font-weight:600;color:${c.ink}}
.gg-side .note{margin-top:10px;font-weight:500;color:${c.ink2}}
/* capture */
.cap-l{position:absolute;left:0;top:0;width:662px;height:416px;display:flex;flex-direction:column;gap:14px}
.cap{flex:1 1 0;min-height:0;display:flex;flex-direction:column}
.cap .frame{flex:1 1 0;min-height:0;background:${c.card};border:1px solid ${c.rule2};border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.cap img{display:block;max-width:100%;max-height:100%;object-fit:contain}
.cap .cc{margin-top:8px;font-size:15px;line-height:1.35;color:${c.ink2};letter-spacing:-.2px}
.cap .cm{font-size:15px;line-height:1.35;color:${c.foot};letter-spacing:-.2px}
.cap-r{position:absolute;left:686px;top:0;width:466px;display:flex;flex-direction:column;gap:14px}
.pt{padding:16px 20px}
.pt .lab{display:flex;justify-content:space-between;font-size:15px;font-weight:800;color:${c.mute};letter-spacing:.4px}
.pt .txt{margin-top:6px;font-weight:500;color:${c.ink}}
/* tables */
.tbl{width:1152px;border-collapse:collapse;color:${c.table}}
.tbl th{font-size:15px;font-weight:800;color:${c.mute};text-align:left;padding:0 14px 12px;border-bottom:1.5px solid ${c.ink};letter-spacing:.2px;white-space:nowrap}
.tbl td{font-size:18px;font-weight:500;padding:12px 14px;border-bottom:1px solid ${c.rule2};letter-spacing:-.2px;line-height:1.3;vertical-align:top}
.tbl .r{text-align:right}
.tbl tr.hi td{font-weight:800;background:${c.card};color:${c.ink}}
.tbl .conf{display:block;font-size:15px;font-weight:500;color:${c.ink3}}
.tbl.apx td{font-size:17px;padding:7.5px 12px}
.tbl.apx th{padding:0 12px 9px}
.tbl.apx td.src{font-size:15px;color:${c.foot}}
/* roe-pbr */
.rp-l{position:absolute;left:0;top:0;width:662px}
.rp-r{position:absolute;left:686px;top:0;width:466px;padding-top:36px}
.rp-r .label{font-weight:700;color:${c.ink}}
.rp-r .num{margin-top:12px;font-size:66px;font-weight:900;letter-spacing:-3.4px;line-height:1;white-space:nowrap}
.rp-r .num .pre,.rp-r .num .post{font-size:25px;font-weight:600;letter-spacing:-.6px;color:${c.ink3}}
.rp-r .src{margin-top:12px}
.rp-r .note{margin-top:18px;font-weight:500;color:${c.ink2}}
/* flows */
.fl-l{position:absolute;left:0;top:0;width:760px}
.fl-notes{position:absolute;left:0;top:348px;width:760px}
.fl-notes p{font-weight:500;color:${c.ink2}}
.fl-r{position:absolute;left:784px;top:0;width:368px}
.fl-r .t{font-size:15px;font-weight:800;color:${c.mute};letter-spacing:.4px;margin-bottom:6px}
.fl-r .formula{font-weight:700;color:${c.ink}}
.fl-r .val{font-weight:500;color:${c.ink2}}
.fl-r .d8{margin-top:22px}
.fl-r .cond{display:flex;flex-direction:column;gap:3px;padding:6px 0;border-top:1px solid ${c.rule2}}
.fl-r .cond .r{display:flex;align-items:center;gap:8px}
/* level chart */
.lc{position:absolute;left:0;top:0;width:1152px}
.lc-note{position:absolute;top:6px;font-size:15px;line-height:20px;font-weight:600;color:${c.ink2};text-align:right;white-space:nowrap;letter-spacing:-.2px}
/* scenarios */
.sc{display:grid;grid-template-columns:repeat(3,368px);column-gap:24px;height:416px}
.sc .card{padding:22px 24px;display:flex;flex-direction:column}
.sc .name{font-size:26px;font-weight:800;letter-spacing:-.6px;line-height:1.25;color:${c.ink}}
.sc .prob{margin-top:10px;font-size:66px;font-weight:900;letter-spacing:-3.4px;line-height:1;color:${c.ink};white-space:nowrap}
.sc .prob .pre,.sc .prob .post{font-size:25px;font-weight:600;letter-spacing:-.6px;color:${c.ink3}}
.sc .t{margin-top:20px;font-size:15px;font-weight:800;color:${c.mute};letter-spacing:.4px}
.sc .trig{margin-top:6px;font-weight:500;color:${c.ink}}
.sc .amp{margin-top:auto;padding-top:14px;font-weight:600;color:${c.ink2}}
/* risks */
.rk{display:grid;gap:18px 24px;height:416px}
.rk .rc{background:${c.cardRed};border:1px solid ${c.chipRisk};border-radius:10px;padding:20px 22px;display:flex;flex-direction:column}
.rk .lab{font-size:15px;font-weight:800;color:${c.red};letter-spacing:.4px}
.rk .txt{margin-top:8px;font-weight:700;color:${c.ink}}
.rk .now{margin-top:auto;padding-top:10px;font-weight:500;color:${c.ink2}}
.rk .now .conf{display:block;font-size:15px;color:${c.ink3}}
/* sources */
.src-cols{columns:2;column-gap:48px;height:416px;column-fill:auto}
.src-g{break-inside:avoid-column}
.src-g h2{font-size:15px;font-weight:800;color:${c.mute};letter-spacing:.4px;margin:0 0 6px}
.src-g ol{list-style:none;margin:0 0 14px;padding:0}
.src-g li{font-size:15px;line-height:1.4;color:${c.ink2};padding:3px 0;letter-spacing:-.2px}
/* disclaimer */
.dc{position:absolute;left:64px;top:240px;width:1000px}
.dc p{font-size:25px;font-weight:500;letter-spacing:-.6px;line-height:1.6;color:${c.ink}}
.dc p+p{margin-top:22px}
.dc .when{margin-top:40px;font-size:19px;font-weight:500;color:${c.ink3};letter-spacing:-.3px}
`;
}
