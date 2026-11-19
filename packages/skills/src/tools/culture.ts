import type { ResultListCard } from "@pickle/protocol";
import { proxyGet, proxyGetText } from "../http";
import { addDays, cleanText, defineSkill, fail, failText, kst, num, schema, str, toYmd, xmlBlocks, xmlText } from "../util";

// ───────────────────────────── 지역 코드 ─────────────────────────────

/** short name → [aliases that may appear in addresses / area fields] */
const SIDO: { key: string; aliases: string[]; kopis?: string; d4l: string }[] = [
  { key: "서울", aliases: ["서울"], kopis: "11", d4l: "11" },
  { key: "부산", aliases: ["부산"], kopis: "26", d4l: "21" },
  { key: "대구", aliases: ["대구"], kopis: "27", d4l: "22" },
  { key: "인천", aliases: ["인천"], kopis: "28", d4l: "23" },
  { key: "광주", aliases: ["광주"], kopis: "29", d4l: "24" },
  { key: "대전", aliases: ["대전"], kopis: "30", d4l: "25" },
  { key: "울산", aliases: ["울산"], kopis: "31", d4l: "26" },
  { key: "세종", aliases: ["세종"], kopis: "36", d4l: "29" },
  { key: "경기", aliases: ["경기"], kopis: "41", d4l: "31" },
  { key: "강원", aliases: ["강원"], d4l: "32" },
  { key: "충북", aliases: ["충북", "충청북"], kopis: "43", d4l: "33" },
  { key: "충남", aliases: ["충남", "충청남"], kopis: "44", d4l: "34" },
  { key: "전북", aliases: ["전북", "전라북"], d4l: "35" },
  { key: "전남", aliases: ["전남", "전라남"], kopis: "46", d4l: "36" },
  { key: "경북", aliases: ["경북", "경상북"], kopis: "47", d4l: "37" },
  { key: "경남", aliases: ["경남", "경상남"], kopis: "48", d4l: "38" },
  { key: "제주", aliases: ["제주"], kopis: "50", d4l: "39" },
];

/** Major cities / districts → 시/도, so "수원" or "분당" filter as 경기. */
const CITY_TO_SIDO: Record<string, string> = {
  수원: "경기", 성남: "경기", 분당: "경기", 판교: "경기", 고양: "경기", 일산: "경기", 용인: "경기", 부천: "경기", 안산: "경기",
  안양: "경기", 화성: "경기", 동탄: "경기", 남양주: "경기", 평택: "경기", 의정부: "경기", 파주: "경기", 시흥: "경기", 김포: "경기",
  광명: "경기", 하남: "경기", 구리: "경기", 군포: "경기", 오산: "경기", 이천: "경기",
  춘천: "강원", 원주: "강원", 강릉: "강원", 속초: "강원",
  청주: "충북", 충주: "충북", 제천: "충북",
  천안: "충남", 아산: "충남", 서산: "충남", 당진: "충남",
  전주: "전북", 익산: "전북", 군산: "전북",
  목포: "전남", 여수: "전남", 순천: "전남", 광양: "전남",
  포항: "경북", 경주: "경북", 구미: "경북", 안동: "경북", 경산: "경북",
  창원: "경남", 김해: "경남", 진주: "경남", 양산: "경남", 거제: "경남", 통영: "경남",
  서귀포: "제주",
};

export function sidoOf(region: string): (typeof SIDO)[number] | undefined {
  const r = region.replace(/\s+/g, "");
  if (!r) return undefined;
  const direct = SIDO.find((s) => s.aliases.some((a) => r.startsWith(a)));
  if (direct) return direct;
  const city = Object.keys(CITY_TO_SIDO).find((c) => r.startsWith(c));
  if (city) return SIDO.find((s) => s.key === CITY_TO_SIDO[city]);
  return SIDO.find((s) => s.aliases.some((a) => r.includes(a)));
}

export const REGION_HINT = "지역은 시·도(예: 서울, 경기, 부산) 단위로 알려주세요";

function inSido(text: string, sido: (typeof SIDO)[number]): boolean {
  const t = text.replace(/\s+/g, "");
  return sido.aliases.some((a) => t.startsWith(a) || t.includes(a));
}

// ───────────────────────────── 공연 (KOPIS) ─────────────────────────────

const GENRES: Record<string, string> = {
  연극: "AAAA",
  뮤지컬: "GGGA",
  클래식: "CCCA",
  국악: "CCCC",
  대중음악: "CCCD",
  콘서트: "CCCD",
  무용: "BBBC",
  대중무용: "BBBE",
  서커스: "EEEB",
  마술: "EEEB",
  복합: "EEEA",
};

export interface Performance {
  id: string;
  name: string;
  from: string;
  to: string;
  venue: string;
  area: string;
  genre: string;
  state: string;
  openRun: boolean;
}

export function parseKopis(xml: string): Performance[] {
  return xmlBlocks(xml, "db").map((db) => ({
    id: xmlText(db, "mt20id"),
    name: xmlText(db, "prfnm"),
    from: xmlText(db, "prfpdfrom"),
    to: xmlText(db, "prfpdto"),
    venue: xmlText(db, "fcltynm"),
    area: xmlText(db, "area"),
    genre: xmlText(db, "genrenm"),
    state: xmlText(db, "prfstate"),
    openRun: xmlText(db, "openrun") === "Y",
  }));
}

export function buildPerformances(label: string, list: Performance[], limit: number): { summary: string; data: Record<string, unknown>; card: ResultListCard } {
  const shown = list.slice(0, limit);
  const short = (d: string) => d.replace(/^\d{4}\./, "");
  return {
    summary: shown.length ? `${label} 공연 ${shown.length}건 · ${shown[0]!.name}` : `${label} 조건에 맞는 공연이 없어요`,
    data: {
      filter: label,
      performances: shown.map((p) => ({ name: p.name, period: `${p.from}~${p.to}`, venue: p.venue, area: p.area, genre: p.genre, state: p.state, id: p.id })),
      source: "KOPIS 공연예술통합전산망",
    },
    card: {
      type: "results",
      title: `${label} 공연`,
      source: "KOPIS",
      items: shown.map((p) => ({
        title: p.name,
        subtitle: `${p.venue}${p.area ? ` · ${p.area.replace(/(특별시|광역시|특별자치시|특별자치도)$/, "")}` : ""}`,
        meta: `${p.genre} · ${short(p.from)}~${short(p.to)}`,
        icon: "film" as const,
      })),
    },
  };
}

export const kPerformances = defineSkill({
  name: "k_performances",
  description:
    "Find performances in Korea (plays, musicals, concerts, classical, dance…) from KOPIS, via k-skill. All parameters optional: " +
    "`query` filters by title keyword, `region` is a 시/도 (e.g. '서울', '부산'), `genre` one of 연극/뮤지컬/클래식/국악/대중음악/무용/서커스, " +
    "`from`/`to` are dates YYYYMMDD (default today → +30 days).",
  parameters: schema({
    query: { type: "string", description: "title keyword, e.g. '레미제라블'" },
    region: { type: "string", description: "시/도, e.g. '서울', '경기', '부산'" },
    genre: { type: "string", enum: ["연극", "뮤지컬", "클래식", "국악", "대중음악", "무용", "서커스"], description: "genre" },
    from: { type: "string", description: "start date YYYYMMDD (default today)" },
    to: { type: "string", description: "end date YYYYMMDD (default from + 30 days)" },
  }),
  icon: "film",
  title: (a) => `${[str(a.region, 10), str(a.genre, 10), str(a.query, 20)].filter(Boolean).join(" ") || "공연"} 찾기`,
  meta: {
    source: "kopis-performance-search",
    title: "공연 찾기",
    description: "KOPIS에서 연극·뮤지컬·콘서트 같은 공연을 지역·장르·기간별로 찾아줘요.",
    category: "문화",
    example: "이번 주말 서울에서 하는 뮤지컬 뭐 있어?",
  },
  async run(a, rc) {
    const t = kst(rc.now);
    const from = toYmd(str(a.from, 12)) || t.ymd;
    let to = toYmd(str(a.to, 12)) || addDays(from, 30);
    if (to < from || to > addDays(from, 31)) to = addDays(from, 31);
    const query = str(a.query, 40);
    const region = str(a.region, 20);
    const sido = region ? sidoOf(region) : undefined;
    if (region && !sido) return failText(`공연: ‘${region}’ 지역을 알아듣지 못했어요. ${REGION_HINT}`, "unknown_region");
    const genre = typeof a.genre === "string" ? GENRES[a.genre] : undefined;
    const r = await proxyGetText(
      "/v1/kopis/performances",
      { stdate: from, eddate: to, cpage: 1, rows: query || (sido && !sido.kopis) ? 100 : 30, signgucode: sido?.kopis, shcate: genre },
      rc.signal,
    );
    if (!r.ok) return fail(r.error, "공연");
    const err = xmlText(r.body, "errmsg") || xmlText(r.body, "returncode");
    if (!r.body.includes("<db>") && err) return failText(`공연: KOPIS 응답 오류 (${err.slice(0, 60)})`, "upstream");
    let list = parseKopis(r.body);
    if (sido) list = list.filter((p) => !p.area || inSido(p.area, sido));
    if (query) {
      const q = query.replace(/\s+/g, "").toLowerCase();
      list = list.filter((p) => p.name.replace(/\s+/g, "").toLowerCase().includes(q));
    }
    const label = [sido?.key ?? region, typeof a.genre === "string" ? a.genre : "", query ? `‘${query}’` : ""].filter(Boolean).join(" ") || "근처";
    return { ok: true, ...buildPerformances(label, list, 10) };
  },
});

// ───────────────────────────── 도서관 (정보나루) ─────────────────────────────

export interface BookSearchResponse {
  response?: {
    numFound?: number;
    docs?: { doc?: { bookname?: string; authors?: string; publisher?: string; publication_year?: string; isbn13?: string; class_nm?: string; bookDtlUrl?: string; loan_count?: string } }[];
    error?: string;
  };
}
export interface LibrariesResponse {
  response?: {
    numFound?: number;
    libs?: { lib?: { libCode?: string; libName?: string; address?: string; tel?: string; homepage?: string; operatingTime?: string; closed?: string } }[];
  };
}

export function rankBooks(query: string, body: BookSearchResponse) {
  const q = query.replace(/\s+/g, "");
  const books = (body.response?.docs ?? [])
    .map((d) => d.doc ?? {})
    .filter((d) => d.bookname)
    .map((d) => ({
      title: cleanText(d.bookname, 120).replace(/\s*:\s*/g, ": "),
      authors: cleanText(d.authors, 80).replace(/^(지은이|저자|글)\s*:\s*/, ""),
      publisher: d.publisher ?? "",
      year: d.publication_year ?? "",
      isbn13: d.isbn13 ?? "",
      loans: num(d.loan_count),
      url: d.bookDtlUrl,
    }));
  // exact-ish title matches first (the API ranks by loan count, which mixes in the same author's other books)
  const score = (t: string) => (t.replace(/\s+/g, "").startsWith(q) ? 2 : t.replace(/\s+/g, "").includes(q) ? 1 : 0);
  const authorHit = (a: string) => a.replace(/\s+/g, "").includes(q);
  return books
    .map((b, i) => ({ b: { ...b, match: score(b.title) > 0 || authorHit(b.authors) }, i, s: score(b.title) }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .map((x) => x.b);
}

export function buildLibrary(
  query: string,
  books: ReturnType<typeof rankBooks>,
  libs: LibrariesResponse | null,
  regionLabel: string | null,
): { summary: string; data: Record<string, unknown>; card: ResultListCard } {
  const libraries = (libs?.response?.libs ?? []).map((l) => l.lib ?? {}).filter((l) => l.libName).slice(0, 6);
  const top = books[0];
  const total = libs?.response?.numFound;
  const exact = !!top?.match;
  const summary = !top
    ? `‘${query}’ 도서를 찾지 못했어요`
    : exact
      ? `‘${top.title.split(":")[0]}’ ${top.authors}${regionLabel && libs ? ` · ${regionLabel} 소장 도서관 ${total ?? libraries.length}곳` : ""}`
      : `‘${query}’와 제목이 일치하는 책은 못 찾았어요 · 비슷한 책 ${Math.min(books.length, 6)}권`;
  const items: ResultListCard["items"] = books.slice(0, regionLabel ? 3 : 6).map((b) => ({
    title: b.title,
    subtitle: [b.authors, b.publisher, b.year].filter(Boolean).join(" · "),
    meta: b.loans !== null ? `대출 ${b.loans.toLocaleString("en-US")}회` : undefined,
    url: b.url,
    icon: "doc" as const,
  }));
  for (const l of libraries) items.push({ title: l.libName ?? "", subtitle: l.address ?? "", meta: l.tel || undefined, url: l.homepage || undefined, icon: "house" });
  return {
    summary,
    data: {
      query,
      exactMatch: exact,
      books: books.slice(0, 6).map(({ match: _m, ...b }) => b),
      holdings:
        regionLabel && libs
          ? { region: regionLabel, isbn13: top?.isbn13, libraryCount: total, libraries: libraries.map((l) => ({ name: l.libName, address: l.address, tel: l.tel, hours: l.operatingTime, closed: l.closed })) }
          : undefined,
      note: !exact
        ? "정보나루 키워드 검색은 대출 많은 순 유사 결과를 줘요. 제목 일부나 저자 이름으로 다시 찾아보세요."
        : regionLabel
          ? "소장 여부만 알려줘요. 대출 가능 여부는 각 도서관 홈페이지에서 확인해야 해요."
          : undefined,
      source: "도서관 정보나루",
    },
    card: { type: "results", title: `‘${query}’ 도서 검색`, source: "도서관 정보나루", items },
  };
}

export const kLibraryBooks = defineSkill({
  name: "k_library_books",
  description:
    "Search books in Korean public libraries (도서관 정보나루 / data4library, via k-skill): title, author, publisher, ISBN, " +
    "loan popularity; with `region` (시/도, e.g. '서울') also lists public libraries in that region holding the top match. " +
    "`query` is a title/author keyword.",
  parameters: schema(
    {
      query: { type: "string", description: "book title or author, e.g. '채식주의자'" },
      region: { type: "string", description: "optional 시/도 to list libraries holding the book, e.g. '서울', '경기'" },
    },
    ["query"],
  ),
  icon: "archive",
  title: (a) => `‘${str(a.query, 30)}’ 도서관 책 찾기`,
  meta: {
    source: "library-book-search",
    title: "도서관 책",
    description: "도서관 정보나루에서 책을 찾고 그 책이 있는 지역 도서관을 알려줘요.",
    category: "문화",
    example: "채식주의자 서울 어느 도서관에 있어?",
  },
  async run(a, rc) {
    const query = str(a.query, 80);
    if (!query) return failText("도서관: 책 제목을 알려주세요");
    const region = str(a.region, 20);
    const sido = region ? sidoOf(region) : undefined;
    if (region && !sido) return failText(`도서관: ‘${region}’ 지역을 알아듣지 못했어요. ${REGION_HINT}`, "unknown_region");
    const s = await proxyGet<BookSearchResponse>("/v1/data4library/book-search", { keyword: query, pageSize: 30 }, rc.signal);
    if (!s.ok) return fail(s.error, "도서관");
    const books = rankBooks(query, s.body);
    if (books.length === 0) return failText(`도서관: ‘${query}’ 도서를 찾지 못했어요`, "not_found");
    let libs: LibrariesResponse | null = null;
    // only look up holdings for a real title/author match, never for a loosely related bestseller
    if (sido && books[0]?.match && books[0].isbn13) {
      const l = await proxyGet<LibrariesResponse>("/v1/data4library/libraries-by-book", { isbn: books[0].isbn13, region: sido.d4l, pageSize: 6 }, rc.signal);
      if (l.ok) libs = l.body;
    }
    return { ok: true, ...buildLibrary(query, books, libs, sido ? sido.key : null) };
  },
});
