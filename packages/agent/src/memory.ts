/** Cheap side calls: durable-fact extraction after a turn, and thread titles. */
import type { LlmClient } from "./llm";
import { looksSecret } from "./secrets";

const EXTRACT_SYSTEM = `너는 대화에서 사용자에 대한 "오래 유지될 사실"만 골라내는 기록 담당이야.
- 대상: 사용자가 직접 밝힌 지속적인 취향, 습관/루틴, 프로필(사는 곳, 직업, 가족·반려동물 이름), 관계, 반복 일정.
- 제외: 일회성 요청, 오늘만의 상황, 추측, 에이전트가 한 말, 이미 아는 사실(기존 목록과 같은 의미), 날씨·뉴스 같은 외부 정보.
- 절대 금지: 비밀번호, 인증번호, 카드번호, 계좌번호, 주민등록번호, 토큰, API 키 같은 비밀 정보.
- 각 사실은 3인칭 없이 짧은 한국어 문장 하나(60자 이내). 예: "커피는 아이스 아메리카노를 좋아함"
- 새로 저장할 것이 없으면 빈 배열.
반드시 JSON 객체 하나로만 답해: {"facts": ["...", "..."]} (최대 3개)`;

const norm = (s: string) => s.toLowerCase().replace(/[\s.,!?~'"`·…\-_/()[\]{}]+/g, "");

function bigrams(s: string): Set<string> {
  const n = norm(s);
  const out = new Set<string>();
  for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2));
  if (n.length === 1) out.add(n);
  return out;
}

/** Near-duplicate test (normalised equality or ≥ 0.75 bigram Jaccard). */
export function isSameFact(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true;
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return false;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter) >= 0.75;
}

/** Pull the first JSON object out of a model reply (tolerates code fences and chatter). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(t);
  if (direct) return direct;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  return start >= 0 && end > start ? tryParse(t.slice(start, end + 1)) : null;
}

export interface SideCallOptions {
  signal?: AbortSignal;
  /** default 20 s */
  timeoutMs?: number;
}

function sideSignal(o: SideCallOptions): AbortSignal {
  const t = AbortSignal.timeout(o.timeoutMs ?? 20_000);
  return o.signal ? AbortSignal.any([o.signal, t]) : t;
}

/** 0–3 new durable Korean facts from one exchange. Best-effort: returns [] on any failure. */
export async function extractMemories(
  llm: LlmClient,
  i: { userText: string; assistantText: string; existing: string[] },
  o: SideCallOptions = {},
): Promise<string[]> {
  const userText = (i.userText ?? "").trim();
  if (userText.length < 4) return [];
  const existing = (i.existing ?? []).filter((s) => typeof s === "string" && s.trim()).slice(-60);
  const user = [
    `기존에 알고 있는 사실:\n${existing.length ? existing.map((f) => `- ${f}`).join("\n") : "(없음)"}`,
    `사용자: ${userText.slice(0, 2000)}`,
    `에이전트: ${(i.assistantText ?? "").slice(0, 1200)}`,
  ].join("\n\n");
  try {
    const res = await llm.complete({
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: user },
      ],
      jsonMode: true,
      thinking: false,
      temperature: 0.1,
      maxTokens: 400,
      signal: sideSignal(o),
    });
    const obj = parseJsonObject(res.content);
    const raw = Array.isArray(obj?.facts) ? obj.facts : [];
    const out: string[] = [];
    for (const f of raw) {
      if (typeof f !== "string") continue;
      const fact = f.replace(/\s+/g, " ").trim().replace(/^[-•*]\s*/, "");
      if (fact.length < 4 || fact.length > 120) continue;
      if (looksSecret(fact)) continue;
      if ([...existing, ...out].some((e) => isSameFact(e, fact))) continue;
      out.push(fact);
      if (out.length === 3) break;
    }
    return out;
  } catch (err) {
    if (!o.signal?.aborted) console.warn(`[pickle/agent] memory extraction skipped: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function fallbackTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "새 대화";
  return [...t].length > 18 ? `${[...t].slice(0, 17).join("").trimEnd()}…` : t;
}

/** ≤ 18-character Korean thread title. Falls back to the text's start on failure. */
export async function titleFor(llm: LlmClient, text: string, o: SideCallOptions = {}): Promise<string> {
  const src = (text ?? "").trim();
  if (!src) return "새 대화";
  try {
    const res = await llm.complete({
      messages: [
        {
          role: "system",
          content: "다음 요청을 대화 목록에 보일 짧은 한국어 제목으로 요약해. 18자 이내 명사구, 따옴표·마침표·이모지 없이 제목만 출력해. 예: 서울 주말 날씨, 엄마 생신 선물 추천",
        },
        { role: "user", content: src.slice(0, 1500) },
      ],
      thinking: false,
      temperature: 0.2,
      maxTokens: 40,
      signal: sideSignal(o),
    });
    let t = res.content.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    t = t.replace(/^(제목\s*[:：]\s*)/, "").replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, "").replace(/[.。!?]+$/, "").trim();
    if (!t || looksSecret(t)) return fallbackTitle(src);
    const chars = [...t];
    return chars.length > 18 ? chars.slice(0, 18).join("").trim() : t;
  } catch {
    return fallbackTitle(src);
  }
}
