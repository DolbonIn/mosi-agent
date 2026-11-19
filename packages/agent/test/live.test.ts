/**
 * Live smoke test against OpenGateway. Skipped unless OPENGATEWAY_API_KEY is set:
 *   bun --env-file=$HOME/.config/pickle-clone/secrets.env test packages/agent/test/live.test.ts
 */
import { expect, test } from "bun:test";
import type { AgentEvent } from "@pickle/protocol";
import { LlmClient, createRunTurn, extractMemories, loadLlmConfig, systemTools, titleFor, type ToolDef } from "../src/index.ts";
import { fakeCtx } from "./mock-llm.ts";

const KEY = process.env.OPENGATEWAY_API_KEY;
const live = KEY ? test : test.skip;

const SYSTEM = `당신은 모시 앱에서 하늘님을 돕는 개인 AI 에이전트 "깽이"입니다. 항상 한국어로, 따뜻하고 간결하게 답하세요.
날씨 같은 실시간 정보는 추측하지 말고 도구로 확인하고, 출처를 짧게 밝히세요. 도구 결과를 지어내지 마세요.`;

function weatherTool(calls: Record<string, unknown>[]): ToolDef {
  return {
    name: "k_weather",
    description: "Current weather and today's high/low for a Korean city (기상청 data).",
    parameters: { type: "object", properties: { city: { type: "string", description: "city name in Korean, e.g. 서울" } }, required: ["city"] },
    icon: "cloud",
    title: (a) => `${String(a.city ?? "")} 날씨 확인`,
    async run(a) {
      calls.push(a);
      const city = String(a.city ?? "서울");
      return {
        ok: true,
        summary: `${city} 14°, 흐림`,
        data: { place: city, tempC: 14, condition: "흐림", high: 17, low: 9, pop: 30, source: "기상청(테스트 데이터)" },
        card: { type: "weather", place: city, now: { tempC: 14, condition: "흐림", icon: "cloud" }, high: 17, low: 9, source: "기상청" },
      };
    },
  };
}

const ms = (n: number) => `${Math.round(n)}ms`;

live(
  "real turn: the model calls the weather tool and answers in Korean",
  async () => {
    const llm = new LlmClient(loadLlmConfig());
    const runTurn = createRunTurn(llm);
    const calls: Record<string, unknown>[] = [];
    const events: AgentEvent[] = [];
    const t0 = performance.now();
    let firstText = 0;
    const outcome = await runTurn(
      { ctx: fakeCtx({ now: () => new Date() }), system: SYSTEM, history: [], userText: "오늘 서울 날씨 어때?", tools: [weatherTool(calls), ...systemTools()] },
      (e) => {
        events.push(e);
        if (e.type === "text" && !firstText) firstText = performance.now() - t0;
      },
    );
    const total = performance.now() - t0;
    console.log(
      `[pickle/agent] live turn: total ${ms(total)}, first text ${ms(firstText)}, tool calls ${calls.length}, usage ${outcome.usage.totalTokens} tok, text=${JSON.stringify(outcome.text.slice(0, 120))}`,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]!.city)).toContain("서울");
    expect(/[가-힣]/.test(outcome.text)).toBe(true);
    // the model may add parallel calls (e.g. sys_time) — require tool results between two assistant messages
    expect(outcome.messages[0]!.role).toBe("assistant");
    expect(outcome.messages.at(-1)!.role).toBe("assistant");
    expect(outcome.messages.some((m) => m.role === "tool")).toBe(true);
    expect(events.some((e) => e.type === "tool" && e.tool.state === "done")).toBe(true);
    expect(outcome.cards.some((c) => c.type === "weather")).toBe(true);
    expect(JSON.stringify({ events, outcome })).not.toContain(KEY!);
  },
  90_000,
);

live(
  "real turn: maxSteps=1 forces a final answer with tool_choice none after tool history",
  async () => {
    const llm = new LlmClient(loadLlmConfig());
    const calls: Record<string, unknown>[] = [];
    const t0 = performance.now();
    const outcome = await createRunTurn(llm)(
      { ctx: fakeCtx({ now: () => new Date() }), system: SYSTEM, history: [], userText: "서울이랑 부산 날씨 각각 알려줘", tools: [weatherTool(calls)], maxSteps: 1 },
      () => {},
    );
    console.log(`[pickle/agent] live forced-final: total ${ms(performance.now() - t0)}, tool calls ${calls.length}, text=${JSON.stringify(outcome.text.slice(0, 100))}`);
    expect(calls.length).toBeGreaterThan(0);
    expect(/[가-힣]/.test(outcome.text)).toBe(true);
    expect(outcome.messages.at(-1)?.role).toBe("assistant");
  },
  90_000,
);

live(
  "side calls: memory extraction and thread title",
  async () => {
    const llm = new LlmClient(loadLlmConfig());
    const t0 = performance.now();
    const [facts, title] = await Promise.all([
      extractMemories(llm, { userText: "참고로 나는 커피는 무조건 아이스 아메리카노만 마셔. 강아지 이름은 콩이야.", assistantText: "알겠어요, 기억해둘게요!", existing: [] }),
      titleFor(llm, "이번 주말에 제주도 가는데 비행기랑 숙소 좀 알아봐줘"),
    ]);
    console.log(`[pickle/agent] live side calls: ${ms(performance.now() - t0)}, facts=${JSON.stringify(facts)}, title=${JSON.stringify(title)}`);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.length).toBeLessThanOrEqual(3);
    expect([...title].length).toBeLessThanOrEqual(18);
    expect(title.length).toBeGreaterThan(0);
  },
  60_000,
);
