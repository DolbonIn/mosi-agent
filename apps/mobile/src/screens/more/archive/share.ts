import { API_BASE, getToken } from "../../../api/client";
import { island } from "../../../app/island";

/**
 * Copy / share for archive items. Success is announced only after the platform confirms (the clipboard promise
 * resolved, or execCommand returned true) — never before.
 */

export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      island.banner({ icon: "checkmark", title: "복사했어요" });
      return;
    }
  } catch {
    /* fall through to the legacy path (WebKit without a user-activation grant, insecure origins) */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  if (!ok) throw new Error("클립보드에 복사하지 못했어요. 길게 눌러 직접 복사해 주세요.");
  island.banner({ icon: "checkmark", title: "복사했어요" });
}

/** System share sheet when there is one; otherwise copy. Resolves "shared" | "copied" | "cancelled". */
export async function shareText(title: string, text: string): Promise<"shared" | "copied" | "cancelled"> {
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void>; canShare?: (d: ShareData) => boolean };
  const data: ShareData = { title, text };
  if (typeof nav.share === "function" && (!nav.canShare || nav.canShare(data))) {
    try {
      await nav.share(data);
      return "shared";
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return "cancelled";
      // NotAllowedError etc. → copy instead
    }
  }
  await copyText(text);
  return "copied";
}

/** `<img src>` / `<iframe src>` for an attachment: the bearer token rides in the query (contract: ?token=). */
export function rawUrl(id: string): string {
  const token = getToken() ?? "";
  return `${API_BASE}/api/attachments/${encodeURIComponent(id)}/raw?token=${encodeURIComponent(token)}`;
}
