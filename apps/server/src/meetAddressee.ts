/**
 * Who a meeting line is for, while 모시 is in conversation mode (meet.ts): "addressed" (a question or request to 모시,
 * or the conversation with it going on), "other" (people talking to each other) or "dismiss" (모시 should stop talking
 * and only listen again). One fast call per line, with the last few lines as context.
 *
 * Two backends, picked by PICKLE_MEET_ADDRESSEE (main.ts; the other one is the fallback when the first fails):
 *  - "decider": OpenGateway's Decisions API (`POST {base}/decisions`, model sionic-ai/decider-4b, a `choice` question);
 *    billed on input tokens only.
 *  - "chat": the meeting chat model with a one-letter answer (max 2 tokens, no hidden reasoning).
 * Logs nothing here; meet.ts logs the verdict and the latency only, never the text.
 */
import type { ChatRequest } from "./meet.ts";

export type Addressee = "addressed" | "other" | "dismiss";

export interface AddresseeInput {
  /** the line to judge */
  utterance: string;
  speaker: string | null;
  /** the last few lines of the meeting, oldest first ("지민: …", "모시: …") */
  recent: string[];
  agent: string;
}

export interface AddresseeResult {
  verdict: Addressee;
  /** probability of the verdict, when the backend gives one */
  p: number | null;
  ms: number;
  backend: "decider" | "chat";
  /** tokens to count toward the user's daily quota */
  tokens: number;
}

export type AddresseeClassifier = (i: AddresseeInput, signal?: AbortSignal) => Promise<AddresseeResult>;

const line = (i: AddresseeInput) => `${i.speaker ? `${i.speaker}: ` : ""}${i.utterance}`.slice(0, 400);
const context = (i: AddresseeInput) => i.recent.slice(-6).map((l) => l.slice(0, 300));

/** The criteria both backends use (Korean: the meetings are Korean). */
export function addresseeCriteria(agent: string): Record<Addressee, string> {
  return {
    addressed: `AI 비서 '${agent}'에게 하는 질문이나 부탁, 또는 ${agent}와 나누던 대화를 이어 가는 말`,
    other: `회의 참석자들끼리 하는 말 (${agent}에게 하는 말이 아님)`,
    dismiss: `${agent}에게 이제 그만 말하고 조용히 듣기만 하라는 말 (예: 조용히 해, 이제 됐어, 고마워 됐어, 듣고만 있어, 그만 얘기해, 이제 우리끼리 얘기할게)`,
  };
}

const LEAD = String.raw`(?:(?:아|어|음|저|자|그럼|근데|그리고)[,\s]+)?`;
const NAME_VOCATIVE = new RegExp(String.raw`^\s*${LEAD}([가-힣A-Za-z]{1,10})\s?님(?=[\s,.!?]|$)`);
const GROUP_VOCATIVE = new RegExp(String.raw`^\s*${LEAD}(?:다들|여러분|모두들?|다\s같이)(?=[\s,.!?]|$)`);

/**
 * "민수님, …", "지민님 화면 공유 좀 …", "다들 …": said to someone else in the room. Never for the agent (its own name
 * is a call, handled before), so no check is needed.
 */
export function addressesOthers(text: string, agent: string): boolean {
  const m = NAME_VOCATIVE.exec(text);
  if (m && !m[1]!.startsWith(agent)) return true;
  return GROUP_VOCATIVE.test(text);
}

const ASK_WORD = /(뭐|뭘|무엇|무슨|언제|어디|어떻게|어때|어떤|어떨|왜|누가|누구|몇|얼마)/;
const REQUEST = /(줘|줘요|주세요|줄래|주실래|주시겠|주실\s*수|줄\s*수|해\s*봐|알려|찾아|확인해|정리해|요약해|말해|읽어|들려|보여)/;

/**
 * A question or a request ("…?", "언제…", "…알려 줘"). An unnamed line that is neither ("그럼 수요일로 확정할게요.",
 * "제가 오후에 올릴게요.") isn't answered even when the classifier leans "addressed": statements in a meeting are for
 * the room. Dismisses ("이제 됐어") are statements too; they don't go through this.
 */
export function looksLikeAsk(text: string): boolean {
  return /[?？]/.test(text) || ASK_WORD.test(text) || REQUEST.test(text);
}

/** p(addressed) the decider needs before 모시 answers an unnamed line (see the eval in SERVER-CONTRACT.md) */
export const DECIDER_MIN_ADDRESSED = 0.7;

/** OpenGateway Decisions API (sionic-ai/decider-4b by default). */
export function deciderClassifier(o: {
  baseUrl: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** "addressed" below this probability counts as "other": a missed follow-up costs less than answering cross-talk */
  minAddressed?: number;
  fetch?: typeof fetch;
}): AddresseeClassifier {
  const model = o.model ?? "sionic-ai/decider-4b";
  const minAddressed = o.minAddressed ?? DECIDER_MIN_ADDRESSED;
  const url = `${o.baseUrl.replace(/\/+$/, "")}/decisions`;
  const doFetch = o.fetch ?? fetch;
  return async (i, signal) => {
    const t0 = performance.now();
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 2000);
    const res = await doFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        state: { recent: context(i).join("\n") || "(없음)", utterance: line(i) },
        questions: {
          to: {
            type: "choice",
            instructions: `회의 받아쓰기의 마지막 말 \`utterance\`는 누구에게 하는 말인가? \`recent\`는 바로 앞의 회의 내용이다. ${i.agent}는 회의에 참여한 AI 비서이고, 지금 참석자와 대화 중이다.`,
            criteria: addresseeCriteria(i.agent),
          },
        },
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`decisions ${res.status}`);
    }
    const body = (await res.json()) as { answers?: { to?: { choice?: unknown; probabilities?: Record<string, number> } }; usage?: { input_tokens?: number; total_tokens?: number } };
    const a = body.answers?.to;
    const choice = a?.choice === "addressed" || a?.choice === "other" || a?.choice === "dismiss" ? a.choice : null;
    if (!choice) throw new Error("decisions: no choice");
    const tokens = Number(body.usage?.total_tokens ?? body.usage?.input_tokens ?? 0) || 0;
    const p = typeof a?.probabilities?.[choice] === "number" ? a.probabilities[choice]! : null;
    const verdict: Addressee = choice === "addressed" && p !== null && p < minAddressed ? "other" : choice;
    return { verdict, p, ms: Math.round(performance.now() - t0), backend: "decider", tokens };
  };
}

/** The meeting chat model answering with one letter. */
export function chatClassifier(chat: (i: ChatRequest) => AsyncIterable<string>, o: { timeoutMs?: number } = {}): AddresseeClassifier {
  return async (i, signal) => {
    const t0 = performance.now();
    const c = addresseeCriteria(i.agent);
    const system = [
      `회의 받아쓰기의 마지막 말이 누구에게 하는 말인지 고르세요. ${i.agent}는 회의에 참여한 AI 비서이고, 지금 참석자와 대화 중이에요.`,
      `A: ${c.addressed}`,
      `B: ${c.other}`,
      `C: ${c.dismiss}`,
      "A, B, C 중 알파벳 하나만 답하세요.",
    ].join("\n");
    const user = `바로 앞의 회의 내용:\n${context(i).join("\n") || "(없음)"}\n\n판단할 마지막 말:\n${line(i)}`;
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 2000);
    let out = "";
    let tokens = 0;
    for await (const d of chat({ system, user, maxTokens: 2, temperature: 0, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, onUsage: (n) => (tokens = n) })) {
      out += d;
      if (/[ABC]/i.test(out)) break;
    }
    const m = out.toUpperCase().match(/[ABC]/);
    if (!m) throw new Error("chat classifier: no letter");
    const verdict: Addressee = m[0] === "A" ? "addressed" : m[0] === "C" ? "dismiss" : "other";
    return { verdict, p: null, ms: Math.round(performance.now() - t0), backend: "chat", tokens };
  };
}

/** The second classifier answers when the first one fails (network, 4xx/5xx, timeout). */
export function withFallback(primary: AddresseeClassifier, secondary: AddresseeClassifier | null): AddresseeClassifier {
  if (!secondary) return primary;
  return async (i, signal) => {
    try {
      return await primary(i, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      return secondary(i, signal);
    }
  };
}

/**
 * PICKLE_MEET_ADDRESSEE: "decider" (default: 60/60 on 30 realistic lines × 2 with meet.ts's context and the rules
 * above, p50 ~70 ms) | "chat" (53/60, p50 ~170 ms, misses follow-ups) | "off" (no follow-ups: the name every time).
 */
export function addresseeBackendFromEnv(raw: string | undefined): "decider" | "chat" | "off" {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "chat" || v === "off" ? v : "decider";
}
