/**
 * An entry's area as its source writes it — "大阪市中央区", "오사카 신사이바시", "渋谷区", "Tokyo Shinjuku" — to tell
 * apart places with one name. Never translated. A value that reads as an address keeps its area part only
 * ("大阪府大阪市中央区心斎橋筋2-7-18" → "大阪府大阪市中央区", "서울특별시 강남구 테헤란로 123" → "서울특별시 강남구").
 *
 * Sources (items.ts picks the first one an entry has): a location element (class lc / loc / location / addr / region /
 * city …, <address>, itemprop address), a table's area column (지역 / 위치 / 주소 / area / location / エリア / 所在地 / 住所 …),
 * a labelled value in the text ("지역: 신주쿠", "所在地：…") or an address in the text: a JP prefecture + municipality, a
 * designated city + ward or a Tokyo ward; a KR 시·도 + 시·군·구 followed by a road, a 동 or a number.
 *
 * Bounded regexes over short strings (an entry's text is looked at up to TEXT_LOOK characters).
 */
import { cleanLabel, meaningful } from "./html";

/** characters kept */
export const AREA_CHARS = 30;
const TEXT_LOOK = 2_000;

const JP_PLACE = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー々ヶ]";
const JP_PREF =
  "(?:北海道|東京都|(?:大阪|京都)府|(?:青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)県)";
/** a municipality with its ward or town: 渋谷区, 大阪市中央区, 横浜市西区, 虻田郡ニセコ町, 墨田区錦糸町 */
const JP_MUNI = `${JP_PLACE}{1,6}?[市区町村郡](?:${JP_PLACE}{1,4}?[区町村])?`;
/** 東京都渋谷区, 大阪府大阪市中央区 (the municipality is what makes it an address) */
const JP_ADDRESS = new RegExp(`${JP_PREF}\\s?${JP_MUNI}`, "u");
const JP_PREF_ONLY = new RegExp(JP_PREF, "u");
/** 大阪市中央区, 名古屋市中区: a designated city's ward, written without its prefecture */
const JP_CITY_WARD = new RegExp(
  `(?<!\\p{Script=Han})(?:札幌|仙台|さいたま|千葉|横浜|川崎|相模原|新潟|静岡|浜松|名古屋|京都|大阪|堺|神戸|岡山|広島|北九州|福岡|熊本)市${JP_PLACE}{1,4}?区`,
  "u",
);
const TOKYO_WARD = /(?<!\p{Script=Han})(?:千代田|中央|港|新宿|文京|台東|墨田|江東|品川|目黒|大田|世田谷|渋谷|中野|杉並|豊島|北|荒川|板橋|練馬|足立|葛飾|江戸川)区/u;

/** 서울 강남구, 부산광역시 해운대구 (a metropolitan city: 구 / 군) · 경기 성남시 분당구, 제주 서귀포시 (a province: 시 / 군) */
const KR_CORE =
  "(?<![가-힣])(?:(?:서울|부산|대구|인천|광주|대전|울산)(?:특별시|광역시|시)?\\s?[가-힣]{1,4}?[구군]|세종(?:특별자치시|시)|" +
  "(?:경기(?:도)?|강원(?:특별자치도|도)?|충청[남북]도|충[남북]|전라[남북]도|전[남북](?:특별자치도)?|경상[남북]도|경[남북]|제주(?:특별자치도|도)?)" +
  "\\s?[가-힣]{1,4}?[시군](?:\\s?[가-힣]{1,4}?구)?)(?![가-힣])";
const KR_AREA = new RegExp(KR_CORE, "u");
/** in running text an area word is an address only when a road, a 동 or a number follows ("경기 연구" is not one) */
const KR_ADDRESS = new RegExp(`${KR_CORE}(?=\\s{1,2}(?:[가-힣0-9.·-]{1,12}(?:로|길|동|읍|면|리|가)(?=[\\s\\d,(]|$)|\\d))`, "u");

/** "지역: 신주쿠", "위치 : 오사카 난바", "所在地：大阪市…", "Area: Shinjuku" (a colon after the word) */
const AREA_CUE = /(?<![\p{L}])(?:지역|위치|소재지|주소|동네|area|location|address|エリア|地域|所在地|住所|場所)\s{0,2}[:：]\s{0,2}([^\n|｜]{2,120})/iu;
/** a table column of areas */
const AREA_HEADER = /^(?:지역|위치|소재지|주소|동네|시[·・/]?구|area|region|location|city|address|エリア|地域|所在地|住所|場所)$/i;
/** a value's own label or postal code in front ("住所：", "〒530-0001", "주소 :") */
const LEAD = /^(?:(?:지역|위치|소재지|주소|area|location|address|エリア|地域|所在地|住所|場所)\s{0,2}[:：]\s{0,2})?(?:〒\s{0,2}\d{3}-?\d{4}\s{0,2})?/i;

const NOT_AREA = /@|:\/\/|www\.|\.(?:com|net|org|co|kr|jp|site|io)(?![\p{L}\p{N}])/iu;

/**
 * The area part of an address ("…中央区心斎橋筋2-7-18" → "…中央区"), or null when it doesn't read as one. "text": in
 * running text (a KR area needs a road / 동 / number after it); "value": a location element's or cell's value; "long":
 * a long value, where a prefecture alone will do.
 */
export function addressArea(s: string, mode: "text" | "value" | "long" = "value"): string | null {
  const t = s.normalize("NFC");
  const hit =
    JP_ADDRESS.exec(t) ?? JP_CITY_WARD.exec(t) ?? TOKYO_WARD.exec(t) ?? (mode === "text" ? KR_ADDRESS : KR_AREA).exec(t) ?? (mode === "long" ? JP_PREF_ONLY.exec(t) : null);
  return hit ? hit[0].replace(/\s+/g, " ").trim() : null;
}

/** a lot number alone: "15-1", "315-57" */
const LOT_ONLY = /^\d{1,5}(?:-\d{1,5}){0,2}$/;
/**
 * a KR address alone: a road and its number ("연무장길 37-30", "서울숲2길 45", "98-1왕십리로", "서울특별시 성동구 연무장17길 5 …")
 * or a 동 / 가 / 리 and its lot ("성수동2가 315-57"), its 시·도 / 시·군·구 in front, a floor or room after
 */
const KR_ADDRESS_ONLY =
  /^(?:(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|[가-힣]{1,10}(?:특별시|광역시|특별자치시|특별자치도|도|시|군|구))\s?){0,3}(?:[가-힣A-Za-z0-9.·]{0,20}[가-힣0-9](?:로|길)\s?\d{1,5}(?:-\d{1,5})?|\d{1,5}(?:-\d{1,5})?\s?[가-힣0-9]{1,20}(?:로|길)|[가-힣0-9]{1,10}(?:동|가|리)\s?\d{1,5}(?:-\d{1,5})?(?:번지)?)(?:,?\s?(?:지하\s?)?\d{1,3}\s?(?:층|호|F))?\s?(?:…|\.{3})?$/u;
/** what follows a JP address's area: its street and number ("梅田1-1-1", "六本木三丁目2番1号 …") */
const JP_STREET = /^\s?[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々ヶ]{0,10}[0-9０-９]/u;

/**
 * Whether a name is only an address or a lot number ("연무장길 37-30", "15-1", "서울특별시 성동구 연무장17길 5 …",
 * "大阪市北区梅田1-1-1"): a link labelled by where the place is, its name elsewhere in its card
 */
export function addressOnly(name: string): boolean {
  const t = name.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!t || t.length > 80) return false;
  if (LOT_ONLY.test(t) || KR_ADDRESS_ONLY.test(t)) return true;
  const jp = t.replace(/^〒\s?\d{3}-?\d{4}\s?/, "");
  const hit = JP_ADDRESS.exec(jp) ?? JP_CITY_WARD.exec(jp) ?? TOKYO_WARD.exec(jp);
  return !!hit && hit.index === 0 && JP_STREET.test(jp.slice(hit[0].length));
}

/** an area element's / cell's / labelled value → the area ("" when nothing usable) */
export function areaValue(raw: string): string {
  // its first clause: "도쿄 신주쿠산초메 · 역 도보 2분" → "도쿄 신주쿠산초메"
  const first = (raw.split(/\n|\s[·•|｜/／]\s|\s{2,}/)[0] ?? "").replace(/\s+/g, " ").trim().replace(LEAD, "").trim();
  // "이메일 주소: a@b.com", "홈페이지 주소: https://…", a phone: not an area
  if (!meaningful(first) || NOT_AREA.test(first) || !/\p{L}/u.test(first)) return "";
  // an address keeps its area part: two pages writing one address apart ("…2-7-18" / "…2-7-18 3F") still meet
  const area = addressArea(first, first.length > AREA_CHARS ? "long" : "value");
  if (area && meaningful(area)) return cleanLabel(area, AREA_CHARS);
  if (first.length <= AREA_CHARS) return first;
  const cut = first.split(/[,，、]/)[0]!.trim();
  return meaningful(cut) ? cleanLabel(cut, AREA_CHARS) : "";
}

/** a table header cell that names an area column */
export const isAreaHeader = (cell: string): boolean => AREA_HEADER.test(cell.replace(/[*_`:：]/g, "").replace(/\s+/g, "").trim());

/** the area in an entry's own text: a labelled value, else an address (strict), else "" */
export function areaIn(text: string): string {
  const t = text.length > TEXT_LOOK ? text.slice(0, TEXT_LOOK) : text;
  const cue = AREA_CUE.exec(t);
  if (cue) {
    const v = areaValue(cue[1]!);
    if (v) return v;
  }
  const a = addressArea(t, "text");
  return a && meaningful(a) ? cleanLabel(a, AREA_CHARS) : "";
}
