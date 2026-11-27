import { apiDelete, apiGet, apiPatch, apiPost, type ApiOptions } from "../../../api/client";
import type { InvestOverview, InvestRuleChanges, InvestRuleDraft, InvestRulePreview, InvestSettingsPatch, InvestSettingsView, InvestSymbolDetail, InvestTossStatus } from "@pickle/protocol";
import { ruleChanges } from "./rules";

/**
 * The 투자 screen's requests, on agent-runtime's paths (2006 §5; @pickle/protocol API.invest*). A write answers with
 * whatever the server confirms; the screen then reads the overview again (or takes it from the `invest` event), so no
 * write's reply shape is relied on. No request here reaches Toss: the server does that, and QA runs the screen against
 * a fake server and a key-less real one (no quote source, no Toss).
 */
const enc = encodeURIComponent;

export const overview = (opts?: ApiOptions) => apiGet<InvestOverview>("/api/invest", opts);
/** one watched symbol (its screen, DD 0914): its row, rules, last 5 alerts and chart; 404 not_watched once it is not */
export const symbolDetail = (symbol: string, opts?: ApiOptions) => apiGet<InvestSymbolDetail>(`/api/invest/symbols/${enc(symbol)}`, opts);
// an edit's preview is of the changes PATCH will send (the server reads `changes` against the rule; the draft rides along)
export const previewRule = (draft: InvestRuleDraft, ruleId: string | null, opts?: ApiOptions) =>
  apiPost<InvestRulePreview>("/api/invest/rules/preview", ruleId ? { ...draft, ruleId, changes: ruleChanges(draft) } : draft, opts);
export const createRule = (draft: InvestRuleDraft, previewId: string | null) => apiPost<unknown>("/api/invest/rules", { draft, ...(previewId ? { previewId } : {}) });
export const patchRule = (id: string, changes: InvestRuleChanges, ifRev: number, previewId: string | null) =>
  apiPatch<unknown>(`/api/invest/rules/${enc(id)}`, { changes, ifRev, ...(previewId ? { previewId } : {}) });
export const deleteRule = (id: string) => apiDelete(`/api/invest/rules/${enc(id)}`);
export const addWatch = (symbol: string) => apiPost<unknown>("/api/invest/watchlist", { symbol });
/** PATCH /api/invest/settings: today only which events call (DD 2010 §4); the server answers its settings view */
export const patchSettings = (patch: InvestSettingsPatch) => apiPatch<InvestSettingsView>("/api/invest/settings", patch);
/** POST /api/invest/toss/check: the server asks Toss now (429 toss_check_too_soon within a minute of the last) */
export const checkToss = () => apiPost<InvestTossStatus>("/api/invest/toss/check");
