import type { Schedule } from "@pickle/protocol";
import { useRef, useState } from "react";
import { toApiError } from "../../../api/client";
import { island } from "../../../app/island";
import { nav, type ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { ContentSwap } from "../../../motion/ContentSwap";
import { Button } from "../../../ui/Button";
import { Chip } from "../../../ui/Chip";
import { ConfirmButton } from "../../../ui/ConfirmButton";
import { EmptyState } from "../../../ui/EmptyState";
import { LargeTitle } from "../../../ui/LargeTitle";
import { List } from "../../../ui/List";
import { presentSheet, type SheetApi } from "../../../ui/Sheet";
import { Toggle } from "../../../ui/Toggle";
import { removeSchedule, schedulesRes, setScheduleEnabled, useResource } from "../data";
import { dayKo, josa, whenKo } from "../format";
import { InlineError, Note, Placeholder, SectionLabel, Stack, useAgentName, useRouteVisible } from "../parts";
import { FILE_AGAIN, fileFact, fileLine, fileLocked, toggleLabel } from "./scheduleFile";
import "./schedules.css";

/**
 * 예약된 일 (MOTION-SPEC §6.11, research §4-11; draft docs/design/drafts/schedules A): recurring work (모닝콜, 출석체크,
 * 브리핑) as two-line rows, the name over "rule · next" ("매일 오전 7:30 · 다음은 오늘", "꺼져 있어요" when off), with a
 * Focus-style toggle beside the row. A schedule with a text file has a third line (DD 2014): the file's name, or why it
 * stopped; off because its file was deleted, the switch is disabled and the second line drops "꺼져 있어요" (the third
 * line says it once, with the reason). A row opens its details (label/value facts, what it asks, a way to change it
 * through the agent, a two-step delete). New schedules are made by asking the agent: the one capsule under the list
 * says so by name and fills the composer with NEW_PROMPT (nothing is sent). No top-bar "+" (two glass shapes: back,
 * tab bar).
 */
const NEW_PROMPT = "매일 7시 30분에 깨워 줘";
const IDEAS = ["매일 아침 7시에 날씨랑 일정 브리핑해 줘", "평일 오전 9시에 출석체크 알려 줘", "매일 밤 10시에 내일 일정 알려 줘"];

/** the part of the row that changes with the switch; null while a switch-on waits for the server's next run */
function nextText(s: Schedule): string | null {
  if (!s.enabled) return "꺼져 있어요";
  if (!s.nextRunAt) return null;
  if (s.rule.startsWith("once@")) return "한 번만";
  return `다음은 ${dayKo(s.nextRunAt)}`;
}

export function SchedulesScreen({ route }: ScreenProps) {
  const visible = useRouteVisible(route.key);
  const res = useResource(schedulesRes, visible);
  const agentName = useAgentName();
  const items = res.data.slice().sort((a, b) => (a.enabled === b.enabled ? (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) : a.enabled ? -1 : 1));

  return (
    <Screen routeKey={route.key}>
      <LargeTitle title={route.title ?? "예약된 일"} layoutId={route.titleLayoutId} />
      <Stack>
        {!res.loaded && res.loading ? (
          <Placeholder rows={3} height={64} />
        ) : res.error && !res.loaded ? (
          <InlineError>{res.error}</InlineError>
        ) : items.length === 0 ? (
          <EmptyState
            icon="clock"
            title="아직 예약된 일이 없어요"
            body="정해진 시간에 깨워 주거나, 브리핑을 보내거나, 출석체크를 챙겨 드릴 수 있어요."
            action={
              <div className="sched-empty-actions">
                <Button tone="primary" size="md" icon="sun" onClick={() => nav.compose(NEW_PROMPT)}>
                  모닝콜 만들기
                </Button>
                <div className="sched-ideas" role="group" aria-label="예약 예시">
                  {IDEAS.map((t) => (
                    <Chip key={t} size="sm" label={t} onClick={() => nav.compose(t)} />
                  ))}
                </div>
              </div>
            }
          />
        ) : (
          <>
            <List label="예약 목록">
              {items.map((s) => (
                <ScheduleRow key={s.id} s={s} />
              ))}
            </List>
            {/* the one way to add: under the thumb, and its name says where it goes (draft A, P1-1) */}
            <div className="sched-new">
              <Button tone="neutral" size="md" onClick={() => nav.compose(NEW_PROMPT)}>
                {agentName}에게 예약 부탁하기
              </Button>
              <Note>
                “{NEW_PROMPT}”처럼 말하면 {josa(agentName, "이가")} 예약을 만들어요.
              </Note>
            </div>
          </>
        )}
      </Stack>
    </Screen>
  );
}

function ScheduleRow({ s }: { s: Schedule }) {
  // the sheet grows out of the whole row (switch included), which stays empty while it is open (MOTION-SPEC §3 Sheet)
  const row = useRef<HTMLDivElement>(null);
  const t = nextText(s);
  // keep the last answer while a switch-on waits for the next run, so the line swaps once (MOTION-SPEC §3 Content swap)
  const [held, setHeld] = useState(t ?? "다음 실행 없음");
  if (t !== null && t !== held) setHeld(t);
  const next = t ?? held;
  const toggle = (on: boolean) => {
    setScheduleEnabled(s.id, on).catch((e) => island.errorBanner(toApiError(e).message, on ? "켜지 못했어요" : "끄지 못했어요"));
  };
  const file = fileLine(s);
  const locked = fileLocked(s);
  return (
    <div ref={row} className="sched-row" data-schedule={s.id} data-off={!s.enabled || undefined}>
      <button
        type="button"
        className="sched-main"
        onClick={() => presentSchedule(s.id, row.current)}
        aria-label={[s.title, s.human, locked ? null : next, file].filter(Boolean).join(", ")}
      >
        <span className="sched-row__title">{s.title}</span>
        <span className="sched-row__sub tnum">
          {s.human}
          {!locked && (
            <>
              {" · "}
              <ContentSwap swapKey={next}>{next}</ContentSwap>
            </>
          )}
        </span>
        {file && <span className="sched-row__file">{file}</span>}
      </button>
      <span className="sched-toggle">
        <Toggle label={toggleLabel(s)} checked={s.enabled} onChange={toggle} disabled={locked} />
      </span>
    </div>
  );
}

function presentSchedule(id: string, source: HTMLElement | null) {
  const s = schedulesRes.store.get().data.find((x) => x.id === id);
  if (!s) return;
  presentSheet({ source, title: s.title, render: (api) => <ScheduleSheet id={id} api={api} /> });
}

function ScheduleSheet({ id, api }: { id: string; api: SheetApi }) {
  const res = schedulesRes.use();
  const s = res.data.find((x) => x.id === id);
  const [error, setError] = useState<string | null>(null);
  const agentName = useAgentName();
  if (!s) return <Note icon="info">이 예약은 지워졌어요.</Note>;
  const del = async () => {
    setError(null);
    api.setBusy(true);
    try {
      await removeSchedule(s.id);
    } catch (e) {
      setError(toApiError(e).message);
      throw e;
    } finally {
      api.setBusy(false);
    }
  };
  return (
    <div className="more-sheet">
      <dl className="sched-facts tnum">
        <Fact label="반복" value={s.human} />
        <Fact label="다음 실행" value={!s.enabled ? "꺼져 있어요" : s.nextRunAt ? whenKo(s.nextRunAt) : "없어요"} />
        <Fact label="마지막 실행" value={s.lastRunAt ? whenKo(s.lastRunAt) : "아직 없어요"} />
        {s.file && <Fact label="지시 파일" value={fileFact(s)!} />}
      </dl>
      {fileLocked(s) && <Note>{FILE_AGAIN}</Note>}
      <div className="sched-asked">
        <SectionLabel level={3}>{agentName}에게 맡긴 일</SectionLabel>
        <p className="sched-quote">“{s.prompt}”</p>
      </div>
      <div className="sched-sheet-actions">
        {/* changing a schedule goes through the agent too: fill the composer, send nothing (critique Q1) */}
        <Button
          tone="neutral"
          size="md"
          fullWidth
          onClick={() => {
            api.close();
            nav.compose(`${s.title} 바꿔 줘`);
          }}
        >
          {agentName}에게 바꿔 달라고 하기
        </Button>
        {s.threadId && (
          <Button
            tone="neutral"
            size="md"
            fullWidth
            onClick={() => {
              api.close();
              nav.push("thread", { threadId: s.threadId }, { title: s.title });
            }}
          >
            결과가 오는 대화 보기
          </Button>
        )}
      </div>
      <div className="sched-danger">
        <ConfirmButton
          label="예약 지우기"
          confirmLabel="한 번 더 누르면 지워요"
          tone="destructive"
          size="md"
          fullWidth={false}
          onConfirm={del}
          onSuccess={() => api.close()}
        />
        <Note>지우면 다음 실행부터 멈춰요. 지난 결과는 대화에 그대로 남아요.</Note>
        <InlineError>{error}</InlineError>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="sched-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
