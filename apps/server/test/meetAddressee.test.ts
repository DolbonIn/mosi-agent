import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "../src/meet.ts";
import {
  addressesOthers,
  addresseeBackendFromEnv,
  chatClassifier,
  deciderClassifier,
  looksLikeAsk,
  withFallback,
  type AddresseeInput,
} from "../src/meetAddressee.ts";

const input: AddresseeInput = {
  utterance: "그럼 QA는 언제 시작해?",
  speaker: "하은",
  recent: ["하은: 모시야, 출시일 언제야?", "모시: 다음 주 수요일이에요."],
  agent: "모시",
};

function fakeFetch(answer: unknown, status = 200) {
  const sent: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, sent };
}

describe("addressee check", () => {
  test("lines said to someone else, and statements, are told apart without the classifier", () => {
    for (const t of ["민수님, QA 인원은 충분하세요?", "지민님 화면 공유 좀 해 주세요.", "아 민수님, 그거요", "다들 이견 없으시죠?", "자, 다들 들어오셨죠?"]) expect(addressesOthers(t, "모시")).toBe(true);
    for (const t of ["하은님이 말씀하신 거 정리해 줘", "모시님 그거 알려 줘", "그럼 QA 기간은 며칠이야?", "민수가 보낸 메일 찾아 줘"]) expect(addressesOthers(t, "모시")).toBe(false);
    for (const t of ["출시 전에 공휴일 있어?", "응, 그 다음은?", "방금 거 다시 한 번 말해 줘요.", "회의 끝나면 요약해서 보내 줘.", "서울 날씨는 어때", "그럼 몇 시야"]) expect(looksLikeAsk(t)).toBe(true);
    for (const t of ["그럼 수요일로 확정할게요.", "아 그거 제가 오늘 오후에 올릴게요.", "생각보다 빠듯하네요.", "고마워, 이제 됐어."]) expect(looksLikeAsk(t)).toBe(false);
  });

  test("decider: one choice question with the line and the recent lines; the bearer key only in the header", async () => {
    const { f, sent } = fakeFetch({ answers: { to: { choice: "addressed", probabilities: { addressed: 0.91, other: 0.05, dismiss: 0.04 } } } });
    const cls = deciderClassifier({ baseUrl: "https://gw.example/v1/", apiKey: "sk-test-123", fetch: f });
    const r = await cls(input);
    expect(r).toMatchObject({ verdict: "addressed", p: 0.91, backend: "decider" });
    expect(sent[0]!.url).toBe("https://gw.example/v1/decisions");
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-123");
    const body = JSON.parse(String(sent[0]!.init.body));
    expect(body.model).toBe("sionic-ai/decider-4b");
    expect(body.state).toEqual({ recent: "하은: 모시야, 출시일 언제야?\n모시: 다음 주 수요일이에요.", utterance: "하은: 그럼 QA는 언제 시작해?" });
    expect(body.questions.to.type).toBe("choice");
    expect(Object.keys(body.questions.to.criteria)).toEqual(["addressed", "other", "dismiss"]);
    expect(String(body.state.utterance) + JSON.stringify(body.questions)).not.toContain("sk-test");
  });

  test("decider: a weak 'addressed' (p < 0.7) counts as other; errors throw", async () => {
    const weak = deciderClassifier({ baseUrl: "https://gw", apiKey: "k", fetch: fakeFetch({ answers: { to: { choice: "addressed", probabilities: { addressed: 0.62 } } } }).f });
    expect((await weak(input)).verdict).toBe("other");
    const dismiss = deciderClassifier({ baseUrl: "https://gw", apiKey: "k", fetch: fakeFetch({ answers: { to: { choice: "dismiss", probabilities: { dismiss: 0.45 } } } }).f });
    expect((await dismiss(input)).verdict).toBe("dismiss");
    const bad = deciderClassifier({ baseUrl: "https://gw", apiKey: "k", fetch: fakeFetch({ error: "x" }, 400).f });
    await expect(bad(input)).rejects.toThrow("decisions 400");
  });

  test("chat: one letter → verdict; the fallback answers when the first backend fails", async () => {
    let reply = "A";
    const seen: ChatRequest[] = [];
    const chat = async function* (i: ChatRequest) {
      seen.push(i);
      yield reply;
    };
    const cls = chatClassifier(chat);
    expect((await cls(input)).verdict).toBe("addressed");
    reply = "c";
    expect((await cls(input)).verdict).toBe("dismiss");
    reply = "B";
    expect((await cls(input)).verdict).toBe("other");
    expect(seen[0]!.maxTokens).toBe(2);
    expect(seen[0]!.user).toContain("하은: 그럼 QA는 언제 시작해?");
    reply = "?";
    await expect(cls(input)).rejects.toThrow();

    const failing = deciderClassifier({ baseUrl: "https://gw", apiKey: "k", fetch: fakeFetch({}, 503).f });
    reply = "A";
    expect((await withFallback(failing, cls)(input)).backend).toBe("chat");
    expect(addresseeBackendFromEnv(undefined)).toBe("decider");
    expect(addresseeBackendFromEnv("chat")).toBe("chat");
    expect(addresseeBackendFromEnv("OFF")).toBe("off");
  });
});
