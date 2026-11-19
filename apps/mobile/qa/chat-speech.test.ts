import { describe, expect, test } from "bun:test";
import { CLAUSE_LONG, CLAUSE_MIN, isEcho, letters, packSegments, speakable, speechChunks, speechCutter, STREAM_MAX, streamSegments } from "../src/screens/chat/call/speechText";

const squash = (s: string) => s.replace(/\s+/g, "");

describe("speakable", () => {
  test("strips markdown, links, URLs and emoji", () => {
    expect(speakable("**오늘** 서울은 _맑아요_ 😊")).toBe("오늘 서울은 맑아요");
    expect(speakable("자세한 건 [기상청](https://weather.go.kr)에서 봐요")).toBe("자세한 건 기상청에서 봐요");
    expect(speakable("여기 있어요: https://example.com/a?b=1 확인해 보세요")).toBe("여기 있어요: 확인해 보세요");
    expect(speakable("# 제목\n- 하나\n- 둘")).toBe("제목 하나 둘");
    expect(speakable("코드\n```js\nx()\n```\n끝")).toBe("코드 끝");
  });
  test("keeps ranges, decimals and Korean punctuation", () => {
    expect(speakable("기온은 10~15도, 강수 확률 3.5%예요")).toBe("기온은 10~15도, 강수 확률 3.5%예요");
  });
});

describe("speechChunks", () => {
  test("one chunk per sentence, in order, covering the whole text", () => {
    const text = "오늘 서울은 맑아요. 낮 기온은 18도까지 올라가요! 우산은 필요 없겠어요?";
    const chunks = speechChunks(text);
    expect(chunks).toEqual(["오늘 서울은 맑아요.", "낮 기온은 18도까지 올라가요!", "우산은 필요 없겠어요?"]);
    expect(squash(chunks.join(""))).toBe(squash(speakable(text)));
  });
  test("line breaks end a sentence; markdown and URLs are not sent", () => {
    const chunks = speechChunks("**요약**\n- 지하철 2호선 3분 뒤 도착\n- 자세히: https://x.example/y");
    expect(chunks.join(" ")).not.toMatch(/https?:|\*\*/);
    expect(chunks[0]).toContain("요약");
  });
  test("a tiny opener joins the next sentence", () => {
    expect(speechChunks("네! 오늘 일정은 세 개예요.")).toEqual(["네! 오늘 일정은 세 개예요."]);
  });
  test("first chunk is short, the rest stay under the limit, nothing is lost", () => {
    const text =
      "오늘 오후 세 시에 강남역 근처 카페에서 팀 회의가 잡혀 있고, 회의가 끝나면 다섯 시 반까지 디자인 리뷰 자료를 정리해서 공유해야 하며, 저녁에는 친구와 약속이 있어요. 내일은 비 소식이 있으니 우산을 챙기세요.";
    const chunks = speechChunks(text);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.length).toBeLessThanOrEqual(40);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(70);
    for (const c of chunks) expect(letters(c)).toBeGreaterThan(0);
    expect(squash(chunks.join(""))).toBe(squash(speakable(text)));
  });
  test("list numbers don't end a sentence; an emoji before a space does", () => {
    expect(speechChunks("1. 서울역\n2. 시청역\n3. 을지로입구역")).toEqual(["1 서울역 2 시청역", "3 을지로입구역"]);
    expect(speechChunks("저는 깽이예요 😊 오늘 기분은 아주 좋아요.")).toEqual(["저는 깽이예요", "오늘 기분은 아주 좋아요."]);
  });
  test("no chunk for symbol-only text", () => {
    expect(speechChunks("😊 … **")).toEqual([]);
    expect(speechChunks("")).toEqual([]);
  });
});

describe("streamSegments", () => {
  test("a normal reply is ONE stream request, every sentence closed with punctuation", () => {
    expect(streamSegments("안녕하세요! 저는 깽이예요 😊 오늘 기분은 아주 좋아요. 당신은 어때요?")).toEqual(["안녕하세요! 저는 깽이예요. 오늘 기분은 아주 좋아요. 당신은 어때요?"]);
    expect(streamSegments("**요약**\n- 2호선 3분 뒤\n- 자세히: https://x.example/y")).toEqual(["요약. 2호선 3분 뒤. 자세히:"]);
  });
  test("over the service limit: whole sentences per request, nothing lost", () => {
    const text = "오늘은 날씨가 좋아요. ".repeat(60);
    const segs = streamSegments(text);
    expect(segs.length).toBe(2);
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(STREAM_MAX);
    expect(segs.join(" ").replace(/\s+/g, "")).toBe(speakable(text).replace(/\s+/g, ""));
    expect(streamSegments("가".repeat(700)).map((s) => s.length)).toEqual([600, 101]);
  });
  test("nothing to say → no request", () => {
    expect(streamSegments("😊 **")).toEqual([]);
  });
});

describe("isEcho (barge-in guard)", () => {
  const spoken = "오늘 서울은 맑고 낮 기온은 18도까지 올라가요.";
  test("the agent's own words coming back are echo", () => {
    expect(isEcho("서울은 맑고", spoken)).toBe(true);
    expect(isEcho("오늘 서울은 막고 낮 기온은", spoken)).toBe(true);
  });
  test("too short to tell counts as echo", () => {
    expect(isEcho("어", spoken)).toBe(true);
  });
  test("the person saying something else is not", () => {
    expect(isEcho("잠깐만요", spoken)).toBe(false);
    expect(isEcho("그만하고 내일 일정 알려 줘", spoken)).toBe(false);
  });
});

describe("packSegments (the pieces the call cut, per stream request)", () => {
  test("pieces in order, joined into as few ≤ 600-character requests as possible", () => {
    expect(packSegments(["네, 내일 서울은 오전에 비가 오다가 오후에는 그치고", "기온은 18도예요."])).toEqual(["네, 내일 서울은 오전에 비가 오다가 오후에는 그치고 기온은 18도예요."]);
    const many = Array.from({ length: 60 }, () => "오늘은 날씨가 좋아요.");
    const segs = packSegments(many);
    expect(segs.length).toBe(2);
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(STREAM_MAX);
    expect(packSegments(["가".repeat(700)]).map((s) => s.length)).toEqual([600, 100]);
    expect(packSegments(["  ", ""])).toEqual([]);
  });
});

/** stream `reply` into a cutter `step` characters at a time (closed = a tool runs at those lengths), then the done text */
function streamed(reply: string, step = 3, closedAt: number[] = []) {
  const c = speechCutter();
  const out: { at: number; piece: string }[] = [];
  for (let i = step; i < reply.length + step; i += step) for (const piece of c.feed(reply.slice(0, i), closedAt.includes(i))) out.push({ at: Math.min(i, reply.length), piece });
  for (const piece of c.feed(reply, true, true)) out.push({ at: -1, piece });
  return { out, pieces: out.map((o) => o.piece), cutter: c };
}
const lettersOf = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");

describe("speechCutter (the reply spoken while it streams)", () => {
  const replies = [
    "안녕하세요, 하늘님! 오늘 목소리가 밝네요.",
    "네! 오늘 서울은 맑아요. 낮 기온은 18도예요.",
    "네, 내일 서울은 오전에 비가 오다가 오후에는 그치고 기온은 18도 정도로 선선할 것 같아요. 우산 챙기세요.",
    "오늘은 3.5도예요. 내일은 10~15도고요.",
    "자세한 건 [기상청](https://weather.go.kr)에서 봐요. 그럼 좋은 하루 보내세요!",
    "코드는 이래요\n```js\nx()\n```\n끝이에요.",
    "저는 깽이예요 😊 오늘 기분은 아주 좋아요.",
    "**요약**\n- 2호선 3분 뒤\n- 자세히: https://x.example/y",
    "좋아요, 이번 주말이면 국립현대미술관 서울관의 소장품 기획전을 추천해요. 평일보다는 붐비지만 오전 열 시쯤 가면 꽤 한산하고, 전시실이 넓어서 천천히 걷기 좋아요.",
  ];
  test("every piece once, in order: together exactly the spoken reply, at any delta size", () => {
    for (const reply of replies)
      for (const step of [1, 2, 3, 7, 40]) {
        const { pieces } = streamed(reply, step);
        expect([reply, step, lettersOf(pieces.join(""))]).toEqual([reply, step, lettersOf(speakable(reply))]);
        expect(new Set(pieces).size).toBe(pieces.length);
      }
  });
  test("a sentence leaves once whitespace follows its mark: '3.5도' stays whole, the last one waits for the done text", () => {
    const c = speechCutter();
    expect(c.feed("오늘은 3.")).toEqual([]);
    expect(c.feed("오늘은 3.5도예요.")).toEqual([]);
    expect(c.feed("오늘은 3.5도예요. 내")).toEqual(["오늘은 3.5도예요."]);
    expect(c.feed("오늘은 3.5도예요. 내일은 더워요")).toEqual([]);
    expect(c.feed("오늘은 3.5도예요. 내일은 더워요", true, true)).toEqual(["내일은 더워요."]);
    expect(c.said()).toBe("오늘은 3.5도예요. 내일은 더워요.");
  });
  test("the first piece: the first sentence — every sentence already whole goes with it", () => {
    const c = speechCutter();
    expect(c.feed("안녕하세요. 반가워요. 오늘")).toEqual(["안녕하세요.", "반가워요."]);
  });
  test("a long first sentence (open at CLAUSE_LONG letters) goes at its last clause boundary with ≥ CLAUSE_MIN letters", () => {
    expect([CLAUSE_MIN, CLAUSE_LONG]).toEqual([12, 24]);
    const { out } = streamed("네, 내일 서울은 오전에 비가 오다가 오후에는 그치고 기온은 18도 정도로 선선할 것 같아요. 우산 챙기세요.", 1);
    expect(out[0]!.piece).toBe("네, 내일 서울은 오전에 비가 오다가 오후에는 그치고");
    expect(out[1]!.piece).toBe("기온은 18도 정도로 선선할 것 같아요.");
    // a comma counts too
    expect(streamed("오늘 오후 세 시에 강남역 근처 카페에서 팀 회의가 있어요, 끝나면 바로 알려 드릴게요.", 1).pieces[0]).toBe("오늘 오후 세 시에 강남역 근처 카페에서 팀 회의가 있어요,");
    // a short first sentence is never cut, whatever connective it has
    expect(streamed("비가 오고 바람이 불어요. 우산 챙기세요.", 1).pieces[0]).toBe("비가 오고 바람이 불어요.");
  });
  test("never after a particle, a quote or a filler; never mid-word", () => {
    const first = (t: string) => streamed(t, 1).pieces[0]!;
    expect(first("회의실에서 하늘 님하고 만나서 이야기를 나누었고 그 다음에 결정했어요.")).toBe("회의실에서 하늘 님하고 만나서 이야기를 나누었고");
    expect(first("하늘 님이 내일 오전 열 시까지 보고서를 보낸다고 하셨는데 아직 소식이 없어요.")).toBe("하늘 님이 내일 오전 열 시까지 보고서를 보낸다고 하셨는데");
    expect(first("오늘 일정은 오전 회의와 오후 미팅이 있고 그리고 저녁에는 약속이 있어요.")).toBe("오늘 일정은 오전 회의와 오후 미팅이 있고");
    // no boundary at all: the whole sentence
    expect(first("오늘 서울 날씨는 미세먼지 농도가 보통 수준인 맑은 날씨가 될 예정이에요.")).toBe("오늘 서울 날씨는 미세먼지 농도가 보통 수준인 맑은 날씨가 될 예정이에요.");
  });
  test("a tiny opener ('네!') waits for the next sentence", () => {
    const c = speechCutter();
    expect(c.feed("네! 오")).toEqual([]);
    expect(c.feed("네! 오늘 서울은 맑아요. ")).toEqual(["네!", "오늘 서울은 맑아요."]);
  });
  test("closed (a tool is running): the text so far is whole and goes now, closed with a mark", () => {
    const c = speechCutter();
    expect(c.feed("확인해 볼게요")).toEqual([]);
    expect(c.feed("확인해 볼게요", true)).toEqual(["확인해 볼게요."]);
    expect(c.feed("확인해 볼게요\n\n오늘 서울은 맑고 18도예요.", false)).toEqual([]);
    expect(c.feed("확인해 볼게요\n\n오늘 서울은 맑고 18도예요.", true, true)).toEqual(["오늘 서울은 맑고 18도예요."]);
  });
  test("open markup holds back: a link or a code fence still arriving", () => {
    const c = speechCutter();
    expect(c.feed("자세한 건 [기상청](https://weather.go")).toEqual([]);
    expect(c.feed("자세한 건 [기상청](https://weather.go", true)).toEqual(["자세한 건."]);
    const d = speechCutter();
    expect(d.feed("코드는 이래요.\n```js\nconsole.log('안녕하세요. 반가워요. ')")).toEqual(["코드는 이래요."]);
    expect(d.feed("코드는 이래요.\n```js\nconsole.log('안녕하세요. 반가워요. ')\n```\n끝이에요. ")).toEqual(["끝이에요."]);
  });
  test("a done text that no longer starts with what was said: nothing more, ever (the call stops cleanly)", () => {
    const c = speechCutter();
    expect(c.feed("안녕하세요. 오늘은 ")).toEqual(["안녕하세요."]);
    expect(c.diverged()).toBe(false);
    expect(c.feed("반가워요. 오늘은 맑아요.", true, true)).toEqual([]);
    expect(c.diverged()).toBe(true);
    expect(c.feed("안녕하세요. 오늘은 맑아요.", true, true)).toEqual([]);
  });
  test("pieces cut while streaming match what speakable() shows for the final text (markdown, emoji, lists)", () => {
    const { pieces } = streamed("**요약**\n1. 서울역\n2. 시청역\n저는 깽이예요 😊 끝!", 2);
    expect(pieces).toEqual(["요약.", "1 서울역.", "2 시청역.", "저는 깽이예요.", "끝!"]);
  });
});
