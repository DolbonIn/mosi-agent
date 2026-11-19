import type { Artifact } from "@pickle/protocol";
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useUi } from "../../../api/store";
import { nav, type ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { Button } from "../../../ui/Button";
import { Card } from "../../../ui/Card";
import { R } from "../../../ui/geometry";
import { EmptyState } from "../../../ui/EmptyState";
import { LargeTitle } from "../../../ui/LargeTitle";
import { SegmentedControl, SegmentedPanels } from "../../../ui/SegmentedControl";
import { artifactsRes, attachmentsRes, useResource } from "../data";
import { ago, dateKo } from "../format";
import { InlineError, Placeholder, useAgentName, useTabVisible } from "../parts";
import { kindOf, openArtifact } from "./ArtifactSheet";
import { MediaGrid } from "./MediaGrid";
import { previewOf } from "./text";
import { UploadFab, openUploadPicker } from "./UploadSheet";
import "./archive.css";

/**
 * 보관함 (MOTION-SPEC §6.5, research §4-5): a full-width segmented control 문서 | 사진·파일 (two-edge thumb, the panel
 * travels by direction; a horizontal swipe on the panel switches too), document cards led by their title (no kind
 * plate) that open as sheets morphing out of the card, a media grid, and a neutral glass upload FAB (media with files
 * only: an empty panel has its one upload button, so no fourth glass) that morphs into the picker sheet.
 * Empty states each offer one real action. Cached lists show at once and refresh whenever the tab becomes visible.
 */
type Seg = "artifacts" | "media";

// the chosen segment survives remounts and tab switches for the session (iOS keeps a segmented control's state)
let lastSeg: Seg = "artifacts";

const splitCopy = (s: string) => {
  const [title, ...rest] = s.split("\n");
  return { title: title ?? s, body: rest.join(" ").trim() || undefined };
};

export function ArchiveScreen({ route }: ScreenProps) {
  const ui = useUi();
  const visible = useTabVisible("archive");
  const segs = ui.archive.segments.length ? ui.archive.segments : [{ id: "artifacts" as const, title: "문서" }, { id: "media" as const, title: "사진·파일" }];
  const order = segs.map((s) => s.id) as Seg[];
  const [seg, setSegState] = useState<Seg>(() => lastSeg);
  const setSeg = (s: Seg) => {
    lastSeg = s;
    setSegState(s);
  };
  const arts = useResource(artifactsRes, visible);
  const media = useResource(attachmentsRes, visible);
  const title = ui.tabs.find((t) => t.id === "archive")?.title ?? "보관함";
  // the FAB only joins the chrome when there is a list to add to; the empty panel's button is the one way in
  const fab = visible && seg === "media" && media.loaded && media.data.length > 0;

  // horizontal swipe on the panel switches segments (vertical scrolling stays native: touch-action pan-y)
  const swipe = useRef<{ id: number; x: number; y: number; t: number } | null>(null);
  const swallowClick = useRef(false);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || e.pointerType === "mouse") return;
    swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || s.id !== e.pointerId || e.type === "pointercancel") return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    const v = Math.abs(dx) / Math.max(1, e.timeStamp - s.t);
    if (Math.abs(dx) < 56 && !(Math.abs(dx) > 28 && v > 0.5)) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const i = order.indexOf(seg) + (dx < 0 ? 1 : -1);
    const next = order[i];
    if (!next) return;
    swallowClick.current = true;
    setTimeout(() => (swallowClick.current = false), 350);
    setSeg(next);
  };

  return (
    <Screen routeKey={route.key} className="arc-screen">
      <LargeTitle title={title} />
      <div className="arc-seg">
        <SegmentedControl<Seg> idBase="archive" label="보관함 종류" value={seg} onChange={setSeg} options={segs.map((s) => ({ value: s.id as Seg, label: s.title }))} />
      </div>
      <div
        className={`arc-panels${fab ? " has-fab" : ""}`}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClickCapture={(e) => {
          if (swallowClick.current) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <SegmentedPanels value={seg} order={order} idBase="archive">
          {seg === "media" ? (
            <MediaPanel copy={splitCopy(ui.archive.emptyMedia)} loaded={media.loaded} loading={media.loading} error={media.error} items={media.data} />
          ) : (
            <ArtifactsPanel copy={splitCopy(ui.archive.emptyArtifacts)} loaded={arts.loaded} loading={arts.loading} error={arts.error} items={arts.data} />
          )}
        </SegmentedPanels>
      </div>
      {fab && <UploadFab />}
    </Screen>
  );
}

function Retry({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="arc-retry">
      <InlineError>{error}</InlineError>
      <Button variant="capsule" tone="secondary" size="sm" icon="refresh" onClick={onRetry}>
        다시 불러오기
      </Button>
    </div>
  );
}

function ArtifactsPanel({ copy, loaded, loading, error, items }: { copy: { title: string; body?: string }; loaded: boolean; loading: boolean; error?: string; items: Artifact[] }) {
  const agent = useAgentName();
  if (!loaded) {
    if (error) return <Retry error={error} onRetry={() => void artifactsRes.load()} />;
    return loading ? <Placeholder rows={3} height={112} /> : null;
  }
  if (!items.length)
    return (
      <EmptyState
        icon="doc"
        title={copy.title}
        body={copy.body}
        action={
          <Button tone="primary" size="md" onClick={() => nav.compose("이번 주 할 일을 정리해서 문서로 만들어 줘")}>
            {agent}에게 문서 만들어 달라고 하기
          </Button>
        }
      />
    );
  return (
    <ul className="arc-cards" aria-label={`문서 ${items.length}개`}>
      {items.map((a) => (
        <li key={a.id}>
          <ArtifactCard a={a} />
        </li>
      ))}
    </ul>
  );
}

function ArtifactCard({ a }: { a: Artifact }) {
  const wrap = useRef<HTMLDivElement>(null);
  const k = kindOf(a.kind);
  const preview = useMemo(() => previewOf(a), [a]);
  return (
    <div ref={wrap} className="arc-card-wrap">
      <Card
        className="arc-card"
        radius={R.card}
        padding={16}
        aria-label={`${k.label}, ${a.title}, ${dateKo(a.updatedAt)} 수정`}
        onClick={() => openArtifact(a, (wrap.current?.firstElementChild as HTMLElement | null) ?? null)}
      >
        <h2 className="arc-card__title">{a.title}</h2>
        <p className="arc-card__meta">
          <span>{k.label}</span>
          <span aria-hidden="true"> · </span>
          <span className="tnum">{ago(a.updatedAt)} 수정</span>
        </p>
        {preview && <p className="arc-card__preview">{preview}</p>}
      </Card>
    </div>
  );
}

function MediaPanel({ copy, loaded, loading, error, items }: { copy: { title: string; body?: string }; loaded: boolean; loading: boolean; error?: string; items: import("@pickle/protocol").Attachment[] }) {
  if (!loaded) {
    if (error) return <Retry error={error} onRetry={() => void attachmentsRes.load()} />;
    return loading ? <Placeholder rows={2} height={120} /> : null;
  }
  if (!items.length)
    return (
      <EmptyState
        icon="photo"
        title={copy.title}
        body={copy.body}
        action={
          <Button tone="secondary" size="md" icon="plus" onClick={(e) => openUploadPicker(e.currentTarget)}>
            사진이나 파일 올리기
          </Button>
        }
      />
    );
  return <MediaGrid items={items} />;
}
