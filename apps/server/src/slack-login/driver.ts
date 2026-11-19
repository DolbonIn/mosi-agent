/**
 * Drives Slack's own web sign-in in a throwaway Chrome (Playwright, channel "chrome", never `playwright install`).
 *
 * Privacy:
 *  - The browser runs an off-the-record context: cookies and localStorage live in memory only and Playwright
 *    deletes its temporary profile directory when the browser closes. Nothing is written to the data dir.
 *    (So Playwright's mock keychain is fine here: no cookie has to survive a restart, and it avoids a Keychain prompt.)
 *  - The email, password and codes are only ever passed to `fill`/`keyboard.type`. They are never logged, never put
 *    in an error message, and the email copy the driver keeps for password retries is dropped in close().
 *  - Only signal keys, booleans and workspace links come back from the page (classifyPage); the session token and the
 *    `d` cookie are read once in extract() and handed to the caller, which seals them into the vault.
 *  - Playwright prints call arguments (including typed text) when DEBUG=pw:api is set: refuse to run then.
 */
import type { Browser, BrowserContext, Page } from "playwright";
import type { LoginRelayErrorCode } from "@pickle/protocol";
import { classifyPage, SLACK_SELECTORS, type PageSignals } from "./selectors.ts";

export interface SlackUrls {
  /** global email sign-in ("find my workspaces by email") */
  signin: string;
  /** a workspace's own sign-in page */
  workspace(domain: string): string;
  /** a workspace's password sign-in page */
  password(domain: string): string;
  /** the web client (it writes localStorage.localConfig_v2) */
  client(teamId?: string): string;
  /** hosts that belong to Slack: anything else after a sign-in step means an SSO provider took over */
  isSlackHost(host: string): boolean;
  /** still on the global sign-in / get-started pages */
  isSigninPage(url: string): boolean;
  /** "sionic.slack.com" for a workspace link, or null */
  domainOf(href: string): string | null;
}

export const SLACK_URLS: SlackUrls = {
  signin: "https://slack.com/signin",
  workspace: (d) => `https://${d}.slack.com/`,
  password: (d) => `https://${d}.slack.com/sign_in_with_password`,
  client: (t) => `https://app.slack.com/client/${t ?? ""}`,
  isSlackHost: (h) => h === "slack.com" || h.endsWith(".slack.com") || h === "slack-gov.com" || h.endsWith(".slack-gov.com"),
  isSigninPage: (u) => /^https:\/\/slack\.com\/(signin|get-started|workspace-signin)/.test(u),
  domainOf: (href) => {
    try {
      const h = new URL(href).hostname;
      return h.endsWith(".slack.com") && h !== "app.slack.com" ? h : null;
    } catch {
      return null;
    }
  },
};

export type DriverOutcome =
  | { kind: "needs_code"; codeLength: number }
  | { kind: "needs_password" }
  | { kind: "needs_2fa"; codeLength: number }
  | { kind: "workspaces"; workspaces: { id: string; name: string; domain: string | null }[] }
  | { kind: "signed_in" }
  | { kind: "error"; code: LoginRelayErrorCode };

export interface SlackTeamSession {
  teamId: string;
  name: string | null;
  domain: string | null;
  token: string;
}

export interface SlackExtract {
  teams: SlackTeamSession[];
  cookie: string;
}

export interface SlackDriver {
  start(i: { domain: string | null; email: string; method: "code" | "password" }): Promise<DriverOutcome>;
  submitCode(code: string): Promise<DriverOutcome>;
  submitPassword(password: string): Promise<DriverOutcome>;
  submitTotp(code: string): Promise<DriverOutcome>;
  pickWorkspace(id: string): Promise<DriverOutcome>;
  /** after signed_in: the session token of every signed-in team plus the shared `d` cookie */
  extract(): Promise<SlackExtract>;
  close(): Promise<void>;
}

export class DriverError extends Error {
  constructor(readonly code: LoginRelayErrorCode, detail: string) {
    super(detail);
    this.name = "DriverError";
  }
}

export interface DriverOptions {
  urls?: SlackUrls;
  headless?: boolean;
  /** one page transition (submit → next screen) */
  stepTimeoutMs?: number;
  /** web client boot until localConfig_v2 carries a token */
  tokenTimeoutMs?: number;
  /** progress hook for logs: step names and timings only */
  onStep?: (step: string, ms: number) => void;
}

const CHROME_ARGS = ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--mute-audio", "--window-size=1280,860"];

/** DEBUG=pw:api|pw:protocol|* would print `fill("…")` arguments: never run the relay like that. */
export function debugLogsSecrets(env: Record<string, string | undefined> = process.env): boolean {
  const d = env.DEBUG ?? "";
  return /(^|,)\s*(\*|pw:\*|pw:api|pw:protocol|pw:channel)/.test(d) || !!env.PWDEBUG;
}

/** Desktop Chrome UA without "HeadlessChrome" (headless Chrome announces itself otherwise). */
export function userAgentFor(version: string, platform: NodeJS.Platform = process.platform): string {
  const major = (/^(\d+)/.exec(version)?.[1] ?? "142").trim();
  const os = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** internal "the page is ready" answer for waitFor (never returned to callers) */
const READY: DriverOutcome = Object.freeze({ kind: "signed_in" as const });

type Decide = (s: Probe) => DriverOutcome | null;

interface Probe {
  sig: PageSignals | null;
  url: string;
  host: string;
  signedIn: boolean;
  /** a confirmCode API answer that arrived after the action */
  codeCheck: { ok: boolean; error: string | null } | null;
  /** alert keys that were not on screen before the action, or any alert after a page load */
  fresh: Set<string>;
  navigated: boolean;
  elapsed: number;
}

export class PlaywrightSlackDriver implements SlackDriver {
  private readonly urls: SlackUrls;
  private readonly headless: boolean;
  private readonly stepTimeoutMs: number;
  private readonly tokenTimeoutMs: number;
  private readonly onStep: (step: string, ms: number) => void;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private closed = false;
  private navSeq = 0;
  private codeSeq = 0;
  private codeCheck: { ok: boolean; error: string | null; seq: number } | null = null;
  private links = new Map<string, { href: string; name: string; domain: string | null }>();
  private browserPid: number | null = null;
  /** kept only so a password retry can refill an emptied email field; dropped in close() */
  private email = "";

  constructor(opts: DriverOptions = {}) {
    this.urls = opts.urls ?? SLACK_URLS;
    this.headless = opts.headless ?? true;
    this.stepTimeoutMs = opts.stepTimeoutMs ?? 25_000;
    this.tokenTimeoutMs = opts.tokenTimeoutMs ?? 45_000;
    this.onStep = opts.onStep ?? (() => {});
  }

  /** tests/diagnostics: the live browser (to check its process and temporary profile) */
  get browserForTest(): Browser | null {
    return this.browser;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** tests/diagnostics: Chrome's browser-process id */
  get pid(): number | null {
    return this.browserPid;
  }

  // ───────────────────────────── public steps ─────────────────────────────

  async start(i: { domain: string | null; email: string; method: "code" | "password" }): Promise<DriverOutcome> {
    await this.ensure();
    this.email = i.email;
    if (!i.domain) {
      if (i.method === "password") return { kind: "error", code: "workspace_required" };
      await this.goto(this.urls.signin, "open_signin");
      const form = await this.waitFor((p) => (p.sig?.emailField ? READY : !this.urls.isSlackHost(p.host) ? { kind: "error", code: "upstream" } : null), "signin_form");
      if (form !== READY) return form ?? { kind: "error", code: "upstream" };
      return this.submitEmail(i.email);
    }

    await this.goto(this.urls.workspace(i.domain), "open_workspace");
    let s0: PageSignals | null = null;
    const ready = await this.waitFor((p) => {
      const s = p.sig;
      if (!s) return null;
      if (s.notFound) return { kind: "error", code: "workspace_not_found" };
      if (!this.urls.isSlackHost(p.host)) return { kind: "error", code: "sso_unsupported" };
      if (s.emailField || s.passwordForm || s.passwordHref || s.sso || s.codeBox) {
        s0 = s;
        return READY;
      }
      return null;
    }, "workspace_form");
    if (ready !== READY) return ready ?? { kind: "error", code: "upstream" };
    const s = s0 as PageSignals | null;
    if (!s) return { kind: "error", code: "upstream" };
    if (i.method === "password") return this.openPasswordForm(i.domain, s);
    if (s.emailField) return this.submitEmail(i.email);
    if (s.sso) return { kind: "error", code: "sso_unsupported" };
    // a workspace without the email-code option: fall back to its password form
    if (s.passwordForm || s.passwordHref) return this.openPasswordForm(i.domain, s);
    return { kind: "error", code: "upstream" };
  }

  async submitCode(code: string): Promise<DriverOutcome> {
    const page = this.need();
    const before = await this.signals();
    if (!before?.codeBox) return { kind: "error", code: "upstream" };
    const inputs = page.locator(SLACK_SELECTORS.codeInputs);
    const n = await inputs.count();
    // a wrong code may still sit in the boxes: empty them first
    for (let k = n - 1; k >= 0; k--) {
      const v = await inputs.nth(k).inputValue().catch(() => "");
      if (v) await inputs.nth(k).fill("").catch(() => {});
    }
    const t0 = Date.now();
    await inputs.first().click({ timeout: 5_000 });
    await page.keyboard.type(code, { delay: 35 });
    return this.after(before, "code", (p) => {
      const s = p.sig;
      if (p.codeCheck && !p.codeCheck.ok) return { kind: "error", code: codeError(p.codeCheck.error) };
      if (s?.workspaces.length) return this.workspaceList(s);
      if (p.signedIn && (!this.urls.isSigninPage(p.url) || p.elapsed > 4_000)) return { kind: "signed_in" };
      if (!this.urls.isSlackHost(p.host)) return { kind: "error", code: "sso_unsupported" };
      if (!s) return null;
      if (s.totp) return { kind: "needs_2fa", codeLength: 6 };
      if (s.sso || p.fresh.has("sso_required")) return { kind: "error", code: "sso_unsupported" };
      if (p.fresh.has("code_expired")) return { kind: "error", code: "code_expired" };
      if (p.fresh.has("slack_ratelimited")) return { kind: "error", code: "slack_ratelimited" };
      if (p.fresh.has("wrong_code")) return { kind: "error", code: "wrong_code" };
      if (s.captcha) return { kind: "error", code: "captcha" };
      // the boxes were cleared and flagged without a readable message
      if (s.codeBox && s.codeError && s.codeFilled === 0 && Date.now() - t0 > 1_500) return { kind: "error", code: "wrong_code" };
      return null;
    });
  }

  async submitPassword(password: string): Promise<DriverOutcome> {
    this.need();
    const before = await this.signals();
    if (!before?.passwordForm) return { kind: "error", code: "upstream" };
    const email = await this.firstVisible(SLACK_SELECTORS.loginEmail);
    if (email && this.email && !(await email.inputValue().catch(() => ""))) await email.fill(this.email);
    const pw = await this.firstVisible(SLACK_SELECTORS.loginPassword);
    if (!pw) return { kind: "error", code: "upstream" };
    await pw.fill(password);
    const submit = await this.firstVisible(SLACK_SELECTORS.loginSubmit);
    if (submit) await submit.click({ timeout: 5_000, noWaitAfter: true });
    else await pw.press("Enter");
    return this.after(before, "password", (p) => {
      const s = p.sig;
      if (p.signedIn) return { kind: "signed_in" };
      if (!this.urls.isSlackHost(p.host)) return { kind: "error", code: "sso_unsupported" };
      if (!s) return null;
      if (s.totp) return { kind: "needs_2fa", codeLength: 6 };
      if (s.codeBox) return { kind: "needs_code", codeLength: s.codeLength };
      if (p.fresh.has("sso_required")) return { kind: "error", code: "sso_unsupported" };
      if (p.fresh.has("slack_ratelimited")) return { kind: "error", code: "slack_ratelimited" };
      if (p.fresh.has("wrong_password")) return { kind: "error", code: "wrong_password" };
      if (s.captcha) return { kind: "error", code: "captcha" };
      return null;
    });
  }

  async submitTotp(code: string): Promise<DriverOutcome> {
    this.need();
    const before = await this.signals();
    if (!before?.totp) return { kind: "error", code: "upstream" };
    const input = await this.firstVisible(SLACK_SELECTORS.totpInput);
    if (!input) return { kind: "error", code: "upstream" };
    await input.fill(code);
    const submit = await this.firstVisible(SLACK_SELECTORS.totpSubmit);
    if (submit) await submit.click({ timeout: 5_000, noWaitAfter: true });
    else await input.press("Enter");
    return this.after(before, "totp", (p) => {
      const s = p.sig;
      if (p.signedIn) return { kind: "signed_in" };
      if (!this.urls.isSlackHost(p.host)) return { kind: "error", code: "sso_unsupported" };
      if (!s) return null;
      if (p.fresh.has("wrong_totp") || p.fresh.has("wrong_code")) return { kind: "error", code: "wrong_totp" };
      if (p.fresh.has("slack_ratelimited")) return { kind: "error", code: "slack_ratelimited" };
      if (s.codeBox) return { kind: "needs_code", codeLength: s.codeLength };
      if (s.captcha) return { kind: "error", code: "captcha" };
      // reloaded onto the same 2FA form with no message: treat as a wrong code
      if (p.navigated && s.totp && p.elapsed > 2_500) return { kind: "error", code: "wrong_totp" };
      return null;
    });
  }

  async pickWorkspace(id: string): Promise<DriverOutcome> {
    this.need();
    const link = this.links.get(id);
    if (!link) return { kind: "error", code: "upstream" };
    const before = await this.signals();
    await this.goto(link.href, "open_workspace_link");
    return this.after(before, "workspace", (p) => {
      const s = p.sig;
      if (!this.urls.isSlackHost(p.host)) return { kind: "error", code: "sso_unsupported" };
      if (p.signedIn && !this.urls.isSigninPage(p.url)) return { kind: "signed_in" };
      if (!s) return null;
      if (s.sso || p.fresh.has("sso_required")) return { kind: "error", code: "sso_unsupported" };
      if (s.totp) return { kind: "needs_2fa", codeLength: 6 };
      if (s.codeBox) return { kind: "needs_code", codeLength: s.codeLength };
      if (s.passwordForm) return { kind: "needs_password" };
      if (s.emailField && p.elapsed > 3_000) return { kind: "error", code: "upstream" };
      if (s.captcha) return { kind: "error", code: "captcha" };
      return null;
    });
  }

  async extract(): Promise<SlackExtract> {
    const page = this.need();
    const t0 = Date.now();
    if (!/\/client\b/.test(page.url())) await this.goto(this.urls.client(), "open_client");
    const deadline = Date.now() + this.tokenTimeoutMs;
    let teams: SlackTeamSession[] = [];
    while (!this.closed && Date.now() < deadline) {
      teams = await page.evaluate(readLocalConfig).catch(() => [] as SlackTeamSession[]);
      if (teams.length) break;
      // bounced back to a sign-in page: the session did not stick
      if (this.urls.isSigninPage(page.url()) && Date.now() - t0 > 5_000) break;
      await sleep(400);
    }
    if (this.closed) throw new DriverError("cancelled", "closed");
    const cookie = await this.dCookie();
    this.onStep("extract", Date.now() - t0);
    if (!teams.length || !cookie) throw new DriverError("token_not_found", teams.length ? "no d cookie" : "no localConfig_v2 token");
    return { teams, cookie };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.email = "";
    this.links.clear();
    this.codeCheck = null;
    const browser = this.browser;
    const context = this.context;
    this.page = null;
    this.context = null;
    this.browser = null;
    const t0 = Date.now();
    // the off-the-record context holds the whole Slack session: closing it drops cookies and storage at once
    try {
      await Promise.race([context?.close(), sleep(5_000)]);
    } catch {
      /* already gone */
    }
    // Chrome can take ~10 s to exit after Browser.close; nothing is left to save, so it is stopped after 1.5 s
    // (Playwright then removes its temporary profile directory)
    await this.killBrowser(browser);
    this.onStep("close", Date.now() - t0);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private async ensure(): Promise<Page> {
    if (this.closed) throw new DriverError("cancelled", "closed");
    if (this.page) return this.page;
    if (debugLogsSecrets()) throw new DriverError("browser_unavailable", "DEBUG would log typed text");
    const t0 = Date.now();
    let chromium: typeof import("playwright").chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      throw new DriverError("browser_unavailable", "playwright missing");
    }
    try {
      this.browser = await chromium.launch({ channel: "chrome", headless: this.headless, args: CHROME_ARGS, ignoreDefaultArgs: ["--enable-automation"] });
    } catch {
      throw new DriverError("browser_unavailable", "chrome launch failed");
    }
    try {
      // the browser process id, so close() can stop a Chrome that lingers after Browser.close
      const cdp = await this.browser.newBrowserCDPSession();
      const info = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: { type: string; id: number }[] };
      this.browserPid = info.processInfo.find((p) => p.type === "browser")?.id ?? null;
      await cdp.detach().catch(() => {});
    } catch {
      this.browserPid = null;
    }
    if (this.closed) {
      const b = this.browser;
      this.browser = null;
      await this.killBrowser(b);
      throw new DriverError("cancelled", "closed");
    }
    this.context = await this.browser.newContext({
      locale: "en-US",
      userAgent: userAgentFor(this.browser.version()),
      viewport: { width: 1280, height: 860 },
      acceptDownloads: false,
    });
    const page = await this.context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) this.navSeq++;
    });
    page.on("response", (r) => {
      let path = "";
      try {
        path = new URL(r.url()).pathname;
      } catch {
        return;
      }
      if (!/\/api\/(signin|signup)\.confirmCode$/.test(path)) return;
      r.json()
        .then((j: unknown) => {
          const o = (j ?? {}) as { ok?: unknown; error?: unknown };
          // only these two fields are kept: the answer may also carry a magic-login URL
          this.codeCheck = { ok: o.ok === true, error: typeof o.error === "string" ? o.error.slice(0, 40) : null, seq: ++this.codeSeq };
        })
        .catch(() => {});
    });
    this.page = page;
    this.onStep("launch", Date.now() - t0);
    return page;
  }

  private async killBrowser(b: Browser | null): Promise<void> {
    if (!b) return;
    const closing = b.close().catch(() => {});
    if (!(await Promise.race([closing.then(() => true), sleep(1_500).then(() => false)])) && this.browserPid) {
      try {
        process.kill(this.browserPid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    await Promise.race([closing, sleep(5_000)]);
  }

  private need(): Page {
    if (this.closed || !this.page) throw new DriverError(this.closed ? "cancelled" : "upstream", "no page");
    return this.page;
  }

  private async goto(url: string, step: string): Promise<void> {
    const page = this.need();
    const t0 = Date.now();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (e) {
      if (this.closed) throw new DriverError("cancelled", "closed");
      // an SSO redirect can abort the navigation; let the caller look at where we ended up
      if (!/ERR_ABORTED|interrupted by another navigation/i.test(String((e as Error)?.message ?? ""))) throw new DriverError("upstream", `goto failed (${step})`);
    }
    this.onStep(step, Date.now() - t0);
  }

  private async signals(): Promise<PageSignals | null> {
    const page = this.page;
    if (!page) return null;
    try {
      return await page.evaluate(classifyPage, SLACK_SELECTORS);
    } catch {
      return null; // mid-navigation
    }
  }

  private async dCookie(): Promise<string | null> {
    if (!this.context) return null;
    const all = await this.context.cookies().catch(() => []);
    const d = all.filter((c) => c.name === "d" && /^xoxd(-|%2D)/i.test(c.value));
    d.sort((a, b) => Number(/slack\.com$/.test(b.domain)) - Number(/slack\.com$/.test(a.domain)));
    return d[0]?.value ?? null;
  }

  private async probe(base: { alerts: Set<string>; nav: number; seq: number; t0: number }): Promise<Probe> {
    const page = this.need();
    const sig = await this.signals();
    const url = page.url();
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* about:blank */
    }
    const navigated = this.navSeq > base.nav;
    const fresh = new Set((sig?.alerts ?? []).filter((a) => navigated || !base.alerts.has(a)));
    const cc = this.codeCheck && this.codeCheck.seq > base.seq ? { ok: this.codeCheck.ok, error: this.codeCheck.error } : null;
    return { sig, url, host, signedIn: !!(await this.dCookie()), codeCheck: cc, fresh, navigated, elapsed: Date.now() - base.t0 };
  }

  /** poll until `decide` answers (every 250 ms) or the step times out */
  private async waitFor(decide: Decide, step: string, before?: PageSignals | null): Promise<DriverOutcome | null> {
    const base = { alerts: new Set(before?.alerts ?? []), nav: this.navSeq, seq: this.codeSeq, t0: Date.now() };
    const end = base.t0 + this.stepTimeoutMs;
    while (Date.now() < end) {
      if (this.closed) throw new DriverError("cancelled", "closed");
      const out = decide(await this.probe(base));
      if (out) {
        this.onStep(step, Date.now() - base.t0);
        return out;
      }
      await sleep(250);
    }
    this.onStep(`${step}_timeout`, Date.now() - base.t0);
    return null;
  }

  private async after(before: PageSignals | null, step: string, decide: Decide): Promise<DriverOutcome> {
    return (await this.waitFor(decide, step, before)) ?? { kind: "error", code: "upstream" };
  }

  private async submitEmail(email: string): Promise<DriverOutcome> {
    const field = await this.firstVisible(SLACK_SELECTORS.emailField);
    if (!field) return { kind: "error", code: "upstream" };
    const before = await this.signals();
    await field.fill(email);
    const submit = await this.firstVisible(SLACK_SELECTORS.emailSubmit);
    if (submit) await submit.click({ timeout: 5_000, noWaitAfter: true });
    else await field.press("Enter");
    const out = await this.after(before, "email", (p) => {
      const s = p.sig;
      if (!this.urls.isSlackHost(p.host)) return { kind: "error", code: "sso_unsupported" };
      if (!s) return null;
      if (s.codeBox) return { kind: "needs_code", codeLength: s.codeLength };
      if (s.workspaces.length) return this.workspaceList(s);
      if (s.sso || p.fresh.has("sso_required")) return { kind: "error", code: "sso_unsupported" };
      if (p.fresh.has("invalid_email")) return { kind: "error", code: "invalid_email" };
      if (p.fresh.has("no_account")) return { kind: "error", code: "no_account" };
      if (p.fresh.has("slack_ratelimited")) return { kind: "error", code: "slack_ratelimited" };
      if (s.captcha) return { kind: "error", code: "captcha" };
      if (s.passwordForm) return { kind: "needs_password" };
      if (p.signedIn && !this.urls.isSigninPage(p.url)) return { kind: "signed_in" };
      return null;
    });
    if (out.kind === "needs_password") {
      const f = await this.firstVisible(SLACK_SELECTORS.loginEmail);
      if (f && !(await f.inputValue().catch(() => ""))) await f.fill(email);
    }
    return out;
  }

  private async openPasswordForm(domain: string, s: PageSignals): Promise<DriverOutcome> {
    if (!s.passwordForm) {
      await this.goto(s.passwordHref ?? this.urls.password(domain), "open_password");
      const ok = await this.waitFor((p) => {
        if (!this.urls.isSlackHost(p.host)) return { kind: "error", code: "sso_unsupported" };
        const x = p.sig;
        if (!x) return null;
        if (x.passwordForm) return { kind: "needs_password" };
        if (x.notFound) return { kind: "error", code: "workspace_not_found" };
        if (x.sso) return { kind: "error", code: "sso_unsupported" };
        if (x.emailField && p.elapsed > 2_000) return { kind: "error", code: "password_unavailable" };
        return null;
      }, "password_form");
      if (!ok) return { kind: "error", code: "password_unavailable" };
      if (ok.kind === "error") return ok;
    }
    const f = await this.firstVisible(SLACK_SELECTORS.loginEmail);
    if (!f) return { kind: "error", code: "password_unavailable" };
    await f.fill(this.email);
    return { kind: "needs_password" };
  }

  private workspaceList(s: PageSignals): DriverOutcome {
    this.links.clear();
    const out: { id: string; name: string; domain: string | null }[] = [];
    s.workspaces.slice(0, 50).forEach((w, i) => {
      const id = `w${i + 1}`;
      const domain = this.urls.domainOf(w.href);
      this.links.set(id, { href: w.href, name: w.name, domain });
      out.push({ id, name: w.name || domain || `워크스페이스 ${i + 1}`, domain });
    });
    return { kind: "workspaces", workspaces: out };
  }

  private async firstVisible(list: string[]) {
    const page = this.need();
    for (const q of list) {
      const loc = page.locator(q);
      const n = await loc.count().catch(() => 0);
      for (let k = 0; k < n; k++) {
        const el = loc.nth(k);
        if (await el.isVisible().catch(() => false)) return el;
      }
    }
    return null;
  }
}

/** signin.confirmCode error → relay error */
export function codeError(e: string | null): LoginRelayErrorCode {
  switch (e) {
    case "expired":
    case "code_expired":
    case "already_used":
      return "code_expired";
    case "ratelimited":
    case "rate_limited":
      return "slack_ratelimited";
    case "captcha_failed":
      return "captcha";
    case "failed":
    case "invalid_code":
    case "code_invalid":
    case "no_code":
      return "wrong_code";
    default:
      return "upstream";
  }
}

/** Runs INSIDE the page: teams in localStorage.localConfig_v2 that carry a session token. */
function readLocalConfig(): SlackTeamSession[] {
  try {
    const raw = localStorage.getItem("localConfig_v2");
    if (!raw) return [];
    const cfg = JSON.parse(raw) as { teams?: Record<string, { id?: string; name?: string; domain?: string; token?: string }> };
    const out: SlackTeamSession[] = [];
    for (const [id, t] of Object.entries(cfg.teams ?? {})) {
      if (!t || typeof t.token !== "string" || !/^xoxc-/.test(t.token)) continue;
      out.push({ teamId: String(t.id ?? id), name: typeof t.name === "string" ? t.name : null, domain: typeof t.domain === "string" ? t.domain : null, token: t.token });
    }
    return out;
  } catch {
    return [];
  }
}
