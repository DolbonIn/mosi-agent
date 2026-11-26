import { useEffect, useRef, useState, type MouseEvent } from "react";
import { toApiError } from "../../../api/client";
import { ChromePortal } from "../../../app/ChromePortal";
import { checkFile, FILE_ACCEPT, withUploadType } from "../../../lib/uploadTypes";
import { Button, type ButtonState } from "../../../ui/Button";
import { Glass } from "../../../ui/Glass";
import { capsule } from "../../../ui/geometry";
import { Icon, type AppIconName } from "../../../ui/Icon";
import { presentSheet, type SheetApi } from "../../../ui/Sheet";
import { upload } from "../data";
import { bytesKo } from "../format";
import { InlineError, Note } from "../parts";

/**
 * Upload: a neutral glass FAB in the bottom chrome group (shares its one backdrop-filter) that morphs into a picker
 * sheet. Picking a file starts the upload at once; the button shows the loader and turns into the check only after
 * the server's 201 — then the sheet folds back and the new tile is in the grid.
 */

export function openUploadPicker(source: HTMLElement | null) {
  presentSheet({ source, title: "보관함에 올리기", render: (api) => <UploadPicker api={api} /> });
}

const OPTIONS: { id: string; label: string; sub: string; icon: AppIconName; accept: string; capture?: "environment" }[] = [
  { id: "library", label: "사진 보관함에서 고르기", sub: "PNG · JPG · HEIC · GIF", icon: "photo", accept: "image/*" },
  { id: "camera", label: "카메라로 찍기", sub: "찍은 사진을 바로 올려요", icon: "film", accept: "image/*", capture: "environment" },
  { id: "file", label: "파일 고르기", sub: "PDF · 텍스트 파일", icon: "doc", accept: FILE_ACCEPT },
];

function UploadPicker({ api }: { api: SheetApi }) {
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [file, setFile] = useState<File | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [state, setState] = useState<ButtonState>("idle");
  const [err, setErr] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    // set on every mount: StrictMode mounts → unmounts → mounts again
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => () => {
    if (thumb) URL.revokeObjectURL(thumb);
  }, [thumb]);

  const run = async (f: File) => {
    setErr(null);
    setState("loading");
    api.setBusy(true);
    try {
      await upload(withUploadType(f));
      if (!mounted.current) return;
      api.setBusy(false);
      setState("success");
      setTimeout(() => api.close(), 700);
    } catch (e) {
      api.setBusy(false);
      if (!mounted.current) return;
      setState("error");
      setErr(toApiError(e).message);
    }
  };

  const onPick = (f: File | undefined) => {
    if (!f) return;
    const bad = checkFile(f);
    setFile(f);
    setThumb(f.type.startsWith("image/") && !bad ? URL.createObjectURL(f) : null);
    if (bad) {
      setState("idle");
      setErr(bad);
      return;
    }
    void run(f);
  };

  return (
    <div className="arc-pick">
      <div className="more-sheet-rows" role="group" aria-label="올릴 방법">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            className="more-sheet-row arc-pick__row"
            disabled={state === "loading"}
            onClick={() => inputs.current[o.id]?.click()}
          >
            <span className="more-sheet-row__icon" aria-hidden="true">
              <Icon name={o.icon} size={18} weight="medium" />
            </span>
            <span className="more-sheet-row__main">
              <span className="more-sheet-row__title">{o.label}</span>
              <span className="more-sheet-row__sub">{o.sub}</span>
            </span>
            <Icon name="chevron-right" size={16} weight="semibold" className="arc-pick__chev" />
          </button>
        ))}
      </div>
      {OPTIONS.map((o) => (
        <input
          key={o.id}
          ref={(el) => {
            inputs.current[o.id] = el;
          }}
          type="file"
          accept={o.accept}
          capture={o.capture}
          hidden
          tabIndex={-1}
          aria-hidden="true"
          data-upload={o.id}
          onChange={(e) => {
            onPick(e.currentTarget.files?.[0]);
            e.currentTarget.value = "";
          }}
        />
      ))}

      {file && (
        <div className="arc-pick__file" aria-live="polite">
          <span className="arc-pick__thumb" aria-hidden="true">
            {thumb ? <img src={thumb} alt="" /> : <Icon name={file.type.startsWith("image/") ? "photo" : "doc"} size={22} weight="medium" />}
          </span>
          <span className="arc-pick__info">
            <span className="arc-pick__name">{file.name}</span>
            <span className="arc-pick__size tnum">{bytesKo(file.size)}</span>
          </span>
          {(state !== "idle" || !err) && (
            <Button
              variant="circle"
              tone="secondary"
              size="md"
              icon="arrow-up"
              state={state}
              ariaLabel={state === "error" ? "다시 올리기" : "올리기"}
              busyLabel="올리는 중"
              successLabel="올렸어요"
              onClick={() => {
                if (state === "error" || state === "idle") void run(file);
              }}
            />
          )}
        </div>
      )}
      <InlineError>{err}</InlineError>
      <Note icon="lock">올린 파일은 나만 볼 수 있어요. 대화에서 모시에게 보여 줄 때만 쓰여요. 10MB까지 올릴 수 있어요.</Note>
    </div>
  );
}

/** the FAB's size (archive.css .arc-fab): a 56px circle */
const FAB = 56;

/** Neutral glass FAB (no accent, no glow) in the bottom chrome group, right-aligned above the tab bar. */
export function UploadFab() {
  return (
    <ChromePortal group="bottom">
      <Glass
        as="button"
        blur="group"
        interactive={1.06}
        lens
        text
        radius={capsule(FAB)}
        className="arc-fab"
        aria-label="사진이나 파일 올리기"
        onClick={(e: MouseEvent<HTMLElement>) => openUploadPicker(e.currentTarget)}
      >
        <Icon name="plus" size={24} weight="medium" />
      </Glass>
    </ChromePortal>
  );
}
