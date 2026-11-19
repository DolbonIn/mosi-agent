import type { SettingsPatch, UserSettings } from "@pickle/protocol";
import { useCallback } from "react";
import { toApiError } from "../../../api/client";
import { updateSettings, useSettings } from "../../../api/store";
import { island } from "../../../app/island";
import { josa } from "../format";

/**
 * Settings rows change optimistically through the foundation's updateSettings() (display prefs apply at once, the
 * PATCH deep-merges on the server, a failure rolls everything back). A failure is said once, in Korean, from the
 * island — the control has already sprung back.
 */
export function useSettingsPatch() {
  return useCallback((patch: SettingsPatch, what = "설정") => {
    updateSettings(patch).catch((e) => island.errorBanner(toApiError(e).message, `${josa(what, "을를")} 바꾸지 못했어요`));
  }, []);
}

export function useCurrentSettings(): UserSettings | null {
  return useSettings();
}
