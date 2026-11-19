import type { Artifact, ArtifactKind } from "@pickle/protocol";
import { htmlText } from "@pickle/protocol";
import { useEffect, useMemo, useState } from "react";
import { isAborted, toApiError } from "../../../api/client";
import * as ep from "../../../api/endpoints";
import { island } from "../../../app/island";
import { FullDocument } from "../../../artifact/HtmlArtifactCard";
import { Button } from "../../../ui/Button";
import { ConfirmButton } from "../../../ui/ConfirmButton";
import { presentSheet, type SheetApi } from "../../../ui/Sheet";
import { removeArtifact } from "../data";
import { ago } from "../format";
import { InlineError, Note } from "../parts";
import { Dashboard, dashboardText } from "./Dashboard";
import { Markdown } from "./Markdown";
import { copyText, shareText } from "./share";
import { parseDashboard, stripMarkdown, withoutTitle } from "./text";

// the kind is a word in the meta line, never a coloured plate (a card is led by its title)
export const KIND: Record<ArtifactKind, { label: string }> = {
  document: { label: "문서" },
  dashboard: { label: "대시보드" },
  table: { label: "표" },
  checklist: { label: "체크리스트" },
  html: { label: "페이지" },
};
export const kindOf = (k: ArtifactKind) => KIND[k] ?? KIND.document;

/** Card → sheet: the sheet morphs out of the card (clip-path from the card's rect/radius to r38). */
export function openArtifact(a: Artifact, source: HTMLElement | null) {
  presentSheet({
    source,
    title: a.title,
    render: (api) => <ArtifactView artifact={a} api={api} />,
  });
}

function ArtifactView({ artifact, api }: { artifact: Artifact; api: SheetApi }) {
  // the list already carries the content: show it at once, then refresh from GET /api/blobs/:id
  const [text, setText] = useState<string | null>(artifact.content?.trim() ? artifact.content : null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [delErr, setDelErr] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ep.blob(artifact.id, { signal: ctrl.signal })
      .then((t) => {
        setText(t);
        setLoadErr(null);
      })
      .catch((e) => {
        if (isAborted(e)) return;
        setLoadErr(toApiError(e).message);
      });
    return () => ctrl.abort();
  }, [artifact.id]);

  const kind = kindOf(artifact.kind);
  const widgets = useMemo(() => (artifact.kind === "dashboard" && text !== null ? parseDashboard(text) : null), [artifact.kind, text]);
  const plain = useMemo(() => {
    if (text === null) return "";
    if (artifact.kind === "dashboard") return widgets ? dashboardText(artifact.title, widgets) : text;
    if (artifact.kind === "html") return htmlText(text);
    return text;
  }, [artifact.kind, artifact.title, text, widgets]);

  const share = async () => {
    setActionErr(null);
    try {
      await shareText(artifact.title, artifact.kind === "dashboard" || artifact.kind === "html" ? plain : stripMarkdown(plain));
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "공유하지 못했어요.");
    }
  };
  const copy = async () => {
    setActionErr(null);
    try {
      await copyText(plain);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "복사하지 못했어요.");
      throw e;
    }
  };
  const del = async () => {
    setDelErr(null);
    api.setBusy(true);
    try {
      await removeArtifact(artifact.id);
      api.setBusy(false);
    } catch (e) {
      api.setBusy(false);
      setDelErr(toApiError(e).message);
      throw e;
    }
  };

  return (
    <div className="arc-doc">
      <p className="arc-doc__meta">
        <span>{kind.label}</span>
        <span aria-hidden="true">·</span>
        <span className="tnum">{ago(artifact.updatedAt)} 수정</span>
      </p>

      <div className="arc-doc__body">
        {text === null ? (
          loadErr ? (
            <InlineError>{loadErr}</InlineError>
          ) : (
            <div className="arc-lines" aria-label="불러오는 중" role="status">
              {[92, 78, 86, 60, 84, 70].map((w, i) => (
                <span key={i} style={{ width: `${w}%` }} />
              ))}
            </div>
          )
        ) : artifact.kind === "html" ? (
          <FullDocument artifact={{ ...artifact, content: text }} />
        ) : artifact.kind === "dashboard" ? (
          widgets ? (
            <Dashboard artifactId={artifact.id} widgets={widgets} />
          ) : (
            <>
              <Note icon="info">대시보드 형식을 읽지 못해서 원본 그대로 보여 드려요.</Note>
              <pre className="md-pre arc-raw">{text}</pre>
            </>
          )
        ) : (
          <Markdown source={withoutTitle(text, artifact.title)} />
        )}
      </div>

      <div className="arc-doc__actions">
        <Button variant="capsule" tone="secondary" size="sm" icon="share" onClick={share} disabled={text === null}>
          공유하기
        </Button>
        <Button variant="capsule" tone="secondary" size="sm" icon="copy" action={copy} disabled={text === null} successLabel="복사했어요" busyLabel="복사하는 중">
          복사하기
        </Button>
      </div>
      <InlineError>{actionErr}</InlineError>

      <div className="arc-doc__danger">
        <ConfirmButton
          label="보관함에서 지우기"
          tone="destructive"
          size="md"
          fullWidth={false}
          onConfirm={del}
          onSuccess={() => {
            island.banner({ icon: "trash", title: "보관함에서 지웠어요", body: artifact.title });
            api.close();
          }}
        />
        <InlineError>{delErr}</InlineError>
      </div>
    </div>
  );
}
