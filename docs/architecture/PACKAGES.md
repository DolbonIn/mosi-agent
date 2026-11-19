# Pickle rebuild — architecture & package APIs (binding)

Wire contract: `packages/protocol/src/index.ts`. Server-internal contract: `packages/agent/src/types.ts`.
This file pins each package's **public exports** so packages can be built in parallel. Implement exactly
these names/signatures (extra helpers are fine; renames are not). Runtime: Bun 1.4 + TypeScript, ESM, no build step
(packages export `src/index.ts`). Tests: `bun test` next to each package (`<pkg>/test/*.test.ts`).


```
apps/server     Bun.serve + bun:sqlite. Owns persistence, auth, routes, SSE, quotas, explore, friends, schedules,
                SDUI; implements the storage interfaces below and wires every package together.
apps/mobile     React 19 PWA (see docs/design/MOTION-SPEC.md).
packages/protocol   wire types (shared with the app)
packages/agent      LLM client (OpenGateway, streaming + tools), runTurn loop, system tools, memory extraction
packages/launcher   per-user agent provisioning (gajae-launcher ideas) + persona files + markdown memory + pool
packages/vault      Credential Enclave (device-sealed envelopes), per-user envelope encryption, access log,
                    device-key approval verification; `src/client.ts` = browser WebCrypto helpers
packages/skills     k-skill (NomaDamas/k-skill) tools through its hosted proxy
packages/messengers agent-messenger (npm agent-messenger@2.43.0) hub: KakaoTalk, Slack, Discord, Telegram, LINE, ...
```

Environment (never committed; dev loads `~/.config/pickle-clone/secrets.env`):
`OPENGATEWAY_API_KEY`, `OPENGATEWAY_BASE_URL` (https://apis.opengateway.ai/v1), `OPENGATEWAY_MODEL`
(`deepseek/deepseek-v4.1-flash-ultrafast`), `VAULT_MASTER_KEY` (32 bytes base64), `PICKLE_DATA_DIR` (default `<repo>/.data`),
`PORT` (8787), `KSKILL_PROXY_BASE_URL` (default https://k-skill-proxy.nomadamas.org), optional `TWILIO_*`.

Security invariants (all packages):
- The LLM never sees a password, card number, token or the API key. Tools reference credentials by id; plaintext
  only exists inside `CredentialAccess.use()` callbacks (connector code) and is dropped right after.
- Secrets never appear in logs, errors, SSE events, tool `data`, or HTTP responses. Redact on the way out.
- Like gajae-launcher's key proxy: only `packages/agent`'s LLM client reads the OpenGateway key; tool contexts get no env.
- Outward-facing or irreversible tool actions (sending a message to someone else, payments, deleting) require an
  approval (`ToolDef.approval`). Approvals may be device-signed (ECDSA P-256) → `deviceVerified` in the access log.

---

## @pickle/agent  (`packages/agent/src/index.ts`)

```ts
export * from "./types";                       // ToolDef, ToolContext, RunTurn, TurnInput, TurnOutcome, LlmMessage ...
export interface LlmConfig { apiKey: string; baseUrl: string; model: string }
export function loadLlmConfig(env?: Record<string, string | undefined>): LlmConfig;   // throws if key missing
export class UpstreamError extends Error { status: number }
export class LlmClient {
  constructor(cfg: LlmConfig);
  readonly model: string;
  /** OpenAI-compatible SSE stream (handles `data:` with/without space, reasoning_content, tool_calls deltas, usage) */
  stream(req: LlmRequest): AsyncIterable<LlmChunk>;
  complete(req: LlmRequest): Promise<{ content: string; toolCalls: LlmToolCall[]; usage: Usage }>;
}
export interface LlmRequest { messages: LlmMessage[]; tools?: ToolDef[]; maxTokens?: number; temperature?: number; signal?: AbortSignal; jsonMode?: boolean }
export type LlmChunk = { type: "text"; delta: string } | { type: "reasoning"; delta: string } | { type: "tool_calls"; calls: LlmToolCall[] } | { type: "usage"; usage: Usage } | { type: "finish"; reason: string };
export interface Usage { promptTokens: number; completionTokens: number; totalTokens: number }
export function createRunTurn(llm: LlmClient): RunTurn;   // gjc two-level loop, see below
export function systemTools(): ToolDef[];                 // sys_* tools over ToolContext.store (artifacts, schedules, memory, friends, time)
export function extractMemories(llm: LlmClient, i: { userText: string; assistantText: string; existing: string[] }): Promise<string[]>; // 0–3 durable facts, Korean
export function titleFor(llm: LlmClient, text: string): Promise<string>;  // ≤ 18 chars Korean thread title
// legacy (keep exporting): chat(), createSession(), loadConfig(), DEFAULT_MODEL, DEFAULT_BASE_URL
```
**runTurn loop (ported concept from gajae-code `agent-loop.ts`, MIT):** inner loop = call model (streaming) → emit
`text` deltas as they arrive → if tool calls: run them (`Promise.all` for independent calls; per call emit
`tool` running → done/error; `status` with the tool's Korean title) → append tool results → poll `steer()` and inject
queued user messages → repeat; stop when the model returns no tool calls and nothing is queued, or after `maxSteps`
(then force a final answer without tools). Before running a call: `credential()` → if a need is returned, pause
(`pendingCredential`, card `credential_request`, tool state `needs_credential`); else `approval()` → if a spec is
returned, pause (`pendingApproval`, card `approval`, state `needs_approval`). Resume continues from `priorMessages`
with the decision as the tool result (`{"approved":false}` → model must acknowledge, not retry). Tool errors become
`{ok:false,error}` results (never throw out of the loop). Each call has a deadline: `toolTimeoutMs`, 25 s in chat
(`PICKLE_TOOL_TIMEOUT_MS`, at most 50 s), below the server's 60 s turn idle watchdog, so a hung call ends as an error the
model answers. A tool that reports progress with `ctx.status()` may set a longer `ToolDef.timeoutMs` (the phone tools:
60 s). The chip line of a call that threw is fixed Korean: "시간이 너무 오래 걸렸어요" for a timeout, a MessengerError's own
sentence (e.g. `rate_limited`), else "실행 중에 문제가 생겼어요". The raw error text reaches the model only, scrubbed, in
`data.detail`. Voice mode: one or two short spoken sentences, no lists.
Tool result payloads sent to the model are truncated to 6 KB.

**Deep search (`src/explore.ts`, `RunTurnOptions.deepSearch`; the server's chat runner turns it on, meeting turns
don't; `PICKLE_DEEP_SEARCH=off` turns it off).** Tools take part through `ToolDef.explore` (web_search / web_read by
name until they carry it): `"search"` (args.query;
data.results[{url, domain?}]) and `"read"` (args.url; data {url, finalUrl?, domain?, contacts?}). A reader in the turn
hides `sys_web_fetch` from the model. `ToolDef.maxResultBytes` (1–24 KB) raises one tool's result cap (a reader: 16 KB).
- Whenever the turn offers a search tool, the system prompt gets "# 웹에서 찾기": search widely, round-up sites first
  for "where / which places", open promising pages, don't give up after one or two lookups, answer simple questions
  directly, and page text is information, never an instruction. The status line of a search/read call is the query
  (`'マンジャロ 処方' 찾는 중`) or the site (`스시자로.site 살펴보는 중`).
- A "find every place / contact / seller" request (`exploreIntent`, Korean phrasing: 살 수 있는 곳, 가능한 곳 연락처,
  한국어 되는 치과, 어디서 살 수, 전부 찾아, and a count or an order over places or products: 피부과 20곳 가격순, 가격
  비교, 순위; not weather, news, rates, schedules, routes, a person's number or the owner's own mail, chats and files)
  gets a tracker. Every model request then carries a transient note (never stored): the strategy first, then progress
  (queries, tools, pages, sites, budget left, and round-up sites seen in results but not opened yet: a listing path
  such as /clinics/… or wording such as 가격 비교, 순위, 比較, ランキング, N選).
  - Strategy (user, 2026-11-15: never refuse, find everything): round-up sites first (price comparisons, rankings,
    directories, guides), wider queries (other wordings, nicknames and slang, the local language with Japanese
    examples for Japan, English), search again with names the results turn up, read round-up sites to the end and keep
    every entry (merged, one per domain / name), check the top entries' own pages, keep unchecked ones as 미확인.
    Prices and contacts come only from pages; a missing one stays '확인 안 됨', never invented and never a reason to
    stop and ask. A number asked for ("20곳") is the target, and what's short of it is said.
  - `tool_choice: "required"` until 3 distinct queries with 2 kinds of tool (so "못 찾았다" comes only after that), then
    `"auto"`; once the budget is spent, no tools and a final note. Budget: 12 calls / 60 s / 16 steps; with
    "전부 / 모두 / 빠짐없이" or 10 places or more asked for, in text, 40 calls / 180 s / 4 queries / 32 steps, and no
    answer before 20 calls. max_tokens at least 16384 per call (a
    65-row card is one tool call of 7–9k tokens), and a step quiet for 15 s repeats its last status (the idle watchdog).
  - Search results whose site the model already saw in the turn are dropped before it sees them
    (`data.duplicates`): by domain, by page on platforms that host many places (blogs, cafés, maps, social sites).
  - Answer: one line per place (name, area, price, contact means, source link, 공식 페이지에서 확인 / 정리 사이트 기준 /
    검색 요약만). More than 8 places go into a card first: `sys_create_artifact`, kind html when its schema offers it,
    else table (any number of places when the person asked for a card / 표); grouped by area, cheapest first, one row
    per place, every entry kept; the reply keeps a summary and the top five. A spent
    budget leaves one last step that may only make the card. The channels 모시 can use itself (phone, connected
    messengers) are marked and offered; contacting stays behind approval. A prescription drug or other regulated item
    bought abroad gets one line after the results (국내로 들여올 때는 반입 기준(처방전·수량)을 확인하세요), nothing
    else; other topics get no warning. Nothing found: what was tried and what to try next.
  - Voice: "찾아볼게요." is said first (part of the first step's message), the normal budget even for 전부, no card,
    then two or three places spoken briefly.

## @pickle/launcher  (`packages/launcher/src/index.ts`)

Per-user agent provisioning modelled on gajae-launcher (owner-keyed record, workspace dir, launcher-owned vs
user-owned config keys merged so user edits survive, reconcile that never deletes) and gajae-way persona/memory
(SOUL.md / USER.md / AGENTS.md re-read by mtime, append-only daily log, BM25 recall, fixed safety notices).

```ts
export interface LauncherOptions { rootDir: string; model: string; safetyVersion?: number }
export interface Lease { release(): void; steer(text: string): void; drain(): string[] }
export class AgentLauncher {
  constructor(opts: LauncherOptions);
  provision(userId: string, init: { agentName: string; displayName: string; persona?: string; avatar?: AvatarSpec; enabledSkills?: string[] }): Promise<AgentProfile>; // idempotent
  profile(userId: string): Promise<AgentProfile | null>;
  update(userId: string, patch: AgentPatch): Promise<AgentProfile>;
  workspaceDir(userId: string): string;            // <rootDir>/<userId>
  systemPrompt(userId: string, ctx: { displayName: string; now: Date; mode: "text" | "voice"; connections: string[]; skills: string[]; recalled: string[] }): Promise<string>;
  appendDaily(userId: string, e: { user: string; assistant: string; at: Date }): Promise<void>;
  remember(userId: string, text: string): Promise<{ id: string }>;
  recall(userId: string, query: string, limit?: number): Promise<string[]>;      // BM25 over facts + recent daily logs
  listMemories(userId: string): Promise<{ id: string; text: string; createdAt: number }[]>;
  forget(userId: string, id: string): Promise<boolean>;
  notepad(userId: string): Promise<string>; writeNotepad(userId: string, text: string): Promise<void>;
  acquire(userId: string): Promise<Lease>;          // per-user FIFO mutex; one turn at a time
  tryAcquire(userId: string): Lease | null;          // null when busy (caller may steer instead)
  steer(userId: string, text: string): boolean;      // inject into the running turn; false if idle
  status(userId: string): AgentStatus; setStatus(userId: string, s: AgentStatus): void;
  restart(userId: string): Promise<void>;
  reconcile(userIds: string[]): Promise<{ created: string[]; repaired: string[] }>;
  running(): { userId: string; status: AgentStatus; since: number }[];
}
```
Workspace layout: `config.json` (`{schemaVersion:1, user:{name,persona,avatar,enabledSkills}, launcher:{model,safetyVersion,createdAt}}`),
`SOUL.md` (persona, seeded once), `USER.md` (what the agent knows about its owner, seeded once), `AGENTS.md` (tool &
reply rules, launcher-owned, rewritten when safetyVersion changes), `memory/facts.md`, `memory/daily/YYYY-MM-DD.md`,
`notepad.md`. All writes atomic (tmp + rename).

## @pickle/vault  (`packages/vault/src/index.ts` server, `packages/vault/src/client.ts` browser)

```ts
// server
export class Enclave {
  static load(opts: { dir: string; masterKey: Uint8Array }): Promise<Enclave>; // ECDH P-256 key pair, private half sealed with masterKey at <dir>/enclave-key.json
  info(): EnclaveInfo;                                                       // kid, public JWK, alg, measurement
  openEnvelope(env: EnclaveEnvelope, expectedAad: string): Promise<Record<string, string>>; // throws on kid/aad mismatch or tamper
}
export function enclaveMeasurement(): string;   // sha256 hex of the enclave module source file(s)
export interface CredentialRow { id: string; userId: string; service: string; label: string; kind: CredentialKind; hint: string; keepFor: KeepFor; expiresAt: number | null; sealed: string; createdAt: number; lastUsedAt: number | null; useCount: number }
export interface VaultStorage {   // implemented by apps/server (SQLite)
  insertCredential(row: CredentialRow): Promise<void>;
  getCredential(userId: string, id: string): Promise<CredentialRow | null>;
  listCredentials(userId: string): Promise<CredentialRow[]>;
  updateCredential(userId: string, id: string, patch: Partial<CredentialRow>): Promise<void>;
  deleteCredential(userId: string, id: string): Promise<boolean>;
  getWrappedUserKey(userId: string): Promise<string | null>;
  setWrappedUserKey(userId: string, wrapped: string): Promise<void>;
  insertAccess(userId: string, rec: AccessRecord): Promise<void>;
  listAccess(userId: string, limit: number): Promise<AccessRecord[]>;
}
export class Vault {
  constructor(opts: { enclave: Enclave; masterKey: Uint8Array; storage: VaultStorage; serviceName: (id: string) => string });
  save(userId: string, req: SaveCredentialRequest): Promise<CredentialInfo>;   // aad must equal `${userId}:${service}:${kind}`
  saveSystem(userId: string, i: { service: string; label: string; kind: CredentialKind; hint: string; keepFor: KeepFor; secret: Record<string, string> }): Promise<CredentialInfo>;
  update(userId: string, id: string, secret: Record<string, string>): Promise<void>;   // e.g. refreshed tokens
  list(userId: string): Promise<CredentialInfo[]>;
  renew(userId: string, id: string, keepFor: KeepFor): Promise<CredentialInfo>;
  remove(userId: string, id: string): Promise<boolean>;
  access(userId: string, opts?: { actor?: "agent" | "user" | "system"; deviceVerified?: boolean }): CredentialAccess; // refuses expired (records outcome "denied")
  record(userId: string, rec: Omit<AccessRecord, "id" | "createdAt">): Promise<void>;
  accessLog(userId: string, limit?: number): Promise<AccessRecord[]>;
}
export function keepForToExpiry(keepFor: KeepFor, now: number): number | null;
export function verifyApproval(publicJwk: JsonWebKey, approvalId: string, nonce: string, signatureB64url: string): Promise<boolean>;
export { seal, open, type SealedSecret };   // legacy env-key helpers (keep)

// browser — packages/vault/src/client.ts (WebCrypto only, no node: imports; the app imports "@pickle/vault/client")
export function sealForEnclave(info: EnclaveInfo, plaintext: Record<string, string>, aad: string): Promise<EnclaveEnvelope>;
export function getOrCreateDeviceKey(): Promise<{ id: string; publicJwk: JsonWebKey; sign(data: string): Promise<string> }>; // non-extractable ECDSA P-256 in IndexedDB
export function signApproval(approvalId: string, nonce: string): Promise<{ signature: string; deviceId: string }>;
export function maskHint(kind: CredentialKind, value: string): string;
```
Per-user envelope encryption: random 32-byte DEK per user, wrapped with `VAULT_MASTER_KEY` (AES-256-GCM, aad `dek:<userId>`);
credential secret sealed with the DEK (AES-256-GCM, aad `cred:<userId>:<credId>`). Zero plaintext buffers after use.

## @pickle/skills  (`packages/skills/src/index.ts`)

```ts
export const KSKILL_PROXY: string;                     // env KSKILL_PROXY_BASE_URL or https://k-skill-proxy.nomadamas.org
export function listSkills(): (SkillInfo & { connection?: string; connectionName?: string; write?: boolean })[];
export function skillTools(enabled?: string[]): ToolDef[];     // k_* filtered by enabled (SkillInfo ids, default all) + web_search, web_read
export function skillCatalogForPrompt(enabled?: string[]): string; // compact bullet list for the system prompt (web tools always listed)
export function connectionServices(): ConnectionService[];     // the logins below, for ConnectionRegistry
export function webTools(): ToolDef[];                         // web_search + web_read (already in every skillTools() list)
export function webSearchProviders(): string[];                // provider ids that have their keys (no values)
```
Each tool: fetch with timeout 12s, in-memory cache (5 min), client-side rate limit ≤ 50 req/min shared, Korean `summary`,
compact `data`, and a UI `card` (`weather` / `results`). Never send user identifiers to the proxy — only the query.

Connected tools (`src/connected/`, docs/architecture/KSKILL-CONNECTIONS.md) declare `connection: "<service>"` and run
with the owner's own login from `ctx.connection`, calling the official upstream directly (fixed origins, no redirects,
per-credential rate limit); without a login they return `needsConnection`. `listSkills()` marks them `needsKey: true`,
`configured: false` (the server sets `configured` per owner). Services: `toss-investment` (k_toss_quote,
k_toss_portfolio, k_toss_orders; read-only), `naver-searchad` (k_naver_ad_report, k_naver_ad_keywords; read-only),
`popbill` (k_popbill_invoices; k_popbill_issue_invoice is `write` + approval), `coupang-partners` (k_coupang_search),
`riss` (k_riss_search). Each connection tool states its meeting privacy: `private: true` for the owner's account data
(portfolio, orders, ad report, invoices), `private: false` for public data read with the login (quotes, search volumes,
product and paper searches). Ported MIT logic and its attribution: packages/skills/NOTICE.md.

Web tools (`src/web/`) are always on (not per-owner skills, not `listSkills()` rows). Both carry `explore` ("search" /
"read", deep search in @pickle/agent) and their own `maxResultBytes` (12 KB / 16 KB), so they need the runtime that
honours it (a 6 KB cap would cut their JSON). Every link they return is absolute with the Unicode host
(`https://스시자로.site/…`), which `new URL()` reads back as is.
- `web_search {query, kind: web|blog|cafe|news, lang: ko|ja|en, limit ≤ 20 (8), page ≤ 5, like?: url}` → `{notice,
  provider, like?, results: [{title, url, snippet, provider, domain (Unicode), date?}], nextPage?}` + a `results` card.
  `exa` (EXA_API_KEY; POST /search, type auto, highlights ≤ 320 chars, userLocation from `lang`) is tried first; blogs
  and cafés go to Exa within the big blog / café hosts of the language unless Naver / Daum keys exist (Korean). `like`
  finds similar sites (Exa /findSimilar without the source domain; deprecated upstream, so a 404/405/410 falls back to
  /search with `query` and the site excluded; only a public site, DNS-checked, goes there). `kskill` (the proxy's Naver
  news route, keyless) backs up news; `naver` NAVER_CLIENT_ID/NAVER_CLIENT_SECRET, `kakao` KAKAO_REST_API_KEY, `brave`
  BRAVE_SEARCH_API_KEY, `tavily` TAVILY_API_KEY stay dormant until their keys are set. At most 3 providers per call, 5 s
  each; a 429 or a rejected key pauses that provider (2 min / 1 h); one bucket per provider (5 at once, 60 a minute);
  results cached 10 min. Keys are read from the env at call time and go only into their provider's header.
- `web_read {url, from?, itemsFrom?}` → `{notice, url, domain, asciiDomain?, redirected?, source: exa|direct|exa+direct,
  title, description?, lang?, sources?: [{label, url}], text, textChars, nextFrom?, items?: [{name, key, tel?, area?,
  url?, domain?, text?, links?, contacts?}], itemsTotal, nextItemsFrom?, contacts: {phones, emails, kakao, telegram,
  line, instagram, whatsapp, forms}: [{value, url?, source: link|text}], links: [{label, url, kind: contact|about|faq}]
  (same site), pageLinks?: [{label, url, external?}], compared?: {exa, direct}, direct?: timeout|5xx, directWaitMs?,
  hint?}`. The URL is vetted first
  (http(s) on 80/443, @pickle/agent `assertPublicUrl`), then Exa's copy is asked for (POST /contents, markdown with
  links; the URL without its #fragment, and never a URL with a token / password / session / signature parameter or on a
  share-link host: Google Docs / Drive, Dropbox, OneDrive, SharePoint, Box, iCloud, WeTransfer, Zoom). The page itself
  is fetched too, after Exa's copy or without one (a region article's clinics can be sentences in Exa's copy and a
  list in the page; when neither has a list, Exa's copy answers as it is, and when the page fails, Exa's copy): pinned
  to the vetted IP, ≤ 5 redirects each vetted, 2 MB, 8 s (while no list is in hand — Exa's copy has none, or there is
  none — a slow page gets up to 15 s in the same one request, ending 1 s before web_read's 20 s), an honest User-Agent,
  one request at a time per host ≥ 1 s apart. When only Exa's copy answers because the page timed out (or web_read's
  time ran out) or sent a 5xx, `data` says so — `direct: "timeout" | "5xx"` and `directWaitMs`, never in the summary or
  the text (a 404 or redirect loop leaves no mark; 403 / 429 are refusals, not copies) — and a new read of that URL
  (no `from` / `itemsFrom`; reading on stays in the cache) asks the page once more with Exa's copy from the cache. A
  caller reading such a page again (agent-runtime) does it later, one page of the site at a time like every other read
  of it (net.ts queues a host's requests ≥ 1 s apart in this process; a re-read is one more request to that site,
  so once per page per turn), and stops on 403 / 429 as always. 401/403/429 are
  returned as failures, never retried or worked around — also when Exa had a copy (the copy is not used to get around a
  refusal) — and a site that sent 403/429 (to us or Exa's crawler; with and without "www.", and every host of the
  redirect chain) is not read either way for 10 min (or its Retry-After, ≤ 1 h). List mode: the page's repeated entries
  (cards, rows; ≥ 6, ≤ 1000; siblings with an extra class such as the `fold` of the entries behind 'show more' in the
  same list; same-kind entries folded inside the list included, a branch under a `<details>` named with its chain; cards
  of the same tag right beside the list in its parent, only blank space or comments between, such as a featured row
  before a grid; else ≥ 6 same-site links sharing a path prefix) become `items`. When the title or first `<h1>` states a count ("一覧19院",
  "65곳"), a list of exactly that many wins — also a short one ("一覧5院") and over cards of only part of them, never a
  menu; of such lists the one whose entries are drawn alike inside (level by level the same tags, a class in common,
  numbers in classes aside) first, so wrappers around different blocks (the tips in one fold, the sources in another)
  lose to the 2 lots of "… 2곳 비교", and one inside a section of the page wins over a group of the sections. A name
  ending in an arrow out (↗ ⇗ ➚ ⤴ ↪ …: "카페 탐방 ↗") is a link to more of the site, no entry. A link to the page itself (a jump inside it, a draft's preview ?preview_id=… / preview=true / _thumbnail_id, a
  tracked utm_… or AMP copy /amp/ / ?amp, with or without www.) or a javascript link is never an entry's link; a table
  row's name loses the area its area column repeats. A link that says only 公式サイト / HP or its own address names nothing:
  when most such entries of a list have a heading of their own before them (an article's table per clinic under
  "<h4>…の基本情報</h4>"), each takes its name from the last heading after the entry before it (within 20,000 characters; a
  tagline after ｜ / │, an 【area】 tag and a tail such as の基本情報 / クリニック情報 / 정보 dropped; a heading left with only クリニック /
  当院 names nothing). A table named by a column's label (the first cell of a header row of two cells or more: 施術タイプ / 比較軸
  / メニュー) compares treatments or prices and is no entry; one with a phone or other contact is the place in the last
  heading before it. A table of a place's branches by row (院名 / 店舗名 | 住所 / アクセス / 電話番号, then 梅田院 | …) is one entry per
  row with the row's own phone and area, named by the place in that heading ("エミナルクリニック 梅田院" under "エミナルクリニック 梅田院・心斎橋院",
  "TCB 梅田院" under "TCB 大阪各院"); rows naming clinics of their own ("○○クリニック 梅田院") make it a comparison. So is a table of
  its branches side by side (項目 | 梅田院 | 心斎橋院, then a 住所 / アクセス / 電話番号 row of as many cells) one entry per column with
  the column's own link, phone and area ("Wクリニック 梅田院" under "Wクリニック（大阪梅田院・心斎橋院）": a city of up to 3 letters before the
  branch goes with it), in a card or in a list of table rows; plans side by side (no row about where) are no such table.
  Clinics side by side (クリニック名 | クリニックフォア | DMMクリニック | デジタルクリニック: most header cells hold a clinic's word,
  none only such words like 内科 | 外科, half the row labels at most do) are one entry per column named by the column,
  with its header cell's link and its own rows, never the row labels (受診方法 / 2.5mg料金 …); made-up ones (クリニックA |
  クリニックB, A院 | B院 | C院: letters in order from A or ○○ on one stem) have no entries. A table of label rows about
  one place (a two-cell row クリニック名 / 院名 / 正式名称 / 병원명 / 상호 … | ○○, first or under a 項目 | 内容 header, beside a
  row such as 住所 / 場所 / 電話番号 / 診療時間 / 公式サイト / 주소 / 진료시간) is
  named by that row before its heading or link label ("…公式サイトへ") and kept without a link; a comparison with a clinic per
  row or clinics side by side is not such a table. When the list is table rows and they hold two such places or
  more, each place is one entry from its name row to the next (its link, phone and area together); price and access rows
  stay entries of their own, and a table of one place's label rows with no name row (地図 / 料金プラン / 住所 / アクセス under
  "1.○○クリニック") is one entry named by the heading right before it. A card with a table per branch, each with a name row
  of its own (梅田院, then 心斎橋院), is one entry per branch, each with its own link and area. An entry's name loses a leading
  rank ("1位", "No.3", "2.") but not a decimal ("2.5mg" stays), also when the name is its heading, and the rank before
  its name leaves its text. A name that is only an address or a lot number (연무장길 37-30, 15-1, 뚝섬로 423,
  大阪市北区梅田1-1) gives way to another name in the entry's card — a heading, bold text, an image's alt that is no
  word for a picture (사진 / 이미지 / logo …), the link's title or aria-label — and the address becomes its area; with no
  such name the address stays the name and is the area too. A name that is only a link's or a button's words (지도보기,
  카카오맵 →, 모두지도, アクセス, 地図を開く ↗, LINEで相談, 📞 전화번호: 지도 / 맵 / 보기 / 예약 / 전화 / アクセス / 地図 / 予約 / 開く / 相談 … with only
  other such words, particles and symbols; アクセスクリニック, 전화국 식당, Book Cafe keep a word over and stay names) names
  nothing, nor does a heading of such words, a phone's link or a link beside a button's of its words alone (公式 ▶): a
  card named by buttons is named by its first line holding a clinic's word (ビューティーオンクリニック銀座 under "06 / GINZA,
  TOKYO"; not an address, not a note opening with a symbol), else by its first line, its title or its bold text; a
  button's line (지도보기, 地図を開く) leaves its text, a field's label (電話番号) does not. Such a card under a heading that
  names nothing (기본 정보, 基本情報, 오시는 길) takes the last heading of a higher rank before it ("<h2>서초구청 주차장</h2>" over
  "<h3>기본 정보</h3>"; a table about one place does not, "…へのアクセス・クリニック概要" being a section), the line that named it
  before going back to its words (영업시간 · …); a block of buttons alone (公式サイト ▶ | 公式 ▶) that no heading names is
  no entry. In Exa's copy a card written as a few bare links to one
  page, a heading over or between them ("### 1. 수서역 환승주차장" over "[공영주차장 / …]", "[1시간 3,840원 …]"; "[프롤라
  카페]", "#### 프롤라", "[서울특별시 …]"), is one entry: links to one page at most 12 lines apart with only text,
  headings or links of another kind (a map) between; two list entries, rows or headings in a row to one page stay two
  (branches sharing one site). It is named by its heading when at least half the cards have one of their own (a heading
  every card repeats, 추천 포인트, is a label; a page linked again further down takes none), else by its first link that
  is not an address; the other links' words are its text. A card opening with its lot's plate ("[15-1](p)" over "###
  셉템버 템퍼쳐", "[98-1왕십리로](p)") starts there: a heading above it is the card's before it, whose links the copy lost,
  and the plate's card keeps its address as its name. A line's link of a button's words names nothing ("- 김주필의원 · …
  [카카오맵 →](map)": the line's own words do) and is not its link when another is there. Places written as label rows
  under their headings ("### 1. 서초초교앞 유료 주차장" over "- 📍 주소: …", "- 📞 전화번호: …", "- 30분당: 3,000원": two rows or more,
  one of 주소 / 위치 / 가까운 역 / 전화번호 / 住所 / アクセス / 電話番号 …) are one entry per heading when no linked list is
  there, two of them a list: named by the heading, the rows' "label: value" its text (the phone row its tel), the
  first link under the heading (a map's, whole) its link. Bare links that make no cards are left to the links
  fallback, an address among them its own area. A bracketed tag at its end or front (【】 ［］ [] （） ())
  that names where the place is goes to `area` when the entry has none (an area from its address stays): each part
  (心斎橋・梅田・天王寺など) is a prefecture / ward / city / town by its own word (群馬, 大阪府, 西区, 吹田市, 本町) or shows as a place in the entry
  itself — in its area, before 駅 / 区 / 市 / 町 / エリア / 周辺 / 역, or in its アクセス / 住所 / 所在地 / 위치 / 주소 line —
  never a way of seeing a doctor (オンライン / 온라인 / 電話 / LINE) or a word with a digit. A tag that only advertises the
  page (公式 / PR / 広告 / 2026年最新 / おすすめ / 人気 / 광고 / 공식 / 추천 …) is dropped; any other tag stays (（初回） /
  （2回目以降）, 【オンライン診療】, (남성 전용), a reading or alias such as （アクチュアリー）). `key` is the name, case folded, without
  separators and kind words (클리닉 / 의원 / 병원 / クリニック / 医院 / 病院 / clinic …; specialties kept, both scripts kept) and
  without a reading in kana after a name in Latin letters (eLife（イーライフ） is elife; （オンライン） / （メンズ） and a tag after
  other words, such as GLP-1内服（リベルサスなど）, stay), and `tel`
  the first phone as national digits: the same tel is one place, the same key one name (the area decides). `area` is the
  entry's area as the page writes it, never translated: a location element (class lc / loc / addr / region …,
  `<address>`, itemprop address), a data-area-style attribute, else the first element holding an address alone
  (`<span class="pp-street">연무장길 37-30</span>`, a plate's `<b>98-1</b><span>왕십리로</span>`; a lot number alone or an element
  left open is none), a table's 지역 / 위치 / 주소 / エリア / 所在地 column, "지역: …" / "所在地：…", or an address in its
  text cut to its area part (a JP prefecture + municipality, a designated city's ward, a Tokyo ward; a KR 시·도 + 시·군·구
  before a road / 동 / number). Placeholder phones (two all-zero groups, one digit 7+ times in a row, 12345678, or
  labelled 임시번호 / 예시 / sample / dummy) are never a contact or a tel and leave the text and the items' text. In a table
  with a place per row under a header row (院 | 2.5mg 1本 | 5mg 1本 | 初診料 | Google: a row of `<th>` or the `<thead>` row
  before the first data row, a row of one cell — the table's title, a section — being none; in Exa's copy the row over
  its separator), an entry's text gives each amount after the cell that names it its column's label ("2.5mg 1本 4,800円 ·
  5mg 1本 9,450円 · 初診料 2,000円 · ★4.6"): the cells up to the name's (a rank, a logo) and values without an amount (an
  area, 自費, ★4.6) stay as they are; the label goes before a cell's first line only, and not when the cell says it
  already (初診料 2,000円) or names another dose before its first amount (リベルサス3mg under 2.5mg); a cell saying there is
  none (— / -) and a button's words (詳しく見る, 詳細を見る) leave. Labels go on as long as every amount the row's text
  shows without them still shows within its 110 characters (the last amounts' labels go first; the first amount's always
  stays). A label loses its tax note (（税込）) and is cut at 32 characters; a header of a link's or button's words (詳細 /
  公式), of a word for any value (内容 / 説明 / 값) or the table's own title (料金早見表 / 比較表) gives none. No labels when a
  header cell holds an amount or, in Exa's copy, a link (a data row written as the header), spans columns or names
  places side by side (half the columns after the first a clinic's word, a branch 〜院 / 〜店 or an address: a comparison
  by column, see above), when no label is left, or for a row of another number of cells. On one page
  an entry repeated with the same tel and name is kept once, so is one with the same URL and name in the same area
  (other clinics or branches linking one site stay; a branch word that only one of the names has, such as 新館 / アネックス /
  〜院 / 〜店 / 신관 / 〜점 / N호점, keeps them apart), and so is a block without a link that has the key of an entry with a
  link or phone before it and brings the area or phone that entry lacks, and no other one (a clinic's table of 住所 /
  電話番号 under its heading, after its card); a comparison's row that brings neither stays, a name alone never merges —
  except a column of clinics side by side without a link or phone: it goes into the entry with the same key and a link or
  phone, else into one without (its card under that name or another form of it; never another column), before or after
  it, in a compatible area (its area to that entry when it lacks one). A later block with an entry's phone whose name
  has no clinic's word and whose words name that entry (4 letters or more: "運営・取引のご案内" with "運営：ビューティーオンクリニック銀座")
  is part of it; a clinic of its own sharing the phone (もみじクリニック新宿) stays.
  The entry kept takes the area, phone, contacts and links it lacks from the copy dropped, and the copy's words after
  its own when a link, a phone or a column's key says they are one place (a column's prices, then its card's hours):
  parts said already, or cut short, are left out (a short one stays beside a new one, as its label or value), and over
  the 110 characters of a text the entry keeps half of them at least and its words through its first price (not a 0),
  cut after a whole part (" · ") unless that wastes more than 12 of them, the copy the rest. A row of a name alone keeps
  its first words (one label in several clinics' tables is not one place). When both routes were read, the one with
  more of the page's own places wins: entries to follow up (a link, phone or other contact), each place
  once (its phone, else its link), without links to the site's pages in the page's own folder (its other articles and
  regions, the redirects it sends readers through; a top page has none, one with a phone still counts). Then more of
  them with a phone, the list no longer than the page's title says ("… 2곳 비교": the page's 2 lots over the 6 links
  Exa's copy makes of them), more entries to follow up, more entries that say where they are when half the list does
  or more (a site's popup cards over a menu in its body; a clinic's own label rows say it once, on 住所), more entries
  (the page on a tie). A list drawn from the site's header / nav / footer is its menu and counts no places (Exa's 7
  popup stores over the 8 sections of the site's menu); with no other list it is still the page's. The list is the
  winner's alone,
  contacts / links / the longer text are merged. `from` (characters) and `itemsFrom` (entries) read on from a 10-minute
  cache without a new request (even when the site refuses meanwhile; the cache keeps the 30 pages used last, a hit
  counts as a use and the 10 minutes run from the read). `sources` are up to 4 other sites the page names as its source
  (출처 / 자료·데이터 출처·제공 / source / data from / 出典 / 引用元 / データ提供 before the link, or as its label; footers count), first
  read only. A linear tokenizer parses the page (no script runs); its text is untrusted. A list of more than 1000
  entries keeps the first 1000 and says so (`itemsCut: true`, "1000+" in the summary, and a hint to read its region /
  category pages).

## @pickle/messengers  (`packages/messengers/src/index.ts`)

```ts
export function providers(): ProviderInfo[];
export interface MessengerStorage {   // implemented by apps/server
  getConnection(userId: string, provider: string): Promise<(Connection & { meta: string | null }) | null>;
  listConnections(userId: string): Promise<Connection[]>;
  upsertConnection(userId: string, c: Connection & { meta?: string | null }): Promise<void>;
  deleteConnection(userId: string, provider: string): Promise<void>;
}
export class MessengerHub {
  constructor(opts: { vault: Vault; storage: MessengerStorage; configRoot: string; onUpdate: (userId: string, c: Connection) => void });
  // opts.session: req.credentialId is a session the server produced (login relay, sealed with vault.saveSystem,
  // kind "token"); the connection OWNS it — signed out + deleted on disconnect and when a re-login replaces it (after
  // the new session is live) — and it never counts as the user's saved login (meta.loginCredentialId stays null)
  connect(userId: string, provider: string, req: ConnectRequest, opts?: { session?: boolean }): Promise<ConnectResponse>;
  verify(userId: string, provider: string, code: string): Promise<ConnectResponse>;
  // owned session (anything but the user's own saved token): adapter.revoke?(ctx, secret, meta, signal) inside an
  // audited use() (action "logout", ≤ 10 s, errors swallowed) → adapter.cleanup → vault.remove; never blocks
  disconnect(userId: string, provider: string): Promise<void>;
  connections(userId: string): Promise<Connection[]>;
  listChats(userId: string, provider: string, opts?: { search?: string; limit?: number }): Promise<MessengerChat[]>;
  readMessages(userId: string, provider: string, chatId: string, limit?: number): Promise<ChatMessage[]>;
  // messages + room facts (KakaoTalk: title/kind/member count/unread/nicknames via read-only CHATINFO + GETMEM + MEMBER)
  readThread(userId: string, provider: string, chatId: string, limit?: number): Promise<{ room: RoomInfo; messages: ChatMessage[] }>;
  send(userId: string, provider: string, chatId: string, text: string): Promise<{ ok: boolean; id?: string }>;
  tools(): ToolDef[];        // msg_connections, msg_list_chats, msg_read, msg_send (approval required)
  shutdown(): Promise<void>;
}
// one normalised model for every provider (src/util.ts); provider ids stay inside the package
interface ChatMessage {
  id: string; at: number | null; senderId: string; senderName: string; senderFull?: string; isMe: boolean;
  kind: "text" | "photo" | "video" | "file" | "emoticon" | "link" | "reply" | "system" | "other";
  text: string; replyTo?: { senderName: string; text: string; isMe?: boolean }; attachment?: { label: string }; mentionsMe?: boolean;
}
```
`msg_read` (src/thread.ts): the LLM gets `{chat:{id,name,kind,members}, count, transcript: "[19:30] 이름: …", notable}` (no
message/user ids, no JSON bodies, ≤ ~4.5 KB); the UI gets a `MessengerCard` with `room` + `thread` (opaque m1…/p1… keys)
+ `highlights` (1–3 ids picked by `pickHighlights`, boosted by the optional `focus` argument). KakaoTalk feeds (type 0)
become short Korean system lines; `"hidden":true` feeds and the messages host-moderation feeds (13/14/25) point at are
dropped (src/adapters/kakao-normalize.ts).
Per-user isolation: `AGENT_MESSENGER_CONFIG_DIR=<configRoot>/<userId>` semantics — pass credentials explicitly to SDK
`login()` calls; tokens produced by logins are sealed back into the vault (`saveSystem` / `update`), never left in
plaintext files longer than the SDK requires.

`@pickle/messengers/login` (`src/login/index.ts`, drivers for the server's Discord / Telegram login relay,
apps/server/src/messenger-login): `DiscordRemoteAuth` (agent-messenger `loginWithRemoteAuth`, QR link
`https://discord.com/ra/…` + `qrSvgDataUri`), `TelegramLogin` (phone → code → 2FA over TDLib), `telegramReadiness(env)`
(`AGENT_TELEGRAM_API_ID`/`_HASH` + koffi/prebuilt-tdlib resolvable, never loads the native library at boot),
`maskPhone` / `normalizePhone`. `src/tdlib/runtime.ts` is our own libtdjson runtime (koffi async receive, routing by
`@client_id`, log verbosity 0): agent-messenger's Telegram client blocks the event loop and is single-user. The
`telegram` adapter's session secret is `{databaseKey, tdDir}` (an encrypted TDLib database under
`<configRoot>/<userId>/telegram/`); `revoke` = TDLib logOut, `cleanup` deletes the directory.

## apps/server

Implements `VaultStorage`, `MessengerStorage`, `ToolStore`; owns the SQLite schema, every route in
`protocol.ROUTES`, the turn wrapper (`start` → runTurn → persist → quota → `done`), approvals/credential resumes,
the `/api/events` hub, schedules runner (30 s tick, KST rules), daily briefing, friends/invites (`/i/:token` HTML),
explore templates seeded from the REA (7 categories; popular tasks mapped to real skills), SDUI `/api/ui-definitions`.
