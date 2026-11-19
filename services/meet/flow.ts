// Meet 화면 조작: 참여 전 화면(이름·마이크·카메라·참여 버튼), 수락 대기, 회의 중 감시, 나가기.
import type { Page } from "playwright";
import { exactLabelRe, SELECTORS } from "./selectors";

export interface Probe {
  ready: string;
  nameInput: boolean;
  join: { kind: "ask" | "now"; disabled: boolean } | null;
  leave: boolean;
  waitingCopy: boolean;
  mic: "on" | "off" | null;
  cam: "on" | "off" | null;
  signals: string[];
  participants: number | null;
}

export async function probe(page: Page): Promise<Probe | null> {
  try {
    return (await page.evaluate(() => (window as unknown as { __mosi?: { probe(): unknown } }).__mosi?.probe() ?? null)) as Probe | null;
  } catch {
    return null; // 이동 중이거나 페이지가 닫힘
  }
}

export type PrejoinOutcome =
  | { kind: "prejoin" }
  | { kind: "fail"; state: "invalid" | "blocked" | "failed"; reason: string };

/** 회의 안에 들어왔는가: 나가기 버튼, 또는 (나가기 버튼을 못 찾는 UI라면) 참석자 타일이 있고 참여 전·대기 화면이 아님 */
export function looksInCall(p: Probe): boolean {
  if (p.leave) return true;
  return p.participants !== null && p.participants >= 1 && !p.join && !p.nameInput && !p.waitingCopy;
}

/** 실패로 해석되는 신호 → (상태, 이유) */
export function classifySignals(signals: string[], phase: "prejoin" | "waiting" | "in_call"): { state: "invalid" | "blocked" | "denied" | "ended"; reason: string } | null {
  const has = (k: string) => signals.includes(k);
  if (phase === "in_call") {
    if (has("removed")) return { state: "ended", reason: "kicked" };
    if (has("meeting_ended")) return { state: "ended", reason: "meeting_ended" };
    return null;
  }
  if (has("cant_join")) return { state: "blocked", reason: "cant_join" };
  if (has("full")) return { state: "blocked", reason: "call_full" };
  if (has("invalid")) return { state: "invalid", reason: "meeting_not_found" };
  if (has("meeting_ended")) return { state: "invalid", reason: "meeting_ended" };
  if (phase === "waiting") {
    if (has("denied")) return { state: "denied", reason: "host_denied" };
    if (has("no_response")) return { state: "denied", reason: "no_response" };
    if (has("removed")) return { state: "denied", reason: "removed" };
  }
  return null;
}

export async function waitForPrejoin(page: Page, timeoutMs: number, signal: AbortSignal): Promise<PrejoinOutcome> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (signal.aborted) return { kind: "fail", state: "failed", reason: "aborted" };
    const p = await probe(page);
    if (p) {
      if (p.nameInput || p.join) return { kind: "prejoin" };
      const bad = classifySignals(p.signals, "prejoin");
      if (bad && bad.state !== "denied" && bad.state !== "ended") return { kind: "fail", state: bad.state, reason: bad.reason };
      if (/accounts\.google\.com/.test(page.url())) return { kind: "fail", state: "blocked", reason: "signin_required" };
    }
    await Bun.sleep(400);
  }
  return { kind: "fail", state: "failed", reason: "prejoin_timeout" };
}

async function toggle(page: Page, words: string[], icons: string[]) {
  const byLabel = page.locator(words.map((w) => `[data-is-muted][aria-label*="${w}" i]`).join(", ")).first();
  if (await byLabel.count().catch(() => 0)) return byLabel;
  // 다른 언어 UI: 아이콘 글꼴 문구로 찾는다
  return page.locator("[data-is-muted]").filter({ hasText: new RegExp(`^\\s*(?:${icons.join("|")})\\s*$`) }).first();
}

async function setToggle(page: Page, words: string[], icons: string[], want: "on" | "off"): Promise<"on" | "off" | null> {
  const t = await toggle(page, words, icons);
  if (!(await t.count().catch(() => 0))) return null;
  for (let i = 0; i < 3; i++) {
    const muted = await t.getAttribute("data-is-muted", { timeout: 2000 }).catch(() => null);
    if (muted === null) return null;
    const state = muted === "true" ? "off" : "on";
    if (state === want) return state;
    await t.click({ timeout: 3000 }).catch(() => {});
    await Bun.sleep(500);
  }
  const muted = await t.getAttribute("data-is-muted", { timeout: 1000 }).catch(() => null);
  return muted === null ? null : muted === "true" ? "off" : "on";
}

export const ensureMicOn = (page: Page) => setToggle(page, SELECTORS.micWords, SELECTORS.micIcons, "on");
export const ensureCamOff = (page: Page) => setToggle(page, SELECTORS.camWords, SELECTORS.camIcons, "off");

async function dismissBubbles(page: Page): Promise<void> {
  const btn = page.getByRole("button", { name: exactLabelRe(SELECTORS.dismissLabels) });
  const n = await btn.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const b = btn.nth(i);
    if (await b.isVisible().catch(() => false)) await b.click({ timeout: 1500 }).catch(() => {});
  }
}

export interface JoinClick {
  kind: "ask" | "now";
  mic: "on" | "off" | null;
  cam: "on" | "off" | null;
  typedName: boolean;
}

/** 이름 입력 → 마이크 켬 → 카메라 끔 → 참여 버튼 클릭. clickJoin=false면 클릭 직전에서 멈춘다(선택자 점검용). */
export async function fillPrejoin(page: Page, name: string, opts: { clickJoin: boolean; signal?: AbortSignal }): Promise<JoinClick> {
  await dismissBubbles(page);
  let typedName = false;
  const input = page.locator(SELECTORS.nameInput).first();
  if (await input.isVisible().catch(() => false)) {
    await input.click({ timeout: 5000 });
    await input.fill("");
    await input.pressSequentially(name, { delay: 60 + Math.round(Math.random() * 40) });
    typedName = true;
  }
  const cam = await ensureCamOff(page);
  const mic = await ensureMicOn(page);
  await Bun.sleep(300 + Math.round(Math.random() * 300));

  await dismissBubbles(page);
  const ask = page.getByRole("button", { name: exactLabelRe(SELECTORS.joinLabels.filter((l) => l.kind === "ask").map((l) => l.label)) });
  const now = page.getByRole("button", { name: exactLabelRe(SELECTORS.joinLabels.filter((l) => l.kind === "now").map((l) => l.label)) });
  let target = null as null | { kind: "ask" | "now"; loc: ReturnType<Page["locator"]> };
  const until = Date.now() + 8000;
  while (!target && Date.now() < until) {
    for (const [kind, loc] of [["now", now], ["ask", ask]] as const) {
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const b = loc.nth(i);
        if ((await b.isVisible().catch(() => false)) && (await b.isEnabled().catch(() => false))) {
          target = { kind, loc: b };
          break;
        }
      }
      if (target) break;
    }
    if (!target) await Bun.sleep(300);
  }
  if (!target) throw new Error("join_button_missing");
  if (opts.signal?.aborted) throw new Error("aborted"); // 그사이 나가기(DELETE)가 왔으면 참여 버튼을 누르지 않는다
  if (opts.clickJoin) await target.loc.click({ timeout: 5000 });
  return { kind: target.kind, mic, cam, typedName };
}

export async function clickLeave(page: Page): Promise<boolean> {
  let btn = page.locator(SELECTORS.leaveButton).first();
  if (!(await btn.isVisible().catch(() => false))) btn = page.locator("button, [role=button]").filter({ hasText: new RegExp(`^\\s*${SELECTORS.leaveIcon}\\s*$`) }).first();
  if (!(await btn.isVisible().catch(() => false))) return false;
  await btn.click({ timeout: 3000 }).catch(() => {});
  await Bun.sleep(800);
  return true;
}

export async function meetingTitle(page: Page, code: string): Promise<string | undefined> {
  const t = await page.title().catch(() => "");
  const s = t.replace(/^\s*(Google\s+)?Meet\s*[-–—:]\s*/i, "").trim();
  if (!s || s === "Meet" || s.toLowerCase().includes(code)) return undefined;
  return s.slice(0, 120);
}
