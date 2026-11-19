// Meet 링크 검사. https://meet.google.com/abc-defg-hij 형식만 받는다(쿼리·끝 슬래시는 버리고 정규화).
export const MEET_URL_RE = /^(?:https:\/\/)?meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?(?:\?[^#\s]*)?(?:#\S*)?$/i;

export interface MeetUrl {
  code: string;
  url: string;
}

export function parseMeetUrl(input: unknown): MeetUrl | null {
  if (typeof input !== "string") return null;
  const m = MEET_URL_RE.exec(input.trim());
  if (!m) return null;
  const code = m[1]!.toLowerCase();
  return { code, url: `https://meet.google.com/${code}` };
}

/** 로그용: rak-ughm-kud → rak-****-kud */
export function maskCode(code: string): string {
  const m = /^([a-z]{3})-[a-z]{4}-([a-z]{3})$/i.exec(code);
  return m ? `${m[1]}-****-${m[2]}` : "***";
}
