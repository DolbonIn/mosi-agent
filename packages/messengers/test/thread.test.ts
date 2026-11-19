import { test, expect, describe, afterEach } from "bun:test";
import type { MessengerCard } from "@pickle/protocol";
import type { ToolDef } from "@pickle/agent";
import { exactId, feedLine, normalizeKakao, parseExactJson, parseFeed } from "../src/adapters/kakao-normalize.ts";
import { buildRoomTitle, cardThread, focusTerms, isSubstantive, pickHighlights, roomOf, titleNames, transcript } from "../src/thread.ts";
import { finishMessages, looksLikeJson, splitDisplayName, type ChatMessage } from "../src/util.ts";
import { IDS, LEFT_MEMBERS, ME_ID, NICK, PRIVATE_IDS, ROOM_CHAT, ROOM_CHAT_ID, ROOM_LOGS, ROOM_MEMBERS, SPAM_TEXT } from "./fixtures/kakao-room.ts";
import { KAKAO_EMAIL, KAKAO_PASSWORD, fakeKakao, harness, sealedLogin, toolCtx, type Harness } from "./helpers.ts";
import type { DiscordClientLike, DiscordSdk, TelegramBotClientLike, TelegramBotSdk } from "../src/sdk.ts";

const names = () => new Map([...ROOM_MEMBERS, ...LEFT_MEMBERS].map((m) => [m.user_id, m.nickname] as const));
const roomMsgs = () => normalizeKakao(ROOM_LOGS, { myUserId: ME_ID, names: names() });

describe("display names", () => {
  test("strips open-chat profile tags only when they clearly are tags", () => {
    expect(splitDisplayName("김도윤/남/68년생/사진")).toEqual({ short: "김도윤", full: "김도윤/남/68년생/사진" });
    expect(splitDisplayName("해피/남/5*/연극")).toEqual({ short: "해피", full: "해피/남/5*/연극" });
    expect(splitDisplayName("초롱별/여/51/무용").short).toBe("초롱별");
    expect(splitDisplayName("민수(남/92)").short).toBe("민수");
    expect(splitDisplayName("지수 / 여 / 30대").short).toBe("지수");
    // not tags: unchanged
    expect(splitDisplayName("BTR-moka")).toEqual({ short: "BTR-moka" });
    expect(splitDisplayName("달빛 고양이")).toEqual({ short: "달빛 고양이" });
    expect(splitDisplayName("Kim/Engineering")).toEqual({ short: "Kim/Engineering" });
    expect(splitDisplayName("kim_92")).toEqual({ short: "kim_92" }); // handles keep their digits
    expect(splitDisplayName("철수 (팀장)")).toEqual({ short: "철수 (팀장)" });
  });
});

describe("room title", () => {
  test("unnamed group: two latest speakers + 외 N명; ≤3 others: all; DM: the person", () => {
    expect(buildRoomTitle(["김도윤/남/68년생/사진", "초롱별/여/51/무용", "해피/남/5*/연극", "BTR-moka", "달빛 고양이"], { memberCount: 6, kind: "open" })).toBe(
      "김도윤, 초롱별 외 3명",
    );
    expect(buildRoomTitle(["민지", "준호"], { memberCount: 3, kind: "group" })).toBe("민지, 준호");
    expect(buildRoomTitle(["민지", "준호", "서연"], { memberCount: 4 })).toBe("민지, 준호, 서연");
    expect(buildRoomTitle(["민지", "준호"], { memberCount: 40 })).toBe("민지, 준호 외 37명");
    expect(buildRoomTitle(["엄마"], { kind: "dm" })).toBe("엄마");
    expect(buildRoomTitle([], {})).toBe("이름 없는 대화방");
  });

  test("roomOf: own title wins; unnamed rooms keep the full tagged member list for the expanded view", () => {
    const msgs = roomMsgs();
    const room = roomOf({ listName: ROOM_CHAT.display_name!, listKind: "group", unread: 7, info: { kind: "open", memberCount: 6 } }, msgs);
    expect(room.kind).toBe("open");
    expect(room.memberCount).toBe(6);
    expect(room.unread).toBe(7);
    expect(room.title).toMatch(/^[^,]+, [^,]+ 외 3명$/);
    expect(room.title).not.toContain("/");
    expect(room.fullTitle).toBe(ROOM_CHAT.display_name!);
    const named = roomOf({ listName: "x", listKind: "group", info: { title: "공연 팀", memberCount: 6 } }, msgs);
    expect(named).toEqual({ title: "공연 팀", kind: "group", memberCount: 6 });
    // latest speakers first
    expect(titleNames(msgs).slice(0, 2).map((n) => splitDisplayName(n).short)).toEqual(["BTR-moka", "초롱별"]);
  });
});

describe("KakaoTalk normalisation", () => {
  test("exact ids from every shape, big integers in feed JSON stay exact", () => {
    const v = BigInt(IDS.doyun);
    expect(exactId({ low: Number(v & 0xffffffffn) | 0, high: Number(v >> 32n) | 0 })).toBe(IDS.doyun);
    expect(exactId(7000000000000001)).toBe("7000000000000001");
    expect(exactId(123n)).toBe("123");
    expect(exactId("42")).toBe("42");
    expect(parseExactJson('{"logId":3971635324108519426,"n":1,"s":"9999999999999999999"}')).toEqual({ logId: "3971635324108519426", n: 1, s: "9999999999999999999" });
  });

  test("hidden feed and the message it hides are dropped; no JSON, no ids anywhere", () => {
    const msgs = roomMsgs();
    const blob = JSON.stringify(msgs.map(({ id: _id, senderId: _s, ...rest }) => rest));
    expect(blob).not.toContain("feedType");
    expect(blob).not.toContain("{\\\"");
    expect(blob).not.toContain(SPAM_TEXT);
    for (const id of PRIVATE_IDS) expect(blob).not.toContain(id);
    expect(msgs.some((m) => m.text.includes("spam"))).toBe(false);
  });

  test("names come from the member map (short, full kept); me → isMe", () => {
    const msgs = roomMsgs();
    const reh = msgs.find((m) => m.text.startsWith("토요일 리허설"))!;
    expect(reh).toMatchObject({ senderName: "김도윤", senderFull: NICK.doyun, isMe: false, kind: "text", senderId: IDS.doyun });
    const mine = msgs.find((m) => m.text === "저도 갈게요!")!;
    expect(mine).toMatchObject({ isMe: true, senderName: "나" });
    expect(msgs.some((m) => /^\d{6,}$/.test(m.senderName))).toBe(false);
    expect(msgs.find((m) => m.senderName === "알 수 없음")).toBeUndefined();
  });

  test("LOCO types map to kinds and Korean placeholders; feeds become short system lines", () => {
    const msgs = roomMsgs();
    const kinds = msgs.map((m) => [m.kind, m.kind === "system" ? m.text : m.attachment?.label ?? ""]);
    expect(kinds).toEqual([
      ["system", "BTR-moka님이 들어왔어요"],
      ["text", ""],
      ["text", ""],
      ["emoticon", "이모티콘"],
      ["text", ""],
      ["photo", "사진"],
      ["reply", ""],
      ["link", "tickets.example.com"],
      ["text", ""],
      ["text", ""],
      ["system", "달빛 고양이님이 나갔어요"],
      ["text", ""],
      ["text", ""],
      ["photo", "사진 3장"],
      ["file", "파일 · 공연_큐시트.pdf"],
      ["other", "삭제된 메시지"],
    ]);
    const reply = msgs.find((m) => m.kind === "reply")!;
    expect(reply.replyTo).toEqual({ senderName: "김도윤", text: "토요일 리허설은 11월 15일 오후 2시, 대학로 연습실에서 해요" });
    expect(msgs.find((m) => m.text.startsWith("@지우"))!.mentionsMe).toBe(true);
  });

  test("feed lines: invite / kick / host; unknown and moderation feeds are not shown", () => {
    const ctx = { myUserId: ME_ID, names: names() };
    const f = (s: string) => feedLine(parseFeed(s)!, ctx);
    expect(f(`{"feedType":1,"inviter":{"userId":${IDS.happy},"nickName":"해피/남/5*/연극"},"members":[{"userId":1,"nickName":"민지"},{"userId":2,"nickName":"준호"}]}`)).toBe(
      "해피님이 민지님, 준호님을 초대했어요",
    );
    expect(f(`{"feedType":1,"inviter":{"userId":${ME_ID},"nickName":"지우"},"members":[{"userId":2,"nickName":"준호"}]}`)).toBe("내가 준호님을 초대했어요");
    expect(f(`{"feedType":6,"member":{"userId":2,"nickName":"준호"}}`)).toBe("준호님을 내보냈어요");
    expect(f(`{"feedType":2,"member":{"userId":2,"nickName":"준호"},"kicked":true}`)).toBe("준호님을 내보냈어요");
    expect(f(`{"feedType":15,"newHost":{"userId":2,"nickName":"준호"}}`)).toBe("준호님이 방장이 됐어요");
    expect(f(`{"feedType":4,"members":[{"userId":${IDS.moka}}]}`)).toBe("BTR-moka님이 들어왔어요"); // name from the map
    expect(f(`{"feedType":4,"members":[{"userId":1,"nickName":"민지"}],"hidden":true}`)).toBeNull();
    expect(f(`{"feedType":14,"logId":1}`)).toBeNull();
    expect(f(`{"feedType":99}`)).toBeNull();
    expect(parseFeed("not json")).toBeNull();
  });

  test("other providers: serialised payloads never reach the user, links detected", () => {
    const out = finishMessages(
      [
        { author: "a", text: '{"type":"x","id":123}', at: 2 },
        { author: "b", text: "자료 https://www.example.org/a 확인", at: 1 },
      ],
      10,
    );
    expect(out[0]).toMatchObject({ kind: "link", attachment: { label: "example.org" }, senderName: "b" });
    expect(out[1]).toMatchObject({ kind: "other", text: "", attachment: { label: "메시지" } });
    expect(looksLikeJson("{안녕}")).toBe(false);
  });
});

describe("highlights", () => {
  const byText = (msgs: ChatMessage[], ids: string[]) => ids.map((id) => msgs.find((m) => m.id === id)!.text);

  test("picks what matters: the request to me, the date/time/place, the link; skips noise", () => {
    const msgs = roomMsgs();
    const ids = pickHighlights(msgs, { myNames: ["지우"] });
    expect(ids.length).toBe(3);
    const texts = byText(msgs, ids);
    expect(texts).toContain("@지우 회비 3만원 오늘까지 입금 부탁드려요");
    expect(texts).toContain("토요일 리허설은 11월 15일 오후 2시, 대학로 연습실에서 해요");
    for (const t of texts) expect(["ㅋㅋㅋㅋ", "넵", ""]).not.toContain(t);
    // chronological order
    const order = ids.map((id) => msgs.findIndex((m) => m.id === id));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("focus keywords win", () => {
    const msgs = roomMsgs();
    const ids = pickHighlights(msgs, { myNames: ["지우"], focus: focusTerms("뒤풀이 식당은?"), max: 1 });
    expect(byText(msgs, ids)[0]).toStartWith("공연 끝나고 뒤풀이는");
    expect(focusTerms("공연 날짜랑 회비를 알려줘")).toEqual(["공연", "날짜랑", "회비", "알려줘"].map((w) => w.replace(/랑$/, "")));
  });

  test("noise-only rooms fall back to the latest substantive message, or nothing", () => {
    const m = (text: string, i: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `x${i}`, at: i, senderId: "a", senderName: "a", isMe: false, kind: "text", text, ...extra });
    expect(pickHighlights([m("ㅋㅋㅋ", 1), m("넵", 2), m("오늘 고생했어", 3), m("ㅎㅎ", 4)])).toEqual(["x3"]);
    expect(pickHighlights([m("ㅋㅋ", 1), m("", 2, { kind: "emoticon" }), m("x님이 들어왔어요", 3, { kind: "system" })])).toEqual([]);
    expect(isSubstantive(m("", 1, { kind: "file", attachment: { label: "파일 · a.pdf" } }))).toBe(true);
  });
});

describe("transcript + card thread", () => {
  test("compact '[HH:MM] 이름: 내용' lines, system lines, placeholders, cap", () => {
    const msgs = roomMsgs();
    const t = transcript(msgs);
    const lines = t.split("\n");
    expect(lines[0]).toBe("[19:12] · BTR-moka님이 들어왔어요");
    expect(lines).toContain("[19:13] 김도윤: 다들 이번 주 공연 준비 잘 되고 있죠?");
    expect(lines).toContain("[19:14] 해피: (이모티콘)");
    expect(lines).toContain('[19:20] 해피: (김도윤의 "토요일 리허설은 11월 15일 오후 2시, 대학로 연…"에 답장) 저 그날 3시쯤 도착할 것 같아요');
    expect(lines).toContain("[19:22] 나: 저도 갈게요!");
    expect(lines).toContain("[19:30] BTR-moka: (파일 · 공연_큐시트.pdf)");
    for (const id of PRIVATE_IDS) expect(t).not.toContain(id);
    expect(t).not.toContain("{");
    const capped = transcript(msgs, { maxChars: 200 });
    expect(capped.length).toBeLessThanOrEqual(240);
    expect(capped.split("\n")[0]).toMatch(/^\(이전 메시지 \d+개 생략\)$/);
    expect(capped.endsWith("(삭제된 메시지)")).toBe(true);
  });

  test("card thread: opaque keys, highlights remapped, full name kept", () => {
    const msgs = roomMsgs();
    const picked = pickHighlights(msgs, { myNames: ["지우"] });
    const { thread, highlights } = cardThread(msgs, picked);
    expect(thread.map((m) => m.id)).toEqual(msgs.map((_, i) => `m${i + 1}`));
    expect(highlights).toHaveLength(3);
    expect(highlights.every((h) => thread.some((m) => m.id === h))).toBe(true);
    const senders = new Set(thread.map((m) => m.senderId));
    expect([...senders].every((s) => s === "" || s === "me" || /^p\d+$/.test(s))).toBe(true);
    expect(thread.find((m) => m.senderName === "김도윤")!.senderFull).toBe(NICK.doyun);
    const blob = JSON.stringify(thread);
    for (const id of PRIVATE_IDS) expect(blob).not.toContain(id);
  });
});

describe("msg_read on the fixture room (end to end through the hub)", () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  test("card = room + thread + highlights; LLM data = transcript; nothing private", async () => {
    const kakao = fakeKakao({ userId: ME_ID, rooms: [{ chat: ROOM_CHAT, logs: ROOM_LOGS, members: ROOM_MEMBERS, left: LEFT_MEMBERS }] });
    h = await harness({ kakaotalk: async () => kakao.sdk });
    await h.hub.connect("u1", "kakaotalk", { credential: await sealedLogin(h, "u1", "kakaotalk", { email: KAKAO_EMAIL, password: KAKAO_PASSWORD }) });
    const read = h.hub.tools().find((t) => t.name === "msg_read") as ToolDef;
    const ctx = { ...toolCtx(h, "u1"), displayName: "지우" };
    const r = await read.run({ provider: "kakaotalk", chat: ROOM_CHAT_ID, limit: 30, focus: "회비" }, ctx);
    expect(r.ok).toBe(true);
    const card = r.card as MessengerCard;
    expect(card.room).toMatchObject({ kind: "open", memberCount: 6, unread: 7, fullTitle: [NICK.doyun, NICK.happy, NICK.chorong, NICK.moka, NICK.dawn].join(", ") });
    expect(card.room!.title).toBe("BTR-moka, 초롱별 외 3명");
    expect(card.target).toBe(card.room!.title);
    expect(card.messages).toEqual([]);
    expect(card.total).toBe(16);
    expect(card.thread).toHaveLength(16);
    expect(card.highlights!.length).toBeGreaterThanOrEqual(1);
    const hl = card.highlights!.map((id) => card.thread!.find((m) => m.id === id)!.text);
    expect(hl).toContain("@지우 회비 3만원 오늘까지 입금 부탁드려요");
    expect(r.summary).toBe("BTR-moka, 초롱별 외 3명 메시지 16개 읽음");
    const data = r.data as { chat: { id: string; name: string; kind: string; members: number }; transcript: string; notable: string; count: number };
    expect(data.chat).toEqual({ id: ROOM_CHAT_ID, name: "BTR-moka, 초롱별 외 3명", kind: "open", members: 6 });
    expect(data.transcript.split("\n")).toHaveLength(16);
    expect(data.notable).toContain("회비 3만원");
    // nothing private in the card; in the LLM data only the chat handle
    const cardBlob = JSON.stringify(card);
    const dataBlob = JSON.stringify({ ...data, chat: { ...data.chat, id: "" } });
    for (const blob of [cardBlob, dataBlob]) {
      for (const id of [...PRIVATE_IDS, ROOM_CHAT_ID]) expect(blob).not.toContain(id);
      expect(blob).not.toContain("feedType");
      expect(blob).not.toContain(SPAM_TEXT);
    }
  });

  /** the fixture room on a connected fake; `searches`: every getChats search the hub asked for */
  async function roomHub(extra: { chat_id: string; title: string }[] = []) {
    const kakao = fakeKakao({
      userId: ME_ID,
      rooms: [
        { chat: ROOM_CHAT, logs: ROOM_LOGS, members: ROOM_MEMBERS, left: LEFT_MEMBERS },
        ...extra.map((e) => ({ chat: { ...ROOM_CHAT, ...e, display_name: null }, logs: [], members: [] })),
      ],
    });
    const searches: (string | undefined)[] = [];
    const make = kakao.sdk.createClient.bind(kakao.sdk);
    kakao.sdk.createClient = (...args: Parameters<typeof make>) => {
      const c = make(...args);
      const get = c.getChats.bind(c);
      c.getChats = (o) => {
        searches.push(o?.search);
        return get(o);
      };
      return c;
    };
    h = await harness({ kakaotalk: async () => kakao.sdk });
    await h.hub.connect("u1", "kakaotalk", { credential: await sealedLogin(h, "u1", "kakaotalk", { email: KAKAO_EMAIL, password: KAKAO_PASSWORD }) });
    const tool = (name: string) => h!.hub.tools().find((t) => t.name === name) as ToolDef;
    return { kakao, searches, read: tool("msg_read"), send: tool("msg_send"), ctx: toolCtx(h, "u1") };
  }

  test("a KakaoTalk chat id is never a step title's room name; names (a phone number too) are shown as given", async () => {
    const { read, send } = await roomHub();
    expect(read.title({ provider: "kakaotalk", chat: ROOM_CHAT_ID })).toBe("카카오톡 대화방 읽기");
    expect(read.title({ provider: "kakaotalk", chat: ` ${ROOM_CHAT_ID} ` })).toBe("카카오톡 대화방 읽기");
    expect(send.title({ provider: "kakaotalk", chat: ROOM_CHAT_ID, text: "x" })).toBe("카카오톡 대화방에 메시지 보내기");
    expect(read.title({ provider: "kakaotalk", chat: "가족" })).toBe("카카오톡 '가족' 읽기");
    expect(read.title({ provider: "kakaotalk", chat: "01012345678" })).toBe("카카오톡 '01012345678' 읽기");
    expect(read.title({ provider: "kakaotalk", chat: "821012345678" })).toBe("카카오톡 '821012345678' 읽기");
    // a Slack-shaped id stays a name on KakaoTalk, and a KakaoTalk-shaped one on Slack
    expect(h!.hub.isChatId("kakaotalk", "C0STANDUP01")).toBe(false);
    expect(h!.hub.isChatId("slack", ROOM_CHAT_ID)).toBe(false);
  });

  test("msg_read by a KakaoTalk id: one listing, no name search", async () => {
    const { read, searches, ctx } = await roomHub();
    const r = await read.run({ provider: "kakaotalk", chat: ROOM_CHAT_ID, limit: 5 }, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { chat: { id: string } }).chat.id).toBe(ROOM_CHAT_ID);
    expect(searches).not.toContain(ROOM_CHAT_ID);
    expect(searches.filter((x) => x === undefined)).toHaveLength(1);
  });

  test("msg_send to a KakaoTalk id: credential() names the room, so the approval never shows the id", async () => {
    const { send, ctx } = await roomHub();
    const args = { provider: "kakaotalk", chat: ROOM_CHAT_ID, text: "회비 보냈어요" };
    expect(await send.credential!(args, ctx)).toBeNull();
    const ap = send.approval!(args, ctx)!;
    expect(ap.title).toStartWith(`카카오톡 '${NICK.moon}`);
    expect(ap.title).not.toContain(ROOM_CHAT_ID);
    expect(ap.title).not.toContain("이름을 확인하지 못한");
    // an id that is no room fails before any approval card
    await expect(send.credential!({ ...args, chat: "9000000000000999" }, ctx)).rejects.toMatchObject({ code: "chat_not_found" });
  });

  test("a room titled with 13+ digits is still found by its name", async () => {
    const { read, ctx } = await roomHub([{ chat_id: "1777", title: "2024000000000001" }]);
    expect(read.title({ provider: "kakaotalk", chat: "2024000000000001" })).toBe("카카오톡 대화방 읽기");
    const chat = await h!.hub.resolveChat("u1", "kakaotalk", "2024000000000001", ctx.credentials, ctx.signal);
    expect(chat).toMatchObject({ id: "1777", name: "2024000000000001" });
  });
});

// ───────────────────────────── Discord / Telegram chat ids ─────────────────────────────

/** Discord snowflakes (17–20 digits) and Telegram ids (-100… supergroup, -… group, a user id for a private chat) */
const DC = { notice: "1180000000000000001", dm: "1180000000000000002", digits: "1180000000000000003", digitsName: "11111111111111111" };
const TG = { group: "-1001234567890", dm: "5123456789", digits: "-4012345678", digitsName: "77777777" };

function fakeDiscordSdk(): { sdk: DiscordSdk; sent: { channelId: string; content: string }[] } {
  const sent: { channelId: string; content: string }[] = [];
  const minjun = { id: "900000000000000002", username: "minjun", global_name: "민준" };
  const seoyeon = { id: "900000000000000003", username: "seoyeon", global_name: "서연" };
  const client: DiscordClientLike = {
    async login() {},
    async testAuth() {
      return { id: "900000000000000001", username: "haneul", global_name: "하늘" };
    },
    async listServers() {
      return [{ id: "1170000000000000000", name: "하늘네 서버" }];
    },
    async listChannels() {
      return [
        { id: DC.notice, name: "공지", type: 0 },
        { id: "1180000000000000009", name: "음성", type: 2 },
      ];
    },
    async listDMChannels() {
      return [
        { id: DC.dm, type: 1, recipients: [minjun] },
        { id: DC.digits, type: 3, recipients: [minjun, seoyeon], name: DC.digitsName },
      ];
    },
    async getMessages(channelId) {
      return [{ id: `${channelId}-m1`, author: { id: minjun.id, username: minjun.username }, content: "토요일 7시 맞지?", timestamp: "2026-11-16T10:00:00.000Z" }];
    },
    async sendMessage(channelId, content) {
      sent.push({ channelId, content });
      return { id: "1190000000000000001", author: { id: "900000000000000001", username: "haneul" }, content, timestamp: "2026-11-16T10:01:00.000Z" };
    },
  };
  return { sdk: { createClient: () => client }, sent };
}

function fakeTelegramBotSdk(): { sdk: TelegramBotSdk; sent: { chatId: number | string; text: string }[] } {
  const sent: { chatId: number | string; text: string }[] = [];
  const date = Math.floor(Date.parse("2026-11-16T10:00:00Z") / 1000);
  const from = { id: Number(TG.dm), is_bot: false, first_name: "민준" };
  const updates = [
    { update_id: 1, message: { message_id: 1, date, from, chat: { id: Number(TG.group), type: "supergroup", title: "동네 모임" }, text: "토요일 10시에 봬요" } },
    { update_id: 2, message: { message_id: 2, date, from, chat: { id: Number(TG.dm), type: "private", first_name: "민준" }, text: "안녕하세요" } },
    { update_id: 3, message: { message_id: 3, date, from, chat: { id: Number(TG.digits), type: "group", title: TG.digitsName }, text: "회비 정리했어요" } },
  ] as unknown as Awaited<ReturnType<TelegramBotClientLike["getUpdates"]>>;
  const client: TelegramBotClientLike = {
    async login() {},
    async getMe() {
      return { id: 7000000001, first_name: "모시봇", username: "mosi_qa_bot" };
    },
    async getUpdates() {
      return updates;
    },
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { message_id: 99 };
    },
  };
  return { sdk: { createClient: () => client }, sent };
}

describe("Discord and Telegram chat ids are ids, not names", () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  /** both connected on fakes; `searches[provider]`: every listChats search the hub asked for (undefined = a full listing) */
  async function idHub() {
    const discord = fakeDiscordSdk();
    const telegram = fakeTelegramBotSdk();
    h = await harness({ discord: async () => discord.sdk, telegrambot: async () => telegram.sdk });
    await h.hub.connect("u1", "discord", { credential: await sealedLogin(h, "u1", "discord", { token: "fake-discord-user-token-0001" }, "token") });
    await h.hub.connect("u1", "telegrambot", { credential: await sealedLogin(h, "u1", "telegrambot", { token: "123456789:AAFakeTelegramBotToken_0123456789" }, "token") });
    const searches: Record<string, (string | undefined)[]> = { discord: [], telegrambot: [] };
    const list = h.hub.listChats.bind(h.hub);
    h.hub.listChats = (userId, provider, opts, access) => {
      (searches[provider] ??= []).push(opts?.search);
      return list(userId, provider, opts, access);
    };
    const tool = (name: string) => h!.hub.tools().find((t) => t.name === name) as ToolDef;
    return { discord, telegram, searches, read: tool("msg_read"), send: tool("msg_send"), ctx: toolCtx(h, "u1") };
  }

  test("a Discord or Telegram chat id is never a step title's room name; names (a phone number too) are shown as given", async () => {
    const { read, send } = await idHub();
    for (const provider of ["discord", "discordbot"]) {
      const name = provider === "discord" ? "디스코드" : "디스코드 봇";
      expect(read.title({ provider, chat: DC.notice })).toBe(`${name} 대화방 읽기`);
      expect(read.title({ provider, chat: ` ${DC.dm} ` })).toBe(`${name} 대화방 읽기`);
      expect(send.title({ provider, chat: DC.notice, text: "x" })).toBe(`${name} 대화방에 메시지 보내기`);
      expect(read.title({ provider, chat: "공지" })).toBe(`${name} '공지' 읽기`);
    }
    for (const provider of ["telegram", "telegrambot"]) {
      const name = provider === "telegram" ? "텔레그램" : "텔레그램 봇";
      for (const id of [TG.group, TG.digits, TG.dm, "8212345678"]) expect(read.title({ provider, chat: id })).toBe(`${name} 대화방 읽기`);
      expect(send.title({ provider, chat: TG.group, text: "x" })).toBe(`${name} 대화방에 메시지 보내기`);
      expect(read.title({ provider, chat: "동네 모임" })).toBe(`${name} '동네 모임' 읽기`);
    }
    // phone numbers stay names: domestic 0…, 82… (11–12 digits), +82…; so do short numbers and a 16-digit unsafe integer
    for (const provider of ["discord", "telegram", "telegrambot"]) {
      for (const phone of ["01012345678", "0212345678", "821012345678", "82212345678", "+821012345678"]) expect(h!.hub.isChatId(provider, phone)).toBe(false);
    }
    expect(read.title({ provider: "telegram", chat: "01012345678" })).toBe("텔레그램 '01012345678' 읽기");
    expect(read.title({ provider: "telegram", chat: "821012345678" })).toBe("텔레그램 '821012345678' 읽기");
    expect(h!.hub.isChatId("telegram", "2024")).toBe(false);
    expect(h!.hub.isChatId("telegram", "9999999999999999")).toBe(false);
    // each provider's id shape only: a snowflake is no Telegram id, a Telegram group id no snowflake, a 16-digit no snowflake
    expect(h!.hub.isChatId("telegram", DC.notice)).toBe(false);
    expect(h!.hub.isChatId("discord", TG.group)).toBe(false);
    expect(h!.hub.isChatId("discord", "1234567890123456")).toBe(false);
    expect(h!.hub.isChatId("kakaotalk", TG.group)).toBe(false);
    expect(h!.hub.isChatId("slack", DC.notice)).toBe(false);
  });

  test("msg_read by a Discord or Telegram id: one listing, no name search", async () => {
    const { read, searches, ctx } = await idHub();
    const d = await read.run({ provider: "discord", chat: DC.dm, limit: 5 }, ctx);
    expect(d.ok).toBe(true);
    expect((d.data as { chat: { id: string } }).chat.id).toBe(DC.dm);
    expect(searches.discord).not.toContain(DC.dm);
    expect(searches.discord!.filter((x) => x === undefined)).toHaveLength(1);
    const t = await read.run({ provider: "telegrambot", chat: TG.group, limit: 5 }, ctx);
    expect(t.ok).toBe(true);
    expect((t.data as { chat: { id: string } }).chat.id).toBe(TG.group);
    expect(searches.telegrambot).not.toContain(TG.group);
    expect(searches.telegrambot!.filter((x) => x === undefined)).toHaveLength(1);
  });

  test("msg_send to a Discord or Telegram id: credential() names the room, so the approval never shows the id", async () => {
    const { send, ctx } = await idHub();
    for (const [provider, id, room, wrong] of [
      ["discord", DC.notice, "하늘네 서버 #공지", "1180000000000000999"],
      ["telegrambot", TG.group, "동네 모임", "-1009999999999"],
    ] as const) {
      const args = { provider, chat: id, text: "회비 보냈어요" };
      expect(await send.credential!(args, ctx)).toBeNull();
      const ap = send.approval!(args, ctx)!;
      expect(ap.title).toStartWith(`${provider === "discord" ? "디스코드" : "텔레그램 봇"} '${room}'`);
      expect(ap.title).not.toContain(id);
      expect(ap.title).not.toContain("이름을 확인하지 못한");
      // an id that is no room fails before any approval card
      await expect(send.credential!({ ...args, chat: wrong }, ctx)).rejects.toMatchObject({ code: "chat_not_found" });
    }
  });

  test("a room titled like an id is still found by its name", async () => {
    const { read, ctx } = await idHub();
    expect(read.title({ provider: "discord", chat: DC.digitsName })).toBe("디스코드 대화방 읽기");
    expect(await h!.hub.resolveChat("u1", "discord", DC.digitsName, ctx.credentials, ctx.signal)).toMatchObject({ id: DC.digits, name: DC.digitsName });
    expect(read.title({ provider: "telegrambot", chat: TG.digitsName })).toBe("텔레그램 봇 대화방 읽기");
    expect(await h!.hub.resolveChat("u1", "telegrambot", TG.digitsName, ctx.credentials, ctx.signal)).toMatchObject({ id: TG.digits, name: TG.digitsName });
  });
});
