import type { AttachmentRef, ID } from "@pickle/protocol";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import * as ep from "../../api/endpoints";
import { island } from "../../app/island";
import { haptic } from "../../motion/haptics";
import { EXIT, t } from "../../motion/springs";
import { R } from "../../ui/geometry";
import { Glass } from "../../ui/Glass";
import { Icon } from "../../ui/Icon";
import { SendButton } from "../../ui/SendButton";
import { copy } from "../../ui/Text";
import { createRecognizer, type Recognizer } from "./call/recognizer";
import { composerStore, setComposerText, useComposerText } from "./composerStore";
import { ACCEPT, asUpload, textFile, textFileName, tooLongForMessage } from "./textFile";
import { josa, MAX_CHARS } from "./util";

/**
 * The chat composer — glass lens r28 portalled into the bottom chrome group (shares its one backdrop-filter).
 *   [+ attach]  [auto-growing field]  [SendButton mic ↔ send ↔ stop]  [call circle]
 * - Enter sends (IME-safe), Shift+Enter breaks a line; a counter near the 4,000 characters a message holds (3,501–4,000).
 * - Attach: POST /api/attachments (field `file`) per file, thumbnails with a remove button, send waits for uploads.
 * - Longer text goes as a .txt attachment (textFile.ts, DD 1736): a paste that would pass 4,000 becomes one at once
 *   (only the pasted text; the field keeps what was typed) with a status line under the field; a field typed past
 *   4,000 says so under the field and goes as one file when sent (no message text).
 * - Focus minimises the tab bar (iOS 26) and the composer takes the row; blur restores it.
 * - The keyboard lifts it (`--kb`, visualViewport).
 * - Mic = dictation into the field (Web Speech ko-KR) where available; otherwise an honest banner.
 * One accent: the send arrow (only when there is something to send). Call and attach are neutral.
 */
export interface Upload {
  key: string;
  file: File;
  preview: string | null;
  id: ID | null;
  error: string | null;
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const TOO_MANY = "한 번에 10개까지 보낼 수 있어요";
const TOO_BIG = "10MB까지 보낼 수 있어요";
/** a paste past 4,000 characters went as a file (until the next input, a file taken out or a send) */
const PASTED = "4,000자가 넘어서 파일로 붙였어요";
/** the field is past 4,000 characters: it goes as a file when sent */
const GOES_AS_FILE = "4,000자가 넘어서 파일로 보내요";
let upSeq = 0;
/** an uploaded row as the message will carry it (the server's url form: /api/attachments/:id/raw) */
const refOf = (u: Upload): AttachmentRef => ({
  id: u.id!,
  filename: u.file.name,
  mime: u.file.type || "application/octet-stream",
  size: u.file.size,
  url: `/api/attachments/${encodeURIComponent(u.id!)}/raw`,
});
/**
 * Threads whose composer has already appeared. The composer lives in the bottom chrome and unmounts while a sheet or
 * another screen covers the thread; when the thread is on top again it must be there at once (re-running the fade-in
 * left the bar blank for a moment).
 */
const appeared = new Set<string>();

export interface ComposerProps {
  threadId: ID;
  placeholder: string;
  streaming: boolean;
  /** resolves with true when the text should come back (refused before the turn started, e.g. 409 busy) */
  /** the text and the files that go (their refs: the bubble draws them, 다시 보내기 sends the same ids) */
  onSubmit: (text: string, attachments: AttachmentRef[]) => Promise<boolean>;
  onStop: () => void;
  onCall?: (el: HTMLElement) => void;
  /** friend threads: "@깽이" hint */
  mention?: string;
  disabled?: boolean;
}

export function Composer({ threadId, placeholder, streaming, onSubmit, onStop, onCall, mention, disabled }: ComposerProps) {
  const text = useComposerText(threadId);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const live = useRef(uploads);
  live.current = uploads;
  /** files taken out before their upload ended: the upload is deleted when it ends */
  const dropped = useRef(new Set<string>());
  const [focused, setFocused] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const rec = useRef<Recognizer | null>(null);
  const focusSeq = useRef(composerStore.get().focusSeq);

  // auto-grow (1 → 5 lines), measured before paint
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "0px";
    const h = Math.min(el.scrollHeight, 132);
    el.style.height = `${Math.max(24, h)}px`;
  }, [text]);

  // focus requests (suggestion chips, nav.compose)
  useEffect(
    () =>
      composerStore.subscribe(() => {
        const s = composerStore.get();
        if (s.focusSeq !== focusSeq.current) {
          focusSeq.current = s.focusSeq;
          if (s.focusThread === threadId) {
            const el = field.current;
            el?.focus({ preventScroll: true });
            el?.setSelectionRange(el.value.length, el.value.length);
          }
        }
      }),
    [threadId],
  );

  useEffect(
    () => () => {
      rec.current?.abort();
    },
    [],
  );

  const uploading = uploads.some((u) => !u.id && !u.error);
  const ready = uploads.filter((u) => u.id).map((u) => u.id!) as ID[];
  const long = tooLongForMessage(text);
  const hasContent = !!text.trim() || ready.length > 0;
  const mode = hasContent ? "send" : streaming ? "stop" : "mic";

  /**
   * `back` returns to the field without losing what was typed since (DD 2058 §1): before it, on a line of its own.
   */
  const giveBack = (back: string) => {
    if (!back) return;
    const now = composerStore.get().text[threadId] ?? "";
    setComposerText(threadId, now ? `${back}\n${now}` : back);
  };

  const submit = useCallback(async () => {
    if (disabled || uploading || !hasContent) return;
    rec.current?.stop();
    setNotice(null);
    let body = text;
    // what goes is what the row held at this press (DD 2058 §2): files put in while the text uploads stay in the row,
    // files taken out meanwhile do not go
    const pressed = new Set(live.current.filter((u) => u.id).map((u) => u.key));
    let textKey: string | null = null;
    if (tooLongForMessage(body)) {
      // more than a message holds: the field goes as a .txt (it comes back if that cannot be sent)
      if (live.current.length >= MAX_FILES) {
        setError(TOO_MANY);
        return;
      }
      setComposerText(threadId, "");
      setError(null);
      const [u] = await startText(body).done;
      if (!u?.id || dropped.current.has(u.key)) {
        // the upload failed, or its row was taken out meanwhile: the text comes back to the field, the row goes
        if (u && !dropped.current.has(u.key)) removeUpload(u.key);
        if (u?.error) setError(u.error === TOO_BIG ? TOO_BIG : "올리지 못했어요");
        giveBack(body);
        return;
      }
      body = "";
      textKey = u.key;
    } else {
      // the field emptied at once (whatever is typed from here on is the next message: it stays)
      setComposerText(threadId, "");
    }
    const sent = live.current.filter((u) => u.id && (pressed.has(u.key) || u.key === textKey));
    const out = new Set(sent.map((u) => u.key));
    live.current = live.current.filter((u) => !out.has(u.key));
    setUploads((cur) => cur.filter((u) => !out.has(u.key)));
    setError(null);
    haptic("selection");
    const restore = await onSubmit(body, sent.map(refOf));
    if (restore) {
      // refused before the turn started: what went comes back, in front of what was put in since
      giveBack(body);
      const back = sent.filter((u) => !live.current.some((x) => x.key === u.key));
      live.current = [...back, ...live.current];
      setUploads((cur) => [...back, ...cur.filter((x) => !out.has(x.key))]);
    } else {
      for (const u of sent) if (u.preview) URL.revokeObjectURL(u.preview);
    }
  }, [disabled, uploading, hasContent, text, threadId, onSubmit]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void submit();
  };

  /**
   * Puts `files` in the files row and uploads them (each with the type it goes as: textFile.ts asUpload). `fresh` are
   * the rows put in (none past the 10 a message takes); `done` resolves with each row as its upload ended.
   */
  const startUploads = (files: File[]): { fresh: Upload[]; done: Promise<Upload[]> } => {
    const room = MAX_FILES - live.current.length;
    const list = files.slice(0, Math.max(0, room));
    if (files.length > room) setError(TOO_MANY);
    const fresh: Upload[] = list.map((raw) => {
      const file = asUpload(raw);
      return {
        key: `u${++upSeq}`,
        file: file ?? raw,
        preview: raw.type.startsWith("image/") && raw.type !== "image/svg+xml" ? URL.createObjectURL(raw) : null,
        id: null,
        error: !file ? "보낼 수 없는 형식이에요" : raw.size > MAX_BYTES ? TOO_BIG : null,
      };
    });
    live.current = [...live.current, ...fresh];
    setUploads((cur) => [...cur, ...fresh]);
    const set = (key: string, patch: Partial<Upload>) => {
      live.current = live.current.map((x) => (x.key === key ? { ...x, ...patch } : x));
      setUploads((cur) => cur.map((x) => (x.key === key ? { ...x, ...patch } : x)));
    };
    const done = Promise.all(
      fresh.map(async (u): Promise<Upload> => {
        if (u.error) return u;
        try {
          const a = await ep.uploadAttachment(u.file, threadId);
          if (dropped.current.has(u.key)) void ep.deleteAttachment(a.id).catch(() => {});
          else set(u.key, { id: a.id });
          return { ...u, id: a.id };
        } catch (e) {
          const error = (e as Error).message || "올리지 못했어요";
          set(u.key, { error });
          return { ...u, error };
        }
      }),
    );
    return { fresh, done };
  };

  /** text longer than a message as a .txt, named after its first line (none when the row already holds 10 files) */
  const startText = (body: string) => startUploads([textFile(body, textFileName(body, live.current.map((u) => u.file.name)))]);

  /** a paste that would pass 4,000 characters: only the pasted text goes, as a file, at once (none past 10 files) */
  const pasteAsFile = (pasted: string) => {
    if (startText(pasted).fresh.length) setNotice(PASTED);
  };

  const removeUpload = (key: string) => {
    const u = live.current.find((x) => x.key === key);
    dropped.current.add(key);
    setNotice(null);
    live.current = live.current.filter((x) => x.key !== key);
    setUploads((cur) => cur.filter((x) => x.key !== key));
    if (u?.preview) URL.revokeObjectURL(u.preview);
    if (u?.id) void ep.deleteAttachment(u.id).catch(() => {});
  };

  const toggleDictation = () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    rec.current ??= createRecognizer();
    if (!rec.current) {
      island.banner({ icon: "mic", title: "이 브라우저에서는 받아쓰기를 쓸 수 없어요", body: "글자로 입력해 주세요" });
      return;
    }
    const base = text ? `${text.replace(/\s+$/, "")} ` : "";
    setListening(true);
    island.listening();
    rec.current.start({
      onInterim: (s) => setComposerText(threadId, base + s),
      onFinal: (s) => {
        setComposerText(threadId, base + s);
        setListening(false);
        island.idle();
        field.current?.focus({ preventScroll: true });
      },
      onEnd: () => {
        setListening(false);
        island.idle();
      },
      onError: (code) => {
        setListening(false);
        island.idle();
        if (code === "not-allowed" || code === "service-not-allowed") island.errorBanner("브라우저 설정에서 마이크를 허용해 주세요", "마이크를 쓸 수 없어요");
      },
    });
  };

  const [firstShow] = useState(() => !appeared.has(threadId));
  useEffect(() => {
    appeared.add(threadId);
  }, [threadId]);

  const showMention = !!mention && focused && !text.includes("@");
  const count = text.length;
  // the counter warns that the limit is near (3,501–4,000); past it the line says what happens instead (DD 2058 §3),
  // and while "붙였어요" shows it waits (both beside each other squeezed the line to three lines at 320 × 130 %)
  const showCount = count > MAX_CHARS - 500 && !long && !notice;

  return (
    <motion.div className="composer-wrap" initial={firstShow ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} transition={t("camera")}>
      <Glass blur="group" text lens radius={R.composer} className="composer" data-focused={focused || undefined} data-listening={listening || undefined}>
        <AnimatePresence initial={false}>
          {uploads.length > 0 && (
            <motion.ul className="composer-files" aria-label="첨부 파일" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: EXIT }} transition={t("fade")}>
              {uploads.map((u) => (
                <li key={u.key} className="composer-file" data-state={u.error ? "error" : u.id ? "ready" : "uploading"}>
                  {u.preview ? <img src={u.preview} alt="" className="composer-thumb" /> : <span className="composer-doc"><Icon name="doc" size={20} /></span>}
                  <span className="composer-file-name">{u.error ?? u.file.name}</span>
                  {!u.id && !u.error && <span className="composer-file-ring" data-loop="busy" aria-label="올리는 중" />}
                  <button type="button" className="composer-file-x" aria-label={`${u.file.name} 빼기`} onClick={() => removeUpload(u.key)}>
                    <Icon name="close" size={12} weight="semibold" />
                  </button>
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
        {showMention && (
          <button
            type="button"
            className="composer-mention"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setComposerText(threadId, `@${mention} ${text}`);
              field.current?.focus();
            }}
          >
            <Icon name="at" size={14} weight="medium" />
            <span className="sr-only">@</span>
            {mention} 붙이면 {josa(mention, "이", "가")} 답해요
          </button>
        )}
        <div className="composer-row">
          <button type="button" className="composer-icon" aria-label="파일 첨부" disabled={disabled} onClick={() => fileInput.current?.click()}>
            <Icon name="plus" size={22} weight="medium" />
          </button>
          <input ref={fileInput} type="file" multiple hidden accept={ACCEPT} onChange={(e: ChangeEvent<HTMLInputElement>) => {
            startUploads(Array.from(e.target.files ?? []));
            e.target.value = "";
          }} />
          <textarea
            ref={field}
            className="composer-field"
            rows={1}
            value={text}
            placeholder={listening ? "듣고 있어요" : placeholder}
            aria-label="메시지"
            enterKeyHint="send"
            disabled={disabled}
            onChange={(e) => {
              setComposerText(threadId, e.target.value);
              if (error) setError(null);
              if (notice) setNotice(null);
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData("text/plain");
              const el = e.currentTarget;
              if (!pasted || text.length - (el.selectionEnd - el.selectionStart) + pasted.length <= MAX_CHARS) return;
              // more than a message holds: the pasted text goes as a .txt; what is in the field stays
              e.preventDefault();
              pasteAsFile(pasted);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
          <SendButton mode={mode} disabled={disabled || (mode === "send" && uploading)} onSend={() => void submit()} onStop={onStop} onMic={toggleDictation} />
          {/* talking with the agent: a waveform, not the phone of the call cards (a call the agent places for you).
              While there is something to send it folds away on `morph` (chat B), so send never sits 2 px from it;
              it comes back when the field is cleared */}
          {onCall && (
            <motion.button
              type="button"
              className="composer-icon composer-call"
              aria-label="통화하기"
              aria-hidden={hasContent || undefined}
              tabIndex={hasContent ? -1 : undefined}
              disabled={disabled || hasContent}
              data-folded={hasContent || undefined}
              initial={false}
              animate={hasContent ? { width: 0, marginLeft: 0, opacity: 0 } : { width: 44, marginLeft: 6, opacity: 1 }}
              transition={t("morph")}
              onClick={(e) => onCall(e.currentTarget)}
            >
              <Icon name="waveform" size={21} weight="medium" />
            </motion.button>
          )}
        </div>
        {(showCount || long || error || notice) && (
          <div className="composer-foot">
            {error ? (
              <span className="composer-err" role="alert">{error}</span>
            ) : (
              (notice || long) && (
                <span className="composer-note t-copy" role="status">
                  {copy(notice ?? GOES_AS_FILE)}
                </span>
              )
            )}
            {showCount && (
              <span className="composer-count tnum">
                {count.toLocaleString("ko-KR")}/{MAX_CHARS.toLocaleString("ko-KR")}
              </span>
            )}
          </div>
        )}
      </Glass>
    </motion.div>
  );
}
