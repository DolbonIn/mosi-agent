import type { Attachment } from "@pickle/protocol";
import { useEffect, useState } from "react";
import { apiRaw, isAborted, toApiError } from "../../../api/client";
import { attachmentObjectUrl } from "../../../api/endpoints";
import { island } from "../../../app/island";
import { ConfirmButton } from "../../../ui/ConfirmButton";
import { Icon, type AppIconName } from "../../../ui/Icon";
import { presentSheet, type SheetApi } from "../../../ui/Sheet";
import { removeAttachment } from "../data";
import { ago, bytesKo } from "../format";
import { InlineError } from "../parts";
import { rawUrl } from "./share";

/**
 * Media grid: 3 columns of square tiles (r12, gap 4). Images load lazily through the `?token=` raw URL; PDFs and text
 * files are file tiles. A tile opens a preview sheet that morphs out of it.
 */

const isImage = (m: string) => m.startsWith("image/");
const isPdf = (m: string) => m === "application/pdf";
const isText = (m: string) => m.startsWith("text/");
const fileIcon = (m: string): AppIconName => (isPdf(m) ? "doc" : isText(m) ? "doc" : "paperclip");
const kindLabel = (m: string) => (isImage(m) ? "사진" : isPdf(m) ? "PDF" : isText(m) ? "텍스트" : "파일");

export function MediaGrid({ items }: { items: Attachment[] }) {
  return (
    <ul className="arc-grid" aria-label={`올린 사진과 파일 ${items.length}개`}>
      {items.map((a) => (
        <li key={a.id} className="arc-grid__cell">
          <MediaTile a={a} />
        </li>
      ))}
    </ul>
  );
}

function MediaTile({ a }: { a: Attachment }) {
  const [broken, setBroken] = useState(false);
  const img = isImage(a.mime) && !broken;
  return (
    <button
      type="button"
      className={`arc-tile${img ? " is-image" : " is-file"}`}
      aria-label={`${kindLabel(a.mime)}, ${a.filename}, ${bytesKo(a.size)}, ${ago(a.createdAt)} 올림`}
      onClick={(e) => openMedia(a, e.currentTarget)}
    >
      {img ? (
        <img src={rawUrl(a.id)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />
      ) : (
        <span className="arc-tile__file">
          <span className="arc-tile__icon" aria-hidden="true">
            <Icon name={isImage(a.mime) ? "photo" : fileIcon(a.mime)} size={22} weight="medium" />
          </span>
          <span className="arc-tile__name">{a.filename}</span>
          <span className="arc-tile__size tnum">{isPdf(a.mime) ? "PDF · " : ""}{bytesKo(a.size)}</span>
        </span>
      )}
    </button>
  );
}

export function openMedia(a: Attachment, source: HTMLElement | null) {
  presentSheet({ source, title: a.filename, render: (api) => <MediaView a={a} api={api} /> });
}

function TextPreview({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    apiRaw("GET", `/api/attachments/${encodeURIComponent(id)}/raw`, undefined, { signal: ctrl.signal, timeoutMs: 30_000 })
      .then((r) => r.text())
      .then((t) => setText(t.length > 200_000 ? `${t.slice(0, 200_000)}\n…` : t))
      .catch((e) => {
        if (!isAborted(e)) setErr(toApiError(e).message);
      });
    return () => ctrl.abort();
  }, [id]);
  if (err) return <InlineError>{err}</InlineError>;
  if (text === null)
    return (
      <div className="arc-lines" role="status" aria-label="불러오는 중">
        {[90, 74, 82, 66].map((w, i) => (
          <span key={i} style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  return (
    <pre className="md-pre arc-text" tabIndex={0} aria-label="파일 내용">
      {text}
    </pre>
  );
}

/**
 * PDF preview: the server forbids framing its responses (X-Frame-Options: DENY), so the file is fetched with the
 * bearer token and framed from a same-origin blob: URL (revoked on close).
 */
function PdfPreview({ a }: { a: Attachment }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    let url: string | null = null;
    attachmentObjectUrl(a.id, { signal: ctrl.signal })
      .then((u) => {
        url = u;
        setSrc(u);
      })
      .catch((e) => {
        if (!isAborted(e)) setErr(toApiError(e).message);
      });
    return () => {
      ctrl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [a.id]);
  if (err) return <InlineError>{err}</InlineError>;
  if (!src)
    return (
      <div className="arc-media__none" role="status">
        <Icon name="doc" size={28} />
        <span>PDF를 불러오는 중이에요</span>
      </div>
    );
  return <iframe src={src} title={`${a.filename} 미리보기`} className="arc-media__pdf" />;
}

function MediaView({ a, api }: { a: Attachment; api: SheetApi }) {
  const [err, setErr] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const url = rawUrl(a.id);
  const del = async () => {
    setErr(null);
    api.setBusy(true);
    try {
      await removeAttachment(a.id);
      api.setBusy(false);
    } catch (e) {
      api.setBusy(false);
      setErr(toApiError(e).message);
      throw e;
    }
  };
  return (
    <div className="arc-media">
      <div className="arc-media__preview">
        {isImage(a.mime) && !broken ? (
          <img src={url} alt={a.filename} className="arc-media__img" onError={() => setBroken(true)} />
        ) : isPdf(a.mime) ? (
          <PdfPreview a={a} />
        ) : isText(a.mime) ? (
          <TextPreview id={a.id} />
        ) : (
          <div className="arc-media__none">
            <Icon name={fileIcon(a.mime)} size={28} />
            <span>미리 볼 수 없는 파일이에요</span>
          </div>
        )}
      </div>
      <dl className="arc-media__meta">
        <div>
          <dt>종류</dt>
          <dd>{kindLabel(a.mime)}</dd>
        </div>
        <div>
          <dt>크기</dt>
          <dd className="tnum">{bytesKo(a.size)}</dd>
        </div>
        <div>
          <dt>올린 때</dt>
          <dd className="tnum">{ago(a.createdAt)}</dd>
        </div>
      </dl>
      {(isPdf(a.mime) || isImage(a.mime)) && (
        <a className="arc-media__open" href={url} target="_blank" rel="noopener noreferrer">
          <Icon name="link" size={17} weight="medium" />
          <span>새 창에서 열기</span>
        </a>
      )}
      <div className="arc-doc__danger">
        <ConfirmButton
          label="보관함에서 지우기"
          tone="destructive"
          size="md"
          fullWidth={false}
          onConfirm={del}
          onSuccess={() => {
            island.banner({ icon: "trash", title: "보관함에서 지웠어요", body: a.filename });
            api.close();
          }}
        />
        <InlineError>{err}</InlineError>
      </div>
    </div>
  );
}
