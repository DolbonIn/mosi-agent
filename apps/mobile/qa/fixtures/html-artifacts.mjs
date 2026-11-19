// HTML artifacts for html-artifact.spec.mjs. The five pages in ./html-artifacts/ are design-director's fixed examples
// for the HTML card guide (v3): fragments of <style> + markup that use only the frame's variables (--bg --surface
// --text --text-2 --text-3 --line --accent --accent-fill --on-accent --danger --success --radius --radius-sm --space
// --space-sm --font), so light, dark and more-contrast follow the app. Synthetic content (하늘, made-up clinics on
// example.com). HOSTILE is the security torture page.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "html-artifacts");
const read = (name) => fs.readFileSync(path.join(dir, `${name}.html`), "utf8");

export const SAMPLES = [
  { id: "qa-html-thread", file: "dc-thread", title: "러스트 입문서 추천 스레드", ask: "러스트 입문서 추천을 디시 스레드처럼 보여 줘", answer: "갤러리 글처럼 꾸며 봤어요." },
  { id: "qa-html-week", file: "week-schedule", title: "이번 주 일정", ask: "이번 주 일정 카드로 정리해 줘", answer: "이번 주 일정을 한 장으로 정리했어요." },
  { id: "qa-html-compare", file: "product-compare", title: "무선 이어폰 3종 비교", ask: "무선 이어폰 세 개 비교표로 보여 줘", answer: "세 제품을 한눈에 비교해 봤어요." },
  { id: "qa-html-trip", file: "travel-timeline", title: "제주 2박 3일", ask: "제주 2박 3일 일정 타임라인으로 짜 줘", answer: "동선 순서대로 짰어요." },
  { id: "qa-html-clinics", file: "directory-list", title: "도쿄·오사카 클리닉 12곳", ask: "도쿄랑 오사카 클리닉 상담료 싼 순으로 정리해 줘", answer: "초진 상담료가 낮은 순이에요." },
].map((s) => ({ ...s, html: read(s.file) }));

export const sample = (file) => SAMPLES.find((s) => s.file === file);

/**
 * Nine pages the real model wrote for these asks (server's run against the v3 guide, saved as returned, 1.8–6 KB):
 * what the renderer meets in practice. Numbers, names and links are the model's (07's tracking link is the one the ask
 * gave, its query string escaped as &amp;); QA stubs every https request, so nothing is ever fetched. 10 and 11 are
 * two laptop tables of the v3.5 run (full/09, lazy/11) whose header cells set no size: the frame's default made them
 * 11.4 px (a 13 px table) and 12.25 px (14 px). 12 is a thread of the v3.8 run (lazy/02) whose <small> times set no
 * size: the browser's `smaller` made them 11.67 px of a 14 px line.
 */
const llmDir = path.join(dir, "llm");
export const LLM = [
  ["01-dc-thread", "커뮤니티 스레드", "디시인사이드 스타일 커뮤니티 스레드 만들어줘"],
  ["02-dc-running", "러닝화 추천 스레드", "디시 스타일로 \"러닝화 추천\" 글 만들어 줘"],
  ["03-week-edit", "이번 주 일정", "토요일 오후 3시에 친구 결혼식도 추가해서 다시 보여줘"],
  ["04-phone-compare", "아이폰 17 vs 갤럭시 S26", "아이폰 17 vs 갤럭시 S26 비교표"],
  ["05-flea-poster", "가을 플리마켓", "동네 플리마켓 포스터"],
  ["06-market-card", "오늘의 시장", "오늘 코스피, 나스닥, 환율 카드"],
  ["07-delivery", "배송 조회", "배송 조회 카드 만들어줘. CJ대한통운 송장 689412345678"],
  ["08-busan-trip", "부산 1박 2일", "부산 1박 2일 여행 일정 짜줘. 바다랑 맛집 위주, 숙소는 해운대"],
  ["09-laptops", "노트북 5종 비교", "노트북 5종을 사양 7개로 비교해줘"],
  ["10-laptops-th", "노트북 5종 사양 비교", "노트북 5종(맥북 에어 M4 13, 갤럭시 북5 프로 14, LG 그램 16, 레노버 요가 슬림 7x, 에이수스 젠북 14 OLED)을 사양 7개로 비교해줘"],
  ["11-laptops-bare", "노트북 5종 · 사양 7개 비교", "노트북 5종을 사양 7개로 비교해줘"],
  ["12-dc-running-small", "러닝화 추천 스레드", "디시 스타일로 \"러닝화 추천\" 글 만들어 줘"],
].map(([file, title, ask]) => ({ id: `qa-llm-${file.slice(0, 2)}`, file, title, ask, answer: "만들어 봤어요.", html: fs.readFileSync(path.join(llmDir, `${file}.html`), "utf8") }));

/** the directory five times over (60 rows, a real "65 places" answer): the sheet must size and scroll it smoothly */
export function longDirectory() {
  const s = sample("directory-list").html;
  const i = s.indexOf("</style>") + "</style>".length;
  const css = s.slice(0, i);
  const body = s.slice(i);
  return css + Array.from({ length: 5 }, () => body).join("\n");
}

/**
 * Three '전부' (find everything) answers the real model wrote after a deep search (lead's run-deep-112055, after
 * 77fa203): one line per place, every place a link. The clinic list is 21.6 KB and 120 links, the largest card a
 * real answer has made; the dermatology list 13.4 KB / 65 links; the dentists 10.3 KB / 19 links with chips. Saved
 * as returned; QA stubs every https request, so nothing is ever fetched.
 */
const deepDir = path.join(dir, "deep");
export const DEEP = [
  ["mounjaro", "일본 마운자로(스시자로) 클리닉 목록", "일본에서 마운자로 처방받을 수 있는 곳 전부 찾아줘", "약 270곳을 확인했고, 가격 낮은 순으로 120곳을 담았어요."],
  ["derm", "도쿄·오사카 한국어 진료 피부과", "도쿄랑 오사카에서 한국어 되는 피부과 전부 가격순으로 알려줘", "확인된 금액 기준으로 정리했어요."],
  ["dentist", "도쿄에서 한국어 되는 치과", "도쿄에서 한국어 되는 치과 전부 찾아줘", "25곳을 찾았어요."],
].map(([file, title, ask, answer]) => ({ id: `qa-deep-${file}`, file, title, ask, answer, html: fs.readFileSync(path.join(deepDir, `${file}.html`), "utf8") }));

/**
 * '전부' cards drawn by code from rows (deep-15: the model sends card_rows, agent-runtime's drawRowsCard draws the
 * card, the server's cleanArtifactHtml keeps it byte for byte). Rows go in as the tool takes them (cardRowOf: a link
 * whole, or none past the 2,048 characters the app opens; deduped by name and region, by phone and by page); the title
 * is the tool's (rowsCardTitle of the pages' titles, their counts and page marks gone). Synthetic: 150 and 500 rows
 * (made-up clinics, example.jp links, masked numbers, one row in nine without a link, two price units: a '다른 기준
 * 가격' line between them); 500 rows with 60-character names and 40-character areas, and 500 whose prices are half
 * words with no amount: both past the height estimate (made at 256 px of content, a 320-wide screen, so the card stays
 * under the frame's 100,000 px there), '전체 500곳 중 405곳' and '중 368곳'; 40 and 500 rows with every field at its
 * clip length (Hangul, 570-character links, a third on a Hangul host, every sixth too long to open: no link; the 500 go
 * past the 300 KB cap: '전체 500곳 중 325곳'); real: a mounjaro run (pages.json run 2 through the tool itself: 236
 * rows). Every region stays on a cut card. `answer`: the model's short reply and the line the code adds after the card
 * (answers.json; a cut card's line names every place left off). `sent`: rows given, `links`: rows with a link,
 * `groups`: regions, `cut`: the card left rows out. QA stubs every https request.
 */
const rowsDir = path.join(dir, "deep-rows");
const rowsAnswers = JSON.parse(fs.readFileSync(path.join(rowsDir, "answers.json"), "utf8"));
export const ROWS = [
  ["rows-150", 150, 134, 12, false, "도쿄·오사카 마운자로 클리닉 (합성)", "도쿄·오사카 마운자로 처방 클리닉 전부 찾아줘"],
  ["rows-500", 500, 445, 12, false, "일본 마운자로 처방 클리닉 (합성)", "일본 마운자로 처방 클리닉 빠짐없이 전부"],
  ["rows-tall", 500, 405, 12, true, "이름이 아주 긴 클리닉 (합성)", "이름 긴 클리닉 전부"],
  ["rows-cut", 500, 368, 12, true, "가격 말이 긴 클리닉 (합성)", "가격 설명 긴 클리닉 500곳 전부"],
  ["rows-long", 40, 32, 9, false, "칸이 아주 긴 행 (합성)", "긴 이름 클리닉 전부"],
  ["rows-max", 500, 249, 12, true, "칸이 아주 긴 행, 크기 한도 (합성)", "긴 이름 클리닉 500곳 전부"],
  ["rows-mounjaro", 236, 235, 14, false, "일본 마운자로 처방 클리닉 전체 목록", "일본에서 마운자로 처방하는 곳 전부 찾아줘"],
].map(([file, sent, links, groups, cut, title, ask]) => ({ id: `qa-rows-${file.slice(5)}`, file, sent, links, groups, cut, title, ask, answer: rowsAnswers[file], html: fs.readFileSync(path.join(rowsDir, `${file}.html`), "utf8") }));

/**
 * Everything the model must not get away with. Each line names what it tries; the spec checks the frame for the
 * evidence (window.__pwned, requests to /qa-remote, the frame's URL, forms, handlers, hrefs). REMOTE is replaced with
 * the spec's own origin, so a request that slipped out would be seen (and answered 404), never sent anywhere else.
 */
export const HOSTILE = `<style>
@import url("REMOTE/qa-remote/import.css");
.bg{background:url(REMOTE/qa-remote/bg.png);height:8px}
.esc{background:\\75 rl(REMOTE/qa-remote/escaped.png);height:8px}
.set{background-image:image-set("REMOTE/qa-remote/set.png" 1x);height:8px}
.tall{height:100vh;max-height:120px;background:var(--surface);border-radius:var(--radius)}
</style><style>p.x{color:var(--danger)}</style><style>.ok{color:var(--text)}</style>
<meta http-equiv="refresh" content="0;url=REMOTE/qa-remote/refresh">
<base href="REMOTE/qa-remote/base/">
<link rel="stylesheet" href="REMOTE/qa-remote/link.css">
<h2 class="ok">보안 점검 페이지</h2>
<p class="ok">아래는 모두 막혀야 해요.</p>
<script>window.__pwned = "script"; parent.postMessage({ type: "height", h: 19999 }, "*");</script>
<img src="x" onerror="window.__pwned='onerror'">
<img src="REMOTE/qa-remote/img.png" alt="원격 이미지">
<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" alt="" width="8" height="8">
<svg width="10" height="10" onload="window.__pwned='svg'"><script>window.__pwned='svgscript'</script><a href="javascript:window.__pwned='svglink'"><rect width="10" height="10"/></a></svg>
<form action="REMOTE/qa-remote/form" method="get"><input name="q" value="하늘"><button id="qa-submit" type="submit">보내기</button></form>
<p><a id="qa-js" href="javascript:window.__pwned='js'">자바스크립트 링크</a> · <a id="qa-data" href="data:text/html,<script>alert(1)</script>">데이터 링크</a> · <a id="qa-hash" href="#top">같은 페이지</a></p>
<p><a id="qa-http" href="http://example.com/plain">http 링크</a> · <a id="qa-mail" href="mailto:qa@example.com">메일</a> · <a id="qa-tel" href="tel:+82212345678">전화</a></p>
<p><a id="qa-idn" href="https://аррӏе.com/login"><b>애플</b> 로그인</a></p>
<map name="m"><area id="qa-area" shape="rect" coords="0,0,10,10" href="https://example.com/area"></map>
<iframe src="REMOTE/qa-remote/iframe"></iframe><object data="REMOTE/qa-remote/object"></object><embed src="REMOTE/qa-remote/embed">
<div class="bg"></div><div class="esc"></div><div class="set"></div><div class="tall"></div>
<div style="background:url('REMOTE/qa-remote/inline.png');height:4px"></div>
<details open ontoggle="window.__pwned='toggle'"><summary>열림</summary>내용</details>
<input autofocus onfocus="window.__pwned='focus'">
<noscript><p title="</noscript><img src=x onerror=window.__pwned='noscript'>"></p></noscript>
<math><mtext><table><mglyph><style><img src=x onerror="window.__pwned='mxss'"></style></mglyph></table></mtext></math>
<p class="x" style="behavior:url(REMOTE/qa-remote/htc)">끝</p>`;
