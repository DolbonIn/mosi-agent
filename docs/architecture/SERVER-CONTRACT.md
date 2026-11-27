# Server contract — what the app must know (apps/server, 2026-11-11)

Wire types live in `@pickle/protocol`. This file records the server's actual behaviour where the protocol is silent
or differs. Every error body is `{error, message}`; `message` is user-facing Korean — show it as-is.

## Auth
- `Authorization: Bearer <token>`; sessions last 90 days. 401 `unauthorized` "다시 로그인해 주세요".
- Signup/login body: `{handle, password, displayName?, agentName?, device:{id, label, signingKey}}` — `signingKey` is an
  EC P-256 **public** JWK (a private `d` is rejected). Signup → 201 AuthResponse, login → 200 AuthResponse.
- 401 `invalid_credentials` "아이디 또는 비밀번호가 맞지 않아요"; 10 req/min per IP → 429 `rate_limited` + `Retry-After`.
- `GET /api/session` returns the SessionBootstrap object only (not `{token, session}`).
- Password reset by the verified phone (나의 모시 > 내 전화번호; there is no SMS path):
  - `POST /api/auth/reset/start {handle}` → `200 {channel:"call", masked:"010-****-5678"}` and a call that reads a
    **6-digit** code twice ("모시 비밀번호 재설정 인증번호는 … 입니다. 요청하지 않았다면 이 전화는 무시해 주세요.").
    409 `no_verified_phone` for an unknown handle and for one without a verified phone alike · 503 `phone_unavailable`
    (no Twilio; checked before the lookup) · 429 `rate_limited` + `Retry-After` (per-IP auth limit; 3 reset calls per
    user per hour) · 502 `phone_failed` (the code is dropped).
  - `POST /api/auth/reset/verify {handle, code, password, device}` → 200 AuthResponse (logged in on this device; every
    other session of the user ends). 400 `weak_password` (<8) / `invalid_password` (>128) / `invalid_device` (checked
    first, no attempt used) · 400 `{error:"invalid_code", message, attemptsLeft}` · 410 `code_expired` (10 minutes,
    5 wrong codes, used, or nothing pending; an unknown handle gets the same).

## Response shapes
- Lists are bare arrays: threads, messages, artifacts, attachments, friends, schedules, credentials, access-log
  (`?limit=1..200`, default 50), skills, memories. Exception: `GET /api/connections` → `{providers, connections}`.
- Every DELETE → `{ok:true}`.
- Creates: `POST /api/threads` 201 Thread (kind "task" only) · `POST /api/schedules` 201 · `POST /api/credentials` 201
  CredentialInfo · `POST /api/invites` 201 InviteResponse · accept 201 Friend (200 if already friends) · block 200 Friend
  `status:"blocked"` · delegate 201 DelegateResponse.
- `/api/health` → `{ok, llm, model, version, db, schema, packages, skills, tts, publicAudio, meet, stt}`; `tts` is
  `"configured"|"missing"` (last probe of the local TTS service), `publicAudio` is `"ready"|"missing"` (Twilio can fetch
  모시-voice audio), `meet` is `"ready"|"missing"|"off"` (the Google Meet bot, services/meet) and `stt` is
  `"ready"|"loading"|"missing"|"off"` (local speech-to-text, services/stt).

## Drawer fields on every Thread — `preview`, `waiting`
Both come with `GET /api/threads` and every `thread_updated` upsert, computed on the server when the thread is read.
- `preview: string`: the first sentence of the agent's latest final answer or event note (whichever is later), markdown,
  headings and status lines stripped, ≤60 chars (cut at a word, "…"), `""` when there is none. Masked on the server, so
  no raw number reaches the list: phones as `maskPhone` ("02-****-1234", "+1 415-***-0123"), meeting codes
  "rak-****-kud", emails "h***@example.com", codes after 인증번호/코드/OTP/PIN/비밀번호 "****", card numbers and digit
  groups of ≥10 digits "****-1234", amounts "***원" / "$***", other runs of ≥6 digits "****". Dates and times stay.
  It changes when a final answer is stored (turn end) or an event note is posted, never on streamed tokens.
  `subtitle` is unchanged (the thread intro uses it).
- `waiting: {kind, text} | null`, approval > call > meeting:
  - `approval`: a pending, unexpired approval in the thread (main thread included): "전화 승인을 기다려요" (`call`),
    "회의 참여 승인을 기다려요" (`meet`), "결제 승인을 기다려요" (`amount`), else "보내기 승인을 기다려요". Off on
    approve/reject (the upsert goes out at the decision) and at expiry (one upsert at `expiresAt`).
  - `call`: while `sys_phone_call` / `sys_call_me` dials (voice synthesis + placing the call): "전화를 거는 중이에요". The
    call thread is published as soon as it exists. The in-app voice call is client state; the app overlays it.
  - `meeting`: the '회의 참여' thread by meeting state: launching/prejoin "회의에 들어가는 중이에요", waiting_admission
    "호스트 수락을 기다려요", in_call "회의 중 · 듣고 받아 적고 있어요."; null once it ends or fails.

## Sending a message — `POST /api/threads/:id/messages`
| Situation | Response |
|---|---|
| turn starts | 200 SSE turn stream |
| agent busy in the **same** thread | 202 `SteeredResponse {steered:true, userMessage}` — show the bubble; the running stream continues |
| agent busy elsewhere, and this is the **first message of the owner's own new thread** (nobody's request in it yet: a thread from Explore's 맡기기 or `POST /api/threads`, the main thread right after sign-up) | 200 SSE, **queued**: `start {threadId, userMessage, messageId}` at once, then `status` "하던 일을 마치면 바로 시작할게요" (again every 10 s) until the agent is free; then the turn streams as usual under the same `messageId` (no second `start`). FIFO behind the running turn; at most 3 queued per user (the next is 409 `busy`). Stop (abort the fetch) while queued: nothing runs, and the user row gets the cancel note. If the turn it waited for used up the day's quota: `error quota_exceeded` instead of the turn |
| agent busy in **another** thread / a schedule / briefing (any other thread) | 409 `busy` "깽이가 다른 일을 하고 있어요. 끝나면 다시 보내 주세요." — keep the text in the composer |
| sent right after Stop, while the stopped turn is still winding down | the request waits for it (≤ settle time + 2 s), then 200 SSE with a **fresh** turn — never steered into the stopped one. If it is somehow still stopping: 409 `busy` "하던 일을 멈추는 중이에요. 잠시 후 다시 보내 주세요." |
| friend thread, not addressed to the agent | 201 `{delivered:true, userMessage}` |
| friend thread, starts with "@" or contains my agent's name | 200 SSE (my agent answers in the shared thread) |
| > 4000 chars / no text and no files | 413 `message_too_long` / 400 `empty_message` |
| quota | 429 `quota_exceeded` (long Korean message mentioning 04:00 reset + tickets) |
| no LLM key | 503 `llm_not_configured` |

`attachmentIds` ≤ 10.

**Files with no text.** `text` may be empty (or spaces) when `attachmentIds` holds at least one file (a photo alone, a
long message the app turned into a .txt), in every case above: a turn, a steer, the queue, a friend thread. The row
keeps `text: ""`. The model's copy is a blank line and the files' notes, as with text; when a text file was read
(whole or cut), it begins with a described note that the file's text is what the person sent and is to be answered
(no sample line; a line of photos or PDFs alone gets none). Where a line is shown and the row has no text, the server
writes a stand-in (DD 1811): `사진` or `사진 N장` when every file is an image, else the first other file's name, plus
` 외 N개` for the rest. It is used in a friend thread's list row (`{이름}: {줄}`) and the friend's banner body. A new
thread of the person's own (`task`, automatic title) whose first line is files with no text is named after the first
file that is not an image, without its extension, at once (`thread_updated`), and the model's title is not asked for;
with images only, the title comes as before.

**A steered line is taken in whole up to 64,000 characters** (the launcher's cap: 4,000 of text plus 50,000 of text
files and their notes), trimmed. Before 2026-11-26 the cap was 4,000, which cut a file sent while the agent was working,
with no note; history still treats a stored turn's first 4,000 characters of a longer line as that line (it is not
replayed again).

**Reading a file again (`sys_file_read {file?, from?}`, agent-runtime 1848-b).** The model can read a text file
(text/plain, text/markdown) from the person's archive again — one whose text left the conversation (a message's file
is in the model's copy of that turn and the next one only), or the rest of one cut at 30,000 characters. `file` is a
name, matched as written, then in any case, then without its extension, then as a part of the name; one name (its
newest file) is read, several names give the list to ask from (10), a photo or PDF by that name says it cannot be
read, and nothing found says so. No `file`: the 20 newest text files (name, KST day, characters). A call reads 30,000
characters at most from `from` (cut at a line break near the cap, as a message's file; the result gives `next`), a
turn 60,000 in all. Whose files: the person's own; in a friend thread only the files sent in that thread (a friend's
too, while they are friends, as data whose instructions are not followed) — a name from anywhere else reads as not
found, and the meeting 모시 has no such tool. The answer row keeps each result's line and numbers, never the file's
text (later turns see what was read, and a deleted file leaves nothing behind). Chip (DD 1852): title `파일 읽기`
(`보관함 파일 확인` with no name); the line names the file in quotes (20 characters) and the real numbers:
`'{이름}' 파일을 다 읽었어요 · {N}자`, `… 앞에서 {M}자 읽었어요 · 전체 {N}자`, `… 파일의 {a}–{b}자를 읽었어요 · 전체 {N}자`,
`… 파일에 더 읽을 글이 없어요 · 전체 {N}자` (`from` at or past the end), `텍스트 파일 {n}개를 찾았어요` / `보관함에 텍스트 파일이 없어요`, `'{이름}'에 맞는 파일이 {n}개예요`, `… 파일을 찾지 못했어요`,
`… 파일은 글이 아니라 읽을 수 없어요`, `… 파일은 보관함에서 지웠어요`, `이번 답에서 읽을 수 있는 양(60,000자)을 다 썼어요`.
The app's status line for the tool is `파일 읽는 중` (no file name: it shows on the lock screen).

**A schedule's file.** `sys_schedule_create` takes `file` (a name, found as above among the person's own files; in a
friend thread one they sent there), and `POST /api/schedules` takes `attachmentId` (the person's own text file; any
other id is 400 `invalid_schedule`). One file a schedule. Every run gets the file's text after its prompt as a
message's file is (whole, or its first 30,000 characters with the cut note); the run's event row keeps the file's
name, not its text, and the daily log and memory read that too. A file deleted later: the run is told the file is gone
and not to guess at it, and its answer says only three things, briefly: the schedule could not run because its file was
deleted, the schedule is now off, and uploading the file again and making a new schedule brings it back (DD 2006, 2014).
Once that answer is stored (not after a failed or stopped run) the schedule goes off with no next run and its stored
cards' `enabled` with it, in one transaction, and those rows are published; that run's banner goes out whatever
`notifications.taskDone` says (the schedule went off on its own; a failed or stopped run follows the setting);
`PATCH {enabled: true}` on a schedule whose
file is gone (off by that run or by the person) answers 409 `schedule_file_deleted`, other edits keep it off; cards of that schedule get
`file: { name, deleted: true }` (`ScheduleCard.file`, `Schedule.file` in `/api/schedules`). Columns
`schedules.attachment_id` / `attachment_name` came with migration v7 (added only; older schedules have none and run as
before). Cost (estimate): a 30,000-character Korean file is ~21k–36k tokens on each model call of a run; run twice a
day (a morning and a pre-market one) it comes to ~12–22% of the day's 400k billable tokens.

**Steered lines left unanswered.** A turn that ends without answering lines steered into it (202) — Stop, a failed turn,
a follow-up the day's quota kept from running — sends `steers_dropped {threadId, messageIds}` to every device of the
person (right after a stream-less turn's `turn_error`), and the server stores it on those rows just before: from then on
every view of such a line, page reads (GET messages) and any later `message` push, carries `steerDropped: true`, for the
line's sender alone. A device that missed the event (asleep, offline) drops the line's steer receipt when it reads the
page again. `steered: true` stays on live pushes only (a page read never carries it) and never comes with
`steerDropped`; a line its turn answered, or one handed to a follow-up turn that ran, never gets `steerDropped`. What
the model reads of the thread does not change.

## SSE framing
- Each event `data: <json>\n\n`; heartbeats are comment lines (`: hb`) — ignore (15 s on turn streams, 25 s on events).
- Turn stream order: `start {threadId, userMessage, messageId}` (userMessage null on approval resume) → any of
  `status {text}` / `text {delta}` / `tool {tool}` / `card {card}` / `memory {…}` → `done {message, quota}` or
  `error {error, message}`; the stream then closes. HTTP status is 200 even if the turn fails; errors before streaming
  are JSON. Client disconnect = Stop (see below); the partial answer is persisted (refetch messages).
- Events: `GET /api/events?token=<session token>` (EventSource can't send headers) → `: connected`,
  `{type:"hello", at, settingsRev, agentRev}`, then `message {threadId, message}` (other tabs, friend side, steer
  follow-ups, schedule turns, card status flips), `thread_updated {thread}`, `agent_status {status, text?}`,
  `quota {quota}`, `notification {title, body, threadId?, messageId?, icon}`, `connection {connection}`, `settings {settings}`,
  `agent {agent}`. 401 without a valid token. `hello`'s revs are read after the stream is registered, so events
  published meanwhile may come before it; a device that slept re-reads `GET /api/session` when a rev differs from the
  one it has seen. `?token=` also works on `/api/blobs/:id` and
  `/api/attachments/:id/raw` (for `<img src>` / PDFs).
- `notification.messageId`: the id of the stored row a banner tells of. Set on a friend's line, a friend's agent's
  message, a new friend's event row, a schedule's or briefing's answer and a meeting's approval card; that row is
  pushed (`message`) before the banner. An app showing that thread leaves the banner out, since the row is on screen.
  A banner with no row behind it (a remembered fact, a skipped schedule) has none.

## Stop (cancel a turn)
There is no stop endpoint: **Stop = abort the fetch that carries the turn's SSE stream** (message send or approval
resume). What the server then does:
- Aborts the model call. A tool that is already running (a call, a messenger send) gets up to 3 s to wind down before
  the agent is free again.
- Visible output stays: partial text stays in the assistant bubble; tool chips that were running become
  `state:"error"` ("중단됐어요"). If nothing visible was produced, there is no assistant bubble — the user's bubble is
  last. No "stopped" bubble is ever added.
- The model is told, in history only, that the request was stopped: `(사용자가 이 요청을 멈췄어요. 다시 부탁하기 전에는
  이어서 처리하지 않아요.)` goes after the request (or after the tool-only bubble). So the next message is answered on its
  own and the stopped request is not picked up again. When partial text exists, history keeps that text and then the
  note (a cut-off list without the note read as an accident: after "고마워" the model finished it in 3–4 of 20 real
  stop → 고마워 runs; with the note, 0 of 20, and asking again — "계속", "아까 그거 마저 적어줘" — still resumes it).
  When a tool had already run (a send, a call, a saved document), history keeps that tool call and its result, then the
  note, so the model knows the action happened and won't repeat it. Upstream timeouts keep completed tool calls the same
  way (without the note).
  While such a note is in history, the system prompt also carries a short "# 멈춘 요청" rule (without it the live model
  still answered the stopped request in 5 of 40 follow-ups; with it, 0 of 40).
- Messages that were steered into the stopped turn (202) or were still queued for it are stopped too: their bubbles
  stay, they get **no** follow-up turn, and the cancel note goes after the last of them.
- Stopping an approved action's resumed turn before it produced anything cancels the original request the same way.
- Usage is still charged: the provider's usage report, or an estimate when the model had already answered.
- A message sent right after Stop starts a new turn (see the table above). The client does not need to wait.

## Voice barge-in — `POST /api/threads/:id/messages/:messageId/heard`
The voice call cut a spoken reply off (the person talked over it, or typed): `HeardRequest {heard}` says what they
heard of it, a prefix of the reply's `speakable()` text in whole words (`""` = nothing, e.g. a reply still waiting to
be spoken). The server keeps only that in the reply's **history** (`llm_json`); the bubble keeps its whole text.
- Counted in spoken letters (`@pickle/protocol` speech.ts `letters(speakable(…))`, the app's count too). The assistant
  text holding the cut keeps its heard words (up to the first word end whose prefix, spoken, begins with them), then
  `…`; assistant text after it is dropped (a message with tool calls keeps its calls, content null); user (steered) and
  tool messages stay. A row without `llm_json` is cut from its text.
- The reply is marked with `(사용자가 답을 끊고 말했어요. 앞 요청을 새 말과 함께 판단해요.)`: in place of the Stop note
  when the barge-in stopped the turn while it generated, and after a finished reply that was cut. No system-prompt rule
  goes with it. A spoken interruption often continues or corrects the request; with the Stop note the model dropped it
  (real-model probe: continuations cut while generating, Stop note 4/21, no note 14/21, this note 20/21; corrections,
  topic changes and plain stops the same with each — numbers in history.ts `VOICE_NOTE`). The Stop button is unchanged.
  Only the reply's row changes: a Stop note on a steered line that came in after the reply was stored (it went
  unanswered) stays.
- A turn still winding down after the call stopped it (or whose abort lands just after this report) is waited for
  first (≤ settle time + 2 s); then read → cut → write with no await in between. The call sends its next line after the
  report is answered (≤ 1 s), and that send waits for the stopped turn too.
- 204: stored, or nothing to change (heard whole, the same report again, a reply paused for approval with `[]`).
  404 `message_not_found` (unknown, not an assistant reply, another thread, or not stored yet: the call drops it) ·
  409 `heard_mismatch` (the reply doesn't start with `heard`, e.g. its final text drifted from the draft the call spoke;
  history stays as it was, the whole reply counted as heard) · 403 `friend_thread` · 400 `bad_heard`.

## Approvals
1. The turn emits `card {type:"approval", approvalId:"ap_…", title, detail, status:"pending"}` — already the DB id.
   Phone calls add `call` (see Phone calls), joining a meeting adds `meet {code}` (see Google Meet); other tools and
   cards stored before them have neither key.
2. Client nonce (`crypto.randomUUID()`, ≤ 128 chars); sign UTF-8 `approve:<approvalId>:<nonce>` with the device P-256
   key (ECDSA SHA-256), base64url IEEE P1363 (64 bytes).
3. `POST /api/approvals/:id {decision:"approve"|"reject", signature, nonce, deviceId}` → 200 SSE of the resumed turn.
   Signature fields are optional but must verify when present (access log records `deviceVerified:true`).
- Errors: 404 `approval_not_found` · 400 `invalid_decision`/`invalid_signature`/`unknown_device` · 403 `bad_signature` ·
  409 `already_decided`/`busy` · 410 `approval_expired` (30 min; card flips to "expired") · 429 `quota_exceeded` ·
  403 `not_friends`. Status flips (approved/rejected/expired) also arrive as `message` events. An approve or reject
  also stamps the card with `decidedAt` (epoch ms), so its receipt time ("오전 10:02에 승인했어요") survives a reload; an
  expiry doesn't (cards decided before this have no `decidedAt`).

## Phone calls (`sys_phone_call`)
- Always approval-gated. Approval card `title`: a person → "<name>님께 전화할까요?"; a business, shop or office —
  `name` ends in a place word such as 치과/병원/의원/약국/센터/식당/카페/은행/학원/구청/부동산/…점 (e.g. "스타벅스 강남점"),
  or Dental/Clinic/Inc/… — → "<name>에 전화할까요?" (no "님", "에" not the honorific "께"); no name → the masked number,
  "010-****-5678에 전화할까요?"; a meeting line — `name` ends in 회의/미팅/컨퍼런스/콘퍼런스/meeting/meet/call/standup/
  daily/sync — → "<name>에 전화로 참여할까요?". A brand with no such ending ("스타벅스") still reads as a person. `detail`: "<masked>로 전화해서 [연결되면 <digits>을 누른 뒤 ]
  이렇게 전할게요: “<message>”".
- The card also carries `call {target, number, message, digits?}` so the person can check whom they approve:
  `target` "단아님" / "연세바른치과" / "relay daily 회의" (null without a name), `number` the **full** number in national format
  ("010-1234-5678", "02-1234-1234", "031-123-4567", "070-1234-5678"; "+1 415-555-0123" for North America, other countries
  E.164; null when the number isn't valid), `message` as it will be said, `digits` the keys pressed after connecting.
  Only the card has it: `title` / `detail`, the model's history text and the logs stay masked. Reload and decision
  (approved / rejected / expired) keep it.
- `digits` (optional): keys pressed after the call connects — a meeting dial-in PIN ending in `#`, an extension.
  `0-9 * #` and `w` (half-second pause), ≤ 40; spaces, dots and dashes are dropped. Anything else → tool error
  `invalid_digits` "누를 번호는 숫자, *, #만 쓸 수 있어요". With digits the call waits about 4 s, presses them, waits about
  5 s, then speaks the message twice.
- Each call creates a kind `"call"` thread ("<name>님께 전화", "<place>에 전화" or "<meeting> 전화 참여", subtitle
  "<agentName>의 외부 통화", icon `phone-out`) that receives the result note.
- Numbers are masked everywhere else the app and the model see them: Korea "010-****-5678" (Seoul "02-****-1234"), US
  "+1 636-***-8953", others "+44****1234". "+82 010…" is accepted (the trunk 0 is dropped).
- Without Twilio the tool returns `phone_not_configured` and the agent says so in plain words (no error codes). On a Twilio
  trial only verified numbers can be called; others fail with `phone_failed` (Twilio code 573002).
- How the message is voiced (모시's voice or Twilio's `<Say>`) is in the Voice section.

## My phone — 나의 모시 > 내 전화번호 (`sys_call_me`)
The agent can call the user's OWN phone ("내 폰으로 전화해줘", "매일 7시에 전화로 깨워줘") once that number is verified.
- `GET /api/profile` → `phone: {masked, verified} | null` (e.g. `{masked:"010-****-5678", verified:true}`). The full
  number is never returned, logged, or shown to the model.
- `PUT /api/profile/phone {phone}` (Korean "010-1234-5678" or E.164) → `200 {masked, verified:false}`. Stores the number
  as pending and places a verification call that reads a 4-digit code twice ("모시 인증번호는 삼, 팔, 일, 오 입니다.",
  모시's voice when ready, else `<Say>`). Show a code input right away; the call arrives within a few seconds (TTS adds
  a few more). Registering replaces the previous number, which stops being callable until the new one is verified.
  - 503 `phone_unavailable` (no Twilio) · 400 `invalid_phone` · 429 `rate_limited` + `Retry-After` (3 verification calls
    per user per hour; deleting the number doesn't reset this) · 502 `phone_failed` (Twilio refused the call, e.g. a
    trial account calling an unverified number; the previous number, if any, is kept).
- `POST /api/profile/phone/verify {code}` → `200 {masked, verified:true}`. The code expires after 10 minutes; 5 attempts.
  - 400 `{error:"bad_code", message, attemptsLeft}` (4, 3, … 0) · 410 `expired` (expired, or no code pending → ask for a
    new call) · 429 `rate_limited` (5 wrong attempts: request a new call). Already verified with nothing pending → 200.
- `DELETE /api/profile/phone` → `{ok:true}`; `phone` becomes null.
- Tool `sys_call_me {message ≤ 300, digits?}`: **not approval-gated**, so it also runs inside scheduled tasks (wake-up and
  reminder calls). Calls only the verified number; the model never passes a number. Unverified → tool error
  `phone_not_verified` "먼저 나의 모시 > 내 전화번호를 등록하고 인증해 주세요". At most 10 calls per user per KST day →
  `daily_limit`. Each call creates a kind `"call"` thread titled "내 휴대폰으로 전화" (subtitle "<agentName>의 외부 통화")
  with the result note ("내 휴대폰(010-****-5678)으로 전화를 걸었어요."). Same voice and trial fallbacks as `sys_phone_call`,
  which is now only for other people's numbers. Neither tool exists in friend threads.

## Google Meet — 모시 joins a meeting (`sys_join_meet`)
모시 can attend a Google Meet meeting by its web link through a browser bot (services/meet; full contract in
MEET-CONTRACT.md): it listens, writes minutes, answers when called by name and posts a summary at the end.
- Tool `sys_join_meet {url, purpose?}` — **approval-gated**. `url` is a meet.google.com link or a code (`abc-defg-hij`).
  The card reads "Google Meet 회의(abc-****-hij)에 참여할까요?" with "<agentName>가 이 회의에 참여해 듣고 받아 적어요.
  참석자들에게는 AI 비서라고 먼저 알려요." (+ purpose). The code is masked there, as in every stored text, the model's
  history and the logs; the card also carries `meet {code:"abc-defg-hij"}`, the full code for the owner's card only
  (absent on older cards). After approval the tool returns at once; the meeting runs in the background,
  independent of the turn. The host still has to admit the bot. The result (`state: "launching"`, `background: true`)
  tells the model it only shows the moment the join started and that later status and content come from
  `sys_meet_notes`.
  - Errors (tool data `error`): `invalid_url` · `meet_not_configured` (bot off) · `already_in_meeting` (one meeting per
    user) · `busy` (the bot is in someone else's meeting) · `meet_unreachable` · `meet_failed`.
- Tools `sys_meet_say {text ≤ 600}` ("회의에서 5분 늦는다고 전해 줘") and `sys_leave_meet {}` exist only while the user has a
  meeting in progress (not approval-gated: they act inside the approved meeting). None of these tools exist in friend
  threads.
- The app's side of a '회의 참여' thread (owner only; someone else's thread or an unknown id → 404 `thread_not_found`):
  - `GET /api/threads/:id/meet` → `200 {meeting: {id, state, live, code, title, purpose, startedAt, joinedAt, endedAt,
    threadId, note, reason} | null}`. `live` = state is launching / prejoin / waiting_admission / in_call. `code` is masked ("abc-****-hij");
    `title` is the Meet page title once the bot has read it, else null. Times are epoch ms (null until joined / ended).
    `threadId` is the meeting's '회의 참여' thread (leave goes there), `note` the sentence that thread shows for the state
    ("회의에 들어왔어요. 지금부터 받아 적을게요.", the end note; null while it is still starting) and `reason` the bot's
    end or failure reason (null while live). The newest meeting of that thread; null for threads without one.
  - `GET /api/threads/:id/meet?approval=<approvalId>` (meeting B) → the same shape for the meeting that join card
    started, asked from the owner's thread the card is in: `{meeting: null}` until the approved join has started one
    (and for meetings from before schema v5); 404 `approval_not_found` ("승인 요청을 찾을 수 없어요") when the approval
    isn't the caller's or isn't that thread's. join() links a meeting to the newest `sys_join_meet` approved in the
    thread it was asked in, for the same code, in the last 10 minutes, that no meeting claims yet.
  - `POST /api/threads/:id/meet/leave` → takes 모시 out, only when that thread's meeting is the one running now:
    `200 {ok:true, left:true, state:"ended"}`. Idempotent: when 모시 is already out of it (the meeting ended, the thread
    has none, or an older meeting's thread while a newer one runs — that one is never touched) → `200 {ok:true,
    left:false, state:<that thread's meeting state> | null}`. No approval (leaving only de-escalates). The end note and
    summary then arrive in the thread as usual.
- Tool `sys_meet_notes {meeting?: "latest"|<id>, part?: "summary"|"transcript"|"both"}` — offered in all of the user's
  own threads once they have at least one meeting row (even a failed join). Not approval-gated; owner only (another
  user's id → `unknown_meeting`). `latest` (the default) is the meeting of the current '회의 참여' thread there, elsewhere the
  newest meeting with transcript lines (a failed join right after doesn't hide it), else the newest meeting.
  - Returns `now` ("2026년 11월 12일(목) 14:05 (한국 시간)"), `meeting {id, title, purpose?, state (Korean: 진행 중/끝남/참여 거절됨/…), started, joined?, ended?, participants?,
    lines, hasSummary}`, `summary` (the `**회의 요약**` row without its heading), `transcript` ("[hh:mm] speaker: text"
    lines, KST; unknown speakers "참석자", 모시's lines under the agent name), `note?` (still running / no summary → the
    transcript is given instead / nothing written down / lines omitted), `recent` (the 5 newest meetings: id, title,
    state, started, lines, summary) and a hint (STT may mishear; don't invent; for a document call
    `sys_create_artifact`). Times always carry the date and weekday, with 오늘/어제 as a prefix when true: "오늘 11월 12일(목)
    14:05", "어제 11월 11일(수) 23:50", "11월 3일(화) 09:00". With "오늘 14:05" alone the model counted "금요일" from the
    wrong day ("오늘 오후 3시" on a Thursday, "모레 11월 14일 금요일" when Friday was the 13th).
  - The transcript is capped at 12,000 characters: about the first 4,000 and the last 8,000 are kept, the middle is
    replaced with "…(중략: N줄, hh:mm–hh:mm)…". Each line is capped at 600 characters.
  - The title is the Meet page title, else the purpose, else "Google Meet abc-****-hij" (never the full code). Summary,
    lines, speaker names and titles go through the agent's secret scrubber (card and ID numbers, token-like strings,
    "비밀번호 1234" values) and Korean phone numbers written in digits become "[전화번호]".
  - Errors: `no_meetings`, `unknown_meeting` (with `recent`).
- Prompt note: in the user's own threads (not friend threads), once they have a meeting, the system prompt ends with a
  `# 회의` block: first "- 지금: 2026년 11월 12일(목) 14:05 (한국 시간). 회의에서 나온 '금요일', '다음 주' 같은 날은 이 날짜를
  기준으로 셈해요.", then one line per meeting still running or finished in the last 24 h (at most 3; the current '회의 참여'
  thread's own meeting always comes first), e.g. "- 회의 'relay daily' 끝남 오늘 11월 12일(목) 02:03 · 40줄 · 요약 있음 →
  내용은 sys_meet_notes", "- 회의 '주간 회의' 진행 중 (오늘 11월 12일(목) 11:58 참여) · 3줄 → 지금까지 내용은 sys_meet_notes",
  "- 회의 '고객 미팅' 참여 실패 오늘 11월 12일(목) 11:55". Then the rules: meeting content (회의록, 요약, 정리, 문서로, 누가 뭐라고 했는지, 정한 것) → call
  `sys_meet_notes` first; a document → `sys_create_artifact` with its result; meetings are not in the messengers (`msg_*`);
  a `sys_join_meet` result in history is the state at join time. In a '회의 참여' thread one more line says its history
  holds only the latest minute rows (history keeps 30 messages), so the start of the meeting is missing there.
  `msg_list_chats` and `msg_read` descriptions say they are for messenger chats only and point at `sys_meet_notes`.
  - Real-LLM eval (ultrafast, in-process server, scratch data, one ended meeting with 40 lines and a summary; the main
    thread's history holds the old "launching" join result): main thread 50/50 (10 phrasings × 5 runs: sys_meet_notes
    first, correct answer, `sys_create_artifact` for every document ask); KakaoTalk/Slack asks never call
    `sys_meet_notes` (15/15). In the '회의 참여' thread "결정된 거 뭐야?" is still answered from the summary row above
    (correct), the other phrasings call `sys_meet_notes`; a question about the first minutes ("누가 처음에 출시 일정 미루자고
    했어?") answered from history alone named the wrong person before the thread line existed, and 3/3 right after.
- Thread: each join creates a kind `"call"` thread titled "회의 참여" (subtitle "<agentName>의 회의 참여", icon `people`).
  - `event` rows for state changes, in order: "Google Meet 회의(abc-****-hij)에 참여하러 갈게요." → "참여 요청을 보냈어요.
    호스트가 수락하면 들어가요." → "회의에 들어왔어요. 지금부터 받아 적을게요. 회의 중에 '<agentName>야'라고 부르면 대답해요." →
    one end note: "회의가 끝나서 나왔어요." / "회의에서 나왔어요." / "회의에서 내보내졌어요." / "혼자 남은 지 2분이 지나서 회의에서
    나왔어요." / "회의 참여 서비스와 연결이 끊겨서 회의를 마쳤어요." / failures ("호스트가 참여 요청을 받아 주지 않았어요.",
    "5분 동안 수락되지 않아서 참여 요청을 거뒀어요.", "이 회의에는 들어갈 수 없다고 나와요. …", "회의를 찾을 수 없어요. …",
    "회의에 참여하지 못했어요. …"; some bot reasons get their own wording: 회의 인원이 가득 참, 로그인한 계정만 들어갈 수 있는 회의,
    이미 끝난 회의).
  - Minutes: one `assistant` row a minute (and when the meeting ends), markdown: `**회의록 · 14:02–14:03**` then
    `- 지민: …` lines. Unknown speakers show as "참석자"; 모시's own spoken lines appear under its name. Later turns in the
    thread see these rows, so "방금 회의에서 뭐라고 했어?" works there.
  - Summary: when a meeting the bot actually entered ends, an `assistant` row `**회의 요약**` (one-line summary, 결정 사항,
    할 일 with owner and due date, 다음 일정). No transcript → event "받아 적은 말이 없어서 요약은 건너뛰었어요." The
    summary is also posted to the thread the join was asked in when that is the owner's own thread (they are its only
    member; never a friend thread), whether or not an approval links the two (meeting B).
  - Every new row sets the thread unread and is pushed on `/api/events` like any message.
- In the meeting: saying the agent's name ("모시야", "모시님", "모시 씨", whisper's "모시아", or the user's own agent name)
  makes 모시 answer out loud in at most two sentences, from the last 3 minutes of the meeting. It says a cached "네,"
  at once, then streams the answer sentence by sentence. "모시 그만" or "잠깐" while it speaks stops it.
  - Misheard calls count only at the start of an utterance and only when more words follow in it: "5시야, 정리해 줘",
    "무시아 …", "모시자 …" (similar-syllable variants of any agent name, e.g. "갱이야" for 깽이). "회의는 5시야",
    "오후 5시야 맞지?", a bare "5시야." and "부모님 모시고" are not calls.
  - With real-time STT the bot also streams `partial {text}` (the utterance so far) and `endpoint {seq, speaker}` (the speaker
    stopped for 0.3 s; the transcript with the same seq follows). A call seen in a partial is only noted: the name shows
    up about 2 s before the speaker finishes, so the "네," goes out at the endpoint (heard ~0.4 s after they stop),
    once per utterance, and the model waits for the final `transcript`. Without an endpoint (or a call only the final
    shows, e.g. the local STT path) the "네," goes out at the transcript. If the final no longer contains the call (an
    STT revision), 모시 has said "네," and nothing more (`meet partial wake revised`); an endpoint whose transcript never
    comes is skipped by seq (`meet ack without transcript`). "모시 그만" in a partial stops speech mid-utterance. The
    name plus a stop word is never treated as a question.
  - A bare call ("모시야.", "모시님?", the name plus a filler at most) that arrives as its own transcript (a pause after
    the name ends the utterance) gets the "네,"; the same speaker's next transcript is its question, answered with no
    second "네,". 4 s without speech → "말씀하세요." (`meet call alone`). "모시 그만" in that gap is not a question.
  - Turn-taking (MEET-CONTRACT.md §3 "말 차례 지키기"): the name plus a leave imperative ("모시야 이제 나가도 돼") → the
    goodbye line, then the meeting is left with reason `asked`; an unfinished line for 모시 ("모시야 그 문서를",
    `turnIncomplete`) waits up to `MEET_TURN_HOLD_MS` after the last speech (10 s cap) for the same speaker's rest; an
    answer not yet spoken is given up when the speaker goes on (superseded: it posts nothing, the joined turn does); 모시
    stops when talked over (`MEET_YIELD_SYLLABLES`: a stop, so a document or approval card it made is still posted) and
    doesn't start on top of someone. Complete lines are answered as fast as before.
  - Two modes per meeting. **Listening** (from the join): transcribe only; a call (exact or misheard name, as above)
    starts a **conversation**. In a conversation, lines without the name are answered too when the addressee check says
    they are for 모시: `addressed` → answered like a call (prompt "방금 X님이 너에게 이어서 한 말"), `other` (people
    talking to each other) → nothing, `dismiss` → "네, 듣고 있을게요." (a cached clip) and back to listening. A leave
    imperative ("이제 나가도 돼", `isLeaveRequest`) leaves when the verdict isn't `other` (these mostly come back
    `dismiss`); the classifier has no `leave` choice (measured below). Fillers
    and backchannels ("음", "네네", "그렇구나", ≤ 2 syllables that aren't a question) never reach the check. The name plus
    "이제 됐어 / 조용히 해 / 듣고만 있어 / 그만 얘기해 / 우리끼리 얘기할게" dismisses without a check (also mid-speech: it
    stops the speech first). `MEET_CONVERSATION_IDLE_MS` (default 90 s) without a line for 모시 → listening, silently.
    "모시 그만" / "잠깐" while it speaks only stops the speech; the conversation goes on. Participant counts don't change
    any of this. Calling 모시 in a conversation is a normal turn. "모시야 이제 됐어" while already listening (after the
    idle timeout) only gets "네, 듣고 있을게요.", never an answer.
    - Two rules before and after the check (meetAddressee.ts): a line that opens by naming someone else ("민수님, …",
      "지민님 화면 공유 좀 …", "다들 …") is `other` without a check; an `addressed` line that is neither a question nor a
      request ("그럼 수요일로 확정할게요.", "제가 오후에 올릴게요.") counts as `other` (statements are for the room; logged
      `gate: "statement"`).
    - The check runs at the endpoint on the last partial (and the endpoint's `speaker`, when the bot sends one), so the
      verdict is usually ready when the transcript arrives (~0.27 s later) and is reused when the words and the speaker
      match; otherwise it runs on the transcript. The speaker matters a lot ("서울 날씨는 어때?": no speaker → other
      p 0.59, "하은" → addressed p 0.85). Context: the lines since the latest call (at most 3 minutes, the last 6) —
      with the talk before the call in it, both backends missed nearly every follow-up.
      `PICKLE_MEET_ADDRESSEE=decider` (default: OpenGateway `POST /v1/decisions`,
      `sionic-ai/decider-4b`, one `choice` question; an `addressed` below p 0.7 counts as `other`) or `chat` (the meeting
      model, one letter); the other backend is the fallback when the first fails; `off` → the name every time. No
      classifier configured → no follow-ups. Its tokens count toward the daily quota.
    - Measured: 30 lines with realistic meetings around them (other people's talk before the call, reactions after
      모시's answer; 12 addressed, 12 cross-talk, 6 dismiss) × 2 runs: decider with the rules and the since-the-call
      context 60/60, p50 68 ms; chat 53/60 (misses follow-ups), p50 166 ms. The same decider with the last 6 lines of
      the whole meeting: 36/60, every follow-up missed. On the first 60 short-context lines: decider 59/60, chat 54/60.
      Neither ever answered cross-talk. End to end (fake bot, real model and decider, 20 scripted lines): 20/20.
    - A 4th `leave` choice, measured 2026-11-14 against HEAD's three in the same run (the 30 lines above, 8 unnamed leave
      lines, 10 near-misses with 나가/가; × 2): the 30 lines unchanged (decider 60/60 both, chat 52/60 both); leave
      lines 16/16 on both backends, against 12/16 (decider) and 14/16 (chat) for the rule plus a verdict other than
      `other`. But it cost the decider (the default) on near-misses: its `addressed` on "너 나가는 거 아니지?" fell
      below 0.7 (2/2 not answered), and "이제 가 봐야 할 시간이네" came back `leave` (2/2; LEAVE_RE then still took
      "봐야", fixed since). Near-misses with three choices: decider 20/20, chat 16/20 (18/20 with four). So there is no
      `leave` choice. The rule misses unnamed "이제 나가도
      돼" and "이만 가 봐도 돼" on the decider (`addressed` at 0.63 / 0.52, under the 0.7 bar); with the name they
      always work.
    - The thread shows "<agentName>가 대화에 들어왔어요. '이제 됐어'라고 하면 다시 듣기만 해요." and "다시 듣기만 할게요." in
      pairs, at most one pair per 2 minutes. Logs: `meet mode {from, to, reason: wake|dismiss|idle}`, `meet addressee
      {verdict, ms, backend, reused}` — never the text.
  - Calls and follow-ups are answered by the meeting agent (apps/server/src/meetAgent.ts `runMeetTurn`: read-only tools,
    the privacy rule, details to the thread) when `deps.llm.meetClient` is set; without it, one plain model call
    (no tools). meet.ts passes the context block (purpose, the last 3 minutes, the line), `acked`, the barge-in signal
    and its own `onSentence`; runMeetTurn counts the tokens.
  - An answer that starts without a "네," (no call in a partial: follow-ups, the local STT path) gets one only if
    neither its first sentence nor a tool call comes within 350 ms (its audio would then come late); otherwise it just
    answers. A tool call plays "찾아볼게요." after a "네," or "네, 잠시만요." in its place (cached clips). The model's own
    leading "네," is dropped only when one of those clips went out. After a "네," with no first sentence and no tool filler
    for 2.5 s (a slow model; once 6.1 s was seen), "잠시만요." (`MEET_ACKS.hold`, sent `cached: true`; plain TTS until the
    bot lists it) plays once. `meet reply` logs `kind` (call|followup), `path`
    (agent|plain), `tools`, `filler` (search|wait), `stall` (0|1) and `ack` (endpoint|transcript|filler|skipped).
  - The bot primes STT with the agent name (`sttPrompt` "<agentName>야, 지금 회의 내용 좀 정리해 줄래?"). A line that
    matches that prompt but is too long for its audio (> 9 syllables/s) is Whisper echoing it: dropped, never a call. On join, the bot first announces
  "안녕하세요, <사용자>님의 AI 비서 <agentName>예요. 회의 내용을 받아 적고 있어요. 저를 부르시려면 '<agentName>야'라고 불러
  주세요."
  - Answers and summaries use `PICKLE_MEET_MODEL` (default `deepseek/deepseek-v4.1-flash-ultrafast`, the same as chat;
    a separate setting so meetings can be pinned independently). About 0.1 s to the first token; `-eco`, the old chat
    default, took 5–30 s, which is why meetings got their own setting. Their tokens count toward the user's daily
    quota; with the quota used up 모시 keeps taking minutes but doesn't answer.
  - Measured with a fake bot and the real model: transcript received → first `/say` 111–178 ms, second sentence +90 ms.
    Add the bot's 0.7 s end-of-speech silence, about 0.3 s of STT and about 0.25 s to the first TTS audio.
- Storage: tables `meetings` (one row per join: state, reason, participants, last transcript seq; `title` since schema
  v3) and `meet_utterances` (each line heard, with speaker and timing, and each line 모시 said), schema v2. While in the
  call the server asks the bot for the page title (`GET /sessions/:id` `title?`) with each minute flush until it has one,
  and once more when the meeting ends. A server restart picks up a meeting
  that's still running (`?since=<last seq>`; replays are de-duplicated); if the bot lost it, the meeting ends with the
  "연결이 끊겨서" note and a summary.
- Env: `MEET_BOT_URL` (default `http://127.0.0.1:8781`, `off` disables), `STT_URL` (default `http://127.0.0.1:8782`,
  health only), `PICKLE_MEET_MODEL`, `PICKLE_MEET_ADDRESSEE` (decider|chat|off), `MEET_CONVERSATION_IDLE_MS`, `MEET_TURN_HOLD_MS`
  (default 1500, 0 = no wait), `MEET_YIELD_SYLLABLES` (default 6, 0 = never yield). Logs carry states, counts and timings only. They never include transcript text,
  participant names or the full code (`abc-****-hij`).

## Agent tools and model calls
- Memory tools: memory off (`settings.privacy.memoryEnabled: false`) → neither `sys_remember` nor `sys_recall` is offered,
  and nothing is recalled into the prompt. Memory on but nothing saved yet → `sys_remember` only (a recall could only come
  back empty). Friend threads never get `sys_recall` or prompt recall: the friend reads the answer.
- Outward actions (messages to others, calls, payments, deletes): the agent calls the tool directly and the approval
  card is the confirmation; it does not ask "할까요?" in chat first (launcher rules v2). It asks back only when the
  recipient or content is missing.
- Chat turns call the model with hidden reasoning off (`thinking:false`), so `status "생각하는 중"` arrives at once and the
  first `text` usually within 1.5 s, even for a new user. `PICKLE_TURN_THINKING=on` restores the provider default. Side
  calls (memory extraction, thread titles) always run without reasoning.

## Credentials (Credential Enclave)
1. A turn may end with `card {type:"credential_request", service, serviceName, reason, fields, status:"pending"}`.
2. `GET /api/enclave` → `{kid, publicKey, alg, measurement}`; seal with `@pickle/vault/client`, aad exactly
   `${userId}:${service}:${kind}` (kind "login" for credential providers, "token" for token providers).
3. `POST /api/credentials {service, label, kind, hint (masked), keepFor, envelope}` → 201 CredentialInfo (never the
   secret). Pending credential cards for that service flip to "saved" (`message` + `thread_updated`); the user's next
   message makes the model retry.
- `PATCH /api/credentials/:id {keepFor}` → CredentialInfo; DELETE → `{ok:true}`.
- 400 `invalid_envelope` "이 계정용으로 암호화된 정보가 아니에요" (aad mismatch / vault errors).

## Connections (agent-messenger)
- `POST /api/connections/:provider` with `{credential: <same body as POST /api/credentials>}` or `{credentialId}`.
  A failed login is still 200 with `connection.status:"error"` and Korean `lastError`.
- display_code providers (KakaoTalk passcode, LINE, Teams) return `verification` with the code to show; poll
  `POST /api/connections/:p/verify {}` or wait for the `connection` event. enter_code (Instagram 2FA):
  `POST /verify {code}` (400 `invalid_code`).
- MessengerError codes pass through: `not_connected` 409, `unknown_provider` 404, `network`/`upstream` 502,
  `provider_unavailable` 503, `rate_limited` 429 with `Retry-After` (the provider's seconds; message
  "슬랙이 요청을 잠시 막았어요. N초 뒤에 다시 시도해 주세요."), others 400 (e.g. `no_pending_verification`).

### Slack 로그인 릴레이 (sign in with the Slack account, no token paste)
The server signs in to Slack's own web sign-in in a throwaway headless Chrome (`apps/server/src/slack-login/`), keeps
only the resulting session (`xoxc-` token + `d` cookie) sealed in the vault, and connects it through the normal Slack
adapter (`auth.test`). The token paste (`POST /api/connections/slack {credential}`) stays as "고급: 토큰 직접 입력".

Every typed value is a device-sealed envelope (`@pickle/vault/client` `sealForEnclave`), never plain JSON, and never
stored: the relay opens it only to type it into Slack.
- start aad `${userId}:slack:login-relay:start`, plaintext `{email}`
- step aad `${userId}:slack:login-relay:${relayId}`, plaintext `{code}` | `{password}` | `{totp}`

Routes (Bearer auth; `Content-Type: application/json` required → else 415; body ≤ 16 KiB):
- `POST /api/connections/slack/login {provider?:"slack", workspace?, method?:"code"|"password", email:<envelope>, keepFor?}`
  `workspace` accepts `sionic`, `sionic.slack.com` or a URL; empty → Slack finds the workspaces by email (code only).
- `POST /api/connections/slack/login/step {relayId, code|password|totp:<envelope>}` or `{relayId, teamId}` (exactly one).
- `POST /api/connections/slack/login/cancel {relayId}` → `{ok:true}` (closes the browser at once).

Every answer is `LoginRelayResponse {relayId, state, codeLength?, workspaces?, connection?, error?, expiresAt}`:

| state | meaning | next |
|---|---|---|
| `needs_code` | Slack emailed a 6-character code (or a new-device check after a password) | step `{code}` |
| `needs_password` | password form (method "password", or the workspace has no email codes) | step `{password}` |
| `needs_2fa` | two-factor code | step `{totp}` |
| `workspaces` | several workspaces: `[{id, name, domain}]` (id is opaque) | step `{teamId: id}` |
| `connected` | sealed, `auth.test` passed; `connection` is the Slack `Connection` (an SSE `connection` event is sent too) | done |
| `error` | terminal, the relay is closed; `error {code, message}` (Korean) | start again |

`wrong_code` / `wrong_password` / `wrong_totp` come back with the SAME state plus `error` (retry; 5 tries per prompt,
then `too_many_attempts`). Terminal codes: `code_expired`, `too_many_attempts`, `sso_unsupported` (Google/SAML/Okta
workspaces are not automated), `workspace_not_found`, `workspace_required` (password without a workspace),
`password_unavailable`, `invalid_email`, `no_account`, `captcha` (Slack asked for a human check), `slack_ratelimited`,
`token_not_found`, `auth_failed`, `timeout` (5 min), `cancelled`, `browser_unavailable` (no Chrome on the server),
`upstream` (the page did not look like Slack's sign-in). A step on a relay that already ended answers 200 with that
reason; an unknown relayId → 404 `relay_not_found`.

HTTP errors: 400 `invalid_envelope` / `invalid_workspace` / `invalid_code` / `invalid_step` / `invalid_team`,
401, 404 `login_relay_unsupported` (other providers), 409 `relay_busy` (a step is still running) / `wrong_step`,
415, 429 `rate_limited` + `Retry-After` (5 starts per user per 15 min), 503 `relay_busy` (3 server browsers at once).
One relay per user: a new start cancels the previous one. Each call can take several seconds (client timeout 90–120 s).

Logs carry step names, timings, the state and a masked workspace (`ws=s****c`) only; never the email, password,
codes, token or cookie. The relay refuses to run when `DEBUG=pw:api`/`pw:protocol` (Playwright would print typed text).
Env: `PICKLE_SLACK_LOGIN_HEADLESS=0` shows the browser (local debugging only).

### Provider sign-in metadata (`ProviderInfo.login`, `ProviderInfo.advanced`)
`GET /api/connections` → `providers[]` carry `login` (which sign-in the connect sheet runs; old clients keep using
`auth`) and `advanced` (bots the person made themselves → the folded "고급 · 직접 만든 봇 연결" group):

| provider | login | row subtitle | flow |
|---|---|---|---|
| kakaotalk, line, instagram, webex | `password` | 계정으로 로그인 | sealed id + password → `POST /api/connections/:p` |
| slack | `relay_code` | 이메일 코드로 로그인 | Slack relay above |
| discord | `remote_auth` | 앱에서 승인해 로그인 | relay below (QR / Discord app) |
| telegram | `phone_code` | 전화번호로 로그인 | relay below (phone → code → 2FA) |
| teams | `device_code` | 회사 계정으로 로그인 | display_code |
| slackbot, discordbot, telegrambot | `bot_token` + `advanced:true` | 봇 토큰으로 연결 | sealed token |

`discord` keeps its token `fields` so a connection made by token paste before the relay still validates; the app no
longer shows that field. `telegram` is `available:false, unavailableReason:"준비 중이에요"` until the operator sets
`AGENT_TELEGRAM_API_ID` + `AGENT_TELEGRAM_API_HASH` (my.telegram.org app registration) in the server env and TDLib
loads (koffi + prebuilt-tdlib, installed with agent-messenger).

### 디스코드 · 텔레그램 로그인 릴레이 (`apps/server/src/messenger-login/`)
Same routes and `LoginRelayResponse` as Slack; `:provider` = `discord` | `telegram` (dispatched in app.ts). Start
carries NO secret (`{keepFor?}` only; `email`/`phone` at start → 400 `invalid_start`). Every typed value is a step
envelope bound to the relay: aad `${userId}:${provider}:login-relay:${relayId}` (unique per relay, one-time id); an
envelope is accepted once (iv replay → 400 `invalid_envelope`). `POST …/login/step {relayId}` with no secret field =
poll (current state). Drivers: `@pickle/messengers/login`.

Discord (agent-messenger `loginWithRemoteAuth`: Discord's own QR login; RSA key pair in memory for that relay only):

| state | fields | meaning | next |
|---|---|---|---|
| `waiting_scan` | `qrUrl` (`https://discord.com/ra/<fp>`), `qrSvg` (data URI), `pollMs` | open `qrUrl` (Discord registers `/ra/*` as an app link: opens the Discord app on the same phone) or scan `qrSvg` from another device | poll |
| `waiting_confirm` | `account {name}`, `pollMs` | the Discord app scanned it; waiting for "로그인" there | poll |
| `connected` | `connection` | token exchanged, sealed (`saveSystem` kind token) and validated by the Discord adapter (`hub.connect {credentialId}`) | done |
| `expired` | `error {code:"timeout"}` | Discord's own ~4 min QR limit or the 5 min relay limit | start again ("새 QR 코드 만들기") |
| `cancelled` | `error {code:"cancelled" \| "qr_rejected"}` | cancelled here / in the Discord app | start again |
| `error` | `error {code}` | `captcha` (Discord asked for a human check), `auth_failed`, `network`, `upstream` | start again |

Telegram (TDLib; session = the TDLib database under `<dataDir>/messengers/<user>/telegram/<dir>` encrypted with a
random 32-byte key; only `{databaseKey, tdDir}` is sealed in the vault):

| state | fields | next |
|---|---|---|
| `needs_phone` | — | step `{phone}` (plaintext `{phone:"010-1234-5678"}` or `+8210…`; normalised to E.164 on the server) |
| `needs_code` | `codeLength`, `codeVia` (`app`\|`sms`\|`call`\|`email`), `phoneMasked` (`010-****-1234`) | step `{code}` |
| `needs_password` | `passwordHint?` (the person's own 2FA hint) | step `{password}` |
| `connected` | `connection` | done |
| `error` | `not_configured` (no api_id), `phone_banned`, `flood_wait` (message says how long), `code_expired`, `no_account`, `unsupported` (email setup / other-device confirmation required), `too_many_attempts`, `auth_failed`, `network`, `upstream` | start again |

Retryable (same state + `error`): `phone_invalid`, `wrong_code`, `wrong_password`; 5 per relay, then
`too_many_attempts`. A re-login deletes the previous Telegram session credential and its database directory.

Limits: 6 starts per user per 15 min (Discord + Telegram together; 429 + `Retry-After`), one Discord/Telegram relay per user (a new
start cancels the previous one; Slack's relay is separate), 30 relays server-wide (503), 5 min per relay, then
`expired`. Every end (connected, expired, cancel, error, replace, shutdown) runs one cleanup: socket closed, TDLib
closed, unfinished TDLib files deleted, timer cleared; a late poll gets the final answer (15 min).

Logs: `messenger_login {relay:<6 chars>, provider, step, state, err?, ms?}` only — never the phone number, code,
password, token, QR link/fingerprint or database key (tests grep the captured logs for every fake value).

## Attachments
- `POST /api/attachments` multipart, field `file` (+ optional `threadId`) → 201
  `{id, filename, mime, size, threadId, url:"/api/attachments/<id>/raw", createdAt}`. Raster images, PDF, plain text
  and Markdown (no SVG, HTML or other text). Markdown is stored as `text/markdown` (`text/x-markdown` too); a file that
  comes with no type or as `application/octet-stream` is told by its name (`.txt` text/plain, `.md`/`.markdown`
  text/markdown). Bun's multipart parser types a file part by its name's extension alone, so a name without a known
  extension is 415 whatever type the part says. Raw: text files (Markdown too) come as `text/plain; charset=utf-8`.
  413 `file_too_large` (10 MB) · 415 `unsupported_type` · 400 `invalid_upload`.
- What the model reads of a message's files (personal threads): a text file's text goes into the model's copy of the
  message, up to 30,000 characters per file and 50,000 for all its files together, in order. A file cut there gets,
  above its text, a note with its whole length, how much the model has and how much is missing
  (`[첨부: 이름 — 전체 N자 중 앞 M자만 읽었어요. 뒤 N−M자는 이 대화에 없어요. …]`) and, where it stops,
  `[첨부: 이름 — 여기서 잘렸어요]`; the cut falls on the last line break within 2,000 characters of the cap (else at
  the cap, never inside a surrogate pair). A text file with nothing of the 50,000 left gets only a note that it was not
  read. The person sees just the file's name, so both notes ask the model to tell them, once, in its first answer about
  the file (described, with no sample line). Images and PDFs: a short note (`내용은 볼 수 없어요`). Cost: a full
  Korean file is ~21k–36k tokens (estimate) on each model call of its turn and of the next turn, whose history still
  holds the request (history keeps the last request whole; after that its 24 KB window drops the file and what came
  before it). From the turn after next the model no longer has the file's text: a file meant to be followed for a whole
  conversation has to be sent again. Rows made before 2026-11-26 had text/plain of up to 8 KB inline and a short note
  for anything else.
- Who reads: `GET /api/attachments/:id/raw` (and `GET /api/artifacts/:id`, `GET /api/blobs/:id`) serve the caller's
  own, or a friend's that the friend's side put in their friend thread (a photo or file they sent, their 모시's card),
  while both are still members of that thread and still friends. Anything else — another user, a friend outside that
  thread, a blocked or removed friend — is the same 404 as a missing id. A friend's file comes with
  `Cache-Control: private, no-cache` (one's own: `private, max-age=3600`). Delete, the lists and `attachmentIds` stay
  the owner's.
- Deleted from the archive (`DELETE /api/artifacts/:id`, `DELETE /api/attachments/:id`; someone else's id, a missing one
  and a second delete are 404 and change nothing): in the same transaction every message carrying it in a thread the
  owner is in (their own threads and friend threads; only the owner's side ever puts their id in a message) keeps the
  card or ref, marked — `ArtifactCard {…, preview: "", deleted: true}` (title, kind kept), `AttachmentRef {…, url: "",
  deleted: true}` (filename, mime, size kept) — and goes out again as `message` to every device of every member of the
  thread; page reads show the same. Matched by the exact id. The attachment's file is removed. In the same transaction
  the model's copy of those messages (`llm_json`) loses the content: the turn that made the document keeps its
  `sys_create_artifact` call and result as a pair (found by the result's `data.artifactId`), the call's arguments
  without `content`, the result's `summary` saying it was deleted with `deleted: true` (replay does not take such an
  HTML card's call for a design-guide call); the message that sent the file
  gets its files' notes made again (text files inline as above, the deleted one as deleted; a row made before 2026-11-26
  is found by that day's rule and made again by it, so it gets no text it never had), the text before and anything
  after kept. The visible answer text and memories are not changed. A document deleted while the turn that made it
  still runs is caught when the turn's answer row is written (same transaction): its card goes in marked, the row's
  model copy and a paused turn's approval messages without its content. An approval already waiting is not changed.

## Explore
- `count` is real delegations only (`POST /api/explore/:id/delegate`), 0 on a fresh server; there are no seeded
  counts (migration v4 removed the ones older servers had seeded, keeping the delegations made since).
- `popular` = every visible template sorted by count, then seed order (the "추천" tab). Other category tabs filter `popular` client-side
  by `template.category === category.id`. `suggestions` = up to 4 personalised templates (names substituted).
- Normal template: delegate returns `{thread, prompt}` → open the thread and send `prompt` as the first message, right
  away: if the agent is busy elsewhere that send queues (200 SSE, see Sending a message) instead of 409.
- `call-demo`: delegate creates a kind "call" thread ("<displayName>님께 전화", subtitle "<agentName>의 외부 통화") with
  `prompt:""` — do NOT auto-send; open the thread. It already holds the agent's greeting ("누구에게 어떤 용건으로
  전화할까요? …"); the agent asks for approval before `sys_phone_call` (see Phone calls).
- `connect-kakao` (suggestion): open the Connections screen instead of delegating.

## Voice — `POST /api/tts`
모시's own voice for the call screen (local Fish Audio Drama-3, `services/tts`).
- Auth required; 30 req/min per user → 429 `rate_limited` + `Retry-After`.
- Body `{text}`: 1–600 chars after trimming. Send plain sentences; the TTS service drops markdown, URLs and leading
  punctuation before speaking.
- 200 → `audio/mpeg` bytes, `Cache-Control: private, max-age=86400`, `X-Audio-Duration: <seconds>`. Identical text is
  served from the server's disk cache, so a repeated line returns at once.
- 400 `empty_text` (empty, not a string, or nothing speakable) · 400 `text_too_long` (> 600) ·
  **503 `tts_unavailable`** when TTS is off (`PICKLE_TTS_URL=off`), down, still loading, timed out or failed. On 503,
  fall back to Web Speech (`speechSynthesis`, `ko-KR`) for that line.
- Speed is about real time (an 8 s line takes ~8 s) and the service makes one line at a time, so request a line as soon
  as its text is final and split long answers into sentences. The client fetches with the bearer header and plays the
  result through a `blob:` URL (CSP `media-src 'self' blob:`).
- Phone calls (`sys_phone_call`, `sys_call_me`, phone verification) use the same voice when `publicAudio` is ready: the
  message is synthesized before dialling and Twilio fetches it from a 15-minute token URL. The call uses Twilio's
  `<Say language="ko-KR">` instead when TTS or public audio isn't available, when the TTS service already has 2 or more
  lines queued (unless the line is cached), or when the voice takes longer than 45 s.
- Public audio (server ops): a separate listener on 127.0.0.1:`PICKLE_AUDIO_PORT` (default 8789) serves only the token
  URLs. Without `PICKLE_PUBLIC_AUDIO_URL` the server opens a Cloudflare quick tunnel to it. Quick tunnels are rate limited
  per IP (`429` / Cloudflare `1015`, or no answer within cloudflared's 15 s): every server start on one Mac asks for one.
  The server retries for as long as it runs — 15 s doubling (60 s when rate limited), ±20 %, at most 10 min apart —
  and logs each failure with its reason (`reason=rate_limited|api_timeout|api_error|timeout|exited`, cloudflared's last
  error line, `retryInS`), then `public audio ready … attempt=N` and `public audio reachable` once a GET through the
  public URL reaches the listener. Until then `publicAudio` is "missing" and calls use `<Say>`. If the audio port is
  taken by another server, it listens on a free port instead (the tunnel points there); with `PICKLE_PUBLIC_AUDIO_URL`
  the port must be free (the outside proxy expects it). QA servers that don't place calls should set
  `PICKLE_AUDIO_TUNNEL=0`.
- The tunnel is kept across restarts, so a restart asks for no new quick tunnel and keeps its URL: cloudflared runs
  detached (own session, output in `<PICKLE_DATA_DIR>/audio-tunnel.log`) with `--metrics 127.0.0.1:<free port>`, and
  `<PICKLE_DATA_DIR>/audio-tunnel.json` records `{pid, port, metrics, bin, args, url, startedAt}`. Shutdown leaves it
  running (`audio tunnel left running for the next start`). The next start reuses it only when the pid is alive, its
  command line is exactly the recorded cloudflared and arguments, and it points at this server's audio port; the URL
  comes from its metrics `GET /quicktunnel` (`audio tunnel reused pid=… url=… ageS=…`, then `public audio ready …
  kept=true reused=true`). A record whose pid is now another process is dropped and that process is never signalled; a
  dead pid's record is dropped; our recorded cloudflared for an old audio port is stopped and replaced. A reused tunnel
  is checked every 15 s and replaced if it dies. On a fallback port (ours busy) nothing is kept or reused. To stop the
  kept tunnel by hand: `kill <pid from audio-tunnel.json>`.

### Real-time voice — `POST /api/tts/stream`
The same voice, streamed as it is generated: first audio in about 0.25 s instead of after the whole line.
- Same auth, body, validation errors (400 `empty_text` / `text_too_long`) and rate limit as `/api/tts`. The two endpoints
  share one budget of 30 requests per minute per user.
- 200 → raw PCM, **signed 16-bit little-endian, mono, 22050 Hz**, chunked with no `Content-Length`; the stream ends when
  the line is done. Headers: `Content-Type: audio/L16; rate=22050; channels=1`, `X-Sample-Rate: 22050`,
  `X-Sample-Format: s16le`, `Cache-Control: no-store`. Byte order is little-endian even though RFC 2586 L16 is
  big-endian, so read with `DataView.getInt16(i, true)` / `Int16Array` on little-endian hardware. Always take the rate
  from `X-Sample-Rate` (the server halves the service's 44.1 kHz with a [1, 2, 1]/4 low-pass). The network can split
  a sample across reads: carry an odd trailing byte into the next chunk.
- Play chunks as they arrive (Web Audio: convert to Float32 `/ 32768`, schedule `AudioBuffer`s back to back at 22050 Hz).
  Chunks are about 0.32 s of audio each (~14 KB).
- **503 `tts_unavailable`** when TTS is off, down or loading, the service already has 2 or more lines queued, or the
  service fails before audio starts. Then use `/api/tts`, or Web Speech. A failure after audio has started just ends
  the stream early.
- Not cached: the same text streams again from scratch. Use `/api/tts` for lines that repeat.
- Abort the fetch to stop speaking (barge-in): the server cancels the upstream request right away and the service stops
  generating within one chunk. The stream also ends if
  no audio arrives for 30 s at the start or 15 s between chunks.
- Stream mode has no retakes: an occasional sentence can run long (babble), bounded by the service's per-sentence cap.

## Friends
- Thread title differs per viewer ("깽이와 진우님의 모시"); `thread.peer = {userId, displayName, agentName}`.
- `message.author.kind` ∈ `me | peer | my-agent | peer-agent` with names like "진우 님", "진우 님의 콩이".
- `GET /i/:token` is an HTML page whose "앱 열기" goes to `/?invite=<token>`; the app then calls
  `POST /api/invites/<token>/accept`.

## Invest (B1) — 나의 모시 > 투자
Watch prices, keep price rules, alert. No model call anywhere in B1, and no order: the Toss client reads only
(prices, holdings, sellable quantity). Types: `packages/protocol/src/invest.ts`. Code: `apps/server/src/invest/`.
- `GET /api/invest` → `InvestOverview {rev, mode, watchlist, rules, settings, quotesFoot, watch, stages (B2b-2), reports
  (B2c-1), decks: []}`. Every figure is a server string (`InvestNum {v, text, unit}`; @pickle/quant format.ts) — screens format
  nothing. `watch.state`: `off` (no source on this server: "지금은 시세를 받지 않아요"; with live rules `foot` "그래서 규칙을
  확인하지 않아요.", plus " 토스증권을 연결하면 확인해요." on a server with Toss; `quotesFoot` null), `ok`, `closed`, `blind` (live rules
  and no quote for 15 minutes of a session; `tone` danger when a real sell stop is live, else caution; `foot` replaces
  `quotesFoot`). `GET /api/invest/symbols/:symbol` → `InvestSymbolDetail` (404 `not_watched`): the row, the rules, the
  last 5 alerts with `line` (the banner's title without the symbol, DD 0914 D2), and `chart` (symbol chart board: the
  daily bars, up to 260; `levels` in @pickle/quant levelChart's shape — stop, invalidate, target1–3, alert (the person's
  price), the buy zone as one band `buyZone` price–hi, resistance, each with its rule's words, in that order (the aria
  says 무효화 and 알림 as levelChart labels them, "손절 25.80, 무효화 27.20, 알림 33.00"); left out: expired rules and
  rules a split or a merge stopped (prices from before it on adjusted bars); `aria` the
  sentence after the chart's name, "11월 26일 종가 32.57달러. 손절 25.80, 1차 익절 36.50, 매수 검토 구간 30.00에서 31.50. RSI
  48." (no levels, no RSI under 15 bars: those sentences left out), the screen putting "SOXL 일봉 40일. " in front with
  the days it drew; `foot` "기준 11월 26일 종가 · Yahoo(지연 시세) · B+", the bars' source and grade). No chart → `chartNote` + `chartNoteTone`: nowhere to get bars "시세를 받지 않아서 차트를 그리지 않아요." (quiet), fewer
  than 30 bars "일봉이 아직 모자라서 차트를 그리지 않아요." (quiet), not received "오늘 일봉을 받지 못해서 차트를 그리지 않아요."
  (caution).
- Event `invest {rev, overview}`: the whole overview whenever it changed (a quote, a rule, a watch state, Toss, settings),
  to the person's devices only. `rev` follows the settings rule: max(previous + 1, server clock), never lowered; an
  unchanged overview sends nothing. `hello.investRev` (absent before the first use) tells a device that slept to re-read.
  Session: `investMode: "real"` only while real orders are on (never in B1).
- Watchlist: `POST /api/invest/watchlist {symbol}` → `InvestSymbolRow` (201 new, 200 already there). US `^[A-Z][A-Z0-9.-]{0,9}$`,
  KR six digits; trimmed and upper-cased. With sources on, Yahoo's own "not found" → 404 `unknown_symbol`; any other
  failure takes the symbol with its symbol as name; with a Toss login its Toss type is asked with that person's token
  once the add is done (B2d-2c; the add never waits for it). `DELETE /api/invest/watchlist/:symbol` → 409
  `has_rules {count}` while it has rules; `?withRules=1` removes both. Newest first. At most 30.
- Rules: `POST /api/invest/rules/preview` (a draft, or `{ruleId, changes}`) → `InvestRulePreview` (the server's sentence,
  stop warning, `basis`, `buffer`/`bufferPct`/`bufferDefault`/`bufferFoot` for stops, `sellable` for sell stops, `callNote`
  for calls, `confirm` tap|hold; valid 10 minutes, used once). `POST /api/invest/rules {draft, previewId?}` → 201
  `InvestRuleRow`. `PATCH /api/invest/rules/:id {changes, ifRev, previewId?}` reads price · lo · hi · direction (price
  alerts only; the same direction again is a no-op) · action · until · once · bufferPct and raises `rev`; a stale `ifRev`
  → 409 `rule_changed {rule}`, a stale preview → 409 `preview_stale {preview}`. `DELETE /api/invest/rules/:id`.
  Kinds a person makes: stop, target (level 1–3), buy_zone (lo < hi), alert (direction below|above). resistance and
  invalidate come from strategy proposals (B2): POST → 400 `kind_not_allowed`; PATCH and DELETE work. `sell` only on a
  stop (400 `sell_not_allowed`). bufferPct 1–20, null = the 5% default (stops only). until: a date from today, within a
  year. At most 60 rules. Errors are `{error, message}` with the DD 2100 copy.
- The watch: from 15 minutes after the open every 5 minutes to the close, plus one check 5 minutes after the close (US
  09:45–16:00 ET + 16:05; early closes 13:00 + 13:05; KRX by its 2026 table; holidays and other years: no check). Each
  slot runs once per server (a marker in `invest_cache`). A person with Toss follows their own Toss market calendar
  (asked with their token once a market day per market, weekends not asked; kept under their key): Toss's answer decides
  that day for them only (US: open or closed and the regular hours, early closes included; KR: whether KRX trades — no
  closing auction = closed — with KRX's hours). Everyone else follows the rules and the table. A Toss answer that
  differs from the table is logged with the market, the day and the two answers only. Quotes: the person's Toss key
  first (every watched symbol in one call), then Yahoo for symbols with live rules (4-minute shared cache). Daily bars:
  the person's Toss candles (their token, kept under their key), else Yahoo (shared); a read made before the day's close
  check lasts to it, so the day's bar is read again once final, else to the next market day. Stooq is not used.
- Rule states `armed | hit | paused | expired` (대기 / 닿음 / 멈춤 / 만료; armed with a deadline: `12-01까지`). Inside while
  armed → one alert and `hit`; inside while hit → nothing; one check outside → armed again, so a later touch is a new alert
  the same day. `once` → `paused` after its alert; a sell stop always pauses; a split or a merge pauses the symbol's
  rules (B2c-2). Any PATCH of a paused or expired rule watches it again. The earlier state is known only when the rule was seen at the check right before (the last close check
  included); otherwise the alert says why (`noPrior`, title line: first look / after an edit / after resuming / quotes
  missing in between) and resistance says "위에 있어요", never "넘었어요". One alert per `ruleId:rev:hitSeq` (UNIQUE).
  The watch never writes a rule's price, direction, action or rev, and a save that lands mid-check wins (no alert for the
  old rule).
- Stop basis (D5-2): ATR14 wider than the stop's distance (from the average price, else the last close) → close basis:
  the close check at or below the stop, or any check at or below the buffer; between the two during the session it waits.
  ATR14 and the last close come from finished daily bars only (today's bar from its close check on); without them the
  last one computed serves up to 5 market days (kept with the day of its last bar, a Toss figure under the person's key;
  an alert's ATR goes to the ledger with that as_of and the source it came from). None → intraday only, and the buffer foot
  starts "지금은 장중 가격만으로 판단해요."; in real mode the stop's alert or record card carries that line too.
- Alerts go to the person's invest thread (kind `schedule`, title "투자", icon `chart`; made on the first alert) as
  `invest_alert` / `invest_stop` cards, each with `disclaimer: true`, plus a `notification` banner (amounts in the app
  banner; B1c's lock-screen push carries the title only). A mock sell stop is a record ("실제 주문이었다면 47주를 팔았을
  거예요", or without a quantity, or skipped at zero sellable); no card says it sold. Expiry ends a rule at its deadline
  day's close check with its own card.
- Calls: a rule with action `call` (and `calls.stopResult` for stop records, `calls.expiry` for expiries; stage calls are
  B2) dials the verified number after the card is stored, then the card gains `call {ok, text}`. 10 invest calls per KST
  day, counted apart from `sys_call_me`; blocked → `callBlock` `not_verified` | `not_configured`. Spoken lines say what
  happened and the price, never advice or the disclaimer. `settings.callNote` is the call footnote in the preview's words
  ("앱에서 인증한 번호로 걸어요. 하루 10통까지예요." or why not) and `settings.bufferPctDefault` the operating default
  buffer (`5%`), so screens hold no copy of either (DD 2341).
- Toss (paths and bodies as the public openapi.json 1.2.28: `POST /oauth2/token` client credentials, `GET /api/v1/prices`,
  `/api/v1/candles?interval=1d&count=200`, `/api/v1/market-calendar/{US|KR}?date=` bearer only; `/api/v1/holdings` and
  `/api/v1/sellable-quantity` also with `X-Tossinvest-Account`, the account from `/api/v1/accounts` (BROKERAGE, else the
  first); every body `{result}`; prices carry no previous close; a person's key serves that person's watch only).
  **One Toss login in the app** (team-lead 0059): the k-skill connection `toss-investment` (fields clientId, clientSecret),
  saved through `POST /api/connections/toss-investment` (연결 › 토스증권, and the invest settings row opens the same
  sheet) or `POST /api/credentials`. Its token and account live in that login's ConnectionRegistry session (memory only),
  shared by the agent's Toss tools and the invest watch: whichever asks first, the other sends that token; a new one
  taken after a refusal is the other's too. The login connecting (its check passed) runs one holdings read with the
  check's token; disconnecting it (`DELETE /api/connections/toss-investment`) or deleting it turns real off, forgets
  holdings and drops the session for both. `GET /api/invest/toss`,
  `POST /api/invest/toss/check` (429 `toss_check_too_soon` within a minute) → `InvestTossStatus`. A 403 asked again with a
  new token is `ip_not_allowed` (never "expired"); the person's Toss calls rest an hour. 401 `auth`, 429 `rate_limited`
  (5 minutes), else `down`. Keys and tokens never reach logs, cards, events or rows; a failure keeps its code alone.
- `PATCH /api/invest/settings {calls?: {stopResult?, stage?, expiry?}}` → `InvestSettingsView`.
- Server env: `PICKLE_INVEST_SOURCES=on` lets the server call public sources (off by default: no Yahoo call at all);
  `PICKLE_TOSS_BASE` (https origin) lets it call Toss (off by default, so tests and QA cannot); `PICKLE_OUTBOUND_IP` is shown
  to the person for Toss's allowed-IP list (never looked up). A 403 or 429 from a public source rests it until the next
  day; a 200 that is not its data (a block page) too. Default User-Agent, one request at a time per host, 10 s limit.

## Invest (B2a) — the ledger, forecasts and events

Each person's own rows (team-lead 0052); no model call behind any route. Code: `apps/server/src/invest/ledger.ts`,
`forecasts.ts`, `events.ts`. Field errors are 400 with the field's Korean sentence (`invalid_ledger`, `invalid_forecast`,
`invalid_event`); a day already past names today (DD 0521 §2): "2025-12-10은 지난 날이에요. 오늘은 2026-11-27이에요." (a
US event: "오늘은 2026-11-26(미 동부)예요."), "기한 2025-12-10은 이미 지났어요. 오늘은 2026-11-27이에요."
- **Ledger** (B2's nine fields): `GET /api/invest/ledger?id=&limit=` → `{items: InvestLedgerEntry[]}` (one id's rows by
  as_of, newest first, or the latest written; the person's own and the shared rows, `shared: true`, never another's).
  `POST /api/invest/ledger InvestLedgerDraft` → 201 entry (author `person`). id `[letters digits . _ -]` ≤ 64; asOf and
  publishedAt a day or an ISO time with its zone, not past two days ahead; unit usd krw index pct pctp qty bp count T GW
  $B text (text: `valueText` only; else a finite `value`); a definition always (L2: no definition, no row); source,
  `sourceTier` T1–T4, `confidence` A/B+/B/C (T4 is C only), url http(s) without credentials; `leadClass` L1/L2/G/T. The
  same id and asOf again replaces the row; a person's rewrite without `revision` gets "{KST day} 고침". The code's series
  (`quote.*`, `atr14.*`) answer 400 `ledger_reserved`, a row code wrote 409 `ledger_locked`. 5,000 own rows (400
  `too_many_ledger_rows`). The watch writes its quote and ATR rows through the same path (author `code`, tier T2).
- **Forecasts** (B6): `POST /api/invest/forecasts InvestForecastDraft {claim, p (0–1, ends out), interval?, dueOn (KST,
  today to 3 years), criterion, ledgerIds? ≤ 10}` → 201 `InvestForecast`. Made once: no edit, no delete (500 per person).
  `PATCH /api/invest/forecasts/:id {outcome: hit|miss|partial|null, actual?, errorCause?, rev?}` — the person's judgement
  (null takes it back); `errorCause` (data interpretation model timing narrative) only with miss or partial; a stale
  `rev` → 409 `forecast_changed {forecast}`; another person's id → 404 `forecast_not_found`. `GET /api/invest/forecasts`
  → `InvestForecastList {items, score, outcomes, causes}`: waiting first, then open (by due day), then judged; the
  statuses' words 기한 전 · 판정 기다림 · 적중 · 빗나감 · 부분 적중 and the causes' words and sentences are the server's (DD 0109
  §2). Score by due day: direction hit rate over 3 and 12 months with the window's count (hits and misses: "방향 적중률
  3개월 64% · 11건 · 목표 65%"), the 12-month Brier score, partial hits out of both (`partialFoot`, beside rows only); a
  window with nothing judged has no row. `empty` when, and only when, there is no row (DD 0405 C): nothing judged "아직
  판정한 예측이 없어요." · only partial hits in 12 months "부분 적중 N건뿐이라 아직 점수를 내지 않아요." · everything judged
  older "최근 12개월에 판정한 예측이 없어요.". `dueText` "12월 31일까지", another KST year "2027년 3월 31일까지";
  `intervalError.text` "구간 안" / "구간보다 0.20%p 위" / "구간보다 $0.30 아래" (`v` signed, DD 0405 D).
- **Events**: `POST /api/invest/events InvestEventDraft {market, day (the market's date, today to 2 years), time? (the
  market's HH:MM), kind (earnings macro policy contract other), title ≤ 80, symbol? (its market), source, sourceTier,
  confidence, url?, remind?}` → 201 `InvestEvent` (`heading` symbol first, `when` "11월 26일 06:20(미 동부 16:20)" /
  "11월 25일 10:00" / "미 동부 11월 26일 · 시각 미정", another KST year "2027년 1월 5일 06:20(미 동부 16:20)" / "미 동부
  2027년 1월 5일 · 시각 미정", `foot` "출처 · 등급", `remindOn`, `reminded`). One per person, market,
  day and title (409 `event_exists {event}`); 200 upcoming. `PATCH /api/invest/events/:id {remind}` is the only change;
  `DELETE /api/invest/events/:id`. `GET /api/invest/events?from&to` (default yesterday KST + 60 days, 400 at most).
- **D-1** (team-lead 0056, DD 0109 §1): from 08:00 KST on the day before the event's market date (whatever the market
  does that day), one `invest_event` card per person in the invest thread with every event of theirs due (one row each,
  KST order; title the heading, or "일정 N개"), `disclaimer: true`, no buttons; banner and push title alone, push tag
  `invest:event:<day>`. Once per person, market, day and title by any path: the claim and the card are one transaction;
  a deleted event added back sends nothing again; the 08:00 report (B2c-1) takes the same claim when it carries the line. An
  event the person or the model added at or after that 08:00 gets no D-1 (it was just said); one code added (author
  `code`) goes at the next beat (DD 0405 F).

## Invest (B2b-1) — the agent's invest tools and rule proposals

The model reads figures code computed and writes only through the person's paths, as author `model`; it never changes a
rule (A12 · G8-5). Code: `apps/server/src/invest/tools.ts`, `proposals.ts`.
- **Tools** (offered in the owner's own threads once they have invest settings, stored when the invest screen is
  first opened or a symbol watched; never in a friend thread or with others present): `invest_watch_list` (the screen's rows, every rule's id and rev), `invest_technicals
  {symbol}` (from the daily bars by @pickle/quant: MA 20/50/200 and the distance from them, RSI 14, MACD, ATR 14,
  Bollinger 20, 20-day VWAP, drawdown from the high, the 60-day volume bands, a 2-ATR stop level; each `{v, text}` with
  the bars' day, source and grade; no bars → no figures), `invest_ledger_add`, `invest_forecast_add`, `invest_event_add`
  (the POST paths above, author `model`), `invest_events` (the GET), `invest_forecast_judge {forecastId, outcome,
  errorCause?}` (due and not judged only: 409 `forecast_not_due` / `forecast_judged`; it sets `InvestForecast.proposal`
  — "{agent name} 제안: 빗나감 · 시기" — never the outcome or the rev), `invest_watch_propose`. The descriptions (DD
  0521): with quotes off or blind the model passes on the server's watch words and never offers to turn quotes on; a
  date said without a year is the next one from today, and a refused date is corrected and tried once more; `"request"`
  only when the person said those prices in the turn, a reason with no source, grade or day that rests only on the
  basis (no price, trend or market move not read in the turn; a request's reason only the person's own, else empty,
  DD 0717), and the watch list never redrawn as an html card (DD 0524, 0600).
- **Proposals**: `invest_watch_propose {symbol, changes[≤ 6], reason (one line ≤ 120, not the rows' prices; may be
  empty only with basis "request", and then the card has no `reason`, DD 0717; else 400), basis}`
  stores a proposal and puts an `invest_rule_change` card in the turn's message (DD 1935 §2-3: the question title,
  `changes` rows 낱말 · 지금 → 바꿀 값, `reason` and `reasonFoot`, the result sentence of
  each rule — a real sell stop's with the sellable quantity — and `warning` for a stop above the price; `confirm: "hold"`
  for a real sell stop, else `tap`; `expiresAt` 24 hours on). The foot is code's (DD 0521 §1): `basis` is a ledger id
  (its newest row the person can read: "11-27 기준, 출처 · 등급"; none, another's or grade C → 400 `invalid_proposal`),
  `"technicals"` (only after `invest_technicals` answered for that symbol in the same turn: its last bar's day, source
  and grade; else 400) or `"request"` (the person named the prices: "요청으로 만든 제안이에요.", no grade); the tool's
  result carries that foot as `data.foot` and a note not to restate the basis, the foot or the prices (team-lead 0631 b).
  A change names an existing rule of the symbol `{ruleId,
  price | lo, hi | direction (price alerts)}`, takes one away `{ruleId, remove: true}`, or makes a new rule `{kind,
  level?, price | lo, hi, direction?}` that only notifies (`created_by: "proposal"`; resistance and invalidation rules
  come this way). It never sets the action, the buffer, the deadline or "once" (400 `invalid_proposal`). Rows (DD 0405
  G): a new rule `없음 → $30.50`, a rule taken away `$30.50 → 없음`; one change's title "SOXL 손절선을 $30.50으로
  올릴까요?/내릴까요?" (a value before), "SOXL 손절선을 $30.50으로 둘까요?" (new), "SOXL 손절선을 지울까요?", "SOXL 알림을
  $35.00 이상으로 바꿀까요?" (the direction alone); several (DD 0452): "SOXL 새 전략 가격 N개를 적용할까요?", "SOXL 규칙 N개를
  바꿀까요?" when one is taken away, "SOXL 규칙 N개를 지울까요?" when all are. The result has one line per change (`\n`;
  with several, a line putting or changing a price starts "손절은 …"); taking one away reads as the rule sheet does: "지우면
  SOXL이 손절선에 닿아도 팔지 않아요." (기록하지 않아요 for a mock sale, 전화하지 않아요, 알리지 않아요; a buy zone "구간에
  들어와도"). Voice turns get no card.
- `POST /api/invest/proposals/:id {decision: "apply" | "keep"}` → `{card}` (status `applied` / `kept`, `decidedAt`).
  Applying writes every change in one transaction: the line moves, the rest of the rule stays, and the rule is watched
  afresh (state armed, its earlier state unknown); a rule taken away is deleted. Refused, nothing written, the card in the body: 409 `proposal_stale`
  (a named rule's rev moved, it was deleted or its deadline passed, the symbol left the watch, the order mode changed, or
  a real sell stop's sellable quantity is not the one the card said), 410 `proposal_expired`, 409 `proposal_decided`
  (the other decision already made; the same one again answers 200). Another person's id → 404 `proposal_not_found`.
  The messages showing the card get its new state (`message` events), and the 30-second beat turns waiting cards past
  their time to `expired`. A turn stores each rule-change card as its proposal stands at the insert, and the A17 line
  only on the message's last invest card.

## Invest (B2e-0) — the macro series

No route and no model behind it; B2b-2's snapshot reads it. Code: `apps/server/src/invest/macro.ts`. FRED's fredgraph
CSV (no key; `FRED · A`) for DGS10 DGS2 DFEDTARU BAMLH0A0HYM2 UNRATE CPILFESL SAHMREALTIME IC4WSA NFCI VIXCLS SP500
DEXKOUS DEXJPUS and NASDAQ100 (B2c-1's market table), from the 1st of January three years back; Yahoo's chart JSON
(`Yahoo(지연 시세) · B+`) only for what FRED does not carry (`^KS11` on Korean market days, `^SOX` on US ones, B2c-1). The public-source rules hold for both hosts: nothing called unless `PICKLE_INVEST_SOURCES=on`, the
default User-Agent, one request at a time per host, a 403/429 or a 200 that is not the series rests that source until
the next US market day (its figures read 확인 불가 meanwhile; a junk body is never cached), one read serves everyone (6 hours
for FRED, Yahoo's daily rule for KOSPI). A day without a value (empty cell or ".") is a null point; the series' `asOf`
is its last day with a value.

## Invest (B2b-2) — the market stage board

Code: `apps/server/src/invest/stages.ts`, `stage-ledger.ts`; every comparison and stage rule is @pickle/quant's
`assessStages` (A2 → A5 → A6), never the server's or the model's.
- **Judged once a day** (migration v12 `invest_judgments`, one row per person and KST day): from 08:00 KST the beat
  judges each person who uses invest (settings or a watched symbol) without today's row. The macro series (B2e-0) are
  read once for all; indicators 6, 7 and 11 come from that person's own ledger, 9 and R6's foreign side from that
  person's own Toss read (B2e below). Off when the server takes no public sources. The screen, `invest_snapshot` and
  the reports read the stored row only.
- **Ledger ids** (team-lead 0437 1a; the person's or the model's figures, code never edits one; grade C never used):
  `stage.eps.samsung.<FY>` / `stage.eps.hynix.<FY>` — the fiscal year holding the middle of the next 12 months, its
  newest figure against the same id's figure nearest 3 months before it (within 15 days, the same unit), (a − b) ÷ |b|
  × 100; `stage.breadth200` (pct); `stage.m7.<AAPL|MSFT|GOOGL|AMZN|META|NVDA|TSLA>` (pct, the recent 3-month change
  of the 12M forward estimate; below 0 is down, team-lead 0511); `stage.capex.MSFT|GOOGL|META|AMZN.<FY>` — next KST
  year's against this year's, the same unit. Too old is unknown, the caution form ("{M월 D일} 값이라 오래됐어요"): 6, 8
  and 11 past 120 days, 7 past 5 US trading days. No figure: "값이 없어요" (quiet). 9 is not a ledger id: its words
  are B2e's.
- **`overview.stages: InvestStages`** — `{kind: "off", off}` ("지금은 지표를 받지 않아서 단계를 판정하지 않아요."), `{kind:
  "none", none}` ("첫 판정은 오늘 08:00에 나와요." / "첫 판정은 곧 나와요."), or `{kind: "judged", escape, recovery,
  gauges, next, judgedAt, judgedText, stale?}`. A head is `{stage, name?, floor?, text, pending?, pendingTone?}`: a
  settled stage has its name ("탈출 3단계", "방어 준비"); a floor has the least stage and no name ("탈출 최소 1단계"); the
  recovery may be "회복 단계 미확정" (outcomes include hold) or "회복 판정 보류" (stage null for both). `pending` counts,
  never numbers indicators: "지표 4개 값이 없어서 2단계 여부는 아직 몰라요." (`quiet`), "오늘 지표 2개를 받지 못해서 …"
  (`caution`), both together (`caution`). `next` says what the stage above the sure one needs (DD 1719 · 1720): a clause
  whose count is 0 is left out, severe signals as how many fewer ("회복 2단계까지: 회복 신호 2개 더, 심각 신호 1개 덜",
  hold "회복 2단계까지: 심각 신호 1개 덜"), `(R3 포함)` only while R3 is not on (unknown is not on), "R3 켜짐" when R3 is
  all that is missing, "탈출 2단계 이하" only while the escape may be 3 or more; a line with no clause left is not sent
  (the same lines in the detail's recover foot, the report and the deck). `judgedText` "12월 2일 08:00 판정 · 어제와 같아요 | 12월 1일 판정과 같아요 |
  탈출 최소 1단계 → 탈출 3단계"; 어제 only when the judged day is today (KST) and the row before it is the day before,
  otherwise the earlier row's day (DD 0710); a day of another KST year is named with its year ("2026년 12월 31일 08:00
  판정"), here, in `stale` and in the as-of days of `GET /api/invest/stages`; `stale` when today's 08:00 row is missing
  ("오늘 08:00 판정을 하지 못했어요. 12월 2일 판정이에요."), never before today's 08:00.
- `GET /api/invest/stages` → `InvestStagesDetail {stages, core11[11] {no, name, signal, value | null, basis, reason},
  groups[worse A1–A8, severe D1–D5, recover R1–R6] {rows {id, text, state, stateText, detail}, next}, method[],
  disclaimer: true}`; off or before the first row: empty core11 and groups. The high-yield spread's level is an
  unsigned %p here as in the report's §2: core11 row 3's value and the A1 · D1 · R2 figure lines (`3.60%p · 6개월
  최저보다 +0.60%p`; DD 1520). Rates stay in %, their changes in %p.
- **`invest_snapshot`** (same offer as B2b-1's tools): the stored heads, next lines, judgedText, stale, core11 and the
  conditions as the screen words them; its description: "단계는 판정본만 말해요. 지금 값은 값으로만 말해요.", and off is
  the server's setting: the model never asks the person to turn it on nor promises to tell them later (DD 0717).
  Off gives two sentences: `summary` is the board's line (the chip shows it), `data.again` the condition it judges
  again on ("지표를 다시 받으면 단계도 다시 판정해요."), for the model alone: the board stays one line (DD 1526-b).
  The description has the model relay both once; a later why is answered by the first, a when by the second's
  condition as it stands, and those two are the whole answer: nothing added saying the reason or the time is unknown
  or unconfirmed, no guessed time or date, no person, switch, setting or notification (DD 1636, after 17bb0a8's real
  turn added an unknown). It quotes neither sentence nor any answer's words.
- **Someone without the invest tools** (no invest settings, i.e. never opened the invest screen: `GET /api/invest`
  stores them): their turn's system prompt gets one server line right after the launcher's prompt (its cache prefix
  unchanged): `# 투자`, that Mosi shows the market stages on the invest screen, that this person has never opened it
  so they cannot be read here, not to raise it unasked, and when asked to say only where it is seen and promise
  nothing for later (DD 1636: 17bb0a8's real turn promised to check and tell). Where, never a value, so a server whose
  sources are off says it too. No tool names, no answer to copy. Never in a friend's thread or with someone else speaking (no invest tools there either); gone once
  they use invest (DD 1520 · 1551, team-lead 1550).
- **The model's ledger figures**: `invest_ledger_add` saves a figure only with the address of a page web_read gave this
  turn or in the thread's recent history (`ToolContext.pages`, filled by the server from web_read results) and only if
  the number is written on that page (sign aside; numbers inside addresses do not count). Else 400-style
  `ledger_unsourced` with the sentence, nothing saved. The person's own paths are unchanged.

## Invest (B2c-1) — the 08:00 report

Code: `apps/server/src/invest/report.ts` (A13 · A15, DD 1935 §2-4, DD 0059 §2, DD 0733, team-lead 0747).
- **Who and when**: right after a person's stage reading of the KST day is stored (the same beat), every day, weekends
  and holidays too, for each person the board judges. None when the server takes no public sources. No setting turns the
  report off; `notifications.investReport` (default on) turns off its banner and push only: the card still goes to the
  invest thread, unread.
- **One row first** (migration v13 `invest_reports`, one per person and KST day, state `making` → `sent`): the row is
  taken before the model is called and counts each call; two calls at most per person and day (a second only when the
  first gave no good summary). A row a restart left `making` is taken again after 10 minutes with the calls it has left
  (never a third). The model is one plain call (no tools, JSON back) and is not counted against `PICKLE_DAILY_TOKENS`.
- **Code writes every number and word** but the summary's three lines (the main risk factor, the main recovery factor,
  the market picture), §1's paragraph (2–5 sentences on the same three) and §7's cells. The stages, their change, the
  missing data and the confidence are code's alone (DD 0828 1). The server checks what the model wrote: a number must be
  one in the data it was given (sign aside; "200일선 · 50일선" are names), no probability with a number, no markdown
  marks, no summary or §1 sentence on the stages, missing data or trust, the summary three sentences of at most 60
  characters each (§1 120, §7 cells 40). A sentence that fails is left out; §7 is all or nothing (DD 0733 3); no good summary after the second call: `summaryNote` "오늘은
  요약을 쓰지 못했어요." (caution), the same line in §1, §7 `empty` "오늘은 시나리오를 쓰지 못했어요.".
- **The card** (`invest_daily`, A17 at the end): title "시장 위험 보고서", `atText` "12월 1일(화) 08:00", `holidayNote`
  "휴장일이라 11월 25일(수) 마감 기준이에요." when a US holiday lies between the last session and 08:00 (a weekend alone is
  not one); `highlights` at most two and `moreCount` — danger: high-yield 4.0%p or VIX 30 crossed upward; caution:
  high-yield 3.5%p or VIX 25 crossed upward, the S&P 500 or KOSPI under its 200-day line, a rule expired or its
  invalidation met since the last report; plain: a line crossed back down, back over the 200-day line. A crossing
  compares the series' last two values and is told once (not again while the series has no newer value). `stageLine`
  the board's heads, `stageSub` the change from the reading before (absent on the first) with `stageTone` danger when the
  escape stage moves up to 4, caution when it moves up otherwise or the recovery stage moves down (a stage move is never
  a top line, DD 0828 1a); `dataGap` "오늘 지표 N개를 받지 못했어요." (caution) for core indicators whose source did not
  answer today, left out when `pending` already says so (nowhere to get one is the tally's and §1's confidence's, DD
  0828 2); `tally`, `rows` (11지표 · 신호), `pending`, `events` (below), `deck {state: "none"}` until C, `foot` "기준 12월
  1일 08:00 · FRED · Yahoo(지연 시세)" (up to three sources named; four or more: two and "외 N곳").
- **Push**: title alone "시장 위험 보고서 · 탈출 3단계" / "… · 탈출 최소 2단계" (the card's name, DD 0828 6), body "", tag
  `invest:report:<day>`.
- **D-1**: for a person whose report goes out today the report carries the D-1 lines (`events {head "12월 2일 일정 4개",
  rows ≤ 3 {title, value}}`) under the same claim (via `daily`), so no `invest_event` card goes for them. Until the
  report is sent, and at most until 09:00 KST, the D-1 card waits; after that it goes on its own and the report carries
  no line of it.
- **`overview.reports`**: the last three sent, newest first: `{id, title "12월 1일(화) · 탈출 3 · 회복 최소 1" (탈출 최소 N
  · 회복 보류 · 회복 미확정; another KST year named when read), line (the summary's first line or the no-summary line),
  threadId, messageId}`.
- `GET /api/invest/reports/:id` → `InvestReport {id, title "12월 1일 보고서", atText, sections[8], disclaimer: true}`
  (another KST year named when read); someone else's or an unknown id: 404 `report_not_found` "볼 수 없는 보고서예요.".
  Sections in A15's order: `conclusion` (the heads, the change, the paragraph or `note`, 판정 신뢰도 높음 with none of
  the 11 unknown, 보통 with 1–3, 낮음 with 4 or more), `market` (S&P500 · 나스닥100 · 필라델피아 반도체 지수 · 코스피 · VIX
  · 10년물 · 2년물 · 하이일드 스프레드 · 엔/달러 · 원/달러: the last value (rates in %, the high-yield spread in %p like its
  change), `변화 … · as-of · source · grade`; missing
  "오늘 받지 못했어요"), `core11` (the board's rows), `worse` · `recovery` (the gauges, only the met conditions, the
  board's next lines), `etf` (per watched symbol with rules: the last daily close, buy zone, targets and stop with
  "보유 중일 때만 해당" unless Toss says it is held, 예상 수익률 · 예상 손실률 "(추정)", 손익비 "2.09" or "2.09 / 3.73" with
  a 2nd target, 진입 조건 — A10's price and market together, the market half not checked (team-lead 0747 8a): in the
  zone "확인 대기 · 가격 구간 도달", out of it "미충족 · 가격이 구간 위예요 | 아래예요" — and always 전략: "재검토 필요" with
  the reason when a rule expired or its invalidation was met, else "만료·무효화 없음"), `scenarios` (다음 거래일 · 5거래일 · 20거래일 × 상승 ·
  횡보 · 하락, words only), `events` (the next 8, KST first).
- 컨센서스: 받을 곳 없음 (A15 §8's column is left out until there is somewhere to get it; DD 0733 6).

## Invest (B2c-2) — what the watch reads besides the rules

Code: `apps/server/src/invest/intraday.ts` (pure), `hub.ts`, `cards.ts` (A14 매 실행 13단계, team-lead 0747 8 · 0856, DD
0847). No model call, no order, no new table.
- **Cadence**: B1's 5-minute checks, closer than A14's hourly run. The session's first check (the market day's first slot,
  never the close check) also reads Yahoo's day chart for each symbol with live rules, for everyone, Toss users too (a
  public delayed quote, no one's token; one read per symbol and check, shared): the open (its first 5-minute bar with an
  open) and the previous close.
- **Gap** (`kind: "gap"`, caution, no `ruleId`; A14 급격한 갭): the open against the previous close, both 3% or more and
  ATR14 × 1 or more (ATR14 as the stop basis reads it). The first check only, the open's market day today, once per symbol
  and day (`gap:<symbol>:<day>`); none where a split stopped the rules or a run card went at that check. Title "SOXL이 전일
  종가보다 5.0% 높게|낮게 시작했어요"; rows 시가 · 전일 종가 `$30.00 · 11월 30일` · 갭 `5.0% · ATR 1.5배` · 시장; banner "SOXL 갭
  상승|하락 출발" / "시가 $31.50 · 전일 종가 대비 5.0%".
- **A run above the buy zone** (`kind: "chase"`, caution, the buy zone's `ruleId`; A14 추격 금지, never a buy signal): a live
  buy_zone rule seen at the check right before, its price then at or under the zone's top, now above the top by ATR14 × 1
  and 3% of the top both. Once per entry: one per `ruleId:rev:hitSeq` (hitSeq moves only when the price comes back into
  the zone). Title "SOXL이 매수 검토 구간 위로 크게 벗어났어요", lines "$28.50까지 올라왔어요." "전략을 다시 봐야 해요."; rows 규칙
  · 벗어난 폭 `구간 위 $1.50 · 5.6% · ATR 1.5배` · 시장; banner "SOXL 매수 검토 구간 크게 벗어남" / "$28.50 · 매수 검토
  $25.00–27.00".
- **Split or merge** (`kind: "split"`, danger, no `ruleId`; A14 분할·병합): at the first check, the price stored at the check
  before (the last close check, of that market day) against today's previous close (today's source's, else Yahoo's): r =
  previous close ÷ that price within ±1% of k (merge, k shares into 1) or of 1/k (split, 1 into k), k ∈ {2, 3, 4, 5, 8,
  10, 15, 20, 25, 50}. That price unknown → nothing judged; a crash leaves the previous close where it was, so it is never
  read as a split. In the alert's transaction every armed or hit rule of the symbol turns `paused` (marked `@split`);
  price, direction, action and rev are not touched. They alert nothing until the person saves one (PATCH, unchanged too,
  or a proposal applied): that rule is watched again with its earlier state unknown (`noPrior`). Once per symbol and day
  (`split:<symbol>:<day>`). Title "SOXL 가격 규칙을 멈췄어요", lines "10주가 1주로 합쳐진 것으로 보여요." | "1주가 2주로 나뉜
  것으로 보여요." and "규칙을 열어 저장하면 다시 봐요."; rows 지난 거래일에 본 가격 `$32.57 · 11월 30일` · 전일 종가 `$325.70 · Yahoo(지연
  시세) · B+` · 멈춘 규칙 `3개`; notes "규칙 가격은 바꾸지 않았어요."; banner "SOXL 가격 규칙 멈춤" / "분할이나 병합으로 보여요 ·
  규칙 3개". The rule's `stateFoot`: "11월 27일 23:45에 분할이나 병합으로 보여서 멈췄어요. 가격을 확인하고 저장하면 다시 봐요."
- Gap, run and split cards go to the invest thread with A17, a banner and a push (tag `invest:gap:<symbol>`,
  `invest:chase:<ruleId>`, `invest:split:<symbol>`), and never call. Gap and run cards write `quote.<symbol>` (the open, the
  price) and `atr14.<symbol>` to the person's ledger (code, T2, the quote source's grade).
- **The buy zone alert** (`kind: "buy_zone_wait"`, caution; A16's middle frame, DD 0847 1): rows 규칙 · 진입 조건 "확인 대기 ·
  가격 구간 도달" · 다음 "손절 $22.00 · 1차 익절 $32.00" (the person's stop and 1st target on the symbol, not expired; either
  alone; no row with neither) · 시장. Every rule alert's stop line (the card's and the call's "손절선 …") reads a stop that
  is not expired (DD 1441 1).
- **The `시장` row** (DD 0847 0) on every rule alert, expiry, gap and run card: the person's stage heads as judged ("탈출
  3단계 · 회복 최소 1단계", 회복 판정 보류, 회복 단계 미확정) when the board has a reading that is not stale (before 08:00 KST the
  last one stands); else "확인 불가" (no reading yet, a day missed, sources off). Calls (rule alerts, mock stop records,
  zero-sellable skips) end on the same reading (DD 0924 1): "시장 단계는 탈출 3단계, 회복 최소 1단계예요." / "시장 단계는 탈출
  3단계이고, 회복은 판정 보류예요." / "시장 단계는 탈출 3단계이고, 회복 단계는 아직 몰라요.", else "시장 상태는 이번에는 확인하지
  못했어요.".
- `InvestAlertCard.ruleId` is absent on a symbol's own card (gap, split). Cards say "ATR 1.5배"; ATR14 is named in this
  contract and the ledger only.

## Invest (B2d-2a) — new events from public calendars

Code only: no route, no model, nobody's token (`apps/server/src/invest/discovery.ts`, on the hub's 30-second beat, one
run at a time; team-lead 0052 B2d, 1550, 1618; DD 1551). From 07:00 KST every day, weekends and holidays too, the KST
day's row in `invest_discovery` is taken first (as the 08:00 report's row), so a second beat or a restart reads nothing
again that day; a run cut short is not retaken (the next day finds the same events). Nothing is called unless
`PICKLE_INVEST_SOURCES=on`; B2e-0's public-source rules hold for the three hosts, one after another: a 403/429 or a 200
that is not the calendar rests that host until the next US market day and the run goes on without it (the day's result
keeps `{code, found: 0, text: "확인 불가"}` for it).
- **Federal Register** (`연방관보 · A`, DD 1711; one fixed query for everyone, team-lead 1550 3): `documents.json`, the
  Industry and Security Bureau and USTR, type RULE, significant, effective from the ET day. Kept: a significant document
  with a document number, an effective date and its federalregister.gov address whose title or abstract says
  semiconductor, export control, Section 232 or Section 301. USTR or a tariff word (Section 232/301, tariff, duty) reads
  `미국 관세 규정 시행`, else `미국 수출통제 규정 시행`; no time, kind `policy`, url the document, item `fr:<number>`.
- **FOMC** (`연준 · A`): fomccalendars.htm, each "YYYY FOMC Meetings" panel; the decision is a meeting's last day (across
  a month too, "Apr/May 30-1") at 14:00 ET, `FOMC 금리 결정`, kind `policy`, item `fomc:<first day>`. A notation vote or
  other words in the days is left out.
- **BLS** (`BLS · A`): bls.ics; CPI, the Employment Situation and PPI (items `cpi:2026-11` · `nfp:…` · `ppi:…` by the
  reference month, the release day `ppi:2026-12-11` when none is written; team-lead 1712), DTSTART a US Eastern wall
  time, UTC or a date. `미국 11월 CPI 발표` · `미국 11월 고용보고서 발표` · `미국 11월 PPI 발표` with the reference month only
  when the event writes "Month YYYY" (else `미국 CPI 발표`: never guessed, DD 1551); kind `macro`, url the release
  schedule page.
- **What goes in** (team-lead 1647): from the market's today, FOMC and BLS up to `EVENT_SPAN_DAYS` (60, the calendar's
  default window; the run rolls it on daily) ahead, the Federal Register up to `EVENT_MAX_DAYS` (732, the draft's two years). Each person with invest settings (B2b-1) gets each find as author
  `code`, `sourceTier` T1, the source's name and grade, `remind` on; day the market's date and time its wall clock as any
  US event (`when` shows the KST day first, "12월 10일 04:00(미 동부 14:00)", DD 1551). Left alone, no error: the same
  market, day and title already there (the person's own too, unchanged), a find that person deleted, a person at 200
  upcoming.
- **Deleting a find** (`DELETE /api/invest/events/:id` on a row that has `disc_source` and `disc_item`) marks
  `invest_event_dismissed (user_id, source, item, day, symbol '')` in the same transaction (team-lead 1618). A mark is
  matched by source, item and symbol (team-lead 1712: an item names one occurrence, so a find the source moves stays
  deleted; the day is kept as a record): that person's later runs skip it, others keep theirs. Deleting the person's or
  the model's own event marks nothing.
- **Nothing announces a find** (DD 1551 6): the calendar, the 08:00 report's events and D-1 show it as any code event (a
  find dated tomorrow goes at that 08:00 KST D-1).
- **Later**: BEA, the BoK's MPC, and moving or dropping what a source no longer lists (B2d-2b below); company earnings
  (B2d-2c below).
- v14, additive, no rollback: `invest_discovery (day PK, state running|done, started_at, finished_at, result JSON)`,
  `invest_event_dismissed (user_id → users cascade, source, item, day, symbol '', dismissed_at; PK the first five)`,
  `invest_events.disc_source` and `disc_item` (null on rows before v14 and on the person's and the model's).

## Invest (B2d-2b) — BEA, the Bank of Korea's MPC, moves and drops

The same run, gate and rules as B2d-2a (team-lead 1618 · 1700 · 1701; DD 1551); two more hosts, each read at most twice a
day, and a page that fails stops its source (no second request to that host that day).
- **BEA** (`BEA · A`): the calendar subscription the release schedule page links (`/news/schedule/ics/online-calendar-
  subscription.ics`, one GET a day; the schedule page itself is not read). The national GDP release (`GDP (… Estimate)`,
  or `Gross Domestic Product, Nth Quarter …`; by state, by county, Puerto Rico left out) reads `미국 3분기 GDP 확정치 발표`
  with the quarter as written (else `미국 GDP 발표`) and the estimate in Korean (DD 1753: Advance 속보치, Second 잠정치,
  Third 확정치; Initial, Updated or none: no word, `미국 3분기 GDP 발표`); Personal Income and Outlays reads
  `미국 10월 PCE 발표` with the month as written, none for a release of two months or none named. Times are UTC there
  (ET wall clock stored); a time with no zone is not read. Kind `macro`, url the schedule page, window
  `EVENT_SPAN_DAYS`. Items (team-lead 1712, DD 1716): `gdp:2026Q3:third` (quarter, year and the estimate as written:
  advance, second, third, initial, updated; without all three the release day `gdp:2027-03-26`), `pce:2026-10` by the
  reference month and its year (the release day for two months or none). BLS reads two months the same way since 2b:
  no month in the title, the day in the item.
- **The Bank of Korea** (`한국은행 · A`): the MPC year list (`listYear.do?mtgSe=A&menuNo=200755&pYear=<year>`, the address
  the page's own year picker builds): the KST year's, and the next year's only on days the window reaches into it. Rows
  `01월 15일(목)` under the page's `2026년`; a row whose weekday does not match its date is left out, a page of another
  year or no list is not the calendar (rests the host), a list with no rows yet is empty. `금통위 기준금리 결정`, market KR,
  no time (none on the page: `when` "… · 시각 미정"), kind `policy`, item `mpc:<day>`, url that year's list, window
  `EVENT_SPAN_DAYS`. When the next year's page fails, what this year's gave still goes in.
- **Moves and drops** (team-lead 1700 1), only for a source read whole and ok that day (every page ok; a Federal Register
  answer whose `count` is above its page is cut: its finds go in, its result says `partial: true`, nothing moves). For
  each person, each find from that source (`disc_source` that source, which only the run's own rows have; from the
  market's today to the end of the source's window) that the source no longer lists on its day moves (same row, day
  and time, `updated_at`) to the day it now lists for the same item, else is deleted, with no deletion mark (nobody
  deleted it). An item is one occurrence, so only a Federal Register rule or a release named by its month or quarter
  can move; a meeting the Fed or the Bank of Korea moves, or a release named by its day, is dropped and added. Nothing
  moves onto an item that person deleted (the stale find goes). A move onto a day where that title already is (the
  person's own) deletes the stale find. The person's and the model's rows (no `disc_source`), past days and days past
  the window are never touched. A kind (the item before `:`: gdp, pce, cpi, nfp, ppi, fomc, mpc, fr) the source gave
  none of in the window while that person has its rows there is held as it is, not moved or dropped (DD 1753: a page
  whose shape changed, the whole source empty included); the source's result says `stale: ["gdp"]` and a log line
  names the kinds. Nothing announces it; the day's result keeps `moved` and `removed`, and the log line counts them.

## Invest (B2d-2c) — watched stocks' next earnings

The last step of the same 07:00 KST run (team-lead 1755 · 1756 · 1813 · 1823; DD 1754 · 1756 · 1757 · 1825-b). A web
search and a model proposal per search, every figure checked by code; nothing one person's Toss token brought in reaches
another person.
- **The Toss type** (v15): a watched row's `security_type` and `toss_name` (Toss's Korean name) come from
  `GET /api/v1/stocks?symbols=` asked with that person's own token: once after adding (the add does not wait for it,
  and a failing ask is only logged), and at the next quote read for a row
  with none, at most once a KST day per row (`type_asked_day`). A symbol not in the answer is `''` (not asked again); a
  failed ask leaves it unknown (asked on another day); a 403 pauses the person's Toss reads and the asks with them. The
  screen's name (`name`) stays. A row takes part when its type is STOCK, FOREIGN_STOCK, DEPOSITARY_RECEIPT or unknown
  (null, `''`); an ETF, ETN or any other form does not. Each person by their own row only.
- **Searches**: one per (symbol, market, subject). The subject: US the symbol; KR the person's own `toss_name`, else
  their row's `name` with a corporate tail cut once at its end (`Co., Ltd.`, `Ltd.`, `Limited`, `Inc.`, `Corp.`,
  `Corporation`, `Company`, `PLC`, case aside, with the comma and spaces before it; `Holdings`, `Group` stay; nothing
  left: not cut), else (the name is the code) the code. People with the same subject share that search; its name check,
  title and rows are theirs only. Without `deps.skills.searchWeb` (`@pickle/skills` searchWeb: the key stays in skills),
  or when the first search answers `not_configured` (no provider key), nothing more runs: `company: { skipped:
  "no_search" }`; without the model `{ skipped: "no_model" }`.
- **At most 20 searches a run**, the longest unsearched first (`invest_earn_searched (symbol, market, subject,
  searched_at)`: nothing else; a row for a symbol nobody watches is not read), the time taken before the search: one
  search each (`web`, 8 results; US `<symbol> earnings date` in English; KR by the subject's letters: a Latin name
  `<subject> earnings date` in English, Hangul or the code `<subject> 실적 발표일` in Korean), one model
  call and one more only when it fails (no JSON or an error); nothing runs again that day.
- **The model's input**: the symbol, the subject (US: a holder's row name, tail cut) and market, today and the window's
  end, the results (title, url, published, excerpt) as untrusted data. It only proposes `{url, day, quote}` (at most
  five).
- **Code's checks**, each counted by reason when it fails: the url is one of this search's results (`url`); the quote
  (6–300 characters, spaces folded) is in that result's title or excerpt as written (`quote`); a date code reads in the
  quote (English, Korean or numeric; a date with no year only when the result's published day is in the last 90 days,
  then the next such day; no published day, none) is the day (`date`); the title or the quote names the
  company (the symbol as a whole word, case kept; the subject or the row names, case aside: `company`); the day is from
  the market's today to `EVENT_SPAN_DAYS` (`window`); a T2 quote has none of `estimated`, `projected`, `tentative`,
  `unconfirmed`, `예상` (any form), `추정`, `미확정`, `확정 공시는 없` (`estimated`; `잠정` and `expected` are not among
  them), and says the date as the company's schedule, with `will report|announce|release|host|hold|present|publish`,
  `scheduled to|for`, `set to report|announce|release`, `예정`, `발표한다|발표할`, `개최한다|개최할` or `공개한다|공개할`
  (`unstated`: a calendar site writes its guess with no word at all; DD 1914-b). T1 is held to neither. A malformed
  proposal is `bad`. The time is only the one time the quote writes in the market's zone (US: ET, KR: KST or 오전/오후),
  else none (`시각 미정`).
- **Evidence** (DD 1754): T1 · A for the company's own words, named by the subject: `<subject> IR` on a host starting
  `investor.`, `investors.` or `ir.` with two names or more after it (`investors.com`, `investor.gov` are not),
  `<subject> 보도자료` on businesswire.com, prnewswire.com, globenewswire.com, `<subject> 공시` on dart.fss.or.kr and
  kind.krx.co.kr; anything else T2 · B named by its host without `www.` (`reuters.com · B`). The best grade's passed
  proposals must agree on one day, else nothing that day (`conflict`); the first with a time leads.
- **Rows**: title `<subject> 실적 발표` (`NVDA 실적 발표`, `삼성전자 실적 발표`; the heading puts nothing in front),
  kind `earnings`, the symbol, author `code`, `disc_source` `company`, item `earn:<YYYY-MM>` (the release month). One
  upcoming earnings row per symbol per person (from the market's today through the window). A different day moves that
  row (day, time, item, url, source, grade, `updated_at`) when the new grade is the same or higher, else it stays; a
  move onto a day that already holds the person's row of that title deletes the stale find. The same day: a higher grade
  replaces url, source, grade and time (none when it writes none: `시각 미정`); the same grade with a time the row lacks
  sets the time
  with its own url and source; a lower grade changes nothing. An item that person deleted (source `company` · item ·
  symbol) is neither added nor moved to. Nothing is dropped: a search is not a calendar.
- **The result** (`company` in the day's `invest_discovery.result`): `searches`, `waiting` (over the cap), `added`,
  `moved`, `updated`, `kept`, `skipped_rows`, `removed`, `dismissed`, and per search (`NVDA`, `005930 삼성전자`) `hits`,
  `candidates`, `passed`, `dropped` by reason, `search: "failed"`, `model: "failed"`, `conflict`; `{ error: true }` when
  the step threw. Counts only, in the log too (the model's tokens logged, not counted against the daily quota).
- v15, additive, no rollback: `invest_watchlist.security_type`, `toss_name`, `type_asked_day`; `invest_earn_searched`.

## Invest (B2e) — KOSPI foreign flows

Indicator 9 and R6's foreign side (team-lead 1854, DD 1857-b). Code: `apps/server/src/invest/hub.ts` (`flowsFor`),
`toss.ts` (`investorTrading`), `stages.ts`.
- **The read**: at each person's 08:00 judgment (the beat that writes their day's row), once, with that person's own
  Toss token: `GET /api/v1/market-indicators/KOSPI/investor-trading?interval=1d&count=30`. KOSPI only; KOSDAQ is never
  asked. The Toss pause and record hold as for any Toss read: paused, no call; a 403 pauses an hour, a 429 five
  minutes. No order path.
- **Settled days only**: records of KST days before the judgment's day. Today's provisional record is neither kept nor
  used (it takes one of the 30). A group's net is buy − sell in won (whole numbers; the openapi's decimal strings). A
  record without a day, or without foreigners' two amounts, is left out.
- **Rows** (v16 `invest_flows (user_id, market, day, individual_net, foreign_net, institution_net, fetched_at)`, one per
  person, market and day; a later read rewrites a kept day): a person's rows feed only that person's judgment. Nothing
  read with one person's token reaches another person's judgment or deck. The judgment reads the person's latest 30
  kept days, and only after that day's read brought a settled day. A read that failed, was paused or brought none gives
  nothing that day; kept rows are not used then.
- **quant's input** `foreignKospi`: `foreign_net` ÷ 1e8 (억원). R6 is judged on these numbers. 9 stays without a judgment
  (`대규모 순매도 지속 여부 판단 없음`; team-lead 1854 4: no threshold made up).
- **The screen** (`GET /api/invest/stages`): 9's value is the 20-day net sum (quant's sum20) while its signal stays
  unknown. `20일 −1.2조원` from 1조 (1만 억) up, in 조 with one decimal; otherwise `20일 +3,400억원`, in 억 with commas.
  Signed with U+2212, zero unsigned; fewer than 20 days: null (확인 불가). Basis `11월 30일 · 토스증권 · A`, the last
  settled day. No Toss login: `토스증권을 연결하면 받아요` (counted with `값이 없어서` in a head's pending, the quiet
  form). A login but nothing today: `오늘 받지 못했어요` (caution), whatever the read's failure (a login whose session
  cannot be had at read time too: never the `연결하면` words; DD 2027 1). Toss off on the server (no
  `PICKLE_TOSS_BASE`): `받을 곳이 아직 없어요`.
- **R6's line** (DD 2012): the rule's order, foreigners first, KOSPI named on every day: `외국인 6거래일 연속 순매수 ·
  코스피 2,512.00 · 200일선 2,480.00 · 11월 26일 · 토스증권 · A, Yahoo(지연 시세) · B+` (`… 연속 순매도`; a last day of
  exactly 0: no run). The run is quant's R6 figure (`foreignBuyRun`, `foreignSellRun`), the streak its state is decided
  by. KOSPI here and the foreign side not: the reason after the sources, on a met day too: `… · Yahoo(지연 시세) · B+ ·
  외국인 수급은 토스증권을 연결하면 받아요` / `… 오늘 받지 못했어요` / `… 받을 곳이 아직 없어요`. The foreign side here
  and KOSPI not (DD 2027 3): `외국인 4거래일 연속 순매수 · 11월 30일 · 토스증권 · A · 코스피는 오늘 받지 못했어요`, met
  days too (KOSPI is Yahoo's; no sources, no reading at all). Both missing: the basis words alone. Only R6's line
  carries a tail.
- v16, additive, no rollback: `invest_flows`.

## Web Push (B1c) — the lock-screen line

- Nothing is sent unless the server env has `PICKLE_PUSH_SUBJECT` (`mailto:` or `https:`, the VAPID contact; team-lead
  2210: the person decides it, no personal address as a default). Until then `GET /api/push/key` and
  `POST /api/push/subscriptions` answer 503 `{error: "push_off"}` (team-lead 2331b, DD 2330: the app takes it as off,
  asks for no permission and shows no reason); `DELETE` works as usual, and rows from before are kept but not sent to.
  Once it is set, the app's next start subscribes. QA never sets it.
- `GET /api/push/key` → `{publicKey}`: the VAPID public key (base64url, 65-byte P-256 point) for
  `PushManager.subscribe({userVisibleOnly: true, applicationServerKey})`. The key pair is made once in the data dir
  (`vapid.json`, 0600); its private half never leaves that file.
- `POST /api/push/subscriptions` with `PushSubscription.toJSON()` → `{ok: true}`. The endpoint must be https on a push
  service browsers use (FCM, Mozilla, Apple, WNS), else 400 `invalid_subscription` (also for keys that are not a P-256
  point and a 16-byte auth secret). The same endpoint again moves it (to this session, or another person signing in on
  that device). Ten per person: the oldest go. Post it again on each app start while permission is granted.
- The session that posted it owns it: `POST /api/auth/logout` (and a password reset) deletes the subscription with the
  session, so a signed-out device gets no line. `DELETE /api/push/subscriptions {endpoint}` → `{ok: true, removed}` (only
  the person's own).
- What is sent (`WebPushPayload`, RFC 8291 aes128gcm + RFC 8292 VAPID, TTL 4 h, urgency high): `{v: 1, title, body: "",
  tag, threadId?, messageId?}`. The title is the invest banner's title (DD 2042-b §4: symbol and event, e.g. "SOXL 손절 관찰가
  도달", "SOXL 모의 손절 기록", "SOXL 감시 기간 끝"; blind is "시세 확인 멈춤" with no row); no amount, quantity or average price.
  `tag` is `invest:<ruleId>` (a later line of the same rule replaces it), `invest:event:<day>`, `invest:report:<day>` or
  `invest:blind`; a tap opens the row.
- A push service's 404/410 drops the subscription; anything else (429, 5xx, no answer) keeps it with its status, no retry.
  Pushes go out after the card is stored, in the background: a slow push service never holds the watch. Endpoints are
  never logged.

## Other
- `PATCH /api/settings` → the whole settings with `rev` (deep merge; unknown keys, `rev` included, 400).
  `PATCH /api/agent` → AgentProfile with `rev`: only the fields sent change, merged in the launcher's per-user queue —
  `skills: {id: bool}` toggles (at least one left on, else 400 `no_skills`; an empty list stands for every skill and is
  spread first), `avatar: {hue?, shape?, eyes?}` (other avatar keys 400), `name`, `persona`; an older app's whole
  `enabledSkills` list still replaces the list (empty → 400 `no_skills`; together with `skills` → 400).
  `POST /api/agent/restart`.
- Settings and agent revisions (`SettingsView.rev`, `AgentProfile.rev`): made by the server, raised only when a value
  changes, to max(previous + 1, server clock in ms), so never lowered — not after a restart, a restore from a backup or
  a config made anew (`users.settings_rev`, 0 before the first change; `rev` in the agent's config.json). A change goes
  to every device of the person as `settings` / `agent` with the whole value — the sending device too, beside its answer
  — and never to anyone else; a PATCH that changes nothing keeps the rev and sends nothing. Devices keep a value only
  when its rev is larger than the one they hold (answers and events come on different connections).
- Daily briefing (`notifications.briefing`, `notifications.briefingTime` in KST, default "07:30"): a system turn in the
  main thread (event "오늘의 브리핑"), once a day within 2 h of that time, for people seen in the last 7 days. Never on
  the account's sign-up day (KST): the welcome message covers that day, and the first briefing is the next morning.
- `POST /api/tickets/use {kind:"basic"|"premium"}` → `{quota, tickets}`; 400 `nothing_to_reset`/`no_tickets`/`invalid_ticket`.
- JSON body > 64 KB → 413 `payload_too_large`; malformed → 400 `invalid_json`; 404 `not_found`; 405; 500 `internal`.
- `GET /api/blobs/:id` → artifact content (markdown, or JSON for dashboards). An `html` artifact comes as a download
  (`text/html`, `Content-Disposition: attachment`) with `Content-Security-Policy: sandbox; default-src 'none';
  style-src 'unsafe-inline'; img-src data:; font-src data: …`: opened anyway it runs nothing and loads nothing.

## HTML artifacts (`kind: "html"`)
- Made by `sys_create_artifact` with kind `"html"` when an answer is best seen: a screen or mock-up (a community
  thread, an app screen), schedule cards, a comparison table, a poster. Not for answers a sentence gives, never in a
  voice call or meeting (`ToolContext.mode` "voice": refused), one per turn (a second call is refused). The tool's
  description carries only design-director's summary (genui/SUMMARY-guarded.txt v3.10 verbatim, `HTML_ARTIFACT_SUMMARY`,
  ~350 tokens: when to draw, one card per answer, a 1–2 line reply, don't ask back but build with sensible defaults
  stated in one line of the reply, look real prices, products and places up first, the guide call, the most-broken
  rules, the theme variable names, https-only links; the "guarded" variant leaves out the rules the server and the
  frame already enforce: sizes under 13px, `--text-3` text, accent text on `--surface`), and its kind list says
  `"table"` is plain data to keep while a comparison to look at (products, prices, specs) is `"html"` (on v3.7 one of
  the two comparison samples went to a table in each of two rounds; on v3.8 with this line neither did). The full
  guide (genui/GUIDE.txt v3.14 verbatim, `HTML_ARTIFACT_GUIDE`, ~7 KB, ~1.8k tokens: the wrapper is the card and sets
  `--bg --surface --text --text-2 --text-3 --line --accent --accent-fill --on-accent --danger --success --radius
  --radius-sm --space --space-sm --font` for light and dark; content 296–366 px; no network) comes back from a call
  with kind `"html"` and `content: ""` (so `content` is not a required argument: the loop counts "" as missing; a
  stand-in word without markup or spaces, ≤ 16 chars, such as "." or "placeholder", counts as such a call too), let
  through whole by `ToolDef.maxResultBytes` (16 KB; other tools keep the loop's 6 KB). Plain turns don't pay for it:
  ~1.5k fewer prompt tokens per model call than with the guide in the description (measured 2026-11-15; in the 11
  samples every thread's first card asked for the guide first, and a follow-up edit used the one history keeps). A
  fragment sent without the guide is taken the same. The model gets the id and a short line back, never the HTML;
  its reply text is 1–2 lines beside the card.
  When the stored card's visible text (no style, tags or attributes; spacing aside) holds both 저장 전 and 시간 미정, an
  event drawn but not saved, that result also carries `data.note`, design-director's wording (이 카드에 저장 전으로 그린
  일정은 일정에 저장되지 않았어요. 답에서는 이 일정을 '카드에만 그려 뒀어요'라고 쓰고, '넣다'는 저장된 일정에만 써요.
  끝에는 '몇 시인지 알려 주시면 일정에 넣을게요.'라고 써요.); never on the agent's own `saveAgentCard` card. The
  reply comes after the card's result, so it reaches the turns that never called `sys_schedule_create` and got no
  `no_time_source` note: those said '토요일 결혼식을 넣었어요' (GUIDE v3.14) and '넣어 다시 보여드렸어요' (v3.15) of the
  unsaved wedding, 2026-11-16, while guide sentences moved the second-turn cards from 18/18 to 7/9. 저장 전 alone is
  common on other cards ('저장 전 확인'). Like the rest of the card tool's results, it is no time source.
- The guide's step is free in a plain turn (loop.ts; deep-search turns keep their own card step): a step whose calls
  all came back with `data.guide` is not counted against the step limit, once per turn, and a turn that got the guide
  but reaches the limit before that tool returned ok without one gets one last step offering only that tool
  (`tool_choice` required, `GUIDE_CARD_NOTE`: no more searching, draw it from what was found, '확인 안 됨' for what
  wasn't), then the answer without tools as before. '노트북 5종을 사양 7개로 비교해줘' once searched through all 8
  steps after the guide and ended in a markdown table (2026-11-15); in 3 later runs the card came within the limit,
  so the last step is checked in tests only.
- The fragment streams inside the tool call's arguments: chat turns run with max_tokens 16384 (`CHAT_MAX_TOKENS`,
  llm-policy.ts; 2048 cut it near 6–8 KB), and while arguments stream for over a second the agent sends a `status`
  event about once a second ("'주간 일정' 화면 만드는 중", `tool_progress` from the LLM client), which also keeps the
  60 s turn idle watchdog fed.
- `Artifact.content` is an HTML fragment: `<style>` blocks + body markup, at most `MAX_ARTIFACT_HTML_BYTES` (150 KB,
  UTF-8) as sent; over that the call is refused with a short reason. A card the agent's own code renders (deep search
  '전부': one row per place) is stored through `sys_create_artifact`'s `saveAgentCard({ title, html }, ctx)` (a
  ToolDef method outside the schema: the model gets name, description and parameters only; same refusals and result as
  `run`), which calls `ToolStore.createArtifact(a, { agentCard: true })`; such a card may hold
  `MAX_ARTIFACT_HTML_CARD_BYTES` (300 KB, UTF-8) after cleaning (512 KB as handed over); no tool argument or schema
  reaches that option (`sys_create_artifact` never passes it), and other kinds keep 256 KB. The app's own render limit
  (HtmlArtifactCard) has to be this constant too, or a card over 150 KB shows its "too big" note. The server cleans it
  before storing
  (`apps/server/src/artifactHtml.ts`, a re-serialising tokenizer): html/head/body/title/meta/link/base tags go
  (content kept, `<style>` kept); script, iframe, frame(set), object, embed, applet, noscript, template, math, xmp,
  plaintext go with their content; every `on*` attribute, `srcdoc`, `srcset`, `ping`, form `action`/`formaction`,
  `http-equiv`; resource URLs (`src`, `poster`, `background`, SVG `image`/`use` href …) unless `data:image/…`; CSS
  `url()`/`image-set()`/`src()` the same way (local `url(#id)` stays), `@import`, `expression()`, `behavior`,
  `-moz-binding`; `<form>` tags (fields kept, as decoration); link hrefs other than `https://` (http, mailto, tel,
  `#…`, relative, javascript: also behind entities); SVG `<set>/<animate>` of an href. Nothing in a `<style>` can close
  it; a `<style>` inside `<svg>` is judged with entities decoded (as the browser reads it). What is left must have
  markup, or the call is refused. Then two card rules models keep breaking are fixed in the cleaned CSS (`tuneCss`,
  outside `<svg>`, whose sizes the viewBox scales): a `font-size` (or `font` shorthand size) under 13px in px, rem or
  pt becomes 13px; a relative size or a function (em, %, vw …, calc, clamp, min, max, var, env) becomes
  `max(13px,<size>)` (a `.8em` th in a 14px table was 11.2px in Chrome and WebKit), xx-small and x-small become 13px,
  smaller `max(13px,.8333em)` (0 stays); and `color: var(--text-3)` becomes `var(--text-2)` (background, border, fill,
  stroke keep it). The model is told the counts (`tuned`: sizes surely under 13px, .8em and 80% included, functions
  not) next to what was removed.
- A real event or reminder never gets a made-up time: `sys_schedule_create`'s description and the guide carry the same
  sentence (no time given → don't create it and don't pick one, 정오 included; draw it as 시간 미정, end the reply with
  몇 시인지 알려 주시면 일정에 넣을게요), the one question allowed beside "don't ask back". The tool also checks it:
  its required `time_quote` (the words that gave the time, copied from the user or a tool result; "" is a missing
  argument in the loop) has to name a time (a clock time, a delay or offset, or a part of the day: 7시, 7:30, 세 시 반,
  정오, 30분 뒤, 30분 전, 내일 아침; '토요일' alone is none) and be found in `ToolContext.heard()`: copied from one
  source (spacing aside), or each of its times heard somewhere on a 12-hour dial (오후 3시, 15:00 and 3시 are one time,
  but never 오후 3시 for 새벽 3시; '오전 10:00 · 30분 전' from the calendar's 오전 10:00 and the user's 30분 전). The
  server sets `heard`: the thread's last 6 user messages, this turn's text and messages steered in since, the last 12
  tool results in history and this turn's results (summary and every string in data, ≤ 256 KB; never `sys_time`, the
  schedule tool's own echo or `sys_create_artifact`'s results, never the agent's words: the design guide's "(정오
  included)" once let a quote '토요일 (시간 미정 → 오후 12:00 임시)' through, and a made-up noon was saved, 2026-11-15).
  A clock time in the quote, or one moved by the quote's offset (3시 회의 30분 전 → 14:30; '10시 30분 전' is 10:30
  or 9:30), has to be the rule's, on the half of the day the
  words fixed where it was heard (오전, 새벽, 아침 before noon; 오후, 저녁 after; an hour 13–23 after; a '3시' quoted
  from '새벽 3시' is still 새벽; a vague '내일 아침' keeps the rule before noon). Otherwise nothing is stored:
  `ok: false`, summary 시간 미정으로 뒀어요, error `no_time_source` with design-director's note (시간을 들은 곳이
  없어서 일정을 만들지 않았어요. 카드에는 시간 미정으로 그리고 이름 아래에 저장 전이라고 적되, 일정 개수에는 세지
  않아요. 답에는 카드에만 그렸다고 쓰고 넣었다고 하지 않아요. 끝에는 '몇 시인지 알려 주시면 일정에 넣을게요.'라고
  써요. The card is mostly drawn right after this note, so it says what the guide says: on GUIDE v3.11 a card counted
  the unsaved wedding in its '4개' and replies said 넣어 다시 그려봤어요, 2026-11-15; on v3.12 with this note all 6
  second-turn cards wrote 저장 전 and none counted it, 2026-11-16), or `time_rule_mismatch`. Only that yes/no comes
  out: nothing of the conversation is logged or echoed. Without `heard` (meeting stand-ins, tests) only the "names a
  time" check runs. Real model (2026-11-15, 3 runs each of '이번 주 일정 카드로' then '토요일 결혼식 추가해서 다시
  보여줘'): the model still tried the wedding at
  12:00 or 00:00 in 2 of 3 second turns on v3.7 and on v3.8; the check stopped all four, and every second turn drew
  시간 미정 and ended with the sentence. A time only a tool result held ('하루 미뤄서 다시 잡아줘' on 오전 10:00 from
  `sys_schedule_list`) went in as 11월 17일 오전 10:00.
- `sys_schedule_list`'s description (design-director's wording) says it lists the schedules and reminders saved in
  this app, the user's own 일정, no calendar connection needed, to be read first for 이번 주 일정, moving or changing a
  meeting, or anything about the user's plans. With the old "List the user's scheduled tasks" the model looked it up
  first in 1 of 4 '하루 미뤄서 다시 잡아줘' turns and 7 of 9 '이번 주 일정 카드로' turns (the others said no calendar
  is connected); with this one in 3 of 3 and 3 of 3 (real model, 2026-11-15). For '팀 주간 회의 30분 전에 알림 하나
  걸어줘' neither wording helped (0 of 3: the model asked for the meeting's time); `sys_schedule_create`'s description
  ends with design-director's line instead ("For a reminder relative to a saved event ('회의 30분 전'), call
  sys_schedule_list first and take its time from there; don't ask the user for it."), and with it 3 of 3 runs read
  the list and set the reminder at 11월 16일 오전 9:30 (the list's 오전 10:00 and the user's 30분 전 in `time_quote`).
  The same line ends `sys_schedule_list`'s description too (`REMINDER_FROM_LIST`): with it on `sys_schedule_create`
  only, 1 of 3 runs on snap-html-13 asked for the meeting's time without calling any tool; with it on both, 6 of 6
  read the list first and set 11월 23일 오전 9:30 (2026-11-16).
  Each one-off's `human` in that list is written at list time with its weekday and, in the KST Mon–Sun week that holds
  today or the next one, 이번 주 / 다음 주 ('11월 23일 (월) 오전 10:00 · 다음 주'; other weeks the date alone;
  `listHuman`); repeating rules keep their words, and the stored `human` that `/api/schedules` returns is unchanged.
  On a Monday (2026-11-16, next Monday's meeting in the list) the cards' head said '이번 주 3건' over 2 rows in 3 of 6
  second turns and 4 of 6 first ones, the reply itself saying 23일 was next week (design-director's count). A
  reminder quoting these words ('11월 16일 (월) 오전 10:00 · 다음 주 · 30분 전') passes the time check as before.
- `ArtifactCard` is unchanged: `kind: "html"`, `preview` = the fragment's text without a heading that repeats the title
  and without tabs or navigation (`<nav>`, role tablist, a list or div whose class says tabs/nav/menu/filters/chips, a
  list of 4+ items of ≤ 10 chars; kept when little else is left), ≤ 140 chars (`htmlPreview` in @pickle/protocol; `htmlText` for the archive list). `GET /api/artifacts` and
  `/api/artifacts/:id` return the cleaned fragment as stored, same auth as other artifacts.
- The app renders it isolated (iframe `srcdoc`, `sandbox` without `allow-same-origin`, the frame's own CSP with no
  network): that is the primary defence; the server's cleaning is the second. The frame inherits the app's CSP, whose
  `script-src 'self' 'sha256-…'` allows exactly one inline script, `HTML_FRAME_SCRIPT` (@pickle/protocol: height and
  link taps), hashed at load in http.ts.
- History replay keeps such a call's title and kind; its HTML only for the last turn and ≤ 12 KB
  (`HTML_REPLAY_MAX_BYTES`), else `(HTML nKB, 보관함에 있어요 — 여기선 생략)` (`compactHtmlCalls`, history.ts). A guide
  call's result stays whole for the last turn too, so a follow-up card ("결혼식 추가해서 다시 보여줘") is drawn with the
  guide at hand (live, the model did not ask for it again there); older turns get a short stub (`HTML_GUIDE_REPLAY`).
