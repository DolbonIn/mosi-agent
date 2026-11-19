/**
 * Slack sign-in page selectors, read from the live pages on 2026-11-12 without submitting anything
 * (slack.com/signin, <ws>.slack.com/, /sign_in_with_password, <org>.enterprise.slack.com SSO page, unknown
 * workspace, and the get-started bundle for the confirmation-code view, the workspace list and the error copy).
 * data-qa attributes and roles first, ids second, text last; English and Korean copy side by side, the way
 * services/meet/selectors.ts does it. This object is passed into the page as JSON, so regexes stay strings.
 */

export const SLACK_SELECTORS = {
  /** email-code sign-in: slack.com/signin and <ws>.slack.com/ */
  emailField: ['[data-qa="email_field"]', "input#signup_email", 'form input[type="email"][name="email"]'],
  emailSubmit: ['[data-qa="submit_button"]', "button#submit_btn"],
  /** "sign in with a password instead" (workspace page) / "Sign in with Password" (enterprise SSO page, no_sso=1) */
  passwordLink: ['[data-qa="sign_in_password_link"]', 'a[href*="sign_in_with_password"]', "a#enterprise_member_email_and_password", 'a[href*="no_sso=1"]'],
  /** password form: workspace (login_*) and enterprise (enterprise_signin_form_*) */
  loginEmail: ['[data-qa="login_email"]', '[data-qa="enterprise_signin_form_email"]', "form#signin_form input#email", "form#enterprise_signin_form input#email"],
  loginPassword: ['[data-qa="login_password"]', '[data-qa="enterprise_signin_form_password"]', 'form#signin_form input[type="password"]', 'input#password[type="password"]'],
  loginSubmit: ['[data-qa="signin_button"]', '[data-qa="enterprise_signin_form_submit"]', "button#signin_btn", 'form#signin_form button[type="submit"]'],
  /** the 6 split inputs ("digit 1 of 6" …) of the emailed confirmation code */
  codeBox: '[data-qa="confirmation_code_input"]',
  codeInputs: '[data-qa="confirmation_code_input"] input',
  /** two-factor (authenticator app / SMS / backup code) */
  totpInput: [
    'input[name="2fa_code"]',
    "input#auth_code",
    '[data-qa="2fa_code_input"] input',
    'input[data-qa="2fa_code_input"]',
    '[data-qa*="two_factor"] input',
    'input[autocomplete="one-time-code"]:not([data-qa="confirmation_code_input"] input)',
  ],
  totpSubmit: ['[data-qa="2fa_submit_button"]', '[data-qa="signin_button"]', "button#signin_btn", 'button[type="submit"]'],
  /** "Workspaces for <email>": one link per workspace (href = `${team.url}?redir=…`), aria-label "Open {name} (n members)" */
  workspaceLinks: ['a[data-qa="current_workspaces_open_link"]', '[data-qa="signedin_workspaces"] a[href]', 'a[data-qa="workspace_launch_button"][href]'],
  /** SSO-only sign-in (SAML/Okta/…): enterprise pages link to /sso/saml/start */
  sso: ['a[href*="/sso/saml/start"]', 'a[href*="/sso/"]', '[id^="enterprise_member_guest_account_signin_link"]', '[data-qa="sso_button"]', '[data-qa="sso_signin_button"]'],
  /** a captcha the person would have to solve (the invisible reCAPTCHA frame has no size and does not count) */
  captcha: ['iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="arkoselabs"]', 'iframe[title*="captcha" i]', ".g-recaptcha", '[data-qa="recaptcha-expired-error"]'],
  /** page copy → signal key (the text itself never leaves the page) */
  alerts: {
    wrong_code: "That code (wasn.t|was not|isn.t) valid|That code won.t work|code (is |was )?(invalid|incorrect)|그 코드는 유효하지 않습니다|코드가 유효하지 않습니다|입력한 코드가 유효하지 않습니다",
    code_expired: "That code.s no longer valid|code (has )?expired|has already been used|코드는 더 이상 유효하지 않습니다|입력한 코드가 만료|코드 확인 시간이 초과|이미 사용된 코드",
    slack_ratelimited: "too many attempts|Try again in a few minutes|시도 횟수가 너무 많습니다|시도한 횟수가 너무 많습니다",
    wrong_password: "incorrect email address or password|incorrect (username|email) or password|password (is |was )?incorrect|잘못된 이메일 주소나 비밀번호|비밀번호가 (올바르지|일치하지|틀렸)",
    wrong_totp: "(two-factor|2-factor|2FA|authentication) code (is |was )?(invalid|incorrect|wrong)|(invalid|incorrect) (two-factor|2FA|authentication) code|2단계 인증 코드가 잘못|인증 코드가 (잘못|유효하지)",
    invalid_email: "isn.t a valid email|that email is invalid|valid email domain|유효한 이메일 주소가 아닙|이메일 주소가 올바르지",
    sso_required: "SSO required by your admins|requires? (SAML|SSO|single sign-on)|must sign in (with|using) (SAML|SSO|single sign-on)|관리자가 SSO를 요구|SSO로 로그인하세요|SSO 사용을 요청",
    no_account: "couldn.t find (an|your) account|no account (was )?found|isn.t (associated|registered)|계정을 찾을 수 없",
    captcha: "I.m not a robot|verify (that )?you.re (a )?human|로봇이 아닙니다|사람인지 확인",
  } as Record<string, string>,
  /** unknown workspace ("There’s been a glitch…") */
  notFound: "There.s been a glitch|workspace (doesn.t|does not) exist|couldn.t find (that|this) workspace|워크스페이스를 찾을 수 없",
};

export type SlackSelectors = typeof SLACK_SELECTORS;

/** What the page shows right now. Only booleans, counts, signal keys and workspace links leave the page. */
export interface PageSignals {
  emailField: boolean;
  codeBox: boolean;
  codeError: boolean;
  codeFilled: number;
  codeLength: number;
  passwordForm: boolean;
  passwordHref: string | null;
  totp: boolean;
  workspaces: { name: string; href: string }[];
  sso: boolean;
  captcha: boolean;
  notFound: boolean;
  alerts: string[];
}

/**
 * Runs INSIDE the page (page.evaluate). Self-contained: no closures, no imports.
 */
export function classifyPage(sel: SlackSelectors): PageSignals {
  const visible = (el: Element | null): el is HTMLElement => {
    if (!el) return false;
    const h = el as HTMLElement;
    const s = getComputedStyle(h);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = h.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const first = (list: string[]): HTMLElement | null => {
    for (const q of list) {
      let nodes: Element[] = [];
      try {
        nodes = Array.from(document.querySelectorAll(q));
      } catch {
        continue;
      }
      const v = nodes.find(visible);
      if (v) return v as HTMLElement;
    }
    return null;
  };
  const text = (document.body?.innerText ?? "").slice(0, 20000);
  const title = document.title ?? "";
  const alerts: string[] = [];
  for (const [key, re] of Object.entries(sel.alerts)) {
    try {
      if (new RegExp(re, "i").test(text)) alerts.push(key);
    } catch {
      /* bad pattern: ignore */
    }
  }
  const box = document.querySelector(sel.codeBox);
  const codeInputs = Array.from(document.querySelectorAll<HTMLInputElement>(sel.codeInputs)).filter(visible);
  const pw = first(sel.loginPassword);
  const pwLink = first(sel.passwordLink) as HTMLAnchorElement | null;
  const workspaces: { name: string; href: string }[] = [];
  const seen = new Set<string>();
  for (const q of sel.workspaceLinks) {
    let nodes: Element[] = [];
    try {
      nodes = Array.from(document.querySelectorAll(q));
    } catch {
      continue;
    }
    for (const n of nodes) {
      const a = n as HTMLAnchorElement;
      if (!visible(a) || !a.href || seen.has(a.href)) continue;
      seen.add(a.href);
      const aria = a.getAttribute("aria-label") ?? "";
      const m = /^(?:Open|Select|Launch)\s+(.+?)(?:\s+\(\d[^)]*\))?$/.exec(aria.trim()) ?? /^(.+?)\s*(?:열기|선택)(?:\s+\(.*\))?$/.exec(aria.trim());
      const name = (m?.[1] ?? (a.innerText || "").split("\n").map((s) => s.trim()).find(Boolean) ?? "").slice(0, 80);
      workspaces.push({ name, href: a.href });
    }
  }
  const captchaEl = (() => {
    for (const q of sel.captcha) {
      let nodes: Element[] = [];
      try {
        nodes = Array.from(document.querySelectorAll(q));
      } catch {
        continue;
      }
      for (const n of nodes) {
        if (!visible(n)) continue;
        const r = (n as HTMLElement).getBoundingClientRect();
        if (r.width >= 60 && r.height >= 40) return true;
      }
    }
    return false;
  })();
  const hasEmail = !!first(sel.emailField);
  const ssoEl = first(sel.sso);
  return {
    emailField: hasEmail,
    codeBox: visible(box) || codeInputs.length > 0,
    codeError: box?.getAttribute("data-state") === "error",
    codeFilled: codeInputs.filter((i) => i.value).length,
    codeLength: codeInputs.length || 6,
    passwordForm: visible(pw),
    passwordHref: pwLink?.href ?? null,
    totp: !!first(sel.totpInput) && !(visible(box) || codeInputs.length > 0),
    workspaces,
    // SSO only counts when there is no other way in on this page
    sso: !!ssoEl && !hasEmail && !visible(pw),
    captcha: captchaEl || alerts.includes("captcha"),
    notFound: new RegExp(sel.notFound, "i").test(`${title}\n${text.slice(0, 2000)}`),
    alerts,
  };
}
