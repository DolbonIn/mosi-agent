/**
 * Slack user session, read path (adapters/slack-web.ts): the REAL hub, adapter and msg_* tools against a local fake of
 * Slack's Web API (test/fake-slack-web.ts, never slack.com). The live failure this guards: four msg_read calls each
 * paged conversations.list, Slack answered 429 / Retry-After 30, agent-messenger's client waited it out silently and
 * every tool hung until the turn's watchdog.
 */
import { test, expect, describe, afterEach } from "bun:test";
import type { ToolDef, ToolResult } from "@pickle/agent";
import { SlackWeb } from "../src/adapters/slack-web.ts";
import type { SlackBotClientLike } from "../src/sdk.ts";
import { MessengerError } from "../src/index.ts";
import { fakeSlack, harness, sealedLogin, toolCtx, type Harness } from "./helpers.ts";
import { fakeSlackWeb, type FakeSlackData, type FakeSlackWeb } from "./fake-slack-web.ts";

const U = "user_1";
const TOKEN = "xoxc-test-111-222-SECRETTOKEN";
const COOKIE = "xoxd-SECRET%2FCOOKIEVALUE";
const PRIVATE_TEXT = "회비는 3만원, 계좌는 우리 1002-123";

const DATA: FakeSlackData = {
  me: "U1",
  convs: [
    { id: "C0ANNOUNCE1", name: "announcement", is_channel: true },
    { id: "C0ENGCOMMON", name: "eng-common", is_channel: true },
    { id: "C0STANDUP01", name: "standup", is_channel: true },
    { id: "C0RANDOM001", name: "random", is_channel: true },
    { id: "C0ARCHIVED1", name: "old-project", is_channel: true, is_archived: true },
    { id: "G0GROUPDM01", name: "mpdm-minji--junho--haneul-1", is_mpim: true },
    { id: "D0MINJI0001", is_im: true, user: "U0MINJI001" },
    { id: "D0JUNHO0001", is_im: true, user: "U0JUNHO001" },
  ],
  users: { U1: { name: "haneul", real_name: "하늘" }, U0MINJI001: { name: "minji", real_name: "김민지" }, U0JUNHO001: { name: "junho", real_name: "이준호" } },
  history: {
    C0ANNOUNCE1: [{ ts: "1731300120.000300", text: "금요일 배포 공지", user: "U0MINJI001" }],
    C0ENGCOMMON: [{ ts: "1731300110.000300", text: "리뷰 부탁드려요 <@U1>", user: "U0JUNHO001" }],
    C0STANDUP01: [
      { ts: "1731300100.000200", text: PRIVATE_TEXT, user: "U0MINJI001", user_profile: { real_name: "김민지" } },
      { ts: "1731300000.000100", text: "어제 한 일: 로그인 수정", user: "U1" },
    ],
    C0RANDOM001: [{ ts: "1731300090.000100", text: "점심 뭐 먹죠", user: "U0JUNHO001" }],
    D0MINJI0001: [{ ts: "1731300080.000100", text: "내일 봬요", user: "U0MINJI001" }],
  },
};

let h: Harness | null = null;
let web: FakeSlackWeb | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
  web?.stop();
  web = null;
});

async function connected(data: FakeSlackData = DATA) {
  web = fakeSlackWeb(data);
  const slack = fakeSlack(web);
  h = await harness({ slack: async () => slack.sdk });
  const res = await h.hub.connect(U, "slack", { credential: await sealedLogin(h, U, "slack", { token: TOKEN, cookie: COOKIE }, "token") });
  expect(res.connection.status).toBe("connected");
  return { web, hh: h };
}

function tool(name: string): ToolDef {
  const t = h!.hub.tools().find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

function ctxWith(signal?: AbortSignal) {
  const ctx = toolCtx(h!, U);
  return signal ? { ...ctx, signal } : ctx;
}

const read = (chat: string, signal?: AbortSignal) => tool("msg_read").run({ provider: "slack", chat }, ctxWith(signal)) as Promise<ToolResult>;

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

describe("listing and reading as the Slack user (fake Web API)", () => {
  test("four parallel msg_read calls by name share ONE users.conversations call; never conversations.list or users.list", async () => {
    const { web } = await connected();
    web.delay("users.conversations", 80); // all four join the same listing
    const names = ["#announcement", "eng-common", "standup", "#random"];
    const results = await Promise.all(names.map((n) => read(n)));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true]);
    expect(results.map((r) => r.card && "target" in r.card && r.card.target)).toEqual(["#announcement", "#eng-common", "#standup", "#random"]);
    expect(web.count("users.conversations")).toBe(1);
    expect(web.count("conversations.history")).toBe(4);
    expect(web.count("conversations.list") + web.count("users.list") + web.count("conversations.info")).toBe(0);
    const listing = web.calls.find((c) => c.method === "users.conversations")!;
    expect(listing.params).toMatchObject({ types: "public_channel,private_channel,mpim,im", exclude_archived: "true", limit: "200" });
    // every request carried the session (Bearer token + d cookie) — to this fake only
    expect(new Set(web.calls.map((c) => `${c.authorization}|${c.cookie}`))).toEqual(new Set([`Bearer ${TOKEN}|d=${COOKIE}`]));
  });

  test("the list: channels, then group DMs, then DMs named through users.info (once per user, cached)", async () => {
    const { web } = await connected();
    const r = await tool("msg_list_chats").run({ provider: "slack" }, ctxWith());
    const chats = (r.data as { chats: { id: string; name: string; kind: string }[] }).chats;
    expect(chats).toEqual([
      { id: "C0ANNOUNCE1", name: "#announcement", kind: "channel" },
      { id: "C0ENGCOMMON", name: "#eng-common", kind: "channel" },
      { id: "C0STANDUP01", name: "#standup", kind: "channel" },
      { id: "C0RANDOM001", name: "#random", kind: "channel" },
      { id: "G0GROUPDM01", name: "minji, junho, haneul", kind: "group" },
      { id: "D0MINJI0001", name: "김민지", kind: "dm" },
      { id: "D0JUNHO0001", name: "이준호", kind: "dm" },
    ]);
    expect(web.count("users.info")).toBe(2);
    const dm = await read("김민지");
    expect(dm.ok).toBe(true);
    expect((dm.data as { transcript: string }).transcript).toContain("내일 봬요");
    expect(web.count("users.info")).toBe(2); // names cached for the session
    expect(web.count("users.conversations")).toBe(1); // list cached (5 min)
  });

  test("paging stops after 5 pages", async () => {
    const many: FakeSlackData = { ...DATA, convs: Array.from({ length: 1300 }, (_, i) => ({ id: `C${String(i).padStart(10, "0")}`, name: `ch-${i}`, is_channel: true })) };
    web = fakeSlackWeb(many);
    const slack = fakeSlack(web);
    h = await harness({ slack: async () => slack.sdk });
    await h.hub.connect(U, "slack", { credential: await sealedLogin(h, U, "slack", { token: TOKEN, cookie: COOKIE }, "token") });
    const all = await h.hub.listChats(U, "slack", { limit: 200 });
    expect(all.length).toBe(200);
    expect(web.count("users.conversations")).toBe(5);
  });

  test("an id in `chat` skips the listing; a cold room is named by conversations.info, a warm one from the list", async () => {
    const { web } = await connected();
    const ch = await read("C0ANNOUNCE1");
    expect(ch.ok).toBe(true);
    expect(ch.card && "target" in ch.card && ch.card.target).toBe("#announcement");
    const dm = await read("D0MINJI0001");
    expect(dm.ok).toBe(true);
    expect(dm.card && "target" in dm.card && dm.card.target).toBe("김민지");
    expect(web.count("users.conversations")).toBe(0);
    expect(web.count("conversations.history")).toBe(2);
    expect(web.count("conversations.info")).toBe(2);
    await h!.hub.listChats(U, "slack");
    await read("C0RANDOM001");
    expect(web.count("conversations.info")).toBe(2); // warm: the list knows the room
    // a wrong id fails the read itself, cleanly
    const missing = await read("C0NOSUCHCH1");
    expect(missing.ok).toBe(false);
    expect((missing.data as { error: string }).error).toBe("chat_not_found");
  });

  test("messages: oldest → newest, names from user_profile / users.info, mine marked, mentions of me flagged", async () => {
    await connected();
    const msgs = await h!.hub.readMessages(U, "slack", "C0STANDUP01", 10);
    expect(msgs.map((m) => [m.senderName, m.isMe, m.text])).toEqual([
      ["나", true, "어제 한 일: 로그인 수정"],
      ["김민지", false, PRIVATE_TEXT],
    ]);
    const eng = await h!.hub.readMessages(U, "slack", "C0ENGCOMMON", 10);
    expect(eng[0]).toMatchObject({ senderName: "이준호", mentionsMe: true });
  });
});

describe("rate limits (429) fail fast", () => {
  test("Retry-After 30 → rate_limited within 1 s; the cooldown holds without calling Slack; it lifts after Retry-After", async () => {
    const { web, hh } = await connected();
    web.limit("users.conversations", 30, 99);
    const t0 = performance.now();
    const first = await read("#standup");
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(first.ok).toBe(false);
    expect(first.data).toMatchObject({ error: "rate_limited", retryAfter: 30 });
    expect(first.summary).toBe("슬랙이 요청을 잠시 막았어요. 30초 뒤에 다시 시도해 주세요.");
    expect(web.count("users.conversations")).toBe(1);

    hh.clock.t += 10_000;
    const t1 = performance.now();
    const again = await read("standup");
    expect(performance.now() - t1).toBeLessThan(200);
    expect(again.data).toMatchObject({ error: "rate_limited", retryAfter: 20 });
    expect(web.count("users.conversations")).toBe(1); // cooldown: Slack was not asked again
    // the limit is Slack's, per method: reading a known id still works meanwhile
    expect((await read("C0STANDUP01")).ok).toBe(true);
    // a rate limit is not a broken connection
    expect((await hh.hub.connection(U, "slack"))?.status).toBe("connected");

    hh.clock.t += 21_000;
    web.limit("users.conversations", 30, 0);
    expect((await read("#standup")).ok).toBe(true);
    expect(web.count("users.conversations")).toBe(2);
  });

  test("Retry-After ≤ 3 s gets one quiet retry inside the deadline; a second 429 fails", async () => {
    const { web } = await connected();
    web.limit("conversations.history", 1, 1);
    const ok = await read("C0RANDOM001");
    expect(ok.ok).toBe(true);
    expect(web.count("conversations.history")).toBe(2);
    web.limit("conversations.history", 1, 2);
    const no = await read("C0ANNOUNCE1");
    expect(no.data).toMatchObject({ error: "rate_limited", retryAfter: 1 });
    expect(web.count("conversations.history")).toBe(4); // one retry, never more
  });

  test("an expired list is still served while the refresh is rate limited", async () => {
    const { web, hh } = await connected();
    expect((await h!.hub.listChats(U, "slack")).length).toBe(7);
    hh.clock.t += 6 * 60_000;
    web.limit("users.conversations", 30, 1);
    expect((await h!.hub.listChats(U, "slack")).length).toBe(7);
    expect(web.count("users.conversations")).toBe(2);
  });
});

describe("abort and deadlines leave nothing running", () => {
  test("an aborted msg_read ends at once and its request is gone", async () => {
    const { web } = await connected();
    web.hang("users.conversations");
    const ctl = new AbortController();
    const p = read("#standup", ctl.signal);
    await until(() => web.pending() === 1);
    const t0 = performance.now();
    ctl.abort(new DOMException("turn over", "AbortError"));
    const r = await p;
    expect(performance.now() - t0).toBeLessThan(300);
    expect(r.ok).toBe(false);
    await until(() => web.pending() === 0);

    web.hang("conversations.history");
    const ctl2 = new AbortController();
    const p2 = read("C0RANDOM001", ctl2.signal);
    await until(() => web.pending() === 1);
    ctl2.abort();
    expect((await p2).ok).toBe(false);
    await until(() => web.pending() === 0);
  });

  test("a shared listing keeps running while one caller still waits, and stops when the last one gives up", async () => {
    const { web } = await connected();
    web.hang("users.conversations");
    const a = new AbortController();
    const b = new AbortController();
    const pa = read("#standup", a.signal);
    const pb = read("#random", b.signal);
    await until(() => web.pending() === 1);
    a.abort();
    expect((await pa).ok).toBe(false);
    await Bun.sleep(100);
    expect(web.pending()).toBe(1);
    expect(web.count("users.conversations")).toBe(1);
    b.abort();
    expect((await pb).ok).toBe(false);
    await until(() => web.pending() === 0);
  });

  test("per-call deadline: a call Slack never answers fails as network, without a request left open", async () => {
    web = fakeSlackWeb(DATA);
    web.hang("conversations.history");
    const sw = new SlackWeb({ api: web.url, token: TOKEN, cookie: COOKIE, userId: "U1", callMs: 150 });
    const t0 = performance.now();
    const err = await sw.readThread("C0RANDOM001", 10).then(
      () => null,
      (e: unknown) => e,
    );
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(err).toBeInstanceOf(MessengerError);
    expect((err as MessengerError).code).toBe("network");
    await until(() => web!.pending() === 0);
  });

  test("closing the session (idle, disconnect, shutdown) aborts what is in flight", async () => {
    const { web } = await connected();
    web.hang("users.conversations");
    const p = h!.hub.listChats(U, "slack").then(
      () => null,
      (e: unknown) => e,
    );
    await until(() => web.pending() === 1);
    await h!.hub.disconnect(U, "slack");
    expect(await p).toBeInstanceOf(MessengerError);
    await until(() => web.pending() === 0);
  });
});

describe("sending and login as the Slack user (fetch, never agent-messenger's client)", () => {
  test("send posts with chat.postMessage; a 429 fails fast, holds a cooldown and is never retried in the background", async () => {
    const { web } = await connected();
    expect(await h!.hub.send(U, "slack", "C0RANDOM001", "점심 12시 반에 봬요")).toEqual({ ok: true, id: "1731300100.000300" });
    const post = web.calls.find((c) => c.method === "chat.postMessage")!;
    expect(post.params).toEqual({ channel: "C0RANDOM001", text: "점심 12시 반에 봬요" });
    expect([post.authorization, post.cookie]).toEqual([`Bearer ${TOKEN}`, `d=${COOKIE}`]);

    web.limit("chat.postMessage", 30, 99);
    const t0 = performance.now();
    const err = (await h!.hub.send(U, "slack", "C0RANDOM001", "두 번째").catch((e: unknown) => e)) as MessengerError;
    expect(performance.now() - t0).toBeLessThan(1000);
    expect([err.code, err.retryAfter, err.message]).toEqual(["rate_limited", 30, "슬랙이 요청을 잠시 막았어요. 30초 뒤에 다시 시도해 주세요."]);
    const viaTool = await tool("msg_send").run({ provider: "slack", chat: "C0RANDOM001", text: "세 번째" }, ctxWith());
    expect(viaTool.data).toMatchObject({ error: "rate_limited", retryAfter: 30 });
    await Bun.sleep(300);
    expect(web.count("chat.postMessage")).toBe(2); // the 429 once; the cooldown kept the tool's try away from Slack
  });

  test("an aborted msg_send ends at once and leaves no request open", async () => {
    const { web } = await connected();
    web.hang("chat.postMessage");
    const ctl = new AbortController();
    const p = tool("msg_send").run({ provider: "slack", chat: "C0RANDOM001", text: "보내는 중" }, ctxWith(ctl.signal));
    await until(() => web.pending() === 1);
    ctl.abort();
    expect((await p).ok).toBe(false);
    await until(() => web.pending() === 0);
  });

  test("msg_send with a channel or DM id: approval, summary and card name the room; a cold list costs one conversations.info, no listing", async () => {
    const { web } = await connected();
    const send = tool("msg_send");
    for (const [id, name] of [
      ["C0ANNOUNCE1", "#announcement"],
      ["D0MINJI0001", "김민지"],
    ] as const) {
      const ctx = ctxWith();
      const args = { provider: "slack", chat: id, text: "확인했어요" };
      expect(send.title(args)).not.toContain(id);
      // as the agent loop runs it: credential() (async), approval() (sync), then run() once the owner approves
      expect(await send.credential!(args, ctx)).toBeNull();
      const spec = send.approval!(args, ctx)!;
      expect(spec.title).toContain(`'${name}'`);
      const r = await send.run(args, ctx);
      expect(r.ok).toBe(true);
      expect(r.summary).toBe(`${name}에 보냈어요`);
      expect(r.card && "target" in r.card && r.card.target).toBe(name);
      expect((r.data as { chat: string }).chat).toBe(name);
      expect(JSON.stringify([spec, r.summary, r.card, r.data])).not.toContain(id);
    }
    expect(web.count("users.conversations")).toBe(0);
    expect(web.count("conversations.info")).toBe(2);
    expect(web.calls.filter((c) => c.method === "chat.postMessage").map((c) => c.params.channel)).toEqual(["C0ANNOUNCE1", "D0MINJI0001"]);
  });

  test("a send to an id that cannot be named fails before any approval card, and nothing is posted; a read still works", async () => {
    const ghost = { id: "D0GHOST0001", is_im: true, user: "U0GHOST001" }; // users.info knows no such user
    const { web } = await connected({ ...DATA, convs: [...DATA.convs, ghost], history: { ...DATA.history, D0GHOST0001: [{ ts: "1731300070.000100", text: "안녕", user: "U0GHOST001" }] } });
    const send = tool("msg_send");
    const ctx = ctxWith();
    const attempt = (chat: string) => send.credential!({ provider: "slack", chat, text: "x" }, ctx).then(() => null, (e: unknown) => e as MessengerError);
    // the approval never shows a raw id, even before credential() named it
    expect(send.approval!({ provider: "slack", chat: "C0STANDUP01", text: "x" }, ctx)!.title).toContain("이름을 확인하지 못한 대화방");
    expect((await attempt("C0NOSUCHCH1"))?.code).toBe("chat_not_found");
    expect(await attempt("D0GHOST0001")).toMatchObject({ code: "chat_not_found", message: "보낼 대화방의 이름을 확인하지 못했어요. 대화방 이름으로 다시 알려 주세요." });
    web.limit("conversations.info", 30, 1);
    const t0 = performance.now();
    expect(await attempt("C0RANDOM001")).toMatchObject({ code: "rate_limited", retryAfter: 30 });
    expect(performance.now() - t0).toBeLessThan(1000);
    // run() alone (e.g. resumed after a restart) refuses the same way
    const r = await send.run({ provider: "slack", chat: "D0GHOST0001", text: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).not.toContain("D0GHOST0001");
    expect(web.count("chat.postMessage")).toBe(0);
    expect(web.count("users.conversations")).toBe(0);
    // reading the nameless DM falls back to its id, as before
    expect((await read("D0GHOST0001")).ok).toBe(true);
  });

  test("login validates the session with auth.test over fetch: 429 fails fast with its message, invalid_auth is refused", async () => {
    web = fakeSlackWeb(DATA);
    const slack = fakeSlack(web); // its agent-messenger client throws if anything touches it
    h = await harness({ slack: async () => slack.sdk });
    const login = async () => h!.hub.connect(U, "slack", { credential: await sealedLogin(h!, U, "slack", { token: TOKEN, cookie: COOKIE }, "token") });

    web.limit("auth.test", 30, 1);
    const t0 = performance.now();
    const limited = await login();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(limited.connection).toMatchObject({ status: "error", lastError: "슬랙이 요청을 잠시 막았어요. 30초 뒤에 다시 시도해 주세요." });

    web.fail("auth.test", { status: 200, error: "invalid_auth" });
    expect((await login()).connection.status).toBe("error");

    web.fail("auth.test", null);
    const ok = await login();
    expect(ok.connection).toMatchObject({ status: "connected", accountLabel: "haneul · Acme" });
    expect(slack.state.logins.at(-1)).toEqual({ token: TOKEN, cookie: COOKIE });
    expect(web.count("auth.test")).toBe(3);
  });
});

describe("slackbot (agent-messenger's bot client, no describeChat)", () => {
  function fakeSlackBot() {
    const state = { lists: 0 };
    const client: SlackBotClientLike = {
      async login() {},
      async testAuth() {
        return { user_id: "B1", team_id: "T1", bot_id: "B1", user: "mosi-bot", team: "Acme" };
      },
      async listChannels() {
        state.lists++;
        return [
          { id: "C0ANNOUNCE1", name: "announcement" },
          { id: "C0RANDOM001", name: "random" },
        ];
      },
      async listUsers() {
        return [];
      },
      async getConversationHistory() {
        return [{ ts: "1731300120.000300", text: "금요일 배포 공지", user: "U0MINJI001" }];
      },
      async postMessage(_channel, text) {
        return { ts: "1731300100.000300", text };
      },
    };
    return { sdk: { createClient: () => client }, state };
  }

  test("an id goes straight to the listing: no extra login use or access-log line; a send's approval still names the room", async () => {
    const bot = fakeSlackBot();
    h = await harness({ slackbot: async () => bot.sdk });
    expect((await h.hub.connect(U, "slackbot", { credential: await sealedLogin(h, U, "slackbot", { token: "xoxb-test-1-2-abc" }, "token") })).connection.status).toBe("connected");
    const r = await tool("msg_read").run({ provider: "slackbot", chat: "C0ANNOUNCE1" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(r.card && "target" in r.card && r.card.target).toBe("#announcement");
    const log = await h.vault.accessLog(U);
    expect(log.filter((x) => x.action === "list_chats").map((x) => x.purpose)).toEqual(["슬랙 봇 대화방 목록 보기"]);
    expect(log.filter((x) => x.action === "read_messages")).toHaveLength(1);
    expect(bot.state.lists).toBe(1);

    // a send names the room before its approval: the same single listing
    const send = tool("msg_send");
    const args = { provider: "slackbot", chat: "C0RANDOM001", text: "공지 확인" };
    expect(await send.credential!(args, ctxWith())).toBeNull();
    expect(send.approval!(args, ctxWith())!.title).toContain("'#random'");
    expect((await h.vault.accessLog(U)).filter((x) => x.action === "list_chats")).toHaveLength(2);
    expect(bot.state.lists).toBe(2);
  });
});

describe("nothing secret leaves through logs or errors", () => {
  test("token, cookie and message text stay out of logs, error messages, tool errors and stored connection state", async () => {
    const logs: string[] = [];
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    const seen: string[] = [];
    try {
      const { web, hh } = await connected();
      await read("#standup"); // a successful read loads PRIVATE_TEXT into the session's memory
      web.limit("conversations.history", 30, 1);
      seen.push(JSON.stringify(await read("C0STANDUP01")));
      hh.clock.t += 31_000; // past the cooldown
      web.fail("conversations.history", { status: 500, error: "internal_error" });
      seen.push(JSON.stringify(await read("C0STANDUP01")));
      web.fail("conversations.history", { error: "channel_not_found" });
      seen.push(JSON.stringify(await read("C0STANDUP01")));
      // sending the private text (before invalid_auth below ends the connection): a 429 and a server error carry none of it
      web.limit("chat.postMessage", 30, 1);
      for (let i = 0; i < 2; i++) {
        const e = (await hh.hub.send(U, "slack", "C0STANDUP01", PRIVATE_TEXT).catch((x: unknown) => x)) as Error;
        seen.push(`${e.name} ${e.message} ${JSON.stringify(e)} ${String(e.stack)}`);
        hh.clock.t += 31_000;
        web.fail("chat.postMessage", { status: 500, error: "internal_error" });
      }
      expect(web.count("chat.postMessage")).toBe(2);
      web.fail("conversations.history", { status: 401, error: "invalid_auth" });
      seen.push(JSON.stringify(await read("C0STANDUP01")));
      seen.push(JSON.stringify([...hh.storage.rows.values()]), JSON.stringify(hh.updates));
      // the deadline and a refused connection, straight from the session
      web.fail("conversations.history", null);
      web.hang("conversations.history");
      const sw = new SlackWeb({ api: web.url, token: TOKEN, cookie: COOKIE, callMs: 100 });
      const timeout = (await sw.readThread("C0STANDUP01", 5).catch((e: unknown) => e)) as Error;
      const refused = (await new SlackWeb({ api: "http://127.0.0.1:1/api", token: TOKEN, cookie: COOKIE }).listChats().catch((e: unknown) => e)) as Error;
      for (const e of [timeout, refused]) seen.push(`${e.name} ${e.message} ${JSON.stringify(e)} ${String((e as { stack?: string }).stack)}`);
    } finally {
      Object.assign(console, orig);
    }
    const blob = [...logs, ...seen].join("\n");
    expect(seen.join("\n")).toContain("rate_limited");
    expect(seen.join("\n")).toContain("chat_not_found");
    expect(seen.join("\n")).toContain("session_expired");
    expect(seen.join("\n")).toContain("upstream"); // the send's HTTP 500
    for (const secret of [TOKEN, "SECRETTOKEN", COOKIE, "COOKIEVALUE", PRIVATE_TEXT, "회비"]) expect(blob).not.toContain(secret);
  });
});
