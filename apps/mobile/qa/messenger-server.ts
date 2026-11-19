/**
 * QA server for the messenger card (kakao-chat). The REAL app server (buildDeps + createApp, its own data dir) with two
 * swaps, so nothing touches a real account or a real LLM:
 *   - the MessengerHub gets a fake KakaoTalk SDK serving the SYNTHETIC fixture room
 *     (packages/messengers/test/fixtures/kakao-room.ts) — bogus credentials, no network;
 *   - runTurn is a deterministic stand-in for the LLM: any message runs the real `msg_read` tool on that room
 *     (focus = the words after "focus:") and answers one fixed line.
 *   QA_LEGACY=1 makes the stand-in emit the card the OLD adapter produced for this room (raw ids as authors, feed JSON
 *   as text) — the "before" picture of the bug, rendered by whatever card component the build has.
 *   A message asking for "카드로" (the friend step: a friend's @mention in a friend thread) gets an html card instead: a
 *   synthetic artifact the asking user's 모시 makes through the real ToolStore, so the other member loads someone
 *   else's artifact.
 *
 * Extra route: POST /qa/connect-kakao {userId} (Bearer token) seals the fake login for the enclave exactly like the
 * phone does and calls the real POST /api/connections/kakaotalk.
 *
 *   PICKLE_DATA_DIR=<scratch> PORT=8806 bun run apps/mobile/qa/messenger-server.ts
 * Never point this at the preview server's data dir; never use 8787/5173.
 */
import type { AgentEvent, Card, MessengerCard, ToolActivity } from "@pickle/protocol";
import type { LlmMessage, RunTurn, ToolDef } from "@pickle/agent";
import { MessengerHub } from "../../../packages/messengers/src/index.ts";
import { maskHint, sealForEnclave } from "../../../packages/vault/src/client.ts";
import { buildDeps } from "../../server/src/main.ts";
import { createApp } from "../../server/src/app.ts";
import { exactId } from "../../../packages/messengers/src/adapters/kakao-normalize.ts";
import { fakeKakao } from "../../../packages/messengers/test/helpers.ts";
import { LEFT_MEMBERS, ME_ID, ROOM_CHAT, ROOM_CHAT_ID, ROOM_LOGS, ROOM_MEMBERS } from "../../../packages/messengers/test/fixtures/kakao-room.ts";

const PORT = Number(process.env.PORT ?? 8806);
if (PORT === 8787) throw new Error("8787 is the preview server with real data — pick another port");
if (!process.env.PICKLE_DATA_DIR) throw new Error("set PICKLE_DATA_DIR to a scratch directory");
const LEGACY = process.env.QA_LEGACY === "1";
const BOGUS = { email: "qa-fixture@example.invalid", password: "not-a-real-password" };

// no LLM key → buildDeps leaves runTurn null; we install the stand-in below
const env = { ...process.env, OPENGATEWAY_API_KEY: "", OPENGATEWAY_BASE_URL: "", PICKLE_TTS_URL: "off", MEET_BOT_URL: "off", STT_URL: "off", TWILIO_ACCOUNT_SID: "" };
const built = await buildDeps(env);
const deps = built.deps;

const kakao = fakeKakao({ userId: ME_ID, rooms: [{ chat: ROOM_CHAT, logs: ROOM_LOGS, members: ROOM_MEMBERS, left: LEFT_MEMBERS }] });
// the fixture login must match the fake's bogus pair
(kakao.sdk as { attemptLogin: unknown }).attemptLogin = async (_e: string, _p: string, deviceUuid: string) => ({
  authenticated: true,
  credentials: { access_token: "kakao-access-1", refresh_token: "kakao-refresh-1", user_id: ME_ID, device_uuid: deviceUuid, device_type: "tablet" },
});
const hub = new MessengerHub({
  vault: deps.vault as never,
  storage: built.db.messengerStorage() as never,
  configRoot: `${process.env.PICKLE_DATA_DIR}/messengers`,
  onUpdate: () => {},
  sdk: { kakaotalk: async () => kakao.sdk },
});
deps.hub = hub as never;

/** What the pre-fix adapter + tool produced for this room (the bug in the report). */
function legacyCard(): MessengerCard {
  const sorted = [...ROOM_LOGS].sort((a, b) => a.sent_at - b.sent_at);
  return {
    type: "messenger",
    provider: "kakaotalk",
    action: "read",
    target: ROOM_CHAT.display_name!,
    messages: sorted.slice(-20).map((m) => ({
      author: m.author_name ?? exactId(m.author_id as unknown),
      text: (m.message || (m.attachment ? "(첨부)" : "")).slice(0, 300),
      at: m.sent_at * 1000,
    })),
  };
}

/** the friend step's html card (synthetic) */
const FRIEND_CARD = { title: "강남역 저녁", html: "<section><h2>강남역 저녁</h2><p>세 곳을 골랐어요.</p><ul><li>가온 식당</li><li>모퉁이 국수</li><li>소담 한식</li></ul></section>" };

const standIn: RunTurn = async (input, emit) => {
  const said = input.userText ?? "";
  if (/카드로/.test(said)) {
    const made = await input.ctx.store.createArtifact({ title: FRIEND_CARD.title, kind: "html", content: FRIEND_CARD.html }, { agentCard: true });
    const card = { type: "artifact", artifactId: made.id, title: FRIEND_CARD.title, kind: "html", preview: "세 곳을 골랐어요." } as Card;
    emit({ type: "card", card } as AgentEvent);
    const text = "세 곳을 골랐어요.";
    emit({ type: "text", delta: text });
    return { text, cards: [card], tools: [], messages: [{ role: "assistant", content: text }], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  const focus = /focus:\s*(.+)$/i.exec(said)?.[1]?.trim();
  const read = input.tools.find((t) => t.name === "msg_read") as ToolDef | undefined;
  const callId = `call_${crypto.randomUUID().slice(0, 8)}`;
  const args = { provider: "kakaotalk", chat: ROOM_CHAT_ID, limit: 30, ...(focus ? { focus } : {}) };
  const startedAt = Date.now();
  const running: ToolActivity = { id: callId, name: "msg_read", title: read?.title(args as never) ?? "카카오톡 읽기", state: "running", startedAt };
  emit({ type: "tool", tool: running });
  let card: Card | undefined;
  let summary = "";
  let data: unknown = null;
  if (LEGACY) {
    card = legacyCard();
    summary = `${ROOM_CHAT.display_name} 메시지 20개 읽음`;
  } else if (read) {
    const r = await read.run(args as never, input.ctx);
    card = r.card;
    summary = r.summary;
    data = r.data;
  }
  const done: ToolActivity = { ...running, state: card ? "done" : "error", summary, endedAt: Date.now() };
  emit({ type: "tool", tool: done });
  if (card) emit({ type: "card", card } as AgentEvent);
  const text = "회비 3만원을 오늘까지 입금해 달라는 부탁이 있었고, 토요일 리허설은 11월 15일 오후 2시 대학로 연습실이에요.";
  emit({ type: "text", delta: text });
  const messages: LlmMessage[] = [
    { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "msg_read", arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: callId, content: JSON.stringify(data ?? { ok: !!card }) },
    { role: "assistant", content: text },
  ];
  return { text, cards: card ? [card] : [], tools: [done], messages, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
};
deps.runTurn = standIn;

const app = createApp(deps);
built.bindApp(app);
app.start();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/qa/connect-kakao") {
      const { userId } = (await req.json()) as { userId: string };
      const auth = req.headers.get("authorization") ?? "";
      const credential = {
        service: "kakaotalk",
        label: `카카오톡 (${maskHint("login", BOGUS.email)})`,
        kind: "login",
        hint: maskHint("login", BOGUS.email),
        keepFor: "7d",
        envelope: await sealForEnclave(deps.enclave.info() as never, BOGUS, `${userId}:kakaotalk:login`),
      };
      return app.fetch(
        new Request(`http://127.0.0.1:${PORT}/api/connections/kakaotalk`, {
          method: "POST",
          headers: { authorization: auth, "content-type": "application/json" },
          body: JSON.stringify({ credential }),
        }),
        srv as never,
      );
    }
    return app.fetch(req, srv as never);
  },
});
console.log(JSON.stringify({ qa: "messenger-server", url: `http://${server.hostname}:${server.port}`, legacy: LEGACY, pid: process.pid }));

const stop = async () => {
  server.stop();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
