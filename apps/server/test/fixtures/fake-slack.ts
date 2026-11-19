/**
 * A local stand-in for Slack's web sign-in, for the login relay tests. It mirrors the structure read from the real
 * pages on 2026-11-12 (data-qa attributes, the 6-box confirmation code, /api/signin.confirmCode answers, the workspace
 * list, the password form, an enterprise SSO page, "There’s been a glitch…") and ends the way Slack does: a `d` cookie
 * plus localStorage.localConfig_v2.teams[teamId].token in the web client. Everything here is fake.
 *
 * Accounts (password sign-in works on any workspace the account belongs to):
 *   kim@example.com        acme                 pw "pw-correct-horse"
 *   multi@example.com      acme + beta          pw "pw-multi"
 *   twofa@example.com      acme                 pw "pw-2fa", TOTP "246810"
 *   newdevice@example.com  acme                 pw "pw-new", then an emailed code (new-device check)
 *   captcha@example.com    acme                 the email step shows a reCAPTCHA challenge
 *   member@ssoco.example   ssoco (SSO only)
 * The emailed code is always CODE ("Q7K9X2"); "EXP111" answers expired.
 * Workspaces: acme, beta (email code + password link), ssoco (Okta only), pwonly (password form only), anything else 404.
 */
import type { SlackUrls } from "../../src/slack-login/driver.ts";

export const CODE = "Q7K9X2";
export const EXPIRED_CODE = "EXP111";

interface Account {
  password: string;
  teams: string[];
  totp?: string;
  newDevice?: boolean;
  captcha?: boolean;
  slow?: number;
}

export const ACCOUNTS: Record<string, Account> = {
  "kim@example.com": { password: "pw-correct-horse", teams: ["acme"] },
  "multi@example.com": { password: "pw-multi", teams: ["acme", "beta"] },
  "twofa@example.com": { password: "pw-2fa", teams: ["acme"], totp: "246810" },
  "newdevice@example.com": { password: "pw-new", teams: ["acme"], newDevice: true },
  "captcha@example.com": { password: "pw-captcha", teams: ["acme"], captcha: true },
  "slow@example.com": { password: "pw-slow", teams: ["acme"], slow: 15_000 }, // the cancel test replaces it meanwhile
  "member@ssoco.example": { password: "pw-sso", teams: ["ssoco"] },
};

export const TEAMS: Record<string, { id: string; name: string; kind: "normal" | "sso" | "pwonly" }> = {
  acme: { id: "T0ACME001", name: "Acme Corp", kind: "normal" },
  beta: { id: "T0BETA002", name: "Beta Labs", kind: "normal" },
  ssoco: { id: "T0SSOCO03", name: "SSO Co", kind: "sso" },
  pwonly: { id: "T0PWONL04", name: "Password Only", kind: "pwonly" },
};

/** deterministic fake session secrets so tests can grep for them */
export const tokenFor = (teamId: string) => `xoxc-FAKE-${teamId}-1111111111-2222222222-abcdefabcdef`;
/** every new browser session gets its own `d` cookie: D_COOKIE_PREFIX + n + "%3D%3D" */
export const D_COOKIE_PREFIX = "xoxd-FAKEsecretcookie%2Fs";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface FakeSlack {
  base: string;
  urls: SlackUrls;
  /** what the site received (for assertions) */
  seen: { emails: string[]; codes: string[]; passwords: string[]; totps: string[]; signouts: { token: string; cookie: string }[] };
  stop(): void;
}

export function startFakeSlack(): FakeSlack {
  const sessions = new Map<string, Set<string>>(); // d cookie → signed-in team domains
  let sessionNo = 0;
  const magic = new Map<string, { email: string; team: string }>();
  const pending = new Map<string, { email: string; team: string }>(); // 2FA / new-device checks
  const seen: FakeSlack["seen"] = { emails: [], codes: [], passwords: [], totps: [], signouts: [] };

  const page = (title: string, body: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:16px system-ui;margin:40px}input{font:16px system-ui;margin:4px}.c input{width:32px;text-align:center}</style></head><body>${body}</body></html>`,
      { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } },
    );
  const cookieOf = (req: Request, name: string) => {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get("cookie") ?? "");
    return m?.[1] ?? null;
  };
  const issueMagic = (email: string, team: string) => {
    const k = crypto.randomUUID();
    magic.set(k, { email, team });
    return `/ws/${team}/magic?k=${k}`;
  };

  // the email-code SPA (global /signin and a workspace page share it)
  const emailApp = (team: string | null) => `
    <form id="f" novalidate>
      <label id="signup_email_label" for="signup_email">Enter your email address</label>
      <input data-qa="email_field" id="signup_email" type="email" name="email" placeholder="name@work-email.com" autocomplete="username webauthn">
      <button data-qa="submit_button" id="submit_btn" type="submit">Sign In With Email</button>
    </form>
    <div id="view"></div>
    <iframe title="" src="" style="width:0;height:0;border:0"></iframe>
    <script>${codeAppJs(team, "signin")}</script>`;

  function codeAppJs(team: string | null, mode: "signin" | "device", presetEmail = ""): string {
    return `
    (() => {
      const team = ${JSON.stringify(team)}, mode = ${JSON.stringify(mode)};
      let email = ${JSON.stringify(presetEmail)};
      const view = document.getElementById("view"), form = document.getElementById("f");
      const post = (p, b) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
      function codeView() {
        if (form) form.remove();
        view.innerHTML = '<h1>Check your email for a code</h1><p>We’ve sent a 6-character code to <strong id="em"></strong>. The code expires shortly, so please enter it soon.</p>' +
          '<div class="c" data-qa="confirmation_code_input" data-state="">' + [1,2,3,4,5,6].map((i) => '<input maxlength="1" aria-label="digit ' + i + ' of 6">').join("") + '</div><p id="err" role="alert"></p>';
        document.getElementById("em").textContent = email;
        const box = view.querySelector('[data-qa="confirmation_code_input"]'), ins = [...box.querySelectorAll("input")], err = document.getElementById("err");
        ins.forEach((inp, i) => inp.addEventListener("input", () => {
          box.dataset.state = ""; err.textContent = "";
          inp.value = inp.value.slice(-1).toUpperCase();
          if (inp.value && i < 5) ins[i + 1].focus();
          const code = ins.map((x) => x.value).join("");
          if (code.length === 6) {
            ins.forEach((x) => (x.disabled = true));
            post("/api/signin.confirmCode", { email, code, team, mode }).then((j) => {
              ins.forEach((x) => (x.disabled = false));
              if (j.ok && j.redirect) { location.href = j.redirect; return; }
              if (j.ok && j.workspaces) { listView(j.workspaces); return; }
              box.dataset.state = "error";
              err.textContent = j.error === "expired" ? "That code’s no longer valid. Check your email for a new code and try again." : "That code wasn’t valid. Give it another go!";
              ins.forEach((x) => (x.value = "")); ins[0].focus();
            });
          }
        }));
        ins[0].focus();
      }
      function listView(ws) {
        view.innerHTML = '<h4>Workspaces for <strong id="em"></strong></h4><div id="list"></div>';
        document.getElementById("em").textContent = email;
        const list = document.getElementById("list");
        for (const w of ws) {
          const a = document.createElement("a");
          a.className = "p-workspaces_list__link"; a.dataset.qa = "current_workspaces_open_link"; a.href = w.url; a.target = "_blank";
          a.setAttribute("aria-label", "Open " + w.name + " (3 members)"); a.textContent = w.name;
          list.append(a, document.createElement("br"));
        }
      }
      if (mode === "device") { codeView(); return; }
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        email = document.getElementById("signup_email").value.trim();
        post("/api/signin.email", { email, team }).then((j) => {
          if (j.ok) return codeView();
          const p = document.createElement("p"); p.setAttribute("role", "alert");
          if (j.error === "captcha_required") {
            const f = document.createElement("iframe"); f.title = "reCAPTCHA"; f.src = "/captcha?recaptcha=1"; f.style.cssText = "width:304px;height:78px;border:1px solid #ccc";
            view.append(f); return;
          }
          p.textContent = j.error === "ratelimited" ? "There were too many attempts to submit an email address. Try again in a few minutes." : "It looks like that isn’t a valid email address.";
          view.append(p);
        });
      });
    })();`;
  }

  const passwordForm = (team: string, opts: { email?: string; error?: string; enterprise?: boolean } = {}) => {
    const t = TEAMS[team]!;
    const err = opts.error ? `<p class="alert alert_error" role="alert">${esc(opts.error)}</p>` : "";
    if (opts.enterprise) {
      return page(
        `Sign in to ${t.name} | Slack`,
        `<h1>Sign in to ${esc(t.name)}</h1>${err}<form id="enterprise_signin_form" method="post" action="/ws/${team}/?no_sso=1">
          <input data-qa="enterprise_signin_form_email" id="email" type="text" name="email" aria-label="Email or username" value="${esc(opts.email ?? "")}">
          <input data-qa="enterprise_signin_form_password" id="password" type="password" name="password" aria-label="Password">
          <button data-qa="enterprise_signin_form_submit" type="submit">Sign In</button></form>`,
      );
    }
    return page(
      `Sign in to ${t.name} | Slack`,
      `<h1 data-qa="signin_header">Sign in to ${esc(t.name)}</h1>${err}<form id="signin_form" data-qa="signin_form" method="post" action="/ws/${team}/sign_in_with_password">
        <input data-qa="login_email" id="email" type="email" name="email" placeholder="name@work-email.com" value="${esc(opts.email ?? "")}">
        <input data-qa="login_password" id="password" type="password" name="password" placeholder="Your password">
        <button data-qa="signin_button" id="signin_btn" type="submit">Sign In</button></form>`,
    );
  };

  const signIn = (req: Request, team: string, to?: string) => {
    let d = cookieOf(req, "d");
    if (!d || !sessions.has(d)) {
      d = `${D_COOKIE_PREFIX}${++sessionNo}%3D%3D`;
      sessions.set(d, new Set());
    }
    sessions.get(d)!.add(team);
    return new Response(null, { status: 302, headers: { Location: to ?? `/client/${TEAMS[team]!.id}`, "Set-Cookie": `d=${d}; Path=/; HttpOnly; SameSite=Lax` } });
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const form = async () => Object.fromEntries(new URLSearchParams(await req.text())) as Record<string, string>;

      if (path === "/signin") return page("Login | Slack", `<h1>Enter your email to sign in</h1>${emailApp(null)}`);

      if (path === "/api/signin.email" && req.method === "POST") {
        const { email, team } = (await req.json()) as { email: string; team: string | null };
        seen.emails.push(email);
        const acct = ACCOUNTS[email];
        if (acct?.slow) await Bun.sleep(acct.slow);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Response.json({ ok: false, error: "invalid_email" });
        if (acct?.captcha) return Response.json({ ok: false, error: "captcha_required" });
        void team;
        return Response.json({ ok: true });
      }

      if (path === "/api/signin.confirmCode" && req.method === "POST") {
        const { email, code, team, mode } = (await req.json()) as { email: string; code: string; team: string | null; mode: string };
        seen.codes.push(code);
        if (code === EXPIRED_CODE) return Response.json({ ok: false, error: "expired" });
        if (code !== CODE) return Response.json({ ok: false, error: "failed" });
        const acct = ACCOUNTS[email];
        if (mode === "device") {
          const p = pending.get(cookieOf(req, "fake_pending") ?? "");
          if (!p) return Response.json({ ok: false, error: "failed" });
          return Response.json({ ok: true, redirect: issueMagic(p.email, p.team) });
        }
        if (team) return Response.json({ ok: true, redirect: issueMagic(email, team) });
        const teams = acct?.teams ?? [];
        return Response.json({ ok: true, workspaces: teams.map((t) => ({ name: TEAMS[t]!.name, url: `${url.origin}${issueMagic(email, t)}` })) });
      }

      // Web API sign-out (the Slack adapter's revoke on disconnect): Bearer xoxc + d cookie
      if (path === "/api/auth.signout" && req.method === "POST") {
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        const cookie = cookieOf(req, "d") ?? "";
        seen.signouts.push({ token, cookie });
        return Response.json(/^xoxc-FAKE-/.test(token) && cookie.startsWith("xoxd-") ? { ok: true } : { ok: false, error: "invalid_auth" });
      }

      if (path === "/captcha") return page("reCAPTCHA", "<p>I’m not a robot</p>");

      const ws = /^\/ws\/([a-z0-9-]+)(\/.*)?$/.exec(path);
      if (ws) {
        const team = ws[1]!;
        const rest = ws[2] ?? "/";
        const t = TEAMS[team];
        if (!t) return page("There's been a glitch… | Slack", "<h1>There’s been a glitch…</h1><p>We’re not quite sure what went wrong.</p>", 404);

        if (rest.startsWith("/magic")) {
          const m = magic.get(url.searchParams.get("k") ?? "");
          if (!m || m.team !== team) return page("Slack", "<p>This link has expired</p>", 400);
          magic.delete(url.searchParams.get("k")!);
          return signIn(req, team);
        }

        if (rest === "/sign_in_with_password" || (rest === "/" && (t.kind === "pwonly" || (t.kind === "sso" && url.searchParams.get("no_sso") === "1")))) {
          const enterprise = t.kind === "sso";
          if (req.method === "POST") {
            const f = await form();
            seen.passwords.push(f.password ?? "");
            const acct = ACCOUNTS[f.email ?? ""];
            if (!acct || acct.password !== f.password || !acct.teams.includes(team)) {
              return passwordForm(team, { email: f.email, error: "Sorry, you entered an incorrect email address or password.", enterprise });
            }
            if (t.kind === "sso") return passwordForm(team, { email: f.email, error: "SSO required by your admins. Sign in with Okta.", enterprise });
            if (acct.totp || acct.newDevice) {
              const pid = crypto.randomUUID();
              pending.set(pid, { email: f.email!, team });
              return new Response(null, { status: 302, headers: { Location: acct.totp ? `/ws/${team}/2fa` : `/ws/${team}/check`, "Set-Cookie": `fake_pending=${pid}; Path=/; HttpOnly` } });
            }
            return signIn(req, team);
          }
          return passwordForm(team, { enterprise });
        }

        if (rest === "/2fa") {
          const p = pending.get(cookieOf(req, "fake_pending") ?? "");
          if (!p) return new Response(null, { status: 302, headers: { Location: `/ws/${team}/` } });
          const formHtml = (err = "") =>
            page(
              "Two-factor authentication | Slack",
              `<h1>Two-factor authentication</h1>${err ? `<p class="alert alert_error" role="alert">${err}</p>` : ""}<form method="post"><p>Enter the 6-digit code from your authenticator app.</p>
               <input name="2fa_code" id="auth_code" autocomplete="one-time-code" inputmode="numeric"><button id="signin_btn" type="submit">Sign In</button></form>`,
            );
          if (req.method === "POST") {
            const f = await form();
            seen.totps.push(f["2fa_code"] ?? "");
            if (f["2fa_code"] !== ACCOUNTS[p.email]?.totp) return formHtml("Your authentication code was incorrect. Please try again.");
            pending.delete(cookieOf(req, "fake_pending")!);
            return signIn(req, team);
          }
          return formHtml();
        }

        if (rest === "/check") {
          const p = pending.get(cookieOf(req, "fake_pending") ?? "");
          if (!p) return new Response(null, { status: 302, headers: { Location: `/ws/${team}/` } });
          return page("Check your email | Slack", `<p>This is just a quick security check.</p><div id="view"></div><script>${codeAppJs(team, "device", p.email)}</script>`);
        }

        if (rest === "/") {
          if (t.kind === "sso") {
            return page(
              `Sign in to ${t.name} | Slack`,
              `<h1>Sign in to ${esc(t.name)}</h1><a id="enterprise_member_guest_account_signin_link_Okta" href="/sso/saml/start?team=${team}">Sign in with Okta</a><br><a id="enterprise_member_email_and_password" href="/ws/${team}/?no_sso=1">Sign in with Password</a>`,
            );
          }
          return page(
            `Slack`,
            `<h1 data-qa="signin_header">Sign in to ${esc(t.name)}</h1>${emailApp(team)}<p>We suggest using the email address you use at work. Or <a data-qa="sign_in_password_link" href="/ws/${team}/sign_in_with_password">sign in with a password instead</a></p>`,
          );
        }
      }

      if (path.startsWith("/sso/saml/start")) return Response.redirect("http://localhost:1/okta-idp", 302);

      const client = /^\/client\/?([A-Z0-9]*)/.exec(path);
      if (client) {
        const d = cookieOf(req, "d");
        const teams = d ? sessions.get(d) : null;
        if (!teams?.size) return new Response(null, { status: 302, headers: { Location: "/signin" } });
        const cfg = { teams: Object.fromEntries([...teams].map((t) => [TEAMS[t]!.id, { id: TEAMS[t]!.id, name: TEAMS[t]!.name, domain: t, url: `https://${t}.slack.com/`, token: tokenFor(TEAMS[t]!.id), user_id: "U0FAKE" }])) };
        return page("Slack", `<h1>Slack</h1><p>Loading workspace…</p><script>setTimeout(() => { localStorage.setItem("localConfig_v2", ${JSON.stringify(JSON.stringify(cfg))}); document.body.dataset.ready = "1"; }, 300);</script>`);
      }
      return page("Not found", "<h1>There’s been a glitch…</h1>", 404);
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  const urls: SlackUrls = {
    signin: `${base}/signin`,
    workspace: (d) => `${base}/ws/${d}/`,
    password: (d) => `${base}/ws/${d}/sign_in_with_password`,
    client: (t) => `${base}/client/${t ?? ""}`,
    isSlackHost: (h) => h === "127.0.0.1",
    isSigninPage: (u) => u.startsWith(`${base}/signin`),
    domainOf: (href) => {
      const m = /\/ws\/([a-z0-9-]+)\//.exec(href);
      return m ? `${m[1]}.slack.com` : null;
    },
  };
  return { base, urls, seen, stop: () => server.stop(true) };
}
