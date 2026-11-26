/**
 * Schedules: rule parsing (`daily@HH:MM`, `weekly@1,3,5@HH:MM` with 1=Mon … 7=Sun,
 * `once@<ISO|epoch>`), KST next-run computation, Korean human text, CRUD routes, and the
 * 30-second scheduler tick that runs due schedules and each user's daily briefing.
 */
import type { Schedule } from "@pickle/protocol";
import type { ScheduleRow } from "./db/index.ts";
import { publishMessage, settingsOf, quotaExceeded, type Core } from "./core.ts";
import { DAY_MS, koreanTime, kstDate, kstParts, kstToEpoch } from "./kst.ts";
import { answeredAfter, deleteMessageRow, holdLease, runSystemTurn, type HeldLease, type TurnResult } from "./turns.ts";
import { bad, json, notFound, readJson, type Ctx, HttpError } from "./http.ts";
import { eulReul, newId } from "./util.ts";
import { errInfo } from "./log.ts";
import { READ_TEXT_MIMES, scheduleFileNote, switchOffGoneSchedule } from "./archive.ts";

export class ScheduleError extends Error {}

export type ParsedRule =
  | { kind: "daily"; hour: number; minute: number; canonical: string }
  | { kind: "weekly"; days: number[]; hour: number; minute: number; canonical: string }
  | { kind: "once"; at: number; canonical: string };

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const WEEKDAY = ["", "월", "화", "수", "목", "금", "토", "일"];
const pad = (n: number) => String(n).padStart(2, "0");

function parseTime(s: string): { hour: number; minute: number } {
  const m = HHMM.exec(s.trim());
  if (!m) throw new ScheduleError("시간은 HH:MM 형식이어야 해요 (예: 07:30)");
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Parses a rule. ISO times without an offset are read as KST. */
export function parseRule(rule: string): ParsedRule {
  const r = String(rule ?? "").trim();
  const [head, ...rest] = r.split("@");
  switch (head) {
    case "daily": {
      if (rest.length !== 1) break;
      const t = parseTime(rest[0]!);
      return { kind: "daily", ...t, canonical: `daily@${pad(t.hour)}:${pad(t.minute)}` };
    }
    case "weekly": {
      if (rest.length !== 2) break;
      const days = [...new Set(rest[0]!.split(",").map((d) => Number(d.trim())))].sort((a, b) => a - b);
      if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw new ScheduleError("요일은 1(월)~7(일) 숫자로 적어 주세요");
      const t = parseTime(rest[1]!);
      return { kind: "weekly", days, ...t, canonical: `weekly@${days.join(",")}@${pad(t.hour)}:${pad(t.minute)}` };
    }
    case "once": {
      const v = rest.join("@").trim();
      let at: number;
      if (/^\d{10}$/.test(v)) at = Number(v) * 1000;
      else if (/^\d{12,14}$/.test(v)) at = Number(v);
      else {
        const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(v);
        if (local) at = kstToEpoch(+local[1]!, +local[2]!, +local[3]!, +local[4]!, +local[5]!) + (local[6] ? +local[6] * 1000 : 0);
        else at = Date.parse(v);
      }
      if (!Number.isFinite(at)) throw new ScheduleError("날짜 형식이 올바르지 않아요");
      return { kind: "once", at, canonical: `once@${at}` };
    }
  }
  throw new ScheduleError("규칙 형식이 올바르지 않아요 (daily@07:30, weekly@1,3,5@09:00, once@2026-11-12T15:00)");
}

/** First run strictly after `after` (null when a one-off time has passed). */
export function nextRunAt(rule: ParsedRule, after: number): number | null {
  if (rule.kind === "once") return rule.at > after ? rule.at : null;
  const p = kstParts(after);
  for (let i = 0; i <= 7; i++) {
    const t = kstToEpoch(p.year, p.month, p.day + i, rule.hour, rule.minute);
    if (t <= after) continue;
    if (rule.kind === "daily") return t;
    if (rule.days.includes(kstParts(t).weekday)) return t;
  }
  return null;
}

export function humanRule(rule: ParsedRule, now: number): string {
  if (rule.kind === "daily") return `매일 ${koreanTime(rule.hour, rule.minute)}`;
  if (rule.kind === "weekly") {
    const d = rule.days.join(",");
    const label = d === "1,2,3,4,5,6,7" ? "매일" : d === "1,2,3,4,5" ? "평일" : d === "6,7" ? "주말" : rule.days.map((x) => WEEKDAY[x]).join("·");
    return `${label} ${koreanTime(rule.hour, rule.minute)}`;
  }
  const p = kstParts(rule.at);
  const year = p.year !== kstParts(now).year ? `${p.year}년 ` : "";
  return `${year}${p.month}월 ${p.day}일 ${koreanTime(p.hour, p.minute)}`;
}

/** KST day number of the Monday of `ms`'s week (Mon–Sun) */
const mondayOf = (ms: number) => Math.floor((ms + 9 * 3600_000) / DAY_MS) - (kstParts(ms).weekday - 1);

/**
 * A one-off's words in the agent's schedule list, read at list time: its weekday and, in the week (KST Mon–Sun) that
 * holds today or the next one, 이번 주 / 다음 주 ('11월 23일 (월) 오전 10:00 · 다음 주'; later or past weeks: the date
 * alone). On a Monday, models counted next Monday's meeting into the card's '이번 주 3건' (4 of 6 cards,
 * design-director, 2026-11-16). Repeating rules keep their words, and the stored `human` (the app's, the API's) stays.
 */
export function listHuman(s: Pick<ScheduleRow, "rule" | "human">, now: number): string {
  let rule: ParsedRule;
  try {
    rule = parseRule(s.rule);
  } catch {
    return s.human;
  }
  if (rule.kind !== "once") return s.human;
  const p = kstParts(rule.at);
  const year = p.year !== kstParts(now).year ? `${p.year}년 ` : "";
  const weeks = (mondayOf(rule.at) - mondayOf(now)) / 7;
  const tag = weeks === 0 ? " · 이번 주" : weeks === 1 ? " · 다음 주" : "";
  return `${year}${p.month}월 ${p.day}일 (${WEEKDAY[p.weekday]}) ${koreanTime(p.hour, p.minute)}${tag}`;
}

/** `fileGone`: the attached file was deleted (the view says so in place of its name, DD 1852) */
export function scheduleView(s: ScheduleRow, fileGone = false): Schedule {
  return {
    id: s.id,
    title: s.title,
    prompt: s.prompt,
    rule: s.rule,
    human: s.human,
    enabled: s.enabled === 1,
    threadId: s.thread_id,
    lastRunAt: s.last_run_at,
    nextRunAt: s.next_run_at,
    createdAt: s.created_at,
    ...(s.attachment_id ? { file: { name: s.attachment_name ?? "", ...(fileGone ? { deleted: true as const } : {}) } } : {}),
  };
}

/** a deleted file's run told the person (DD 2014): an answer stored whole — not after an error or a Stop */
export const toldGone = (res: TurnResult): boolean => !!res.message && !res.error && !res.aborted;

const fileGone = (core: Core, s: ScheduleRow) => !!s.attachment_id && !core.db.getAttachment(s.user_id, s.attachment_id);
const viewOf = (core: Core, s: ScheduleRow) => scheduleView(s, fileGone(core, s));

const MAX_SCHEDULES = 50;

/** Validates and stores a schedule (routes + ToolStore). Throws ScheduleError with Korean text. */
export function createScheduleFor(
  core: Core,
  userId: string,
  s: { title: unknown; prompt: unknown; rule: unknown; enabled?: boolean; threadId: string | null; attachmentId?: string | null },
): ScheduleRow {
  const title = String(s.title ?? "").trim().slice(0, 60);
  const prompt = String(s.prompt ?? "").trim().slice(0, 2000);
  if (!title) throw new ScheduleError("일정 이름이 필요해요");
  if (!prompt) throw new ScheduleError("무엇을 할지(prompt)가 필요해요");
  if (core.db.listSchedules(userId).length >= MAX_SCHEDULES) throw new ScheduleError(`예약은 최대 ${MAX_SCHEDULES}개까지 만들 수 있어요`);
  // the attached file: one of this person's own text files, nobody else's (a friend's file id is as unknown as any other)
  let attachment: { id: string; name: string } | null = null;
  if (s.attachmentId != null) {
    const a = typeof s.attachmentId === "string" ? core.db.getAttachment(userId, s.attachmentId) : null;
    if (!a || !READ_TEXT_MIMES.has(a.mime)) throw new ScheduleError("보관함에서 그 텍스트 파일을 찾지 못했어요");
    attachment = { id: a.id, name: a.filename };
  }
  const now = core.now();
  const parsed = parseRule(String(s.rule ?? ""));
  const next = nextRunAt(parsed, now);
  if (parsed.kind === "once" && next === null) throw new ScheduleError("이미 지난 시간이에요");
  const id = newId("s");
  core.db.insertSchedule({
    id,
    userId,
    title,
    prompt,
    rule: parsed.canonical,
    human: humanRule(parsed, now),
    enabled: s.enabled !== false,
    threadId: s.threadId,
    nextRunAt: s.enabled === false ? null : next,
    now,
    attachment,
  });
  return core.db.getSchedule(userId, id) as ScheduleRow;
}

// ───────────────────────────── routes ─────────────────────────────

export function scheduleRoutes(core: Core) {
  const wrap = (fn: () => Response): Response => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ScheduleError) throw bad(err.message, "invalid_schedule");
      throw err;
    }
  };
  return {
    list: (_c: Ctx, userId: string) => json(core.db.listSchedules(userId).map((s) => viewOf(core, s))),
    create: async (c: Ctx, userId: string) => {
      const body = await readJson(c.req);
      let threadId: string | null = null;
      if (typeof body.threadId === "string") {
        const t = core.db.threadFor(body.threadId, userId);
        if (!t) throw notFound("대화를 찾을 수 없어요");
        // a schedule would post into the shared thread on its own, even after a block
        if (t.kind === "friend") throw bad("친구와 함께 쓰는 대화방에는 예약을 걸 수 없어요", "invalid_schedule");
        threadId = body.threadId;
      }
      if (body.attachmentId !== undefined && body.attachmentId !== null && typeof body.attachmentId !== "string") throw bad("attachmentId는 문자열이어야 해요", "invalid_schedule");
      const attachmentId = typeof body.attachmentId === "string" ? body.attachmentId : null;
      return wrap(() =>
        json(
          viewOf(core, createScheduleFor(core, userId, { title: body.title, prompt: body.prompt, rule: body.rule, enabled: body.enabled !== false, threadId, attachmentId })),
          201,
        ),
      );
    },
    patch: async (c: Ctx, userId: string) => {
      const cur = core.db.getSchedule(userId, c.params.id!);
      if (!cur) throw notFound("예약을 찾을 수 없어요");
      const body = await readJson(c.req);
      return wrap(() => {
        const title = body.title !== undefined ? String(body.title).trim().slice(0, 60) : cur.title;
        const prompt = body.prompt !== undefined ? String(body.prompt).trim().slice(0, 2000) : cur.prompt;
        if (!title || !prompt) throw new ScheduleError("이름과 내용은 비워 둘 수 없어요");
        if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new ScheduleError("enabled는 true/false여야 해요");
        const enabled = body.enabled !== undefined ? (body.enabled as boolean) : cur.enabled === 1;
        // its file was deleted: it stays off (DD 2014); a new upload and a new schedule bring it back
        if (enabled && cur.enabled !== 1 && fileGone(core, cur))
          throw new HttpError(409, "schedule_file_deleted", "지시 파일을 지워서 이 예약은 다시 켤 수 없어요. 파일을 다시 올리고 예약을 새로 만들어 주세요.");
        const now = core.now();
        const parsed = parseRule(body.rule !== undefined ? String(body.rule) : cur.rule);
        const next = enabled ? nextRunAt(parsed, now) : null;
        if (enabled && parsed.kind === "once" && next === null) throw new ScheduleError("이미 지난 시간이에요");
        core.db.updateSchedule(userId, cur.id, { title, prompt, rule: parsed.canonical, human: humanRule(parsed, now), enabled, nextRunAt: next });
        return json(viewOf(core, core.db.getSchedule(userId, cur.id)!));
      });
    },
    remove: (c: Ctx, userId: string) => {
      if (!core.db.deleteSchedule(userId, c.params.id!)) throw notFound("예약을 찾을 수 없어요");
      return json({ ok: true });
    },
  };
}

// ───────────────────────────── scheduler ─────────────────────────────

const BRIEFING_WINDOW_MS = 2 * 60 * 60 * 1000;
/** A briefing that left nothing (the model call failed) is tried again inside its window: this many attempts a day at most, the first included… */
const BRIEFING_TRIES = 3;
/** …at least this far apart. */
const BRIEFING_RETRY_MS = 20 * 60 * 1000;
const ACTIVE_WINDOW_MS = 7 * DAY_MS;
const MAX_RUNS_PER_TICK = 25;

export function briefingPrompt(core: Core, userId: string): string {
  const user = core.db.userById(userId)!;
  const location = core.db.kvGet(userId, "t:location") || "서울";
  const now = core.now();
  const today = kstDate(now);
  const todays = core.db
    .listSchedules(userId)
    .filter((s) => s.enabled === 1 && s.next_run_at !== null && kstDate(s.next_run_at) === today)
    .map((s) => `${s.title} (${s.human})`);
  return [
    `[자동 아침 브리핑] ${user.display_name} 님에게 오늘의 브리핑을 준비해 주세요.`,
    `1. k_weather로 '${location}'의 오늘 날씨(현재 기온, 최고·최저, 강수)를 확인하세요. 가능하면 k_fine_dust로 미세먼지도 확인하세요.`,
    "2. k_news로 오늘 주요 뉴스 3개를 골라 한 줄씩 요약하세요.",
    `3. 오늘 예약된 일: ${todays.length ? todays.join(", ") : "없음"}`,
    "4. 마지막에 sys_show_briefing으로 '오늘의 브리핑' 카드를 보여 주세요. 날씨·뉴스·일정을 항목으로 넣고, 이어서 물어볼 만한 항목에는 action(send)을 붙이세요.",
    "아침 인사로 짧고 따뜻하게 시작하세요.",
  ].join("\n");
}

/**
 * kv `sys:briefing_try`: today's briefing attempts. Written as "running" before each turn (next to `sys:briefing_day`,
 * the day's started mark, as before); after it "failed" with the time the next attempt may start, or "done" (answered,
 * out of attempts, past the window, or the person sent something in between).
 */
interface BriefingTry {
  day: string;
  /** attempts started today */
  n: number;
  /** when the first one started (a send after it ends the retries) */
  first: number;
  /** when the latest one started */
  at: number;
  state: "running" | "failed" | "done";
  next: number | null;
  /** the latest attempt's event row */
  event: string;
}

const TRY_KEY = "sys:briefing_try";

function readTry(core: Core, userId: string): BriefingTry | null {
  try {
    const v = JSON.parse(core.db.kvGet(userId, TRY_KEY) ?? "null") as BriefingTry | null;
    return v && typeof v === "object" && typeof v.day === "string" ? v : null;
  } catch {
    return null;
  }
}

function writeTry(core: Core, userId: string, t: BriefingTry, now: number): void {
  core.db.kvSet(userId, TRY_KEY, JSON.stringify(t), now);
}

/** What a briefing attempt left: an answer (text or a card on screen, even if an error came after it), a Stop, or nothing. */
export function briefingResult(res: TurnResult): "answered" | "stopped" | "failed" {
  const m = res.message;
  if (m && (m.text.trim() || m.cards.length)) return "answered";
  if (res.aborted) return "stopped";
  return "failed";
}

/**
 * Has the person been working in the app since `since`: sent anything (any thread, a line steered into a turn included)
 * or answered an approval card (approve or reject; not one that expired)?
 */
function sentSince(core: Core, userId: string, since: number): boolean {
  const q = { u: userId, s: since };
  return (
    !!core.db.sql
      .query(
        `SELECT 1 FROM messages m JOIN thread_members tm ON tm.thread_id = m.thread_id AND tm.user_id = $u
         WHERE m.role = 'user' AND m.created_at >= $s AND (m.author_user_id IS NULL OR m.author_user_id = $u) LIMIT 1`,
      )
      .get(q) ||
    !!core.db.sql.query(`SELECT 1 FROM approvals WHERE user_id = $u AND resolved_at >= $s AND status IN ('approved', 'rejected') LIMIT 1`).get(q)
  );
}

const hhmm = (ms: number) => {
  const p = kstParts(ms);
  return `${pad(p.hour)}:${pad(p.minute)}`;
};

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** users whose briefing attempt runs in this process (a "running" mark of anyone else was left by a stopped server) */
  private briefing = new Set<string>();

  constructor(private core: Core) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.core.log.error("scheduler tick failed", { err: errInfo(err) }));
    }, this.core.cfg.schedulerIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs everything that is due now; resolves when the started turns finish. */
  async tick(): Promise<{ schedules: number; briefings: number }> {
    const now = this.core.now();
    const jobs: Promise<boolean>[] = [];
    const seen = new Set<string>();
    // overdue schedules of busy users stay due; look past them so they can't starve everyone else
    for (const s of this.core.db.dueSchedules(now, 500)) {
      if (jobs.length >= MAX_RUNS_PER_TICK) break;
      if (seen.has(s.user_id)) continue; // one turn per user per tick
      const raw = this.core.deps.launcher.tryAcquire(s.user_id);
      if (!raw) continue; // busy → retried next tick
      seen.add(s.user_id);
      jobs.push(this.runSchedule(s, now, holdLease(this.core, s.user_id, null, raw)));
    }
    const scheduleCount = jobs.length;
    jobs.push(...this.briefings(now));
    const results = await Promise.allSettled(jobs);
    const ran = results.map((r) => r.status === "fulfilled" && r.value);
    return { schedules: ran.slice(0, scheduleCount).filter(Boolean).length, briefings: ran.slice(scheduleCount).filter(Boolean).length };
  }

  private ensureThread(s: ScheduleRow): string {
    const { db } = this.core;
    const existing = s.thread_id ? db.threadFor(s.thread_id, s.user_id) : null;
    if (existing && existing.kind !== "friend") return existing.id;
    const user = db.userById(s.user_id)!;
    const id = newId("t");
    db.createThread({ id, ownerId: s.user_id, kind: "schedule", title: s.title, subtitle: `${user.agent_name}의 예약된 일`, icon: "clock", now: this.core.now() }, [s.user_id]);
    db.setScheduleThread(s.id, id);
    return id;
  }

  private async runSchedule(s: ScheduleRow, now: number, lease: HeldLease): Promise<boolean> {
    const { core } = this;
    try {
      let parsed: ParsedRule | null = null;
      try {
        parsed = parseRule(s.rule);
      } catch {
        parsed = null;
      }
      core.db.markScheduleRun(s.id, now, parsed ? nextRunAt(parsed, now) : null);
      const user = core.db.userById(s.user_id);
      if (!user) {
        lease.release();
        return false;
      }
      const settings = settingsOf(user);
      if (quotaExceeded(core, s.user_id)) {
        lease.release();
        core.events.publish(s.user_id, {
          type: "notification",
          title: "예약된 일을 건너뛰었어요",
          body: `오늘 사용량 한도가 다 차서 ${eulReul(s.title)} 실행하지 못했어요.`,
          icon: "clock",
        });
        return false;
      }
      const threadId = this.ensureThread(s);
      lease.bindThread(threadId);
      // an attached file: its text after the prompt for the model; the event row keeps its name only (archive.ts)
      const withFile = scheduleFileNote(core, s.user_id, s);
      const res = await runSystemTurn(core, {
        userId: s.user_id,
        threadId,
        prompt: withFile?.prompt ?? s.prompt,
        ...(withFile ? { stored: withFile.stored } : {}),
        eventText: `${s.title} · ${s.human}`,
        lease,
        notify: { title: s.title, icon: "clock", enabled: settings.notifications.taskDone },
      });
      // the file is gone and the answer that says so is stored: off now, cards too (a failed or stopped run leaves it on)
      if (withFile?.gone && toldGone(res)) {
        for (const id of switchOffGoneSchedule(core, s.user_id, s.id)) publishMessage(core, id);
      }
      return true;
    } catch (err) {
      core.log.error("schedule run failed", { schedule: s.id, err: errInfo(err) });
      try {
        lease.release();
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  private briefings(now: number): Promise<boolean>[] {
    const { core } = this;
    const out: Promise<boolean>[] = [];
    const today = kstDate(now);
    const p = kstParts(now);
    for (const user of core.db.activeUsers(now - ACTIVE_WINDOW_MS)) {
      const settings = settingsOf(user);
      if (!settings.notifications.briefing || !user.main_thread_id) continue;
      // never on the sign-up day (KST): the welcome message covers it, and a briefing turn right after sign-up held
      // the agent while the person's first sends and approvals got 409 busy. It starts the next morning.
      if (kstDate(user.created_at) === today) continue;
      const [hh, mm] = settings.notifications.briefingTime.split(":").map(Number) as [number, number];
      const target = kstToEpoch(p.year, p.month, p.day, hh, mm);
      const end = target + BRIEFING_WINDOW_MS;
      if (now < target || now > end) continue;
      let n = 1;
      let first = now;
      if (core.db.kvGet(user.id, "sys:briefing_day") === today) {
        const t = this.retryDue(user.id, user.main_thread_id, today, now, end);
        if (!t) continue;
        n = t.n + 1;
        first = t.first;
      }
      // busy or over the daily quota: not an attempt, looked at again on the next tick
      if (quotaExceeded(core, user.id)) continue;
      const raw = core.deps.launcher.tryAcquire(user.id);
      if (!raw) continue;
      const threadId = user.main_thread_id;
      const lease = holdLease(core, user.id, threadId, raw);
      const started: BriefingTry = { day: today, n, first, at: now, state: "running", next: null, event: newId("m") };
      core.db.tx(() => {
        core.db.kvSet(user.id, "sys:briefing_day", today, now);
        writeTry(core, user.id, started, now);
      });
      this.briefing.add(user.id);
      out.push(
        runSystemTurn(core, {
          userId: user.id,
          threadId,
          prompt: briefingPrompt(core, user.id),
          eventText: "오늘의 브리핑",
          lease,
          notify: { title: "오늘의 브리핑", icon: "sun", enabled: true },
          retryable: true,
          eventId: started.event,
        })
          .then((r) => this.settleBriefing(user.id, started, end, briefingResult(r), r.error?.error ?? "empty_reply"))
          .catch((err) => {
            lease.release();
            // a throw after the answer was stored (while publishing, say) is no failure: never send it twice
            if (answeredAfter(core, threadId, started.event)) {
              core.log.error("briefing error after answer", { user: user.id, attempt: n, err: errInfo(err) });
              return this.settleBriefing(user.id, started, end, "answered", "internal");
            }
            return this.settleBriefing(user.id, started, end, "failed", "internal", errInfo(err));
          })
          .finally(() => this.briefing.delete(user.id)),
      );
    }
    return out;
  }

  /** Records how an attempt ended; true when the briefing was delivered. */
  private settleBriefing(userId: string, t: BriefingTry, end: number, result: "answered" | "stopped" | "failed", error: string, err?: string): boolean {
    const { core } = this;
    const now = core.now();
    if (result !== "failed") {
      // answered, or stopped by the person (their choice): nothing more today
      writeTry(core, userId, { ...t, state: "done" }, now);
      return result === "answered";
    }
    const next = t.n < BRIEFING_TRIES && t.at + BRIEFING_RETRY_MS <= end ? t.at + BRIEFING_RETRY_MS : null;
    writeTry(core, userId, { ...t, state: next === null ? "done" : "failed", next }, now);
    core.log.warn("briefing failed", { user: userId, attempt: t.n, next: next === null ? "none" : hhmm(next), error, err });
    return false;
  }

  /** Today's failed attempt when another one may start now, else null. */
  private retryDue(userId: string, threadId: string, today: string, now: number, end: number): BriefingTry | null {
    const { core } = this;
    let t = readTry(core, userId);
    if (!t || t.day !== today) return null; // started before attempts were recorded, or a mark from another day
    if (t.state === "running") {
      if (this.briefing.has(userId)) return null;
      // left by a server that stopped mid-turn. Answered before it stopped: done. Otherwise the attempt counts as failed.
      if (answeredAfter(core, threadId, t.event)) {
        writeTry(core, userId, { ...t, state: "done" }, now);
        return null;
      }
      deleteMessageRow(core, t.event);
      this.settleBriefing(userId, t, end, "failed", "server_restart");
      t = readTry(core, userId)!;
    }
    if (t.state !== "failed" || t.next === null || now < t.next) return null;
    // the person has been working with their agent since: a briefing now would cut into that (a steer, a 409)
    if (sentSince(core, userId, t.first)) {
      writeTry(core, userId, { ...t, state: "done", next: null }, now);
      core.log.info("briefing retry dropped", { user: userId, attempt: t.n, reason: "user_sent" });
      return null;
    }
    return t;
  }
}

export { HttpError };
