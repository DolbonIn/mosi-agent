import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isAborted, toApiError } from "../../../api/client";
import { createStore, useStore, type Store } from "../../../lib/createStore";
import { Button } from "../../../ui/Button";
import { ConfirmButton } from "../../../ui/ConfirmButton";
import { SegmentedControl } from "../../../ui/SegmentedControl";
import { presentSheet, type SheetApi, type SheetSource } from "../../../ui/Sheet";
import { SignalMark } from "../../../ui/Invest";
import { TextField } from "../../../ui/TextField";
import { Toggle } from "../../../ui/Toggle";
import { investRes, reloadInvest } from "../data";
import { ChoiceList, copyOf, SectionLabel } from "../parts";
import * as api from "./api";
import {
  actionChoices,
  BUFFER_RANGE,
  CALL_NOTE,
  canOnce,
  canSell,
  defaultAction,
  deleteNote,
  draftOf,
  isHeld,
  marketOf,
  KIND_WORD,
  NEW_KINDS,
  ONCE_NOTE,
  parseBufferPct,
  parsePrice,
  phoneNotice,
  ruleChanges,
  sheetTitle,
  toRuleDraft,
  untilDefault,
  untilMin,
  type Draft,
  type NewKind,
} from "./rules";
import type { InvestAction, InvestMode, InvestRulePreview, InvestRuleRow, InvestSettingsView } from "@pickle/protocol";

/**
 * 규칙 편집 시트 (DD 1935 §3-3, DD 2008 §3/§5, DD 2010 §4, DD 2015-b, DD 2042-b §1–§2, DD 2135). A new rule picks its
 * kind (the four 규칙 추가 makes: a segmented control while all four labels fit, else a 종류 choice list); a rule's own
 * sheet names its kind in the title and never changes it (PATCH has no kind). Then price (a range for 매수 검토), a
 * stop's 장중 버퍼 (empty = the default, the server's number as placeholder; its price and, on the default, its footnote
 * are the preview's), direction (가격 알림 only), what happens (a choice list; 매도 only for a stop on a held symbol),
 * 한 번 알리고 멈추기 (not on a sale), a 기한 switch with its date row. A hit or paused rule says so at the top: that is
 * its state now, not what saving does. The result sentence is the server's (POST /rules/preview, with its own numbers):
 * pinned over save with its warning while that stays within a third of the sheet, else at the end of the scroll content
 * with only save pinned (DD 2341: decided on measured heights, never a line count); save waits for the sentence of the draft as it stands, and stays off while nothing changed
 * (but a paused rule's 다시 감시하기, which arms it as it is). A stop above the price now still saves, under the server's
 * --danger warning. A live sale (preview confirm "hold") saves with ConfirmButton and its previewId. Server first: the
 * screen changes when the write is confirmed and the overview is read again.
 */

interface State {
  d: Draft;
  /** the last preview and the draft it was read for (an older one stays on screen, dimmed, while the next is read) */
  preview: InvestRulePreview | null;
  previewKey: string;
  previewError: string | null;
  error: string | null;
  /** the rule's rev the next PATCH is sent against */
  rev: number;
  /** the result sentence sits at the end of the form, not over save (it would take more than a third of the sheet) */
  resultInBody: boolean;
}

interface Ctx {
  symbol: string;
  rule: InvestRuleRow | null;
  market: "US" | "KR";
  mode: InvestMode;
  held: boolean;
  settings: InvestSettingsView;
  st: Store<State>;
}

const KINDS: { value: NewKind; label: string }[] = NEW_KINDS.map((k) => ({ value: k, label: KIND_WORD[k] }));

/**
 * 규칙 추가's kind: a segmented control while its four labels fit their segments, else a 종류 heading and a choice list
 * (DD 2135). Fit is measured on the labels themselves: an invisible copy of the control's track and segments (no roles,
 * inert) at the form's width, its labels bold as the chosen one is, read again whenever it or a label changes size.
 */
function KindPicker({ value, onChange }: { value: NewKind; onChange: (k: NewKind) => void }) {
  const measure = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const el = measure.current;
    if (!el) return;
    const check = () => setFits([...el.children].every((c) => c.scrollWidth <= c.clientWidth));
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const c of el.querySelectorAll(".seg-item > span")) ro.observe(c);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="iv-kind">
      <div ref={measure} className="seg iv-seg-measure" aria-hidden="true" inert>
        {KINDS.map((k) => (
          <span key={k.value} className="seg-item" data-on>
            <span>{k.label}</span>
          </span>
        ))}
      </div>
      {fits ? (
        <SegmentedControl options={KINDS} value={value} onChange={onChange} label="규칙 종류" role="radiogroup" />
      ) : (
        <div className="iv-field">
          <SectionLabel level={3} id="iv-rule-kind">
            종류
          </SectionLabel>
          <ChoiceList labelledBy="iv-rule-kind" value={value} options={KINDS} onChange={onChange} rowClassName="iv-flat-row iv-kind-choice" />
        </div>
      )}
    </div>
  );
}
const DIRECTIONS: { value: "above" | "below"; label: string }[] = [
  { value: "above", label: "이상" },
  { value: "below", label: "이하" },
];
const ACTION_WORD: Record<InvestAction, string> = { notify: "알림", call: "전화", sell: "매도(실제 주문이 켜져 있을 때)" };

export function presentRule(source: SheetSource, opened: { symbol: string; rule: InvestRuleRow | null }) {
  const o = investRes.store.get().data;
  if (!o) return;
  const { symbol, rule } = opened;
  const held = isHeld(o, symbol);
  const st = createStore<State>({ d: draftOf(rule, held), preview: null, previewKey: "", previewError: null, error: null, rev: rule?.rev ?? 0, resultInBody: false });
  const ctx: Ctx = { symbol, rule, market: marketOf(o, symbol), mode: o.mode, held, settings: o.settings, st };
  presentSheet({
    source,
    title: sheetTitle(symbol, rule),
    render: (sheet) => <RuleForm ctx={ctx} sheet={sheet} />,
    footer: (sheet) => <RuleFooter ctx={ctx} sheet={sheet} />,
  });
}

const draftKey = (ctx: Ctx, d: Draft) => {
  const draft = toRuleDraft(d, ctx.symbol, ctx.held, ctx.rule?.level);
  return { draft, key: draft ? JSON.stringify(draft) : "" };
};

/** the preview for the draft as it stands (fresh), the one on screen (an older one stays, dimmed), and a refusal */
function useResult(ctx: Ctx) {
  const s = useStore(ctx.st);
  const { draft, key } = useMemo(() => draftKey(ctx, s.d), [ctx, s.d]);
  const fresh = draft && s.preview && s.previewKey === key ? s.preview : null;
  // the server refused or could not be reached: its words stand where the sentence would (no older sentence beside them)
  const failed = !!draft && !fresh && !!s.previewError;
  const shown = draft ? (fresh ?? s.preview) : null;
  return { s, draft, key, fresh, failed, shown };
}

/** what saving does, the server's: its sentence (or its refusal), the stop warning, a save's error */
function ResultBlock({ ctx }: { ctx: Ctx }) {
  const { s, draft, fresh, failed, shown } = useResult(ctx);
  return (
    <div className="iv-result-block">
      {failed ? (
        <p className="iv-result-warn t-copy" role="alert">
          {copyOf(s.previewError!)}
        </p>
      ) : (
        <p className={`iv-result t-copy${draft && !fresh ? " is-stale" : ""}`} aria-live="polite" aria-busy={!!draft && !fresh}>
          {copyOf(shown ? shown.sentence : draft ? "저장하면 어떻게 되는지 확인하고 있어요." : "가격을 넣으면 저장했을 때 어떻게 되는지 여기에 보여 드려요.")}
        </p>
      )}
      {fresh?.warning && (
        <p className="iv-result-warn has-mark">
          <SignalMark signal="risk" className="iv-mark" />
          <span className="t-copy">{copyOf(fresh.warning)}</span>
        </p>
      )}
      {s.error && (
        <p className="iv-result-warn t-copy" role="alert">
          {copyOf(s.error)}
        </p>
      )}
    </div>
  );
}

function RuleForm({ ctx, sheet }: { ctx: Ctx; sheet: SheetApi }) {
  const s = useStore(ctx.st);
  const d = s.d;
  const set = (p: Partial<Draft>) => ctx.st.patch({ d: { ...ctx.st.get().d, ...p }, error: null });
  const unit = ctx.market === "KR" ? { trailing: <span className="iv-unit">원</span> } : { leading: "$" };
  const choices = actionChoices(d.kind, ctx.held);
  // a sale the symbol cannot make (its holding went) shows, and is sent as, what the kind does without one
  const action = d.action === "sell" && !canSell(d.kind, ctx.held) ? defaultAction(d.kind, false) : d.action;
  const lo = parsePrice(d.lo);
  const hiBad = d.kind === "buy_zone" && d.hi.trim() !== "" && (parsePrice(d.hi) === null || (lo !== null && (parsePrice(d.hi) ?? 0) <= lo));
  const now = Date.now();
  // the server's note once a preview has it; the same sentences from the settings until then
  const callLine = action === "call" ? (s.preview?.callNote ?? phoneNotice(ctx.settings)?.text ?? CALL_NOTE) : null;
  const delNote = ctx.rule ? deleteNote(ctx.rule, ctx.mode) : null;
  // the buffer's price and footnote come with the preview (the last one stays while the next is read); its default
  // number is the server's, the rule's or the last preview's (DD 2135: never one of the screen's own)
  const pv = s.preview;
  const pvFresh = !!pv && s.previewKey === draftKey(ctx, d).key;
  const bufferBad = parseBufferPct(d.bufferPct) === undefined;
  const lastDefault = useRef<string | undefined>(ctx.rule?.bufferDefault && ctx.rule.bufferPct?.v != null ? ctx.rule.bufferPct.text : undefined);
  if (pv?.bufferDefault && pv.bufferPct?.v != null) lastDefault.current = pv.bufferPct.text;
  // shown with the field empty too (DD 2135); the rule's own until the first preview
  const bufferPrice = pv?.buffer ?? ctx.rule?.buffer ?? null;
  // the server's footnote, the default's or a set value's; held back while it would say the other one than the field
  const bufferFoot = pv?.bufferFoot && pv.bufferDefault === (d.bufferPct.trim() === "") ? pv.bufferFoot : undefined;
  const priceField = (label: string, field: "price" | "lo" | "hi", error?: string) => (
    <TextField
      label={label}
      value={d[field]}
      onChange={(v) => set({ [field]: v })}
      inputMode="decimal"
      enterKeyHint="done"
      error={error ?? (d[field].trim() && parsePrice(d[field]) === null ? "숫자로 넣어 주세요." : undefined)}
      {...unit}
    />
  );

  return (
    <div className="iv-rule-form">
      {/* the rule's state now, the server's sentence (DD 2135): under the title, before what can change */}
      {(ctx.rule?.state === "hit" || ctx.rule?.state === "paused") && ctx.rule.stateFoot && <p className="iv-note iv-state-note t-copy">{copyOf(ctx.rule.stateFoot)}</p>}
      {!ctx.rule && <KindPicker value={d.kind as NewKind} onChange={(kind) => set({ kind, action: kind === d.kind ? d.action : defaultAction(kind, ctx.held) })} />}
      {d.kind === "buy_zone" ? (
        <>
          {priceField("구간 아래 가격", "lo")}
          {priceField("구간 위 가격", "hi", hiBad ? "아래 가격보다 큰 숫자로 넣어 주세요." : undefined)}
        </>
      ) : (
        priceField("가격", "price")
      )}
      {d.kind === "stop" && (
        <TextField
          label="장중 버퍼"
          value={d.bufferPct}
          onChange={(bufferPct) => set({ bufferPct })}
          inputMode="decimal"
          enterKeyHint="done"
          placeholder={lastDefault.current?.replace(/[\s%]/g, "")}
          error={bufferBad ? BUFFER_RANGE : undefined}
          hint={bufferFoot}
          trailing={
            <span className="iv-buffer-trail">
              <span>%</span>
              {bufferPrice && <span className={`iv-buffer-price tnum${pvFresh ? "" : " is-stale"}`}>{bufferPrice.text}</span>}
            </span>
          }
        />
      )}
      {d.kind === "alert" && (
        <SegmentedControl options={DIRECTIONS} value={d.direction === "above" ? "above" : "below"} onChange={(direction) => set({ direction })} label="방향" role="radiogroup" size="sm" />
      )}

      <div className="iv-field">
        <SectionLabel level={3} id="iv-rule-action">
          닿으면
        </SectionLabel>
        <ChoiceList labelledBy="iv-rule-action" value={action} options={choices.map((a) => ({ value: a, label: ACTION_WORD[a] }))} onChange={(a) => set({ action: a })} rowClassName="iv-flat-row iv-choice" />
        {callLine && <p className="iv-note t-copy">{copyOf(callLine)}</p>}
      </div>

      {canOnce(d.kind, action) && (
        <div className="iv-field">
          <div className="iv-flat">
            <div className="iv-flat-row">
              <span className="iv-flat-title" id="iv-once-label">
                한 번 알리고 멈추기
              </span>
              <Toggle label="한 번 알리고 멈추기" checked={d.once} onChange={(once) => set({ once })} />
            </div>
          </div>
          {d.once && <p className="iv-note t-copy">{copyOf(ONCE_NOTE)}</p>}
        </div>
      )}

      {/* 기한: the Reminders grammar (DD 2008 §5): a switch, and the native date row under it while it is on */}
      <div className="iv-flat iv-until">
        <div className="iv-flat-row">
          <span className="iv-flat-title" id="iv-until-label">
            기한
          </span>
          <Toggle label="기한" checked={d.until !== null} onChange={(on) => set({ until: on ? untilDefault(now) : null })} />
        </div>
        {d.until !== null && (
          <label className="iv-flat-row iv-until-day">
            <span className="iv-flat-title">마지막 날</span>
            <input
              className="iv-date-input tnum"
              type="date"
              value={d.until}
              min={untilMin(now)}
              onChange={(e) => set({ until: e.target.value || null })}
              aria-describedby="iv-until-label"
            />
          </label>
        )}
      </div>

      {ctx.rule && (
        <div className="iv-danger">
          {delNote && <p className="iv-note t-copy">{copyOf(delNote)}</p>}
          <ConfirmButton
            label="규칙 지우기"
            tone="destructive"
            size="md"
            fullWidth={false}
            confirmLabel="한 번 더 누르면 지워요"
            onConfirm={async () => {
              sheet.setBusy(true);
              try {
                await api.deleteRule(ctx.rule!.id);
              } finally {
                sheet.setBusy(false);
              }
              await reloadInvest().catch(() => undefined);
            }}
            onSuccess={() => sheet.close()}
            onError={(e) => ctx.st.patch({ error: toApiError(e).message })}
          />
        </div>
      )}
      {/* the result too tall to pin (DD 2341): the scroll content's end, just over save */}
      {s.resultInBody && <ResultBlock ctx={ctx} />}
    </div>
  );
}

/** pinned under the form: save, and over it the result while it fits a third of the sheet */
function RuleFooter({ ctx, sheet }: { ctx: Ctx; sheet: SheetApi }) {
  const { s, draft, key, fresh } = useResult(ctx);
  const foot = useRef<HTMLDivElement>(null);

  // where the result goes (DD 2341): the pinned part (result + warning + save) at most a third of the sheet, measured
  // whenever the sheet, the pinned part or the result changes size. In the form the result is never wider than here
  // (the body has the wider inset), so a result moved there for its height never fits back and nothing flips.
  useLayoutEffect(() => {
    const el = foot.current;
    const pinned = el?.closest<HTMLElement>(".sheet-footer");
    const panel = el?.closest<HTMLElement>(".sheet-panel");
    if (!el || !pinned || !panel) return;
    const block = panel.querySelector<HTMLElement>(".iv-result-block");
    const check = () => {
      const inBody = ctx.st.get().resultInBody;
      const gap = parseFloat(getComputedStyle(el).rowGap) || 0;
      const pinnedH = pinned.getBoundingClientRect().height + (inBody && block ? block.getBoundingClientRect().height + gap : 0);
      const next = pinnedH > panel.getBoundingClientRect().height / 3;
      if (next !== inBody) ctx.st.patch({ resultInBody: next });
    };
    check();
    // moving the result resizes what is observed: decided on the next frame, not inside the observer's delivery (WebKit
    // reports a loop otherwise)
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    });
    ro.observe(panel);
    ro.observe(pinned);
    if (block) ro.observe(block);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [ctx, s.resultInBody]);

  // the sentence for the draft as it stands: read a moment after it settles, an older read dropped
  useEffect(() => {
    if (!draft) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api.previewRule(draft, ctx.rule?.id ?? null, { signal: ctrl.signal }).then(
        (preview) => ctx.st.patch({ preview, previewKey: key, previewError: null }),
        (e) => {
          if (!isAborted(e)) ctx.st.patch({ previewError: toApiError(e).message, previewKey: "" });
        },
      );
    }, 250);
    ctx.st.patch({ previewError: null });
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // the draft's sent shape is the dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // the save control follows the server's confirm once it has spoken; before that, a live sale is assumed to hold
  const hold = fresh ? fresh.confirm === "hold" : !!draft && draft.action === "sell" && ctx.mode === "real";
  // a paused rule: any save arms it again (agent-runtime 2052 A1), so the one button says so (DD 2042-b §1) and is on
  // with nothing changed; any other rule's save waits for the server to see a change (preview `changed`, DD 2135)
  const paused = ctx.rule?.state === "paused";
  const off = !fresh || (!fresh.changed && !paused);

  const save = async () => {
    const p = fresh!;
    sheet.setBusy(true);
    try {
      if (ctx.rule) await api.patchRule(ctx.rule.id, ruleChanges(draft!), ctx.st.get().rev, p.previewId);
      else await api.createRule(draft!, p.previewId);
    } finally {
      sheet.setBusy(false);
    }
    await reloadInvest().catch(() => undefined);
  };
  const onError = (e: unknown) => {
    const err = toApiError(e);
    const data = err.data as { preview?: InvestRulePreview; rule?: InvestRuleRow } | undefined;
    // the quantity, the mode or the rule moved since the sentence was read: the new one replaces it, and the
    // person reads it before pressing again
    if (err.code === "preview_stale" && data?.preview) ctx.st.patch({ preview: data.preview, previewKey: key });
    if (err.code === "rule_changed" && data?.rule) {
      ctx.st.patch({ rev: data.rule.rev });
      void reloadInvest().catch(() => undefined);
    }
    ctx.st.patch({ error: err.message });
  };

  return (
    <div ref={foot} className="iv-rule-foot">
      {!s.resultInBody && <ResultBlock ctx={ctx} />}
      {hold ? (
        <ConfirmButton key={key} label={paused ? "길게 눌러 다시 감시하기" : "길게 눌러 저장"} disabled={off} onConfirm={save} onSuccess={() => sheet.close()} onError={onError} />
      ) : (
        <Button key={key} tone="primary" size="lg" fullWidth disabled={off} action={save} onSuccess={() => sheet.close()} onError={onError}>
          {paused ? "다시 감시하기" : "저장"}
        </Button>
      )}
    </div>
  );
}
