// 회의 세션 하나: Chrome 띄우기 → 참여 → 회의 중(듣기·말하기·감시) → 종료.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { closeBounded, gotoFailure, realBrowserOps, type BrowserOps, type GotoFailure } from "./browser";
import { CHROME_ARGS, type Config } from "./config";
import { classifySignals, clickLeave, ensureCamOff, ensureMicOn, fillPrejoin, looksInCall, meetingTitle, probe, waitForPrejoin } from "./flow";
import { buildInitScript } from "./inject";
import { Listener, type TranscriptEvent } from "./listen";
import { log } from "./log";
import { int16ToBase64 } from "./audio";
import { ackCache, clipKey, SayQueue, warmTts, type Clip, type MicSink, type PushResult } from "./say";
import { endReasonFor, isTerminal, StateMachine, type EndReason, type MeetState } from "./state";
import { warmStt } from "./stt";
import { maskCode } from "./url";

export type SessionEvent =
  | { event: "state"; data: { state: MeetState; reason?: string } }
  | { event: "transcript"; data: TranscriptEvent }
  | { event: "speaking"; data: { on: boolean; sayId: string } }
  | { event: "participants"; data: { count: number } }
  | { event: "partial"; data: { text: string } }
  | { event: "endpoint"; data: { seq: number; speaker: string | null } }
  | { event: "log"; data: { code: string; reason: string } }
  | { event: "ended"; data: { reason: EndReason; state?: MeetState } };

export interface SessionInit {
  id: string;
  url: string;
  code: string;
  name: string;
  announce?: string;
  /** STT initial prompt(에이전트 이름이 든 문장). 로그에 남기지 않는다 */
  sttPrompt?: string;
  /** 테스트 전용: 참여 흐름 없이 페이지가 뜨면 바로 in_call */
  loopback?: boolean;
}

type Listener_ = (e: SessionEvent) => void;

/** 앞 세션의 Chrome 닫기(최대 closeTimeoutMs + 죽이기). 같은 프로필로 새 Chrome을 띄우기 전에 기다린다(profile_in_use 방지) */
let teardown: Promise<unknown> = Promise.resolve();

async function bounded<T>(p: Promise<T>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p.then(() => {}, () => {}), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}

interface Mosi {
  mic: {
    push(b64: string, rate: number, first: boolean, sayId: string): PushResult;
    loadClip(key: string, b64: string, rate: number): unknown;
    hasClip(key: string): boolean;
    playClip(key: string, sayId: string): PushResult | null;
    stop(): unknown;
    drain(ms?: number, sayId?: string): Promise<unknown>;
    status(): unknown;
  };
  capture: { status(): unknown; enable(on: boolean): boolean; rxJitter(): Promise<{ jbMs: number; targetMs: number } | null> };
  watchSpeakers(on: boolean): boolean;
  activeSpeaker(): string | null;
}

export class Session {
  readonly id: string;
  readonly code: string;
  readonly url: string;
  readonly name: string;
  readonly announce?: string;
  private readonly sttPrompt?: string;
  readonly loopback: boolean;
  readonly sm = new StateMachine();
  readonly createdAt = Date.now();
  joinedAt?: number;
  title?: string;
  participants?: number;
  endReason?: EndReason;
  private subs = new Set<Listener_>();
  /** 다시 붙는 구독자용(?since=) 최근 transcript */
  private transcripts: TranscriptEvent[] = [];
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  /** 띄운 Chrome 본 프로세스 pid(닫기가 멈추면 죽인다) */
  private chromePid: number | null = null;
  /** Chrome을 다시 띄울 때마다 늘어난다: 앞 Chrome의 close·crash 이벤트로 세션이 끝나지 않게 */
  private browserGen = 0;
  /** 마지막 Chrome 띄우기에 걸린 시간(앞 Chrome 닫기 기다림 제외) */
  private lastLaunchMs = 0;
  private listener: Listener;
  private say: SayQueue;
  private ac = new AbortController();
  private leaving = false;
  private lastSpeechAt = Date.now();
  private aloneSince: number | null = null;
  private finished: Promise<void>;
  private resolveFinished!: () => void;
  /** 받는 쪽 지터 버퍼(최근 값, 최대): 이만큼 회의 소리가 늦게 들어온다 */
  readonly rx = { jbMs: null as number | null, targetMs: null as number | null, maxJbMs: 0 };
  readonly stats = { launchMs: 0, prejoinMs: 0, joinClickMs: 0, admittedMs: 0, sayFirstAudioMs: [] as number[], sayFirstCaptureMs: [] as number[] };

  constructor(
    init: SessionInit,
    private cfg: Config,
    private browser: BrowserOps = realBrowserOps,
  ) {
    this.id = init.id;
    this.code = init.code;
    this.url = init.url;
    this.name = init.name;
    this.sttPrompt = init.sttPrompt;
    this.announce = init.announce;
    this.loopback = !!init.loopback;
    this.finished = new Promise((r) => (this.resolveFinished = r));
    this.listener = new Listener({
      sttUrl: cfg.sttUrl,
      vad: { hangoverMs: cfg.vadHangoverMs },
      // 발화 끝을 정한 순간(soniox: finalize, local: VAD 구간 끝). seq·speaker = 뒤따를 transcript의 seq·speaker(모르면 null)
      onEndpoint: (seq: number, speaker: string | null) => this.emit({ event: "endpoint", data: { seq, speaker } }),
      ...(init.sttPrompt !== undefined ? { sttPrompt: init.sttPrompt } : {}),
      ...(cfg.stt === "soniox" && cfg.sonioxKey
        ? {
            soniox: {
              apiKey: cfg.sonioxKey,
              model: cfg.sonioxModel,
              endpointDetection: cfg.sonioxEndpoint,
              ...(cfg.sonioxUrl ? { url: cfg.sonioxUrl } : {}),
              terms: [init.name, `${init.name}야`],
              ...(init.sttPrompt ? { contextText: init.sttPrompt } : {}),
            },
            finalizeSilenceMs: cfg.finalizeSilenceMs,
            onPartial: (text: string) => this.emit({ event: "partial", data: { text } }),
            onFallback: (reason: string) => {
              this.emit({ event: "log", data: { code: "stt_fallback", reason } });
              void this.warmLocalStt("fallback");
            },
          }
        : {}),
      onTranscript: (ev) => {
        this.transcripts.push(ev);
        if (this.transcripts.length > 2000) this.transcripts.splice(0, this.transcripts.length - 2000);
        this.emit({ event: "transcript", data: ev });
      },
      speakerProbe: () => this.mosi((m) => m.activeSpeaker()).then((v) => (typeof v === "string" ? v : null)),
      onSpeech: () => {
        this.lastSpeechAt = Date.now();
      },
    });
    const sink: MicSink = {
      push: async (b64, rate, first, sayId) => (await this.mosi((m, a) => m.mic.push(a.b64, a.rate, a.first, a.sayId), { b64, rate, first, sayId })) ?? undefined,
      playClip: async (clip, sayId) => {
        // 페이지에 올려 둔 소리면 key만 보내고(가장 빠름), 없으면 올리면서 바로 재생한다
        const r = await this.mosi((m, a) => m.mic.playClip(a.key, a.sayId), { key: clip.key, sayId });
        if (r) return r;
        const r2 = await this.mosi((m, a) => (m.mic.loadClip(a.key, a.b64, a.rate), m.mic.playClip(a.key, a.sayId)), { key: clip.key, b64: int16ToBase64(clip.pcm), rate: clip.rate, sayId });
        if (!r2) throw new Error("page_unavailable");
        return r2;
      },
      stop: async () => {
        await this.mosi((m) => m.mic.stop());
      },
      drain: async (sayId) => {
        await this.mosi((m, a) => m.mic.drain(180_000, a.sayId), { sayId: sayId ?? null });
      },
    };
    this.say = new SayQueue({
      ttsUrl: cfg.ttsUrl,
      voice: cfg.ttsVoice,
      sink,
      emit: (event, data) => this.emit({ event, data }),
      beforeSpeak: async () => {
        if (this.page && !this.loopback) await ensureMicOn(this.page).catch(() => null);
      },
      onFirstAudio: (sayId, ms, path) => {
        this.stats.sayFirstAudioMs.push(ms);
        log(`say ${sayId} first audio scheduled ${ms}ms via ${path}`);
      },
    });
    this.sm.onChange((c) => {
      log(`session ${this.id} ${maskCode(this.code)} ${c.from} -> ${c.state}${c.reason ? ` (${c.reason})` : ""}`);
      this.emit({ event: "state", data: { state: c.state, ...(c.reason ? { reason: c.reason } : {}) } });
      if (isTerminal(c.state)) void this.finish(c.state, c.reason);
    });
  }

  get state(): MeetState {
    return this.sm.state;
  }

  get active(): boolean {
    return !this.sm.terminal;
  }

  done(): Promise<void> {
    return this.finished;
  }

  /** `/say {cached:true}`로 바로 낼 수 있는 맞장구 문장들 */
  cachedTexts(): string[] {
    return ackCache.keys();
  }

  snapshot() {
    return {
      id: this.id,
      state: this.sm.state,
      ...(this.sm.reason ? { reason: this.sm.reason } : {}),
      ...(this.title ? { title: this.title } : {}),
      ...(this.joinedAt ? { joinedAt: new Date(this.joinedAt).toISOString() } : {}),
      ...(this.participants !== undefined ? { participants: this.participants } : {}),
      ...(ackCache.keys().length ? { acks: ackCache.keys() } : {}),
    };
  }

  debugStats() {
    const l = this.listener.stats;
    return {
      ...this.stats,
      listener: { chunks: l.chunks, segments: l.segments, sttCalls: l.sttCalls, sttMs: l.sttMs, sttRoundTripMs: l.sttRoundTripMs, dropped: l.dropped, empty: l.empty },
      say: this.say.stats,
      acks: { ...ackCache.stats, clips: ackCache.keys().map((k) => ({ chars: k.length, ms: ackCache.get(k)!.ms })) },
      rx: this.rx,
      sttEngine: this.listener.sttEngine,
      sttFallback: this.listener.stats.fallback,
      soniox: this.listener.sonioxStats,
      vadHangoverMs: this.cfg.vadHangoverMs,
    };
  }

  /** 시험 모드 /debug: 페이지 안 마이크·캡처 상태 */
  async debugPage() {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    return page
      .evaluate(() => {
        const w = window as any;
        return { mic: w.__mosi?.mic.status() ?? null, capture: w.__mosi?.capture.status() ?? null, diag: w.__diag ?? null };
      })
      .catch(() => null);
  }

  transcriptsSince(since: number): TranscriptEvent[] {
    return this.transcripts.filter((t) => t.seq > since);
  }

  subscribe(fn: Listener_): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(e: SessionEvent): void {
    for (const fn of [...this.subs]) {
      try {
        fn(e);
      } catch {
        /* 구독자 오류는 무시 */
      }
    }
  }

  private async mosi<T>(fn: (m: Mosi, arg: any) => T, arg?: unknown): Promise<Awaited<T> | null> {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    try {
      const src = `(${fn.toString()})(window.__mosi, ${JSON.stringify(arg ?? null)})`;
      return (await page.evaluate(src)) as Awaited<T>;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ 시작

  start(): void {
    void this.run().catch((e) => {
      const msg = String((e as Error)?.message ?? e);
      const code = msg.split(":")[0]!;
      const reason = /^[a-z_]{3,40}$/.test(code) ? code : "error";
      if (!this.sm.terminal) {
        log(`session ${this.id} error reason=${reason}`);
        this.sm.transition("failed", reason);
      }
    });
  }

  private async run(): Promise<void> {
    const t0 = Date.now();
    void this.prepareVoice();
    // 회의 페이지 열기: 실패하면 Chrome을 닫고(최대 5초) 다시 띄워 한 번 더. 두 번 다 망 문제면 network_unavailable
    const failures: GotoFailure[] = [];
    for (let attempt = 1; ; attempt++) {
      await this.launch();
      if (attempt === 1) this.stats.launchMs = Date.now() - t0;
      if (this.sm.terminal) return;
      const fail = await this.openMeetingPage(this.page!);
      if (this.sm.terminal) return;
      if (!fail) break;
      failures.push(fail);
      // 2026-11-12 사고 때 secd(Keychain)가 100~285% CPU였고 secd가 다시 뜬 순간 Chrome 연결이 돌아왔다. Chrome 쿠키 저장소는 Keychain 키로
      // 풀리므로 ctx.cookies()가 제때 오는지를 같이 남긴다(오면 망 단절 쪽, 안 오면 Keychain 멈춤 쪽). 쿠키 내용은 남기지 않는다
      const cookies = await this.probeCookies();
      // URL·회의 코드는 남기지 않는다(오류 메시지에 들어 있어 이름과 망 오류 코드만)
      log(`session ${this.id} goto_failed name=${fail.name}${fail.net ? ` net=${fail.net}` : ""} stage=${fail.stage} attempt=${attempt}/${this.cfg.gotoAttempts} ms=${fail.ms} launchMs=${this.lastLaunchMs} cookies=${cookies}`);
      if (this.sm.terminal) return;
      if (attempt >= this.cfg.gotoAttempts) throw new Error(failures.every((f) => f.network) ? "network_unavailable" : "goto_failed");
      await this.closeBrowser("goto_retry");
      if (this.sm.terminal) return;
    }
    const page = this.page!;

    if (this.loopback) {
      this.sm.transition("prejoin");
      await page.waitForFunction(() => (window as any).__loopbackReady === true, null, { timeout: 20_000 });
      this.enterCall();
      return;
    }

    const pre = await waitForPrejoin(page, this.cfg.prejoinTimeoutMs, this.ac.signal);
    if (this.sm.terminal) return;
    if (pre.kind === "fail") {
      this.sm.transition(pre.state, pre.reason);
      return;
    }
    this.stats.prejoinMs = Date.now() - t0;
    this.sm.transition("prejoin");

    const click = await fillPrejoin(page, this.name, { clickJoin: !this.cfg.noJoin, signal: this.ac.signal });
    if (this.cfg.noJoin) {
      log(`session ${this.id} MEET_NO_JOIN: stopped before join kind=${click.kind} mic=${click.mic} cam=${click.cam} typedName=${click.typedName}`);
      return;
    }
    this.stats.joinClickMs = Date.now() - t0;
    log(`session ${this.id} join clicked kind=${click.kind} mic=${click.mic} cam=${click.cam} typedName=${click.typedName}`);
    if (this.sm.terminal) return;
    if (click.kind === "ask") this.sm.transition("waiting_admission");
    await this.waitAdmission(click.kind);
  }

  /** 서버 응답(commit)을 gotoCommitTimeoutMs, DOM까지 gotoTimeoutMs 안에. 외부 연결이 안 되는 Chrome은 commit 단계에서 빨리 실패한다 */
  private async openMeetingPage(page: Page): Promise<GotoFailure | null> {
    const t = Date.now();
    let stage: GotoFailure["stage"] = "commit";
    try {
      await page.goto(this.url, { waitUntil: "commit", timeout: Math.min(this.cfg.gotoCommitTimeoutMs, this.cfg.gotoTimeoutMs) });
      stage = "load";
      await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1000, this.cfg.gotoTimeoutMs - (Date.now() - t)) });
      return null;
    } catch (e) {
      return gotoFailure(e, stage, Date.now() - t);
    }
  }

  /** ctx.cookies()가 cookieProbeMs 안에 오는지: `ok/<ms>` · `timeout` · `error` · `none`(Chrome 없음) */
  private async probeCookies(): Promise<string> {
    const ctx = this.ctx;
    if (!ctx) return "none";
    const t = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      ctx.cookies().then(
        () => `ok/${Date.now() - t}ms`,
        () => "error",
      ),
      new Promise<string>((res) => (timer = setTimeout(() => res("timeout"), this.cfg.cookieProbeMs))),
    ]);
    clearTimeout(timer);
    return r;
  }

  /** 지금 Chrome을 닫는다. ctx.close()가 closeTimeoutMs를 넘기면 프로세스를 죽인다(세션이 닫기에 묶이지 않게) */
  private async closeBrowser(why: string): Promise<void> {
    const ctx = this.ctx;
    const pid = this.chromePid;
    this.browserGen++;
    this.ctx = null;
    this.page = null;
    this.chromePid = null;
    if (!ctx) return;
    const t = Date.now();
    const dir = this.cfg.profileDir;
    const p = closeBounded(ctx, async () => pid ?? (await this.browser.findPid(dir)), this.browser, this.cfg.closeTimeoutMs);
    teardown = p.catch(() => {});
    const r = await p;
    if (r !== "closed") log(`session ${this.id} teardown forced (${why}) ${r === "forced" ? "chrome killed" : "chrome pid unknown"} after ${Date.now() - t}ms`);
  }

  private async launch(): Promise<void> {
    const dir = this.cfg.profileDir;
    // 앞 세션(또는 앞 시도)의 Chrome이 아직 닫히는 중이면 기다린다(닫기는 최대 closeTimeoutMs + 죽이기)
    const tw = Date.now();
    await teardown;
    if (Date.now() - tw > 50) log(`session ${this.id} launch waited ${Date.now() - tw}ms for the previous chrome to close`);
    if (this.sm.terminal) return;
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* 무시 */
    }
    let ctx: BrowserContext;
    try {
      const tl = Date.now();
      ctx = await this.browser.launch(dir, {
        channel: "chrome",
        headless: this.cfg.headless,
        // Playwright adds --use-mock-keychain on macOS: cookies saved by login.ts (a normal Chrome, real Keychain)
        // could not be decrypted, so a signed-in bot profile looked signed out and joined as a guest
        ignoreDefaultArgs: ["--enable-automation", "--use-mock-keychain", "--password-store=basic"],
        args: CHROME_ARGS,
        locale: "ko-KR",
        permissions: ["microphone", "camera"],
        viewport: null,
      });
      this.lastLaunchMs = Date.now() - tl;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      const reason = /ProcessSingleton|SingletonLock|profile.*in use|user data directory is already in use/i.test(msg) ? "profile_in_use" : "launch_failed";
      log(`session ${this.id} launch failed reason=${reason}`);
      this.sm.transition("failed", reason);
      return;
    }
    // pid를 먼저 찾고 나서 ctx를 세운다: 그사이 세션이 끝나면 아래에서 바로 닫는다
    const pid = await this.browser.findPid(dir);
    const gen = ++this.browserGen;
    this.ctx = ctx;
    this.chromePid = pid;
    if (this.sm.terminal) {
      await this.closeBrowser("cancelled");
      return;
    }
    ctx.on("close", () => {
      if (gen === this.browserGen && !this.sm.terminal && !this.leaving) this.sm.transition("failed", "browser_closed");
    });
    await ctx.exposeBinding("__mosiPcm", (_source, b64: string, t: number) => {
      if (this.sm.state === "in_call") this.listener.onPcm(b64, t);
    });
    await ctx.addInitScript({ content: buildInitScript({ selfName: this.name, forceScriptProcessor: this.cfg.forceScriptProcessor, chunkSamples: 1600 /* 100 ms: 말 끝·finalize 판정을 촘촘하게 */ }) });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    // 같은 프로필로 다른 탭이 열려 있으면 정리
    for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {});
    this.page = page;
    page.on("close", () => {
      if (gen === this.browserGen && !this.sm.terminal && !this.leaving) this.sm.transition("failed", "page_closed");
    });
    page.on("crash", () => {
      if (gen === this.browserGen && !this.sm.terminal) this.sm.transition("failed", "page_crashed");
    });
  }

  private async waitAdmission(kind: "ask" | "now"): Promise<void> {
    const page = this.page!;
    const started = Date.now();
    const timeout = kind === "ask" ? this.cfg.admissionTimeoutMs : 60_000;
    while (!this.sm.terminal) {
      const p = await probe(page);
      if (p && looksInCall(p)) {
        if (!p.leave) log(`session ${this.id} in call without a leave button (fallback signal)`);
        this.stats.admittedMs = Date.now() - started;
        this.enterCall();
        return;
      }
      if (p) {
        const bad = classifySignals(p.signals, "waiting");
        if (bad && bad.state !== "ended") {
          this.sm.transition(bad.state, bad.reason);
          return;
        }
      }
      if (Date.now() - started > timeout) {
        this.sm.transition(kind === "ask" ? "denied" : "failed", kind === "ask" ? "admission_timeout" : "join_timeout");
        return;
      }
      await Bun.sleep(500);
    }
  }

  private enterCall(): void {
    if (!this.sm.transition("in_call")) return;
    this.joinedAt = Date.now();
    this.lastSpeechAt = Date.now();
    this.listener.start();
    void this.afterJoin();
  }

  private async afterJoin(): Promise<void> {
    const page = this.page;
    if (!page) return;
    void this.preloadClips();
    if (!this.loopback) {
      await this.mosi((m) => m.watchSpeakers(true));
      await ensureMicOn(page).catch(() => null);
      await ensureCamOff(page).catch(() => null);
      void this.monitor();
    }
    if (this.announce && this.announce.trim()) {
      await Bun.sleep(this.loopback ? 200 : 1500);
      if (this.sm.state === "in_call") this.say.enqueue(this.announce.trim().slice(0, this.cfg.maxSayChars));
    }
  }

  // ------------------------------------------------------------------ 회의 중 감시

  /** 받는 쪽 지터 버퍼를 잰다(10초마다). 300 ms를 넘으면 로그: 그만큼 받아 적기가 늦어진다 */
  private async sampleRx(): Promise<void> {
    const r = await this.mosi((m) => m.capture.rxJitter());
    if (!r) return;
    this.rx.jbMs = r.jbMs;
    this.rx.targetMs = r.targetMs;
    this.rx.maxJbMs = Math.max(this.rx.maxJbMs, r.jbMs);
    if (r.jbMs > 300) log(`session ${this.id} rx jitter buffer ${r.jbMs}ms (target ${r.targetMs}ms)`);
  }

  private async monitor(): Promise<void> {
    const page = this.page!;
    let missingSince: number | null = null;
    let lastTitleAt = 0;
    while (this.sm.state === "in_call" && !this.leaving) {
      const p = await probe(page);
      if (this.sm.state !== "in_call" || this.leaving) break;
      if (p) {
        const now = Date.now();
        if (p.participants !== null && p.participants !== this.participants) {
          this.participants = p.participants;
          this.emit({ event: "participants", data: { count: p.participants } });
        }
        if (now - lastTitleAt > 10_000) {
          lastTitleAt = now;
          this.title = await meetingTitle(page, this.code);
          void this.sampleRx();
        }
        // 끝남 감지
        if (!looksInCall(p)) {
          missingSince ??= now;
          const bad = classifySignals(p.signals, "in_call");
          if (bad && now - missingSince >= 1000) {
            await this.endCall(bad.reason as EndReason, false);
            break;
          }
          if (now - missingSince >= 15_000) {
            await this.endCall("meeting_ended", false);
            break;
          }
        } else {
          missingSince = null;
        }
        // 혼자 남음: 참석자 1명 이하(또는 "혼자" 문구)인데 2분 동안 아무도 말하지 않았다
        const alone = (p.participants !== null && p.participants <= 1) || p.signals.includes("alone");
        if (alone) {
          this.aloneSince ??= now;
          const quietFor = now - Math.max(this.lastSpeechAt, this.aloneSince);
          if (now - this.aloneSince >= this.cfg.aloneTimeoutMs && quietFor >= this.cfg.aloneTimeoutMs) {
            log(`session ${this.id} alone for ${Math.round((now - this.aloneSince) / 1000)}s; leaving`);
            await this.endCall("alone", true);
            break;
          }
        } else {
          this.aloneSince = null;
        }
      }
      await Bun.sleep(1000);
    }
  }

  // ------------------------------------------------------------------ 말하기

  /** TTS 데우기 → 맞장구 소리 만들기(이미 있으면 건너뜀) → 페이지에 올려 두기 */
  /** local STT 데우기: MEET_STT=local(또는 키 없음)일 때 세션 시작에, soniox에서 넘어올 때 한 번 */
  private sttWarmed = false;
  private async warmLocalStt(why: "start" | "fallback"): Promise<void> {
    if (this.sttWarmed) return;
    this.sttWarmed = true;
    const w = await warmStt(this.cfg.sttUrl, this.sttPrompt);
    if (w) log(`session ${this.id} stt warm (${why}) ${w.serverMs}ms`);
  }

  private async prepareVoice(): Promise<void> {
    if ((!this.loopback || this.cfg.warmTtsInTest) && this.listener.sttEngine === "local") void this.warmLocalStt("start");
    if (!this.loopback || this.cfg.warmTtsInTest) {
      const w = await warmTts(this.cfg.ttsUrl, this.cfg.ttsVoice);
      if (w) log(`session ${this.id} tts warm ${w.ms}ms`);
    }
    if (!this.cfg.ackTexts.length || this.sm.terminal) return;
    const t0 = Date.now();
    await ackCache.ensure(this.cfg.ttsUrl, this.cfg.ttsVoice, this.cfg.ackTexts, { cancelled: () => this.sm.terminal }).catch(() => {});
    log(`session ${this.id} acks ready ${ackCache.keys().length}/${this.cfg.ackTexts.length} in ${Date.now() - t0}ms`);
    await this.preloadClips();
  }

  /** 맞장구 소리를 페이지 가상 마이크에 미리 올려 둔다(재생할 때 key만 보내면 되게) */
  private async preloadClips(): Promise<void> {
    for (const key of ackCache.keys()) {
      const clip = ackCache.get(key)!;
      const has = await this.mosi((m, a) => m.mic.hasClip(a.key), { key });
      if (has === false) await this.mosi((m, a) => m.mic.loadClip(a.key, a.b64, a.rate), { key, b64: int16ToBase64(clip.pcm), rate: clip.rate });
    }
  }

  sayText(text: string): string {
    return this.say.enqueue(text);
  }

  /** 캐시된 맞장구 소리면 TTS 없이 바로 낸다. 없으면 null */
  sayCached(text: string): string | null {
    const clip: Clip | undefined = ackCache.get(text);
    if (!clip) return null;
    return this.say.enqueue(clipKey(text), clip);
  }

  async stopSaying(): Promise<number> {
    return this.say.stop();
  }

  /** 측정용: 마지막으로 캡처된 큰 소리 시각(epoch ms) */
  lastCapturedLoud(): number | null {
    return this.listener.lastLoudEpoch;
  }

  /** 측정용: 다음 큰 소리 캡처 시각(epoch ms) */
  nextCapturedLoud(timeoutMs: number): Promise<number | null> {
    return this.listener.nextLoud(timeoutMs);
  }

  // ------------------------------------------------------------------ 끝내기

  /** DELETE /sessions/:id */
  async leave(): Promise<MeetState> {
    if (this.sm.terminal) return this.sm.state;
    if (this.sm.state === "in_call") await this.endCall("left", true);
    else {
      this.ac.abort();
      this.sm.transition("ended", "left");
    }
    await this.finished;
    return this.sm.state;
  }

  private async endCall(reason: EndReason, clickHangup: boolean): Promise<void> {
    if (this.leaving) return;
    this.leaving = true;
    await this.say.close().catch(() => {});
    if (clickHangup && this.page && !this.loopback) await clickLeave(this.page).catch(() => false);
    this.sm.transition("ended", reason);
  }

  private async finish(state: MeetState, reason?: string): Promise<void> {
    this.leaving = true;
    this.ac.abort();
    this.endReason = endReasonFor(state, reason);
    // 페이지가 멈춰 있어도 끝내기가 묶이지 않게 단계마다 상한을 둔다
    await bounded(this.say.close(), 3000);
    await bounded(this.listener.flush(), 3000);
    this.listener.close();
    await this.closeBrowser(state === "ended" ? "end" : "failed");
    this.emit({ event: "ended", data: { reason: this.endReason, ...(state !== "ended" ? { state } : {}) } });
    log(`session ${this.id} finished state=${state} end=${this.endReason}`);
    this.subs.clear();
    this.resolveFinished();
  }
}

export function chromeInstalled(): boolean {
  const candidates = [
    process.env.MEET_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean) as string[];
  return candidates.some((p) => existsSync(p));
}
