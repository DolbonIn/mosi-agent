/**
 * How chat turns call the model: hidden reasoning off by default. Measured with new users and the
 * real tool list, time until the first model call decides (first text or tool call):
 * - deepseek-v4.1-flash-eco (2026-11-11): provider default 1.6–8.5 s, usually opening with a needless
 *   lookup (sys_recall / sys_schedule_list); reasoning off 0.7–1.5 s, straight to the useful tool or question.
 * - deepseek-v4.1-flash-ultrafast (chat model since 2026-11-12, n=8 each, sequential): greetings
 *   ~0.25 s either way (it doesn't reason there); "오늘 날씨" 1.37 s median with ~480 reasoning chars
 *   vs 0.48 s off; "모닝 브리핑 예약" 1.24 s median (max 4.3 s), ~730 reasoning chars and a needless
 *   sys_schedule_list in 5/8, vs 0.22 s off with no lookup. Same direction as eco, smaller gap.
 * Side calls (memories, titles) already disable reasoning in @pickle/agent.
 */

/**
 * A chat tool call's deadline: PICKLE_TOOL_TIMEOUT_MS, default 25 s, at most 50 s. It must stay below the turn idle
 * watchdog (turnIdleTimeoutMs, 60 s): then a hung tool ends as an error the model answers ("슬랙이 응답하지 않아 …"),
 * instead of the watchdog ending the whole turn. A tool that reports progress may set a longer ToolDef.timeoutMs.
 */
export const CHAT_TOOL_TIMEOUT_MS = 25_000;
export const MAX_CHAT_TOOL_TIMEOUT_MS = 50_000;

export function chatToolTimeoutMs(raw: string | undefined): number {
  const n = Number(raw?.trim() || NaN);
  if (!Number.isFinite(n) || n <= 0) return CHAT_TOOL_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.floor(n), MAX_CHAT_TOOL_TIMEOUT_MS));
}

/**
 * max_tokens of one chat model call. The agent's default (2048) cut html artifacts short: sys_create_artifact kind
 * "html" carries the whole fragment in its arguments (~3-4 bytes of HTML a token), so 2048 stopped near 6-8 KB, a
 * broken call. 16384 covers the long lists the guide allows (up to ~40 KB); the gateway takes it for the chat model
 * (checked 2026-11-15 up to 32768). Text answers end long before; it is a ceiling, not a cost.
 */
export const CHAT_MAX_TOKENS = 16_384;

/**
 * Deep search for "find every place / contact / seller" requests (@pickle/agent explore.ts): on unless
 * PICKLE_DEEP_SEARCH=off. Meeting turns have their own runner and never use it.
 */
export function deepSearchOn(raw: string | undefined): boolean {
  return !/^(?:off|0|false|no)$/i.test(raw?.trim() ?? "");
}

/** "off" (default): chat turns skip hidden reasoning. "provider": leave it to the provider default. */
export type ThinkingMode = "off" | "provider";

export function thinkingMode(raw: string | undefined): ThinkingMode {
  const v = raw?.trim().toLowerCase();
  return v === "on" || v === "provider" || v === "default" ? "provider" : "off";
}

/**
 * The agent's LlmClient for chat turns, with `thinking:false` added to every model request
 * (an explicit `thinking` on a request wins). Methods stay bound to the real client, so its
 * private fields keep working.
 */
export function withThinking<T extends object>(client: T, mode: ThinkingMode): T {
  if (mode === "provider") return client;
  return new Proxy(client, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      if (prop === "stream" || prop === "complete") {
        return (req: Record<string, unknown>, ...rest: unknown[]) => v.call(target, { ...req, thinking: req?.thinking ?? false }, ...rest);
      }
      return v.bind(target);
    },
  });
}
