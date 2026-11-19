/**
 * Heuristic secret guard for text the agent wants to store (memories, daily logs).
 * False positives are acceptable: refusing to remember is always safe.
 */

const KEYWORD = /(비밀\s*번호|비번|패스워드|암호|password|passwd|pwd|passcode|핀\s*번호|\bpin\b|otp|인증\s*번호|보안\s*코드|cvc|cvv|토큰|token|api[\s_-]?key|secret|시크릿|private\s*key|개인\s*키|계좌\s*비밀)/i;
const CARD = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/;
const RRN = /(?<!\d)\d{6}\s*-\s*[1-8]\d{6}(?!\d)/; // 주민등록번호
const TOKENISH = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs]|AKIA|AIza|eyJ)[A-Za-z0-9_\-.]{12,}/;
const LONG_RANDOM = /[A-Za-z0-9_\-+/=]{28,}/;

function hasLongRandom(text: string): boolean {
  const m = text.match(new RegExp(LONG_RANDOM.source, "g")) ?? [];
  return m.some((s) => /\d/.test(s) && /[A-Za-z]/.test(s) && !/^https?/.test(s));
}

/** keyword, optional particle/separator, then a value-like token (has a digit, ≥4 latin/symbol chars, or follows ":"/"=") */
const KEYWORD_VALUE = new RegExp(
  `${KEYWORD.source}(\\s*(?:은요|는요|은|는|이|가|을|를|:|=)?\\s*)((?:[:=]\\s*)?(?:\\S*\\d\\S*|[A-Za-z!@#$%^&*_.\\-]{4,}\\S*))`,
  "gi",
);

/** true when the text looks like it contains (or is about storing) a credential or card/ID number. */
export function looksSecret(text: string): boolean {
  if (!text) return false;
  if (CARD.test(text) || RRN.test(text) || TOKENISH.test(text) || hasLongRandom(text)) return true;
  KEYWORD_VALUE.lastIndex = 0;
  return KEYWORD_VALUE.test(text);
}

/** Mask card numbers, RRNs and token-like strings (for logs that must keep the surrounding text). */
export function scrubSecrets(text: string): string {
  return text
    .replace(new RegExp(CARD.source, "g"), "[가림]")
    .replace(new RegExp(RRN.source, "g"), "[가림]")
    .replace(new RegExp(TOKENISH.source, "g"), "[가림]")
    .replace(new RegExp(LONG_RANDOM.source, "g"), (s) => (/\d/.test(s) && /[A-Za-z]/.test(s) && !/^https?/.test(s) ? "[가림]" : s))
    .replace(new RegExp(KEYWORD_VALUE.source, "gi"), (_m, kw: string, sep: string) => `${kw}${sep}[가림]`);
}
