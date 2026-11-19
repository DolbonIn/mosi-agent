/**
 * @pickle/agent — LLM client (OpenGateway, streaming + tools), the runTurn loop, system tools and
 * memory side calls. See docs/architecture/PACKAGES.md.
 */
import { DEFAULT_BASE_URL, DEFAULT_MODEL, UpstreamError } from "./llm";

export * from "./types";
export {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  LlmClient,
  UpstreamError,
  billableTokens,
  estimateTokens,
  loadLlmConfig,
  toOpenAiTools,
  type LlmChunk,
  type LlmClientOptions,
  type LlmCompletion,
  type LlmConfig,
  type LlmRequest,
  type Usage,
} from "./llm";
export {
  DEFAULT_MAX_STEPS,
  DEFAULT_TOOL_TIMEOUT_MS,
  TOOL_ERROR_SUMMARY,
  TOOL_STOPPED_SUMMARY,
  TOOL_TIMEOUT_SUMMARY,
  createRunTurn,
  parseToolArgs,
  partialOutcome,
  repairHistory,
  truncateUtf8,
  type RunTurnOptions,
} from "./loop";
export {
  CARD_DONE_REPLY,
  CARD_MAX_ROWS,
  CARD_STATUS,
  CARD_AGENT_BYTES,
  CARD_ALL_ROWS,
  CARD_HEIGHT_BUDGET,
  CARD_URL_MAX,
  CARD_COUNT_TOKEN,
  CARD_PAGE_MS,
  CARD_PAGES_GUARD,
  CARD_PAGE_ROWS,
  CARD_ROWS_TOOL,
  CARD_MIN_PLACES,
  CARD_READ_MS,
  CARD_READ_BY_MS,
  LIST_CHECK,
  PLACES_MAX,
  listPrice,
  nameFee,
  nameWalk,
  DEEP_MAX_STEPS,
  DEEP_MAX_TOKENS,
  DEEP_SEARCH_DEFAULTS,
  EXHAUSTIVE_MAX_STEPS,
  EXHAUSTIVE_SEARCH_DEFAULTS,
  EXPLORE_RULE,
  ExploreTracker,
  QUIET_BEAT_MS,
  TOOL_MARKUP_NOTE,
  ToolMarkupFilter,
  VOICE_SEARCH_PREFACE,
  cardRowOf,
  cardRows,
  cardTitle,
  cardToolOf,
  cleanCard,
  domainOf,
  drawRowsCard,
  drawRowsCards,
  allAgain,
  exploreHints,
  exploreIntent,
  exploreOpen,
  askedStem,
  askedSidos,
  askedGus,
  exploreKind,
  exploreStatus,
  isPlaceholderPhone,
  priceValue,
  renderRowsCard,
  rowsCardTitle,
  scrubPlaceholderPhones,
  siteKey,
  type CardRow,
  type CardTool,
  type RowsCard,
  type DeepSearchLimits,
  type DeepSearchOptions,
  type ExploreHints,
  type ExploreSummary,
  type ExploreTrackerInit,
} from "./explore";
export { assertPublicUrl, htmlToText, isBlockedAddress, normalizeDashboard, normalizeScheduleRule, systemTools, webFetchTool, type PinnedInit, type WebFetchOptions } from "./system-tools";
export { extractMemories, isSameFact, parseJsonObject, titleFor, type SideCallOptions } from "./memory";
export { ICON_NAMES, iconOr, isIconName } from "./icons";
export { looksSecret, scrubSecrets } from "./secrets";
export {
  CONNECTION_SERVICE_RE,
  ConnectionError,
  ConnectionRegistry,
  connectionErrorCode,
  connectionHandle,
  connectionReason,
  knownSecrets,
  memoryConnections,
  memorySession,
  needsConnection,
  redactResult,
  redactor,
  type ConnectionErrorCode,
  type ConnectionRegistryOptions,
  type ConnectionStatus,
  type ConnectionVault,
  type KnownSecrets,
  type Redactor,
} from "./connections";
export { KST_OFFSET_MS, WEEKDAYS_KO, formatKst, koreanClock, kstClock, kstDateKey, kstIso, kstParts, type KstParts } from "./kst";

// ───────────────────────────── legacy (first slice) ─────────────────────────────

export interface OpenGatewayConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): OpenGatewayConfig {
  const apiKey = env.OPENGATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error("OPENGATEWAY_API_KEY is not set. Provide it via env only.");
  }
  return {
    apiKey,
    baseUrl: (env.OPENGATEWAY_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: env.OPENGATEWAY_MODEL ?? DEFAULT_MODEL,
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  config?: OpenGatewayConfig;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const cfg = opts.config ?? loadConfig();
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: opts.temperature ?? 0.7,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new UpstreamError(res.status, raw.split(cfg.apiKey).join("[redacted]").slice(0, 300));
  }
  const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new UpstreamError(res.status, "empty completion");
  }
  return content.trim();
}

export interface AgentTool {
  name: string;
  description: string;
  run(input: unknown): Promise<unknown>;
}

export interface AgentSession {
  readonly userId: string;
  readonly tools: readonly AgentTool[];
  history(): readonly ChatMessage[];
  send(userText: string, signal?: AbortSignal): Promise<string>;
}

export interface AgentSessionInit {
  userId: string;
  systemPrompt: string;
  tools?: AgentTool[];
  config?: OpenGatewayConfig;
  maxHistory?: number;
  maxTokens?: number;
}

export function createSession(init: AgentSessionInit): AgentSession {
  const system: ChatMessage = { role: "system", content: init.systemPrompt };
  const requested = init.maxHistory ?? 20;
  const limit = Math.max(2, requested - (requested % 2));
  let turns: ChatMessage[] = [];
  return {
    userId: init.userId,
    tools: init.tools ?? [],
    history: () => turns,
    async send(userText: string, signal?: AbortSignal) {
      const next: ChatMessage[] = [...turns, { role: "user", content: userText }];
      const reply = await chat([system, ...next], {
        config: init.config,
        signal,
        maxTokens: init.maxTokens,
      });
      turns = [...next, { role: "assistant" as const, content: reply }].slice(-limit);
      return reply;
    },
  };
}
