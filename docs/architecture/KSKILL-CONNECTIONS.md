# k-skill login connections: runtime contract (2026-11-12)

Owner: agent-runtime (`packages/agent`). The brief is `$SCR/KSKILL-LOGIN-BRIEF.md`. Routes are owned by `server`
(apps/server), tools by `kskill-tools` (packages/skills) and the card and connect sheet by `kakao-chat` (apps/mobile).
Code: `packages/agent/src/connections.ts`, the gates in `packages/agent/src/loop.ts`; tests in
`packages/agent/test/connections.test.ts` (bogus credentials, scripted model, fake services, the real vault).

## Invariants
- Credentials are sealed on the device (vault envelope, aad `${userId}:${service}:${kind}`), exactly like messenger
  logins. They are unsealed server-side only inside `ConnectionResolver.use()`, while the tool runs. The vault wipes the
  object when `use` settles.
- Credentials never reach the LLM: not in tool args, results, cards, status lines, logs, transcripts or SDUI.
  - Tools get no resolver: `ctx.connections` is hidden from reads, `in`, `Object.keys` and descriptors alike.
  - A `connection` tool sees only its own login, as `ctx.connection`. Its legacy `ctx.credentials` is disabled.
  - `ctx.connection` is not enumerable, so `JSON.stringify(ctx)` and `{...ctx}` never carry the login.
  - Other tools can't reach a catalog service's logins through `ctx.credentials`: `find()` is refused via
    `ConnectionResolver.owns`, and `use(id)` via `ownsCredential`.
  - `ctx` is a Proxy over an empty stand-in target, so a sealed or frozen server ctx or store never trips a Proxy
    invariant.
  - A `connection` tool's result is redacted inside the vault callback, before anything leaves it: summary, data,
    card, memory and thrown error text. Text is redacted first and truncated after.
  - Its side channels are redacted the same way: `ctx.status(...)` (exact values only, so progress text such as
    "OTP 2/3" stays readable) and every `ctx.store` call (remember, kv, artifacts, friend messages).
  - What redaction masks, as `[가림]`:
    - Exact secret values, in their raw, trimmed, URL-encoded, form-encoded, JSON-escaped, base64, unpadded base64,
      base64url and hex forms.
    - `base64("a:b")` pairs (Basic auth), and numbers equal to a secret.
    - Any non-boolean value under a credential-named key. Key names are matched after lower-casing and removing
      `-`/`_`.
      - The base names are `password`, `secret`, `secretKey`, `accessKey`, `apiKey`, `privateKey`, `token`,
        `authorization`, `bearer`, `cookie`, `sessionId`, `credential`, `pin` and `otp`.
      - The match is anchored at the end of the key, which may add one suffix: `s`, `header`, `value` or `hash`.
      - Pagination tokens are excluded: `page`, `next`, `continuation`, `sync`, `cursor`, `pagination`,
        `resumption` and `skip` followed by `token`.
      - Usage counts are excluded: a number under `tokens`, `inputTokens`, `totalTokens` and the like, or `pins`.
        Any other value under those keys is masked, lists included. The exception is `pins` holding an object or a
        list of objects (map or chat pins). Those are walked key by key, so a nested `pin` is still masked. Inside
        that walk, an all-digit string or an integer of 4–8 digits (a PIN code) is masked, unless its key is data
        such as `lat`, `lng`, `id`/`…Id` (on the raw key: `placeId`, `place_id`), `count`/`…Count`, `index`,
        `zip`/`zipCode`, `year` or `price`. A key ending in `account`, or containing `pass`, `pin`, `code`, `otp` or
        `secret`, is never data.
    - JWT and `sk-`/`ghp_`/`AKIA`/`AIza` keys, anywhere.
    - Any `Bearer`/`Basic` value of 10 or more characters, anywhere. This is safe over pretty: "Basic configuration"
      is masked too.
    - Every session-store string of 8 or more characters that is set, read or cleared during the run, including
      cookie-jar values. Secret fields match anywhere. Session strings match in one of two ways:
      - A random-looking string matches anywhere, like a secret, since it can't sit inside an ordinary word. That is
        16 or more characters that mix letters and digits, are hex, or are base64 with `+` or `=`. Letters with `/`
        only (`Popbill/Invoice/List`) are not random-looking.
      - Any other session string is masked only as a whole token: none of `A-Z`, `a-z`, `0-9`, `_` or `-` right
        before or after it. A stored `verified` masks `verified` standing alone, but never the inside of
        `unverified` or `re-verified`.
    - These session strings are not masked at all:
      - URLs, dates, MIME types (`application/…`, `text/…` and the other registered top-level types), IANA time
        zones (`Asia/Seoul`, `Etc/GMT+9`) and strings with spaces;
      - cookie-jar metadata, which has no `+` or `=` and no random-looking part, so a base64 token starting with `/`
        is still masked:
        - paths whose segments are all word-shaped: lowercase (`api`, `v1`, `main.3f9a2b.js`), Capitalized,
          camelCase or PascalCase with humps of 3+ letters and an optional file extension (`Invoice`,
          `getAccountInfo`, `Login.do`), or a short CONSTANT (`API`). A segment that mixes upper case, lower case and
          digits is never word-shaped. Other paths (`/OAuth/Token`, `/user/MyPage`) are collected and match only as
          whole tokens;
        - domains (`.popbill.com`);
        - dotted lowercase words (`www.popbill.com`, `invoice.read`) and host names ending in a 2–6 letter TLD
          (`api2.popbill.co.kr`, `cdn3.example.tv`). Neither may have a random-looking label. A label is
          random-looking when one of its hyphen-separated parts is 12+ letters with a run of 5+ consonants, has 8+
          characters mixing letters and digits, or has 6+ digits (`qwhfkzpxmtrbnvcl.worker`, `8c7f…2b.worker`,
          `1731400000.abc123.sig`). Real long labels (`tosspayments`, `githubusercontent`) have no such run.
  - Failure text also gets `scrubSecrets` (cards, RRNs, long random strings).
  - Not masked, because masking them would mangle ordinary data:
    - values shorter than 4 characters;
    - all-digit values shorter than 6;
    - config words such as `prod`, `real` and `test`.
  - Secret-field needles: all-digit ones only match at digit boundaries, and ones shorter than 8 characters only at
    word boundaries.
  - Known trade-offs (accepted after review pass 10). Most lean toward masking too much (safe over pretty). Two
    are small gaps, marked "gap":
    - Collected paths match as whole tokens, so a URL ending in exactly that path is masked (`…/OAuth/Token?x=1` →
      `…[가림]?x=1`). Paths with 2-letter humps or acronyms are collected: `/user/MyPage`, `/api/getUserById`,
      `/OAuth2/Token`, `/FAQList`.
    - Hosts with a label of 8+ characters that mixes letters and digits are collected and masked in URLs:
      `server2026.example.com`, `mail2023.naver.com`, `bucket20261112.s3.amazonaws.com`, CloudFront and API Gateway ids.
    - A cached hex value also masks inside a longer hex string (`deadbeefcafebabe1234` → `[가림]1234`).
    - Inside `pins`, a key containing `pin` (`shippingId`) is checked, and so are 4–8 digit integers under keys that
      aren't data keys (`reviews`, `total`, Naver `mapx`).
    - Gap: inside `pins`, `otpCount` and `pinCount` count as data, because the `…count` rule wins.
    - Gap: about 20% of random lowercase letters-only labels (`<16 letters>.worker`) have no 5-consonant run, so
      they are skipped as host names. Real session ids almost always contain digits.
- A missing or refused login never makes the agent ask for secrets in chat. It posts a `connection_request` card,
  whose 연결하기 button opens the connect sheet.
- Write tools (`write: true`) always go through the approval card. When `approval()` returns nothing, a default card
  is used: "<title> — 진행할까요?" / "<서비스> 계정으로 실제로 실행돼요.". Write tools are never offered in meeting
  voice turns.

## Tool side (`@pickle/agent`, used by packages/skills)
```ts
interface ToolDef {
  connection?: string;       // vault service id /^[a-z0-9_-]{2,32}$/ (vault rule: no dots), e.g. "popbill", "toss-investment"
  connectionReason?: string; // the card line when there is no login yet ("세금계산서를 발행하려면 팝빌 연결이 필요해요")
  write?: boolean;           // acting tool (issue/send/buy/reserve). Excluded from meetings
}
interface ConnectionHandle {        // ctx.connection, only during run()
  service: string; credentialId: string; hint: string;
  secret: Readonly<Record<string, string>>;              // the fields the user saved; wiped after run()
  update(secret: Record<string, string>): Promise<void>; // reseal rotated values into the same vault row
  session: { get<T>(): T | null; set(value: unknown, ttlMs: number): void; clear(): void }; // memory only, per credential, 1 s–24 h
}
needsConnection(service, serviceName, reason?, summary?): ToolResult // upstream refused the login
connectionHandle({ service, secret, ... }) // a real handle around a plain object: the test double for tool unit tests
memoryConnections({ popbill: {...} }, { popbill: "팝빌" }) // in-memory resolver with connect()/disconnect() for loop tests
```
- Read secrets from `ctx.connection.secret` only, never from args or env.
- On an upstream 401, wrong key or expired session: call `ctx.connection.session.clear()`, then
  `return needsConnection(...)`.
- Don't put secret values in `data`, `summary`, `card` or errors. The redaction is a backstop.
- Return a pagination cursor as `cursor`, not as `*Token`.

## Service catalog (`ConnectionService` in `@pickle/agent` types; packages/skills exports `connectionServices()`)
```ts
interface ConnectionService {
  id: string; name: string; description: string;
  kind: "login" | "token";     // vault CredentialKind of the saved row
  fields: CredentialField[];   // what the connect sheet asks for (sealed on device)
  verify?(secret, { signal, session }): Promise<{ ok: true; accountLabel?: string } | { ok: false; message: string; retryable?: true }>;
  revoke?(secret, { signal, session }): Promise<void>; // best-effort upstream sign-out
}
```
- **`verify` failures.** Return `retryable: true` when the failure isn't a definite refusal: 5xx, maintenance, rate
  limit or an unexpected response. Leave it out for a refusal (401/403, wrong key or ID). A thrown error (network) is
  treated as retryable.

## Runtime (`createRunTurn`), per call of a tool with `connection`
1. **Gates, in order.**
   - `credential()` (legacy).
   - The connection: an invalid id or no resolver is a tool error. Otherwise `find(service)`, and with no login the
     call gets a connection gate.
   - `approval()`, or the write default.
2. **No login.**
   - Emit the `connection_request` card (one pending card per service per turn) and set the chip to
     `needs_credential` ("팝빌 연결 필요").
   - Wait up to `TurnInput.connectionWaitMs` for the user to connect. The wait is opt-in: the default is 0, voice mode
     is always 0, and the maximum is 4 min. The server passes about 90 s for interactive text turns. The loop has its
     own deadline of the wait plus 2 s, in case the resolver hangs.
   - During the wait:
     - the calls that need no login run beside it;
     - the status says "팝빌 연결 기다리는 중" every 15 s, which feeds the server's idle timer;
     - a steered message (`TurnInput.steerPending()`) ends the wait;
     - a service is waited for at most twice per turn, and a wait that timed out is not repeated in the turn;
     - when the batch also holds an approval card, siblings without a login don't wait: they get `needs_connection`
       at once, so the approval card isn't held back.
   - **The user connected:** the card becomes `"connected"` in `outcome.cards`, and the same call is gated again (so a
     write tool still shows its approval card first) and then run in this turn.
   - **The wait ended:** the model gets
     `{ok:false, error:"needs_connection", service, serviceName, message}`, where the message tells it not to ask for
     secrets and to say in one sentence that it will continue after the connection. The card stays pending.
3. **The login exists.**
   - The tool runs as
     `ctx.connections.use(service, {action: write ? "use" : "view", purpose: <tool title>}, conn => run(args, ctx + {connection: conn}))`.
   - The vault records the access as actor `agent`.
   - If the result carries `needsConnection` (a refused login), step 2 runs, but the wait now needs a login other
     than the refused credential (`waitFor({exclude})`). The call is retried once, then gives `needs_connection`.
   - The card and the wait always use the tool's own `connection`; the tool can't name another service. A tool
     without `connection` can't raise the card at all.
   - A refused `write` tool is not retried: it may have partly run, and its approval named the old login. It gives
     `needs_connection` at once, and the owner asks again after reconnecting.
4. **Approval resume.** The login is resolved again at run time. A login removed meanwhile leads to step 2.

## Server side (`ConnectionRegistry` from @pickle/agent; wiring by `server`)
```ts
const connections = new ConnectionRegistry({ vault, services: () => skills.connectionServices?.() ?? [] });
connections.catalog() / service(id) / isService(id) / serviceName(id)
connections.forUser(userId)              // → ConnectionResolver for ToolContext.connections
connections.status(userId)               // → [{service, serviceName, connected, credentialId, hint, label, expiresAt, connectedAt, lastUsedAt}]
connections.verify(userId, service, { credentialId }) // service.verify (actor "user", action "login"); 20 s; Korean, redacted message;
                                                       // retryable: true on the service's flag, a timeout, a throw or a cancelled check
connections.notifyConnected(userId, service, { credentialId }) // drops rows older by (createdAt, id) + their sessions, wakes waiting turns → count
connections.revoke(userId, service)      // service.revoke for each live login (parallel, best effort, 10 s total) → vault.remove every row → drop sessions
connections.forget(userId, service)      // drop cached sessions only (e.g. after DELETE /api/credentials/:id)
```
- **Turn input.**
  - `ToolContext.connections = connections.forUser(userId)`.
  - `TurnInput.steerPending = () => lease.pending() > 0`, using launcher `Lease.pending()`.
  - `connectionWaitMs: 90_000` for interactive text chat turns only. Leave it unset (0) for voice, phone, scheduled
    and meeting turns.
  - Friend threads, and any turn answering someone other than the owner (`ExecuteTurnOptions.speaker: "other"`),
    never run on the owner's logins. They get no `connection` tools, no `write` tools, no resolver, no wait, and no
    connected-service names in the prompt.
- **Service names.** Include the catalog in the vault's `serviceName` lookup, so the access log says "팝빌".
- **Same-millisecond rows.** `notifyConnected` orders rows by `(createdAt, id)`, and ids are random. Two rows saved in
  the same millisecond are kept or dropped in arbitrary order (one always survives), so a test with a frozen clock
  must advance it between two saves.
- **GET /api/connections.** Lists the catalog as `ProviderInfo` and the status as `Connection` rows. Each catalog
  entry has category `"korea"`, the fields, and `kind: ConnectionService.kind`.
  - `auth` is `"api_key"` for API-key services and `"credentials"` for id/password logins.
  - `kind` is what the device seals as. API-key services are `"token"`, so the aad becomes `${userId}:${id}:token`.
- **GET /api/skills.** `SkillInfo.connection` and `connectionName` name a skill's login, so the skills screen can
  offer 연결하기. `configured` says whether this owner has connected it, so it is per owner.
- **Optional fields.** `CredentialField.optional` marks a field that may be left empty (팝빌 아이디), and the device
  then leaves its key out of the sealed secret. Tools read optional keys as possibly absent.
- **POST /api/connections/:service `{credential}`.**
  1. Validate the request, then `vault.save`.
  2. Call `connections.verify`.
     - On a failure without `retryable`, `vault.remove` the new row and answer status `"error"` with the Korean
       message.
     - On a `retryable` failure, keep the row, answer status `"needs_verification"` with the Korean line in
       `lastError`, and verify again later:
       - after each delay in `cfg.connectionRecheckMs`: 30 s, 2 min and 10 min;
       - never sooner than the service's floor in `cfg.connectionRecheckFloorMs`. 쿠팡 파트너스 has a floor of 1 h,
         because its verify spends the owner's own API quota.
       - Before each check, confirm the row still exists, and stop quietly if it doesn't (replaced or disconnected).
       - A later success takes step 3, and a later refusal removes the row. If an older login of the service
         remains, `notifyConnected(userId, service)` (no credentialId) wakes the turns that excluded the removed row.
       - If the service is still unreachable after the last check, the row stays, unconfirmed.
     - Until it passes a check, the row is unconfirmed. It is listed as `"needs_verification"`. It is not a connect,
       so it wakes no turn and flips no card. The unconfirmed mark is kept in memory only (not persisted): after a
       server restart such a row looks confirmed. It lists as connected, and a later `{credentialId}` pass is no
       connect.
  3. On success, flip the stored pending `connection_request` cards of the service to `"connected"`, then call
     `connections.notifyConnected(userId, service, { credentialId })`.
  4. When nothing was waiting (count 0), the flipped card can carry
     `action: {label: "이어서 하기", send: "<서비스> 연결했어요. 이어서 해 주세요."}`.
  - A save of a catalog service through POST /api/credentials should do the same.
- **POST /api/connections/:service `{credentialId}`.** Checks a saved login again.
  - An unconfirmed login that passes is the connect: step 3.
  - A login that already worked and passes again is not a new connect. It gets no `notifyConnected` and no card flip.
    A tool that just refused that login keeps its card pending; the waiting turn excludes that credential anyway, so
    only a different login resumes it.
  - A refusal or an unreachable upstream never removes a login that already worked.
- **Cards the running turn raised.** Note each pending `connection_request` card with the service's connect count at
  the moment it was raised. At persist time, a card whose service got a connect after that moment is stored
  `"connected"` with 이어서 하기. A card the loop already flipped (its own wait picked the connect up) is stored as is.
  A connect counts only the cards stored before it.
- **DELETE /api/connections/:service.** Calls `connections.revoke`.
- **Meetings.**
  - Skip `write` tools entirely.
  - Keep `connection` when wrapping a def, so read-only login tools resolve.
  - Use `connectionWaitMs: 0`.
  - Send `connection_request` cards to the meeting thread, as is done for `credential_request`.

## Card (`@pickle/protocol`)
```ts
interface ConnectionRequestCard {
  type: "connection_request";
  service: string; serviceName: string;
  title: string;        // "팝빌 연결이 필요해요"
  reason: string;       // "팝빌 세금계산서 발행에 팝빌 계정 연결이 필요해요." or the upstream's refusal line
  status: "pending" | "connected" | "dismissed";
  action: CardAction;   // { label: "연결하기", open: "connections" }
}
```
- **Opening the sheet.** The app opens `nav.push("connections", { focus: card.service, connect: true })`. The turn's
  stream must stay open while the sheet is up, because the turn is waiting.
- **After connecting.** When the connect succeeds, the app may flip a visible pending card of that service to
  connected at once. The `done` message carries the final state anyway.
- **States.** A connected card shows 연결됐어요, plus 이어서 하기 when the server added that action.
