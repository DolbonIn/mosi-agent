// The '전부' answer in the lines sweep's card thread (lines.spec "cards", fixtures/lines-cards.mjs): 900 synthetic rows,
// as many as the card_rows tool takes (CARD_ALL_ROWS). The agent's own code draws them (drawRowsCards), here on three
// cards, '(1/3)' to '(3/3)'. The server's cleanArtifactHtml then cleans each card, so the frames hold what the app gets.
// Drawn at run time, so the sweep reads the head (title, basis, summary) the current explore.ts writes.
// Synthetic: made-up clinics, masked numbers, reserved example.jp links. The links are long and percent-encoded, as
// Japanese clinic pages' are; that is what fills a card's 300 KB.
//   bun apps/mobile/qa/fixtures/lines-rows-cards.ts   → { rows, cards: [{ title, html, shown, bytes }] } as JSON
const here = new URL(".", import.meta.url);
const { drawRowsCards, CARD_ALL_ROWS, CARD_AGENT_BYTES } = await import(new URL("../../../../packages/agent/src/explore.ts", here).href);
const { cleanArtifactHtml } = await import(new URL("../../../../apps/server/src/artifactHtml.ts", here).href);

const REGIONS = ["도쿄도", "오사카부", "가나가와현", "아이치현", "후쿠오카현", "홋카이도", "교토부", "효고현", "사이타마현", "지바현", "히로시마현", "미야기현"];
const WARDS = ["시부야구", "신주쿠구", "미나토구", "기타구", "주오구", "나카구", "하카타구", "사카에", "우메다", "난바"];
const FIRST = ["가온", "다솜", "라온", "미르", "바름", "새봄", "아라", "예솜", "온새", "하람", "누리", "보람", "솔빛", "한결", "도담"];
const KIND = ["클리닉", "내과", "피부과 클리닉", "메디컬 클리닉", "의원"];
let seed = 7;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
const rows = Array.from({ length: CARD_ALL_ROWS as number }, (_, i) => {
  const g = REGIONS[i % REGIONS.length]!;
  const w = WARDS[rnd(WARDS.length)]!;
  const yen = 9800 + rnd(40) * 500;
  const url = rnd(9) === 0
    ? ""
    : `https://example.jp/clinics/${encodeURIComponent(`${g}${w}合成クリニック${i + 1}`)}/access?from=list&page=${1 + rnd(40)}` +
      `&utm_source=${encodeURIComponent(`${w}合成案内ページ`)}&utm_campaign=${encodeURIComponent(`${g}${w}マンジャロ処方オンライン診療合成キャンペーン${i % 7}`)}`;
  return {
    group: g,
    name: `${FIRST[rnd(FIRST.length)]} ${KIND[rnd(KIND.length)]} ${w}점 ${i + 1}`,
    area: `${g} ${w}`,
    price: rnd(9) === 0 ? "상담 후 결정" : `¥${yen.toLocaleString("en-US")} · 2.5mg 4本${rnd(3) === 0 ? " · 첫 달" : ""}`,
    contact: `0${3 + rnd(6)}-****-${String(1000 + rnd(9000))}`,
    url,
    check: rnd(7) === 0 ? "대면 진료만" : "비대면 진료 가능",
  };
});
const set = drawRowsCards({ title: "일본 마운자로 처방 클리닉 (합성)", basis: "각 클리닉 누리집 · 2026-11-17 기준", rows, regulated: true, overlap: false, maxBytes: CARD_AGENT_BYTES });
const cards = set.cards.map((c: { title: string; card: { html: string; shown: unknown[] } }) => {
  const html = cleanArtifactHtml(c.card.html).html;
  return { title: c.title, html, shown: c.card.shown.length, bytes: Buffer.byteLength(html) };
});
process.stdout.write(JSON.stringify({ rows: rows.length, cards }));
