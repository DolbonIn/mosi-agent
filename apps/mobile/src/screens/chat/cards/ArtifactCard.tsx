import type { Artifact, ArtifactCard as ArtifactRef, DashboardWidget } from "@pickle/protocol";
import { useEffect, useState } from "react";
import * as ep from "../../../api/endpoints";
import { BarChart } from "../../../ui/BarChart";
import { Icon, type AppIconName } from "../../../ui/Icon";
import { presentSheet } from "../../../ui/Sheet";
import { copy } from "../../../ui/Text";
import { Markdown } from "../markdown";
import { dayClockKo } from "../util";

/**
 * Artifact card → sheet. The card is paper: a text-size kind glyph (no plate, meeting B / IT-9), the title, and the
 * kind as a word in the two-line preview ("문서 · 참석 4명 · 42분"); tapping it morphs a sheet out of
 * the card (presentSheet source) that loads the artifact: documents and checklists render as markdown, dashboards as
 * widgets (stat tiles, BarChart with the chart rule, lists). Deleted from the archive (`deleted`): the same glyph and
 * title in secondary colour over who deleted it (`note`, cards/deleted.ts), no chevron, and nothing to tap (not a
 * button, no focus: the document is gone, DD 2103 / 2259 §7); an html card comes here too, its page frame gone.
 */
const KIND: Record<ArtifactRef["kind"], { icon: AppIconName; label: string }> = {
  document: { icon: "doc", label: "문서" },
  dashboard: { icon: "chart", label: "대시보드" },
  table: { icon: "doc", label: "표" },
  checklist: { icon: "check-circle", label: "체크리스트" },
  html: { icon: "doc", label: "페이지" },
};

export function ArtifactCard({ card, note = "보관함에서 지웠어요" }: { card: ArtifactRef; note?: string }) {
  const k = KIND[card.kind] ?? KIND.document;
  if (card.deleted)
    return (
      <div className="ccard ccard-artifact is-deleted">
        <Icon name={k.icon} size={17} weight="medium" className="art-glyph" />
        <span className="art-body">
          <span className="art-title">{card.title}</span>
          <span className="art-note t-copy">{copy(note)}</span>
        </span>
      </div>
    );
  const open = (el: HTMLElement) => presentSheet({ source: el, title: card.title, render: () => <ArtifactBody id={card.artifactId} kind={card.kind} /> });
  return (
    <button type="button" className="ccard ccard-artifact" onClick={(e) => open(e.currentTarget)} aria-label={`${k.label} 열기: ${card.title}`}>
      <Icon name={k.icon} size={17} weight="medium" className="art-glyph" />
      <span className="art-body">
        <span className="art-title">{card.title}</span>
        <span className="art-preview">
          {k.label}
          {card.preview ? ` · ${card.preview}` : ""}
        </span>
      </span>
      <Icon name="chevron-right" size={18} className="art-chev" />
    </button>
  );
}

function ArtifactBody({ id, kind }: { id: string; kind: ArtifactRef["kind"] }) {
  const [a, setA] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ep.artifact(id)
      .then((x) => alive && setA(x))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [id]);
  if (error)
    return (
      <p className="art-error" role="alert">
        <Icon name="exclamation" size={16} /> {error}
      </p>
    );
  if (!a)
    return (
      <div className="art-loading" aria-busy="true">
        <span className="art-skel" />
        <span className="art-skel short" />
        <span className="art-skel" />
      </div>
    );
  return (
    <div className="art-sheet">
      <p className="art-meta">{dayClockKo(a.updatedAt)} · 보관함에 저장됨</p>
      {kind === "dashboard" ? <Dashboard content={a.content} id={a.id} /> : <Markdown text={a.content} className="art-md" />}
    </div>
  );
}

function Dashboard({ content, id }: { content: string; id: string }) {
  let widgets: DashboardWidget[] = [];
  try {
    const parsed = JSON.parse(content) as { widgets?: DashboardWidget[] };
    widgets = Array.isArray(parsed.widgets) ? parsed.widgets : [];
  } catch {
    return <Markdown text={content} className="art-md" />;
  }
  const stats = widgets.filter((w): w is Extract<DashboardWidget, { type: "stat" }> => w.type === "stat");
  return (
    <div className="dash">
      {stats.length > 0 && (
        <div className="dash-stats">
          {stats.map((s, i) => (
            <div key={i} className="dash-stat">
              <span className="dash-stat-label">{s.label}</span>
              <span className="dash-stat-value tnum">{s.value}</span>
              {s.delta && <span className="dash-stat-delta tnum">{s.delta}</span>}
            </div>
          ))}
        </div>
      )}
      {widgets.map((w, i) =>
        w.type === "bars" ? (
          <section key={i} className="dash-block">
            <h4 className="dash-h">{w.label}</h4>
            <BarChart id={`${id}-${i}`} data={w.points.map((p) => ({ label: p.x, value: p.y }))} ariaLabel={w.label} height={150} />
          </section>
        ) : w.type === "list" ? (
          <section key={i} className="dash-block">
            <h4 className="dash-h">{w.label}</h4>
            <ul className="dash-list">
              {w.items.map((it, j) => (
                <li key={j}>{it}</li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}
