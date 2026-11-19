import { test, expect, describe, afterEach } from "bun:test";
import type { ToolDef } from "@pickle/agent";
import { KAKAO_EMAIL, KAKAO_PASSWORD, fakeKakao, harness, sealedLogin, toolCtx, type Harness } from "./helpers.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const U = "user_1";

function tool(name: string): ToolDef {
  const t = h!.hub.tools().find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

async function connectedKakao() {
  const kakao = fakeKakao();
  h = await harness({ kakaotalk: async () => kakao.sdk });
  await h.hub.connect(U, "kakaotalk", { credential: await sealedLogin(h, U, "kakaotalk", { email: KAKAO_EMAIL, password: KAKAO_PASSWORD }) });
  return kakao;
}

describe("messenger tools", () => {
  test("exposes msg_connections, msg_list_chats, msg_read, msg_send with valid schemas", async () => {
    h = await harness({ kakaotalk: async () => fakeKakao().sdk });
    const tools = h.hub.tools();
    expect(tools.map((t) => t.name)).toEqual(["msg_connections", "msg_list_chats", "msg_read", "msg_send"]);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(t.parameters.type).toBe("object");
    }
    expect(tool("msg_send").parameters.required).toEqual(["provider", "chat", "text"]);
  });

  test("msg_send always asks for approval with the exact text", async () => {
    await connectedKakao();
    const ctx = toolCtx(h!, U);
    const args = { provider: "kakaotalk", chat: "가족 단톡방", text: "오늘 저녁 7시에 봬요 🙂" };
    expect(tool("msg_send").approval!(args, ctx)).toEqual({
      title: "카카오톡 '가족 단톡방'에 메시지를 보낼까요?",
      detail: "오늘 저녁 7시에 봬요 🙂",
    });
    expect(tool("msg_send").title(args)).toBe("카카오톡 '가족 단톡방'에 메시지 보내기");
  });

  test("msg_send asks for a login (CredentialNeed) when the messenger isn't connected", async () => {
    h = await harness({ kakaotalk: async () => fakeKakao().sdk });
    const ctx = toolCtx(h, U);
    const need = await tool("msg_send").credential!({ provider: "kakaotalk", chat: "엄마", text: "hi" }, ctx);
    expect(need).toMatchObject({ service: "kakaotalk", serviceName: "카카오톡" });
    expect(need!.fields.map((f) => f.key)).toEqual(["email", "password"]);
    // device-code providers never ask for a password
    expect(await tool("msg_send").credential!({ provider: "teams", chat: "x", text: "hi" }, ctx)).toBeNull();
  });

  test("msg_send runs after approval: resolves the chat by name, sends, returns a 'sent' card", async () => {
    const kakao = await connectedKakao();
    const ctx = toolCtx(h!, U);
    expect(await tool("msg_send").credential!({ provider: "kakaotalk", chat: "가족 단톡방", text: "x" }, ctx)).toBeNull();
    const r = await tool("msg_send").run({ provider: "kakaotalk", chat: "가족 단톡방", text: "도착했어요" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("가족 단톡방에 보냈어요");
    expect(kakao.state.sent).toEqual([{ chatId: "1002", text: "도착했어요" }]);
    expect(r.card).toMatchObject({ type: "messenger", provider: "kakaotalk", action: "sent", target: "가족 단톡방" });
    const rec = (await h!.vault.accessLog(U)).find((x) => x.action === "send_message")!;
    expect(rec).toMatchObject({ actor: "agent", deviceVerified: true, outcome: "ok", service: "kakaotalk" });
  });

  test("msg_read by chat name returns compact messages and a 'read' card — no secrets", async () => {
    await connectedKakao();
    const ctx = toolCtx(h!, U);
    const r = await tool("msg_read").run({ provider: "kakaotalk", chat: "단톡", limit: 2 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("가족 단톡방 메시지 2개 읽음");
    const data = r.data as { chat: { id: string; name: string; kind: string }; transcript: string; count: number };
    expect(data.chat).toMatchObject({ id: "1002", name: "가족 단톡방", kind: "group" });
    expect(data.count).toBe(2);
    expect(data.transcript).toBe("[13:41] 준호: 좋아요!\n[13:42] 민지: 방 1002");
    expect(r.card).toMatchObject({ type: "messenger", action: "read", target: "가족 단톡방", messages: [], room: { title: "가족 단톡방", kind: "group" }, total: 2 });
    const card = r.card as import("@pickle/protocol").MessengerCard;
    expect(card.thread!.map((m) => [m.id, m.senderId, m.senderName, m.text])).toEqual([
      ["m1", "p1", "준호", "좋아요!"],
      ["m2", "p2", "민지", "방 1002"],
    ]);
    expect(card.highlights!.length).toBeGreaterThanOrEqual(1);
    const creds = await h!.vault.list(U);
    const blob = JSON.stringify(r);
    for (const s of [KAKAO_PASSWORD, KAKAO_EMAIL, "kakao-access-1", "kakao-refresh-1", ...creds.map((c) => c.id)]) {
      expect(blob).not.toContain(s);
    }
  });

  test("ambiguous chat names return candidates instead of guessing (and nothing is sent)", async () => {
    const kakao = await connectedKakao();
    const ctx = toolCtx(h!, U);
    const r = await tool("msg_send").run({ provider: "kakaotalk", chat: "가족", text: "hi" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.data).toMatchObject({ error: "chat_ambiguous", candidates: ["가족 단톡방", "가족 여행"] });
    expect(kakao.state.sent).toHaveLength(0);
    // an exact name wins over partial matches
    const exact = await tool("msg_read").run({ provider: "kakaotalk", chat: "가족 여행" }, ctx);
    expect((exact.data as { chat: { id: string } }).chat.id).toBe("1004");
    const none = await tool("msg_read").run({ provider: "kakaotalk", chat: "없는방" }, ctx);
    expect(none.data).toMatchObject({ error: "chat_not_found" });
    const list = await tool("msg_list_chats").run({ provider: "kakaotalk", search: "가족" }, ctx);
    expect((list.data as { chats: { name: string }[] }).chats.map((c) => c.name)).toEqual(["가족 단톡방", "가족 여행"]);
  });

  test("msg_read on an unconnected messenger fails gracefully", async () => {
    h = await harness({ kakaotalk: async () => fakeKakao().sdk });
    const r = await tool("msg_read").run({ provider: "kakaotalk", chat: "엄마" }, toolCtx(h, U));
    expect(r.ok).toBe(false);
    expect((r.data as { error: string }).error).toBe("not_connected");
    const bad = await tool("msg_read").run({ provider: "myspace", chat: "x" }, toolCtx(h, U));
    expect((bad.data as { error: string }).error).toBe("unknown_provider");
  });

  test("msg_connections lists connected accounts by label", async () => {
    await connectedKakao();
    const r = await tool("msg_connections").run({}, toolCtx(h!, U));
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("카카오톡 연결됨");
    const data = r.data as { connected: { provider: string; account: string }[]; notConnected: { provider: string }[] };
    expect(data.connected).toEqual([{ provider: "kakaotalk", name: "카카오톡", account: "하늘 (ha***@kakao.com)" }] as never);
    expect(data.notConnected.map((x) => x.provider)).toContain("slack");
  });
});
