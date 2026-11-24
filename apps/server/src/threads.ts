/**
 * Threads & messages: list/create/patch, history pagination, POST message (SSE turn, steer 202,
 * friend-thread delivery) and POST /api/approvals/:id (decision → resumed SSE turn).
 */
import { MAX_MESSAGE_CHARS, speakable, speechNorm, type AttachmentRef, type Card, type SteeredResponse } from "@pickle/protocol";
import type { LlmMessage } from "@pickle/agent";
import type { ThreadRow } from "./db/index.ts";
import {
  messageView,
  publishMessage,
  publishThread,
  QUOTA_MESSAGE,
  quotaExceeded,
  settingsOf,
  threadView,
  threadViewById,
  type Core,
} from "./core.ts";
import { bad, forbidden, HttpError, json, notFound, readJson, type Ctx } from "./http.ts";
import { activeThreadOf, holdLease, MAX_QUEUED_TURNS, noteSteered, parseCall, queuedTurns, streamQueuedTurn, streamTurn, waitForStoppedTurn, type HeldLease } from "./turns.ts";
import { areFriends } from "./friends.ts";
import { attachmentPath, attachmentRef } from "./archive.ts";
import { clampInt, iGa, newId, preview, safeJson } from "./util.ts";
import { cutToHeard, withVoiceNote } from "./history.ts";
import { errInfo } from "./log.ts";
import { templateHint } from "./explore.ts";

const TEXT_ATTACHMENT_INLINE = 8 * 1024;
/** a heard report is at most a whole reply's spoken text */
const HEARD_MAX_CHARS = 20_000;
const HEARD_POLL_MS = 50;

function requireThread(core: Core, threadId: string, userId: string): ThreadRow {
  const t = core.db.threadFor(threadId, userId);
  if (!t) throw notFound("대화를 찾을 수 없어요", "thread_not_found");
  return t;
}

/** LLM-side user content: the text plus short notes for attachments (small text files inlined). */
async function llmUserContent(core: Core, userId: string, text: string, atts: AttachmentRef[]): Promise<string> {
  if (!atts.length) return text;
  const notes: string[] = [];
  for (const a of atts) {
    if (a.mime === "text/plain" && a.size <= TEXT_ATTACHMENT_INLINE) {
      try {
        const body = await Bun.file(attachmentPath(core, userId, a.id)).text();
        notes.push(`[첨부: ${a.filename}]\n${body}`);
        continue;
      } catch {
        /* fall through */
      }
    }
    notes.push(`[첨부: ${a.filename} (${a.mime}, ${Math.ceil(a.size / 1024)}KB) — 내용은 볼 수 없어요]`);
  }
  return `${text}\n\n${notes.join("\n")}`;
}

function mentionsAgent(text: string, agentName: string): boolean {
  const t = text.trim();
  return t.startsWith("@") || (agentName.length > 0 && t.includes(agentName));
}

export function threadRoutes(core: Core) {
  const { db, deps } = core;

  return {
    list: (_c: Ctx, userId: string) => json(db.threadsFor(userId).map((t) => threadView(core, t, userId))),

    create: async (c: Ctx, userId: string) => {
      const body = await readJson(c.req);
      const kind = body.kind ?? "task";
      if (kind !== "task") throw bad("새로 만들 수 있는 대화는 task 종류뿐이에요", "invalid_kind");
      const rawTitle = typeof body.title === "string" ? body.title.trim().slice(0, 60) : "";
      const user = db.userById(userId)!;
      const id = newId("t");
      db.createThread(
        { id, ownerId: userId, kind: "task", title: rawTitle || "새 대화", subtitle: `${user.agent_name}에게 맡긴 일`, icon: "sparkles", autoTitle: !rawTitle, now: core.now() },
        [userId],
      );
      publishThread(core, id); // every device of the person lists it at once (this one has it from the 201), not at the first answer
      return json(threadViewById(core, id, userId), 201);
    },

    patch: async (c: Ctx, userId: string) => {
      const t = requireThread(core, c.params.id!, userId);
      const body = await readJson(c.req);
      if (body.archived !== undefined) {
        if (typeof body.archived !== "boolean") throw bad("archived는 true/false여야 해요");
        db.setThreadArchived(t.id, userId, body.archived);
      }
      if (body.title !== undefined) {
        if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 60) throw bad("제목은 1~60자로 적어 주세요");
        if (t.kind === "friend") throw bad("친구 대화방의 이름은 바꿀 수 없어요");
        db.setThreadTitle(t.id, body.title.trim());
      }
      const view = threadViewById(core, t.id, userId)!;
      core.events.publish(userId, { type: "thread_updated", thread: view });
      return json(view);
    },

    messages: (c: Ctx, userId: string) => {
      const t = requireThread(core, c.params.id!, userId);
      const beforeRaw = c.url.searchParams.get("before");
      const before = beforeRaw && /^\d{1,15}$/.test(beforeRaw) ? Number(beforeRaw) : null;
      const limit = clampInt(c.url.searchParams.get("limit"), 1, 200, 50);
      const rows = db.listMessages(t.id, before, limit);
      if (t.unread && before === null) {
        db.setUnread(t.id, userId, false);
        // the reader's other devices drop the unread mark too (this one does on its own); unread is per person, so the
        // friend in a shared thread hears nothing
        core.events.publish(userId, { type: "thread_updated", thread: threadViewById(core, t.id, userId)! });
      }
      return json(rows.map((r) => messageView(core, r, userId)));
    },

    send: async (c: Ctx, userId: string) => {
      const thread = requireThread(core, c.params.id!, userId);
      const body = await readJson(c.req);
      if (typeof body.text !== "string") throw bad("메시지를 입력해 주세요", "empty_message");
      const text = body.text.trim();
      if (!text) throw bad("메시지를 입력해 주세요", "empty_message");
      if (text.length > MAX_MESSAGE_CHARS) throw new HttpError(413, "message_too_long", `메시지는 ${MAX_MESSAGE_CHARS.toLocaleString("ko-KR")}자까지 보낼 수 있어요`);
      const mode = body.mode === "voice" ? "voice" : "text";
      let attachments: AttachmentRef[] = [];
      if (body.attachmentIds !== undefined) {
        if (!Array.isArray(body.attachmentIds) || body.attachmentIds.length > 10 || body.attachmentIds.some((x) => typeof x !== "string"))
          throw bad("첨부 파일 목록이 올바르지 않아요");
        attachments = (body.attachmentIds as string[]).map((id) => {
          const a = db.getAttachment(userId, id);
          if (!a) throw notFound("첨부 파일을 찾을 수 없어요");
          return attachmentRef(a);
        });
      }
      const user = db.userById(userId)!;

      // sent right after Stop: let the stopped turn finish winding down first (it would otherwise
      // swallow this message as a steer and cancel it along with itself)
      const stillStopping = await waitForStoppedTurn(core, userId, core.cfg.turnSettleMs + 2000);

      if (thread.kind === "friend") return sendToFriendThread(c, userId, thread, text, attachments, mode);

      if (quotaExceeded(core, userId)) throw new HttpError(429, "quota_exceeded", QUOTA_MESSAGE);
      if (!deps.runTurn) throw new HttpError(503, "llm_not_configured", "AI 서버 설정이 아직 안 됐어요. 관리자에게 알려 주세요.");

      // 둘러보기's 부탁하기 sends the template's short line; the how-to rides along in the model copy only
      const hint = thread.kind === "task" && isNewOwnThread(thread, userId) ? templateHint(user, text) : null;
      const content = (await llmUserContent(core, userId, text, attachments)) + (hint ? `\n\n${hint}` : "");
      // everything below is synchronous until streamTurn, so the busy/steer decision can't race
      const now = core.now();
      const userMsgId = newId("m");
      const insertUserRow = (steered: boolean) => {
        db.insertMessage({ id: userMsgId, threadId: thread.id, role: "user", text, attachments, llm: [{ role: "user", content }], steered, createdAt: now });
        for (const a of attachments) db.setAttachmentThread(userId, a.id, thread.id);
      };

      const raw = deps.launcher.tryAcquire(userId);
      if (raw) return startTurn(c, holdLease(core, userId, thread.id, raw), thread, userId, userMsgId, content, mode, () => insertUserRow(false));

      // the agent is busy. Steer only into a turn running in THIS thread — never leak text into
      // another thread's turn (a friend thread, a schedule, a briefing).
      if (activeThreadOf(core, userId) !== thread.id) {
        // The first message of the owner's own new thread waits for the agent instead of 409: Explore's 맡기기 sends its
        // prompt right after delegate creates the thread, and a first message right after sign-up is the same race.
        if (isNewOwnThread(thread, userId) && queuedTurns(core, userId) < MAX_QUEUED_TURNS) {
          return streamQueuedTurn(core, c, { userId, threadId: thread.id, userText: content, mode, initiatedBy: "user", historyBeforeId: userMsgId }, () => {
            insertUserRow(false);
            db.touchThread(thread.id, now);
            publishMessage(core, userMsgId); // the person's other devices (this one merges it by id)
            return messageView(core, db.getMessage(userMsgId)!, userId);
          });
        }
        throw busyElsewhere(user.agent_name);
      }
      if (stillStopping || core.activeTurns.get(userId)?.stopping) throw new HttpError(409, "busy", "하던 일을 멈추는 중이에요. 잠시 후 다시 보내 주세요.");
      insertUserRow(true);
      if (deps.launcher.steer(userId, content)) {
        noteSteered(core, userId, userMsgId);
        const userMessage = messageView(core, db.getMessage(userMsgId)!, userId);
        db.touchThread(thread.id, now);
        // the person's other devices get the line too, so every device shows it in the same place (this one has it from
        // the 202 and merges the push by id)
        publishMessage(core, userMsgId);
        publishThread(core, thread.id);
        const res: SteeredResponse = { steered: true, userMessage };
        return json(res, 202);
      }
      // the running turn finished in between → take the lease and run normally
      const late = deps.launcher.tryAcquire(userId);
      if (!late) {
        db.sql.query("DELETE FROM messages WHERE id = $id").run({ id: userMsgId });
        throw busyElsewhere(user.agent_name);
      }
      return startTurn(c, holdLease(core, userId, thread.id, late), thread, userId, userMsgId, content, mode, () => {
        db.sql.query("UPDATE messages SET steered = 0 WHERE id = $id").run({ id: userMsgId });
      });
    },

    /**
     * The call cut a spoken reply off (the user talked over it): keep only what was heard in its history, so the next
     * turn knows the rest never reached them, and mark it with VOICE_NOTE (in place of a Stop note). Body {heard}: the
     * spoken text the user heard, a prefix of the reply's speakable text ("" = nothing). 204 when stored or nothing to
     * change (all heard, the same report again, a reply paused for approval); 404 when the reply isn't stored (the
     * client just drops the report); 409 when `heard` isn't how the reply begins.
     */
    heard: async (c: Ctx, userId: string) => {
      const thread = requireThread(core, c.params.id!, userId);
      if (thread.kind === "friend") throw forbidden("이 대화에서는 쓸 수 없어요", "friend_thread");
      const body = await readJson(c.req);
      if (typeof body.heard !== "string" || body.heard.length > HEARD_MAX_CHARS) throw bad("들은 내용이 올바르지 않아요", "bad_heard");
      const heard = body.heard;
      const messageId = c.params.messageId!;
      // A stopped turn stores its reply (and the cancel note) on the way out, and the client's abort may land a moment
      // after this report: wait for that turn to wind down first, so nothing rewrites the row after the cut.
      for (let waited = 0; waited < core.cfg.turnSettleMs + 2000; waited += HEARD_POLL_MS) {
        const cur = core.activeTurns.get(userId);
        if (!cur || cur.threadId !== thread.id) break;
        if (cur.stopping) {
          await waitForStoppedTurn(core, userId, core.cfg.turnSettleMs + 2000 - waited);
          break;
        }
        // stored and not being stopped: a finished turn on its way out, or a newer turn (the line that cut in)
        if (db.getMessage(messageId)) break;
        await new Promise((res) => setTimeout(res, HEARD_POLL_MS));
      }
      // from here on synchronous: read → cut → write
      const row = db.getMessage(messageId);
      if (!row || row.thread_id !== thread.id || row.role !== "assistant") throw notFound("메시지를 찾을 수 없어요", "message_not_found");
      const stored = safeJson<unknown>(row.llm_json, null);
      // [] = paused for approval: its messages travel with the approval, so there is nothing here to cut
      if (Array.isArray(stored) && stored.length === 0) return new Response(null, { status: 204 });
      if (!speechNorm(speakable(row.text)).startsWith(speechNorm(heard))) throw new HttpError(409, "heard_mismatch", "답과 맞지 않아요");
      const base: LlmMessage[] = Array.isArray(stored) ? (stored as LlmMessage[]) : [{ role: "assistant", content: row.text }];
      const cut = cutToHeard(base, heard);
      // talked over, not stopped with the button: the Stop note gives way to the voice note (history.ts VOICE_NOTE)
      const next = withVoiceNote(cut ?? base, !!cut);
      if (JSON.stringify(next) !== JSON.stringify(base)) db.setMessageLlm(row.id, next);
      return new Response(null, { status: 204 });
    },

    decide: async (c: Ctx, userId: string) => {
      const a = db.getApproval(userId, c.params.id!);
      if (!a) throw notFound("승인 요청을 찾을 수 없어요", "approval_not_found");
      const body = await readJson(c.req);
      const decision = body.decision;
      if (decision !== "approve" && decision !== "reject") throw bad("decision은 approve 또는 reject여야 해요", "invalid_decision");
      if (a.status !== "pending") throw new HttpError(409, "already_decided", "이미 처리된 요청이에요");
      const now = core.now();
      const spec = safeJson<{ title: string; detail: string; amount?: number }>(a.spec_json, { title: "승인 요청", detail: "" });
      if (a.expires_at <= now) {
        if (db.resolveApproval(userId, a.id, "expired", now, null, false)) setApprovalCardStatus(a.message_id, a.id, "expired");
        throw new HttpError(410, "approval_expired", "승인 요청 시간이 지났어요. 다시 부탁해 주세요.");
      }

      let deviceVerified = false;
      const nonce = typeof body.nonce === "string" ? body.nonce : null;
      if (body.signature !== undefined) {
        if (typeof body.signature !== "string" || typeof body.deviceId !== "string" || !nonce || nonce.length > 128 || body.signature.length > 256)
          throw bad("기기 서명 정보가 올바르지 않아요", "invalid_signature");
        const device = db.getDevice(userId, body.deviceId);
        if (!device) throw bad("등록되지 않은 기기예요", "unknown_device");
        let ok = false;
        try {
          ok = await deps.verifyApproval(JSON.parse(device.signing_jwk) as JsonWebKey, a.id, nonce, body.signature);
        } catch (err) {
          core.log.warn("verifyApproval error", { err: errInfo(err) });
          ok = false;
        }
        if (!ok) throw forbidden("기기 서명을 확인하지 못했어요", "bad_signature");
        deviceVerified = true;
      }

      const call = parseCall(a.call_json);
      if (!call) throw new HttpError(500, "internal", "승인 요청 정보가 손상됐어요");
      const thread = db.threadFor(a.thread_id, userId);
      if (!thread) throw notFound("대화를 찾을 수 없어요", "thread_not_found");
      if (thread.kind === "friend") {
        // resuming would post into the shared thread: only while still friends
        const peerId = db.threadMembers(thread.id).find((id) => id !== userId);
        if (!peerId || !areFriends(core, userId, peerId)) throw forbidden("메시지를 보낼 수 없는 친구예요", "not_friends");
      }
      if (decision === "approve" && quotaExceeded(core, userId)) throw new HttpError(429, "quota_exceeded", QUOTA_MESSAGE);
      if (!deps.runTurn) throw new HttpError(503, "llm_not_configured", "AI 서버 설정이 아직 안 됐어요. 관리자에게 알려 주세요.");

      // the vault record is the only await below; it runs while we hold the lease and is guarded
      const raw = deps.launcher.tryAcquire(userId);
      if (!raw) throw new HttpError(409, "busy", `${iGa(db.userById(userId)?.agent_name ?? "모시")} 다른 일을 하고 있어요. 잠시 후 다시 눌러 주세요.`);
      const lease = holdLease(core, userId, thread.id, raw);
      try {
        if (!db.resolveApproval(userId, a.id, decision === "approve" ? "approved" : "rejected", now, nonce, deviceVerified))
          throw new HttpError(409, "already_decided", "이미 처리된 요청이에요");
        setApprovalCardStatus(a.message_id, a.id, decision === "approve" ? "approved" : "rejected");
        const svc = serviceOfCall(core, call.function.name, call.function.arguments);
        try {
          await deps.vault.record(userId, {
            credentialId: null,
            service: svc.id,
            serviceName: svc.name,
            action: "approval",
            purpose: spec.title,
            actor: "user",
            outcome: decision === "approve" ? "ok" : "denied",
            deviceVerified,
          });
        } catch (err) {
          core.log.warn("access record failed", { err: errInfo(err) });
        }
        core.log.info("approval decided", { user: userId, approval: a.id, decision, deviceVerified });
        return streamTurn(core, c, {
          userId,
          threadId: thread.id,
          userText: null,
          userMessage: null,
          mode: "text",
          lease,
          initiatedBy: "user",
          resume: { call, decision, priorMessages: safeJson<LlmMessage[]>(a.prior_messages_json, []), pausedMessageId: a.message_id },
        });
      } catch (err) {
        lease.release();
        throw err;
      }
    },
  };

  /**
   * Persists the user row (`prepare`), pushes it to the person's other devices (`message`; the sending one has it from
   * the stream's `start` and merges the push by id) and streams the turn; frees the lease on any failure.
   */
  function startTurn(c: Ctx, lease: HeldLease, thread: ThreadRow, userId: string, userMsgId: string, content: string, mode: "text" | "voice", prepare: () => void): Response {
    try {
      prepare();
      const now = core.now();
      db.touchThread(thread.id, now);
      publishMessage(core, userMsgId);
      const userMessage = messageView(core, db.getMessage(userMsgId)!, userId);
      return streamTurn(core, c, {
        userId,
        threadId: thread.id,
        userText: content,
        userMessage,
        mode,
        lease,
        initiatedBy: "user",
        historyBeforeId: userMsgId,
      });
    } catch (err) {
      lease.release();
      throw err;
    }
  }

  function setApprovalCardStatus(messageId: string, approvalId: string, status: "approved" | "rejected" | "expired"): void {
    const row = db.getMessage(messageId);
    if (!row) return;
    const cards = safeJson<Card[]>(row.cards_json, []);
    // the moment of the decision rides on the card, so the receipt's "오전 10:02에 승인했어요" survives a reload (an expiry
    // is not a decision)
    const decidedAt = status === "expired" ? undefined : core.now();
    const next = cards.map((card) =>
      card.type === "approval" && card.approvalId === approvalId ? { ...card, status, ...(decidedAt !== undefined ? { decidedAt } : {}) } : card,
    );
    db.updateMessageCards(messageId, next);
    // tool chip: needs_approval → done/error is reported by the resumed turn; reflect decision now
    publishMessage(core, messageId);
    publishThread(core, row.thread_id); // the drawer's `waiting` turns off
  }

  /**
   * Shared friend thread: the human message is stored once (visible to both). If it calls the
   * sender's agent by name (or starts with "@"), the sender's agent answers in the thread (SSE);
   * otherwise the server answers `201 {delivered:true, userMessage}`.
   */
  async function sendToFriendThread(c: Ctx, userId: string, thread: ThreadRow, text: string, attachments: AttachmentRef[], mode: "text" | "voice"): Promise<Response> {
    const peerId = db.threadMembers(thread.id).find((id) => id !== userId);
    if (!peerId || !areFriends(core, userId, peerId)) throw forbidden("메시지를 보낼 수 없는 친구예요", "not_friends");
    const me = db.userById(userId)!;
    const wantsAgent = mentionsAgent(text, me.agent_name);
    if (wantsAgent) {
      if (quotaExceeded(core, userId)) throw new HttpError(429, "quota_exceeded", QUOTA_MESSAGE);
      if (!deps.runTurn) throw new HttpError(503, "llm_not_configured", "AI 서버 설정이 아직 안 됐어요. 관리자에게 알려 주세요.");
    }
    const raw = wantsAgent ? deps.launcher.tryAcquire(userId) : null;
    if (wantsAgent && !raw) throw busyElsewhere(me.agent_name);
    const lease = raw ? holdLease(core, userId, thread.id, raw) : null;
    try {
      const now = core.now();
      const id = newId("m");
      db.tx(() => {
        db.insertMessage({ id, threadId: thread.id, role: "user", text, attachments, authorUserId: userId, authorKind: "human", createdAt: now });
        db.touchThread(thread.id, now, preview(`${me.display_name}: ${text}`));
        db.setUnread(thread.id, peerId, true);
      });
      // the friend and the sender's own other devices (the sending one merges it by id with the 201 / start); a line that
      // reached the friend without a turn (the 201 below) tells the sender's devices it was delivered
      publishMessage(core, id, { delivered: !lease });
      publishThread(core, thread.id);
      const peer = db.userById(peerId);
      if (peer && settingsOf(peer).notifications.friendMessages) {
        core.events.publish(peerId, { type: "notification", title: `${me.display_name} 님`, body: preview(text, 80), threadId: thread.id, icon: "people" });
      }
      const userMessage = messageView(core, db.getMessage(id)!, userId);
      if (!lease) return json({ delivered: true, userMessage }, 201);
      return streamTurn(core, c, {
        userId,
        threadId: thread.id,
        userText: `[${me.display_name} 님] ${text}`,
        userMessage,
        mode,
        lease,
        initiatedBy: "user",
        historyBeforeId: id,
      });
    } catch (err) {
      lease?.release();
      throw err;
    }
  }

  /** The owner's own thread with nobody's request in it yet (only the agent's greeting, if any): a send may queue. */
  function isNewOwnThread(thread: ThreadRow, userId: string): boolean {
    if (thread.owner_id !== userId || thread.kind === "friend") return false;
    return !db.sql.query(`SELECT 1 FROM messages WHERE thread_id = ? AND role IN ('user', 'event') LIMIT 1`).get(thread.id);
  }

  /** 409 when the agent is working elsewhere (another thread, a schedule, a briefing). */
  function busyElsewhere(agentName: string): HttpError {
    return new HttpError(409, "busy", `${iGa(agentName)} 다른 일을 하고 있어요. 끝나면 다시 보내 주세요.`);
  }
}

/** Which service an approval was for (for the access log). */
export function serviceOfCall(core: Core, toolName: string, argsJson: string): { id: string; name: string } {
  const args = safeJson<Record<string, unknown>>(argsJson, {});
  if (toolName === "sys_phone_call") return { id: "phone", name: "전화" };
  if (toolName === "sys_friend_message") return { id: "pickle-friends", name: "모시 친구" };
  if (toolName.startsWith("msg_") && typeof args.provider === "string") {
    let name = args.provider;
    try {
      name = core.deps.providers().find((p) => p.id === args.provider)?.name ?? args.provider;
    } catch {
      /* ignore */
    }
    return { id: args.provider, name };
  }
  return { id: "pickle", name: "모시" };
}

