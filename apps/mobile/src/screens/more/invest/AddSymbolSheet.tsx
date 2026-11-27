import { useState } from "react";
import { toApiError } from "../../../api/client";
import { Button } from "../../../ui/Button";
import { presentSheet, type SheetApi, type SheetSource } from "../../../ui/Sheet";
import { TextField } from "../../../ui/TextField";
import { investRes, reloadInvest } from "../data";
import { InlineError } from "../parts";
import * as api from "./api";

/**
 * 종목 추가 (DD 1935 §3-2 ②, DD 2008 §4): the person adds a symbol; 모시 never does (G6). One field, one button, off
 * while the field is empty. The server looks the symbol up; one it cannot find is said in the sheet, which stays open.
 * Added: the sheet closes and the overview, read again, has the new row on top.
 */
/** `initial`: the symbol filled in (a symbol's screen that is no longer watched, DD 0918 §2); the person still adds it */
export function presentAddSymbol(source: SheetSource, initial = "") {
  presentSheet({ source, title: "종목 추가", render: (sheet) => <AddSymbol sheet={sheet} initial={initial} /> });
}

const clean = (s: string) => s.trim().toUpperCase();
const NOT_FOUND = "찾을 수 없는 종목이에요. 기호를 다시 확인해 주세요.";

/** TextField has no props for these (DD 2008 §4: no autocorrect, no spellcheck on a ticker) */
const plainInput = (el: HTMLInputElement | null) => {
  if (!el) return;
  el.setAttribute("autocorrect", "off");
  el.spellcheck = false;
};

function AddSymbol({ sheet, initial }: { sheet: SheetApi; initial: string }) {
  const [symbol, setSymbol] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const s = clean(symbol);
  const watched = !!investRes.store.get().data?.watchlist.some((w) => w.symbol === s);
  const add = async () => {
    sheet.setBusy(true);
    try {
      await api.addWatch(s);
    } finally {
      sheet.setBusy(false);
    }
    await reloadInvest().catch(() => undefined);
  };
  return (
    <div className="iv-add-form">
      <TextField
        ref={plainInput}
        label="종목 기호"
        value={symbol}
        onChange={(v) => {
          setSymbol(v);
          setError(null);
        }}
        placeholder="예: SOXL, 005930"
        autoCapitalize="characters"
        autoComplete="off"
        enterKeyHint="done"
        maxLength={12}
        error={watched ? "이미 감시하고 있는 종목이에요." : undefined}
        autoFocus
      />
      <InlineError>{error}</InlineError>
      {/* a new symbol is a new try: the button leaves "다시 시도하기" when the field changes */}
      <Button
        key={s}
        tone="primary"
        size="lg"
        fullWidth
        disabled={!s || watched}
        action={add}
        onSuccess={() => sheet.close()}
        onError={(e) => {
          const err = toApiError(e);
          setError(err.code === "unknown_symbol" ? NOT_FOUND : err.message);
        }}
      >
        추가
      </Button>
    </div>
  );
}
