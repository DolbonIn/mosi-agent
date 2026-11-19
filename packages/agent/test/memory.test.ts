import { afterAll, beforeEach, expect, test } from "bun:test";
import { LlmClient, extractMemories, isSameFact, looksSecret, scrubSecrets, titleFor } from "../src/index.ts";
import { startMockLlm } from "./mock-llm.ts";

const mock = startMockLlm();
afterAll(() => mock.stop());
beforeEach(() => {
  mock.requests.length = 0;
  mock.script.length = 0;
});
const llm = new LlmClient({ apiKey: "k-memory-test", baseUrl: mock.url, model: "m" }, { retryDelayMs: 5 });

test("extractMemories returns new, non-secret, non-duplicate facts (max 3)", async () => {
  mock.script.push({
    text: [
      JSON.stringify({
        facts: ["커피는 아이스 아메리카노를 좋아함", "강아지 이름은 콩이", "비밀번호는 qwer1234", "커피는 아이스아메리카노를 좋아함.", "회사는 판교", "주말엔 등산"],
      }),
    ],
  });
  const facts = await extractMemories(llm, { userText: "나 아아 좋아하고 강아지 콩이 키워. 회사는 판교야", assistantText: "기억할게요", existing: ["커피는 아이스 아메리카노를 좋아함"] });
  expect(facts).toEqual(["강아지 이름은 콩이", "회사는 판교", "주말엔 등산"]);
  const body = mock.requests[0]!.body;
  expect(body.response_format).toEqual({ type: "json_object" });
  expect(body.thinking).toEqual({ type: "disabled" });
  expect(body.stream).toBe(false);
});

test("extractMemories tolerates fenced JSON and returns [] on garbage or errors", async () => {
  mock.script.push({ text: ['```json\n{"facts":["매일 7시에 일어남"]}\n```'] });
  expect(await extractMemories(llm, { userText: "나 매일 7시에 일어나", assistantText: "", existing: [] })).toEqual(["매일 7시에 일어남"]);
  mock.script.push({ text: ["no json here"] });
  expect(await extractMemories(llm, { userText: "아무 말이나 해봐", assistantText: "", existing: [] })).toEqual([]);
  mock.script.push({ status: 400, errorBody: "bad" });
  const warn = console.warn;
  console.warn = () => {};
  try {
    expect(await extractMemories(llm, { userText: "에러 나는 경우", assistantText: "", existing: [] })).toEqual([]);
  } finally {
    console.warn = warn;
  }
});

test("extractMemories skips trivial input without calling the model", async () => {
  expect(await extractMemories(llm, { userText: "ㅇㅇ", assistantText: "", existing: [] })).toEqual([]);
  expect(mock.requests).toHaveLength(0);
});

test("titleFor trims quotes/punctuation and caps at 18 chars; falls back on failure", async () => {
  mock.script.push({ text: ['"서울 주말 날씨."'] });
  expect(await titleFor(llm, "이번 주말 서울 날씨 어때?")).toBe("서울 주말 날씨");
  mock.script.push({ text: ["아주아주아주아주아주아주아주 긴 제목입니다요"] });
  expect([...(await titleFor(llm, "x"))].length).toBeLessThanOrEqual(18);
  mock.script.push({ status: 400 });
  expect(await titleFor(llm, "엄마 생신 선물로 뭐가 좋을지 추천해줄래?")).toBe("엄마 생신 선물로 뭐가 좋을지…");
});

test("secret heuristics", () => {
  expect(looksSecret("비밀번호는 abc12345")).toBe(true);
  expect(looksSecret("주민번호 900101-1234567")).toBe(true);
  expect(looksSecret("커피는 아이스 아메리카노")).toBe(false);
  expect(looksSecret("비밀번호를 자주 잊어버림")).toBe(false);
  for (const t of ["카드 비밀번호 0412 기억해줘", "도어락 비밀번호 1234", "wifi password hunter22", "PIN: 0000"]) expect(looksSecret(t)).toBe(true);
  for (const t of ["토큰 관리가 귀찮아", "암호화폐 투자를 좋아함", "otp 앱을 바꿨어"]) expect(looksSecret(t)).toBe(false);
  expect(scrubSecrets("도어락 비밀번호 1234 맞지?")).toBe("도어락 비밀번호 [가림] 맞지?");
  expect(scrubSecrets("카드 1234 5678 9012 3456 로 결제")).toBe("카드 [가림] 로 결제");
  expect(isSameFact("강아지 이름은 콩이", "강아지 이름은 콩이.")).toBe(true);
  expect(isSameFact("강아지 이름은 콩이", "고양이를 좋아함")).toBe(false);
});
