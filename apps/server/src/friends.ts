/**
 * Friends: invite links (24 h), accept → one shared `friend` thread visible to both users,
 * block / remove, 말 전하기 (ToolStore.messageFriend), and the `/i/:token` landing page.
 */
import type { Friend, InviteResponse } from "@pickle/protocol";
import type { FriendRow, UserRow } from "./db/index.ts";
import { publishMessage, publishThread, settingsOf, threadViewById, type Core } from "./core.ts";
import { bad, forbidden, json, notFound, type Ctx } from "./http.ts";
import { escapeHtml, newId, preview, randomB64url, wa } from "./util.ts";

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

type FriendJoin = FriendRow & { handle: string; display_name: string; agent_name: string };

export function listAcceptedFriends(core: Core, userId: string): FriendJoin[] {
  return core.db.listFriends(userId).filter((f) => f.status === "accepted" && core.db.getFriend(f.friend_id, userId)?.status === "accepted");
}

async function friendView(core: Core, f: FriendJoin): Promise<Friend> {
  let avatar: Friend["avatar"] = { hue: 8, shape: "blob", eyes: "dot" };
  try {
    const p = await core.deps.launcher.profile(f.friend_id);
    if (p?.avatar) avatar = p.avatar;
  } catch {
    /* fallback avatar */
  }
  return {
    userId: f.friend_id,
    displayName: f.display_name,
    handle: f.handle,
    agentName: f.agent_name,
    avatar,
    status: f.status,
    threadId: f.thread_id,
    since: f.created_at,
  };
}

function joinOf(core: Core, userId: string, friendId: string): FriendJoin | null {
  const row = core.db.getFriend(userId, friendId);
  const u = core.db.userById(friendId);
  if (!row || !u) return null;
  return { ...row, handle: u.handle, display_name: u.display_name, agent_name: u.agent_name };
}

function friendThreadBetween(core: Core, a: string, b: string): string | null {
  const row = core.db.sql
    .query(
      `SELECT t.id FROM threads t
       JOIN thread_members ma ON ma.thread_id = t.id AND ma.user_id = $a
       JOIN thread_members mb ON mb.thread_id = t.id AND mb.user_id = $b
       WHERE t.kind = 'friend' ORDER BY t.created_at ASC LIMIT 1`,
    )
    .get({ a, b }) as { id: string } | null;
  return row?.id ?? null;
}

export function isBlockedBetween(core: Core, a: string, b: string): boolean {
  return core.db.getFriend(a, b)?.status === "blocked" || core.db.getFriend(b, a)?.status === "blocked";
}

export function areFriends(core: Core, a: string, b: string): boolean {
  return core.db.getFriend(a, b)?.status === "accepted" && core.db.getFriend(b, a)?.status === "accepted";
}

function originOf(core: Core, req: Request): string {
  if (core.cfg.publicOrigin) return core.cfg.publicOrigin.replace(/\/+$/, "");
  const url = new URL(req.url);
  const proto = core.cfg.trustProxy ? (req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")) : url.protocol.replace(":", "");
  const host = (core.cfg.trustProxy ? req.headers.get("x-forwarded-host") : null) ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

function validInvite(core: Core, token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const inv = core.db.getInvite(token);
  if (!inv || inv.expires_at < core.now()) return null;
  return inv;
}

// ───────────────────────────── 말 전하기 ─────────────────────────────

const norm = (s: string) =>
  s
    .trim()
    .replace(/^@/, "")
    .replace(/\s*님(의 모시)?$/, "")
    .toLowerCase();

export async function messageFriend(core: Core, userId: string, target: string, text: string): Promise<{ ok: boolean; detail: string }> {
  const q = norm(target);
  const body = text.trim().slice(0, 1000);
  if (!q) return { ok: false, detail: "누구에게 전할지 알려 주세요" };
  if (!body) return { ok: false, detail: "전할 내용이 비어 있어요" };
  const me = core.db.userById(userId) as UserRow;
  const friends = listAcceptedFriends(core, userId);
  // never guess: handle first, then an exact name, then a name containing the query — and only
  // when exactly one friend fits (a message to the wrong person can't be taken back)
  const pick = (cands: typeof friends) => (cands.length ? cands : null);
  const cands =
    pick(friends.filter((f) => f.handle.toLowerCase() === q)) ??
    pick(friends.filter((f) => norm(f.display_name) === q || norm(f.agent_name) === q)) ??
    (q.length >= 2 ? pick(friends.filter((f) => norm(f.display_name).includes(q))) : null) ??
    [];
  const who = target.trim().slice(0, 20);
  if (cands.length > 1) {
    const list = cands.map((f) => `${f.display_name}(@${f.handle})`).join(", ");
    return { ok: false, detail: `'${who}'에 해당하는 친구가 여러 명이에요: ${list}. 누구에게 전할지 아이디로 알려 주세요` };
  }
  const match = cands[0];
  if (!match) return { ok: false, detail: `친구 목록에서 '${who}' 님을 찾지 못했어요` };
  let threadId = match.thread_id && core.db.threadFor(match.thread_id, userId) ? match.thread_id : friendThreadBetween(core, userId, match.friend_id);
  if (!threadId) threadId = createFriendThread(core, userId, match.friend_id);
  const now = core.now();
  const id = newId("m");
  core.db.tx(() => {
    core.db.insertMessage({ id, threadId: threadId!, role: "assistant", text: `${me.agent_name}: ${body}`, authorUserId: userId, authorKind: "agent", createdAt: now });
    core.db.touchThread(threadId!, now, preview(`${me.agent_name}: ${body}`));
    core.db.setUnread(threadId!, match.friend_id, true);
  });
  publishMessage(core, id);
  publishThread(core, threadId);
  const friendUser = core.db.userById(match.friend_id);
  if (friendUser && settingsOf(friendUser).notifications.friendMessages) {
    core.events.publish(match.friend_id, { type: "notification", title: `${me.display_name} 님의 모시`, body: preview(body, 80), threadId, messageId: id, icon: "people" });
  }
  return { ok: true, detail: `${match.display_name} 님에게 전했어요` };
}

function createFriendThread(core: Core, a: string, b: string): string {
  const id = newId("t");
  const ua = core.db.userById(a)!;
  const ub = core.db.userById(b)!;
  const now = core.now();
  core.db.createThread({ id, ownerId: a, kind: "friend", title: `${wa(ua.agent_name)} ${ub.display_name}님의 모시`, subtitle: "", icon: "people", now }, [a, b]);
  return id;
}

// ───────────────────────────── routes ─────────────────────────────

export function friendRoutes(core: Core) {
  const { db } = core;
  return {
    createInvite: (c: Ctx, userId: string) => {
      const token = randomB64url(18);
      const now = core.now();
      const expiresAt = now + INVITE_TTL_MS;
      db.insertInvite({ token, userId, now, expiresAt });
      const res: InviteResponse = { token, url: `${originOf(core, c.req)}/i/${token}`, expiresAt };
      return json(res, 201);
    },

    accept: async (c: Ctx, userId: string) => {
      const inv = validInvite(core, c.params.token!);
      if (!inv) throw notFound("초대 링크가 올바르지 않아요. 친구에게 새 링크를 받아 주세요.", "invalid_invite");
      const inviterId = inv.user_id;
      if (inviterId === userId) throw bad("내가 만든 초대 링크예요. 친구에게 보내 주세요.", "self_invite");
      if (!db.userById(inviterId)) throw notFound("초대 링크가 올바르지 않아요. 친구에게 새 링크를 받아 주세요.", "invalid_invite");
      if (isBlockedBetween(core, userId, inviterId)) throw forbidden("이 친구는 추가할 수 없어요", "blocked");
      if (areFriends(core, userId, inviterId)) return json(await friendView(core, joinOf(core, userId, inviterId)!));

      const now = core.now();
      const threadId = friendThreadBetween(core, userId, inviterId) ?? createFriendThread(core, inviterId, userId);
      const me = db.userById(userId)!;
      const inviter = db.userById(inviterId)!;
      const eventId = newId("m");
      db.tx(() => {
        db.upsertFriend(userId, inviterId, "accepted", threadId, now);
        db.upsertFriend(inviterId, userId, "accepted", threadId, now);
        db.useInvite(inv.token);
        db.setThreadArchived(threadId, userId, false);
        db.setThreadArchived(threadId, inviterId, false);
        db.insertMessage({
          id: eventId,
          threadId,
          role: "event",
          text: `${inviter.display_name} 님과 ${me.display_name} 님이 친구가 되었어요. 이제 서로의 모시에게 말을 전할 수 있어요. 메시지에 모시 이름을 부르거나 @로 시작하면 내 모시가 대답해요.`,
          createdAt: now,
        });
        db.touchThread(threadId, now, "친구가 되었어요");
        db.setUnread(threadId, inviterId, true);
      });
      // both friends, every device: the inviter's and the accepter's, the accepting one too (the 201 carries no rows)
      publishMessage(core, eventId);
      publishThread(core, threadId);
      core.events.publish(inviterId, { type: "notification", title: "새 친구", body: `${me.display_name} 님과 친구가 되었어요`, threadId, messageId: eventId, icon: "people" });
      return json(await friendView(core, joinOf(core, userId, inviterId)!), 201);
    },

    list: async (_c: Ctx, userId: string) => {
      const rows = db.listFriends(userId);
      return json(await Promise.all(rows.map((r) => friendView(core, r))));
    },

    block: async (c: Ctx, userId: string) => {
      const target = c.params.userId!;
      if (target === userId) throw bad("나 자신은 차단할 수 없어요");
      if (!db.userById(target)) throw notFound("사용자를 찾을 수 없어요");
      const now = core.now();
      const existing = db.getFriend(userId, target);
      db.tx(() => {
        db.upsertFriend(userId, target, "blocked", existing?.thread_id ?? friendThreadBetween(core, userId, target), now);
        // end their side of the friendship — but never erase a block they placed on me
        if (db.getFriend(target, userId)?.status !== "blocked") db.deleteFriend(target, userId);
      });
      const tid = db.getFriend(userId, target)?.thread_id;
      if (tid) {
        db.setThreadArchived(tid, userId, true);
        publishThread(core, tid);
      }
      return json(await friendView(core, joinOf(core, userId, target)!));
    },

    remove: (c: Ctx, userId: string) => {
      const target = c.params.userId!;
      const row = db.getFriend(userId, target);
      if (!row) throw notFound("친구를 찾을 수 없어요");
      db.tx(() => {
        db.deleteFriend(userId, target);
        if (row.status === "accepted") db.deleteFriend(target, userId);
        if (row.thread_id && db.threadFor(row.thread_id, userId)) db.setThreadArchived(row.thread_id, userId, true);
      });
      if (row.thread_id) publishThread(core, row.thread_id);
      return json({ ok: true });
    },

    /** GET /i/:token — Korean landing page with OG tags (HTTP 200 even when invalid, like the real site). */
    landing: (c: Ctx) => {
      const token = c.params.token ?? "";
      const inv = validInvite(core, token);
      const inviter = inv ? db.userById(inv.user_id) : null;
      const openHref = `/?invite=${encodeURIComponent(token)}`;
      const valid = !!(inv && inviter);
      const title = valid ? `${inviter!.display_name} 님이 모시 친구로 초대했어요` : "초대 링크가 올바르지 않아요";
      const desc = valid
        ? `${inviter!.display_name} 님의 모시 ${wa(inviter!.agent_name)} 친구가 되면 서로의 모시에게 말을 전할 수 있어요.`
        : "친구에게 새 링크를 받아 주세요.";
      const pageUrl = `${originOf(core, c.req)}/i/${encodeURIComponent(token)}`;
      const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(valid ? title : "모시: 나만의 AI 에이전트")}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="모시">
<meta property="og:title" content="${escapeHtml(valid ? title : "모시: 나만의 AI 에이전트")}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${escapeHtml(pageUrl)}">
<meta name="twitter:card" content="summary">
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#111216; color:#f5f5f7;
         font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif; }
  main { text-align:center; padding:32px 24px; max-width:420px; }
  .face { width:88px; height:88px; margin:0 auto 24px; border-radius:46% 54% 50% 50%; background:#ef4b3a; position:relative; }
  .face::before, .face::after { content:""; position:absolute; top:34px; width:10px; height:16px; border-radius:6px; background:#2a0f0c; }
  .face::before { left:28px; } .face::after { right:28px; }
  h1 { font-size:22px; line-height:1.4; margin:0 0 10px; font-weight:700; }
  p { margin:0 0 28px; color:#a1a1a6; font-size:16px; line-height:1.5; }
  a.btn { display:inline-block; padding:14px 28px; border-radius:999px; background:#f5f5f7; color:#111216; text-decoration:none; font-weight:600; }
</style>
</head>
<body>
<main>
  <div class="face" aria-hidden="true"></div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(desc)}</p>
  <a class="btn" href="${escapeHtml(openHref)}">앱 열기</a>
</main>
</body>
</html>`;
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    },
  };
}

export { threadViewById };
