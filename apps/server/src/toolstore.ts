/** ToolStore adapter: the slice of server persistence that agent tools may touch (user-scoped). */
import { FileLookupError, type ToolStore } from "@pickle/agent";
import type { ArtifactRow } from "./db/index.ts";
import type { Core } from "./core.ts";
import { createScheduleFor, listHuman } from "./schedules.ts";
import { fileChars, fileReader, findFile } from "./archive.ts";
import { listAcceptedFriends, messageFriend } from "./friends.ts";
import { newId } from "./util.ts";
import { cleanArtifactHtml, MAX_ARTIFACT_HTML_BYTES, MAX_ARTIFACT_HTML_CARD_BYTES } from "./artifactHtml.ts";

const ARTIFACT_KINDS = new Set<ArtifactRow["kind"]>(["document", "dashboard", "table", "checklist", "html"]);
const MAX_ARTIFACT_BYTES = 256 * 1024;
/** an agent-rendered card as handed over: bounded before cleaning, held to MAX_ARTIFACT_HTML_CARD_BYTES after */
const MAX_AGENT_CARD_INPUT_BYTES = 512 * 1024;
const MAX_KV_KEY = 64;
const MAX_KV_VALUE = 4096;

export function makeToolStore(core: Core, userId: string, threadId: string): ToolStore {
  const { db, deps } = core;
  // one reader a turn (a store is made per turn): its 60,000-character budget is the turn's
  const readFile = fileReader(core, userId, threadId);
  return {
    async readFile(q) {
      return readFile(q);
    },

    async createArtifact(a, opts) {
      const kind = ARTIFACT_KINDS.has(a.kind) ? a.kind : "document";
      const title = String(a.title ?? "").trim().slice(0, 120) || "제목 없는 문서";
      let content = String(a.content ?? "");
      // an html card the agent's own code rendered (deep search '전부' rows; never a tool argument): 300 KB cleaned
      const agentCard = kind === "html" && opts?.agentCard === true;
      const inBytes = Buffer.byteLength(content);
      if (agentCard ? inBytes > MAX_AGENT_CARD_INPUT_BYTES : inBytes > MAX_ARTIFACT_BYTES) throw new Error(agentCard ? "화면이 너무 커요 (300KB 이하)" : "문서가 너무 커요 (256KB 이하)");
      let html: Omit<ReturnType<typeof cleanArtifactHtml>, "html"> & { content: string } | undefined;
      if (kind === "html") {
        // what the model sent is bounded; the stored copy is the cleaned one (escaping can grow it a little)
        if (!agentCard && inBytes > MAX_ARTIFACT_HTML_BYTES) throw new Error("화면이 너무 커요 (150KB 이하)");
        const r = cleanArtifactHtml(content);
        if (agentCard && Buffer.byteLength(r.html) > MAX_ARTIFACT_HTML_CARD_BYTES) throw new Error("화면이 너무 커요 (300KB 이하)");
        if (!/<[a-zA-Z]/.test(r.html)) throw new Error("화면에 남은 내용이 없어요 (스크립트·외부 자원만 있었어요)");
        content = r.html;
        html = { content, removed: r.removed, tuned: r.tuned };
      }
      if (kind === "dashboard") {
        try {
          JSON.parse(content);
        } catch {
          throw new Error('대시보드 내용은 {"widgets":[...]} 형식의 JSON이어야 해요');
        }
      }
      const id = newId("a");
      db.insertArtifact({ id, userId, threadId, title, kind, content, now: core.now() });
      return html ? { id, html } : { id };
    },

    async createSchedule(s) {
      // a file: the person's own text file, found here as sys_file_read finds it (in a friend thread, one they sent there)
      let attachmentId: string | null = null;
      let chars = 0;
      const name = String(s.file ?? "").trim();
      if (name) {
        const found = findFile(core, userId, threadId, name, true);
        if (!("row" in found)) throw new FileLookupError(found);
        attachmentId = found.row.id;
        chars = fileChars(core, found.row);
      }
      const row = createScheduleFor(core, userId, { title: s.title, prompt: s.prompt, rule: s.rule, threadId: null, attachmentId });
      return { id: row.id, human: row.human, nextRunAt: row.next_run_at, ...(row.attachment_name ? { file: { name: row.attachment_name, chars } } : {}) };
    },

    async listSchedules() {
      // the list's own words: weekday and 이번 주 / 다음 주 for one-offs (listHuman); the stored human stays the app's
      const now = core.now();
      return db.listSchedules(userId).map((s) => ({ id: s.id, title: s.title, human: listHuman(s, now), enabled: s.enabled === 1 }));
    },

    async deleteSchedule(id) {
      return db.deleteSchedule(userId, String(id));
    },

    async remember(text) {
      const t = String(text ?? "").trim().slice(0, 500);
      if (!t) return;
      // runTurn already emits an in-stream `memory` event for this tool call
      await deps.launcher.remember(userId, t);
    },

    async recall(query, limit) {
      return deps.launcher.recall(userId, String(query ?? ""), Math.min(10, Math.max(1, limit ?? 5)));
    },

    async messageFriend(friendHandleOrName, text) {
      return messageFriend(core, userId, String(friendHandleOrName ?? ""), String(text ?? ""));
    },

    async listFriends() {
      return listAcceptedFriends(core, userId).map((f) => ({ handle: f.handle, displayName: f.display_name, agentName: f.agent_name }));
    },

    kv: {
      async get(key) {
        const k = String(key ?? "").slice(0, MAX_KV_KEY);
        return k ? db.kvGet(userId, `t:${k}`) : null;
      },
      async set(key, value) {
        const k = String(key ?? "").slice(0, MAX_KV_KEY);
        if (!k) return;
        db.kvSet(userId, `t:${k}`, String(value ?? "").slice(0, MAX_KV_VALUE), core.now());
      },
    },
  };
}
