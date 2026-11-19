import type { ID } from "@pickle/protocol";
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
import { createRecognizer, type Recognizer } from "./call/recognizer";
import { composerStore, setComposerText, useComposerText } from "./composerStore";
import { josa, MAX_CHARS } from "./util";

/**
 * The chat composer — glass lens r28 portalled into the bottom chrome group (shares its one backdrop-filter).
 *   [+ attach]  [auto-growing field]  [SendButton mic ↔ send ↔ stop]  [call circle]
 * - Enter sends (IME-safe), Shift+Enter breaks a line; 4,000-character guard with a counter near the limit.
 * - Attach: POST /api/attachments (field `file`) per file, thumbnails with a remove button, send waits for uploads.
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

const OK_TYPE = /^(image\/(png|jpe?g|gif|webp|heic|heif|avif)|application\/pdf|text\/plain)$/i;
const MAX_BYTES = 10 * 1024 * 1024;
let upSeq = 0;
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
  onSubmit: (text: string, attachmentIds: ID[]) => Promise<boolean>;
  onStop: () => void;
  onCall?: (el: HTMLElement) => void;
  /** friend threads: "@깽이" hint */
  mention?: string;
  disabled?: boolean;
}

export function Composer({ threadId, placeholder, streaming, onSubmit, onStop, onCall, mention, disabled }: ComposerProps) {
  const text = useComposerText(threadId);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [focused, setFocused] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const over = text.length > MAX_CHARS;
  const hasContent = !!text.trim() || ready.length > 0;
  const mode = hasContent ? "send" : streaming ? "stop" : "mic";

  const submit = useCallback(async () => {
    if (disabled || over || uploading || !hasContent) {
      if (over) setError(`${MAX_CHARS.toLocaleString("ko-KR")}자까지 보낼 수 있어요`);
      return;
    }
    rec.current?.stop();
    const body = text;
    const keep = uploads;
    setComposerText(threadId, "");
    setUploads([]);
    setError(null);
    haptic("selection");
    const restore = await onSubmit(body, ready);
    if (restore) {
      if (!composerStore.get().text[threadId]) setComposerText(threadId, body);
      setUploads((cur) => (cur.length ? cur : keep));
    } else {
      for (const u of keep) if (u.preview) URL.revokeObjectURL(u.preview);
    }
  }, [disabled, over, uploading, hasContent, text, uploads, ready, threadId, onSubmit]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void submit();
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = 10 - uploads.length;
    const list = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > room) setError("한 번에 10개까지 보낼 수 있어요");
    const fresh: Upload[] = list.map((file) => ({
      key: `u${++upSeq}`,
      file,
      preview: file.type.startsWith("image/") && file.type !== "image/svg+xml" ? URL.createObjectURL(file) : null,
      id: null,
      error: !OK_TYPE.test(file.type) ? "보낼 수 없는 형식이에요" : file.size > MAX_BYTES ? "10MB까지 보낼 수 있어요" : null,
    }));
    setUploads((cur) => [...cur, ...fresh]);
    await Promise.all(
      fresh
        .filter((u) => !u.error)
        .map(async (u) => {
          try {
            const a = await ep.uploadAttachment(u.file, threadId);
            setUploads((cur) => cur.map((x) => (x.key === u.key ? { ...x, id: a.id } : x)));
          } catch (e) {
            setUploads((cur) => cur.map((x) => (x.key === u.key ? { ...x, error: (e as Error).message || "올리지 못했어요" } : x)));
          }
        }),
    );
  };

  const removeUpload = (u: Upload) => {
    setUploads((cur) => cur.filter((x) => x.key !== u.key));
    if (u.preview) URL.revokeObjectURL(u.preview);
    if (u.id) void ep.deleteAttachment(u.id).catch(() => {});
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
                  <button type="button" className="composer-file-x" aria-label={`${u.file.name} 빼기`} onClick={() => removeUpload(u)}>
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
          <input ref={fileInput} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,image/heic,application/pdf,text/plain" onChange={(e: ChangeEvent<HTMLInputElement>) => {
            void addFiles(e.target.files);
            e.target.value = "";
          }} />
          <textarea
            ref={field}
            className="composer-field"
            rows={1}
            value={text}
            placeholder={listening ? "듣고 있어요" : placeholder}
            aria-label="메시지"
            aria-invalid={over || undefined}
            enterKeyHint="send"
            disabled={disabled}
            onChange={(e) => {
              setComposerText(threadId, e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
          <SendButton mode={mode} disabled={disabled || (mode === "send" && (over || uploading))} onSend={() => void submit()} onStop={onStop} onMic={toggleDictation} />
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
        {(count > MAX_CHARS - 500 || error) && (
          <div className="composer-foot">
            {error && <span className="composer-err" role="alert">{error}</span>}
            {count > MAX_CHARS - 500 && (
              <span className="composer-count tnum" data-over={over || undefined}>
                {count.toLocaleString("ko-KR")}/{MAX_CHARS.toLocaleString("ko-KR")}
              </span>
            )}
          </div>
        )}
      </Glass>
    </motion.div>
  );
}
