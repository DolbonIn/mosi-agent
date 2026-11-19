import type { AgentProfile, AgentStatus, SkillInfo } from "@pickle/protocol";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { toApiError } from "../../../api/client";
import * as ep from "../../../api/endpoints";
import { loadProfile, sessionStore, useAgent } from "../../../api/store";
import { island } from "../../../app/island";
import type { ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { Avatar, DEFAULT_AVATAR } from "../../../ui/Avatar";
import { Button } from "../../../ui/Button";
import { ConfirmButton } from "../../../ui/ConfirmButton";
import { LargeTitle } from "../../../ui/LargeTitle";
import { ListSection } from "../../../ui/List";
import { TextField } from "../../../ui/TextField";
import { Toggle } from "../../../ui/Toggle";
import { Sentences } from "../../../ui/Text";
import { SkillConnectButton } from "../connections/SkillConnectButton";
import { forgetMemory, memoriesRes, skillsRes, useResource } from "../data";
import { ago, josa } from "../format";
import { Foot, InlineError, Placeholder, StatusPill, Stack, useRouteVisible } from "../parts";
import "./agent.css";

/**
 * 모시 설정 (research §4-6, REA runtime-05, my-mosi B): the agent and its state first (face, 쉬는 중 · 아직 일한 적이
 * 없어요), its colour saved the moment it is picked (rolled back with a banner if the server refuses, §8.13); name
 * and persona saved with one primary button only after the server answered; what it can do (skills under category
 * headings, no plates — the last one can't be switched off, the server refuses an empty list with 400 no_skills);
 * what it remembers (each memory erasable, two-step); a restart row for when it gets stuck. One heading system:
 * list section titles, the counts as their trailing detail.
 * params: { section?: "memories" } scrolls to the memories.
 */

const HUES = [8, 32, 48, 150, 200, 265, 320];
const HUE_NAMES: Record<number, string> = { 8: "빨강", 32: "주황", 48: "노랑", 150: "초록", 200: "하늘", 265: "보라", 320: "분홍" };
const STATUS: Record<AgentStatus, { label: string; tone: "ok" | "wait" | "neutral" | "error" }> = {
  idle: { label: "쉬는 중", tone: "ok" },
  running: { label: "일하는 중", tone: "wait" },
  starting: { label: "준비 중", tone: "wait" },
  stopped: { label: "멈춤", tone: "neutral" },
  error: { label: "문제가 생겼어요", tone: "error" },
};

const setSessionAgent = (agent: AgentProfile) => sessionStore.set((s) => (s.session ? { ...s, session: { ...s.session, agent } } : s));
const hueOf = (agent: AgentProfile | null | undefined) => agent?.avatar?.hue ?? DEFAULT_AVATAR.hue;

export function AgentScreen({ route }: ScreenProps) {
  const agent = useAgent();
  const visible = useRouteVisible(route.key);
  const memRef = useRef<HTMLElement>(null);
  const wantMemories = route.params?.section === "memories";

  useEffect(() => {
    if (!wantMemories || !visible) return;
    const t = window.setTimeout(() => memRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 420);
    return () => window.clearTimeout(t);
  }, [wantMemories, visible]);

  return (
    <Screen routeKey={route.key}>
      <LargeTitle title={route.title ?? agent?.name ?? "모시"} layoutId={route.titleLayoutId} />
      <Stack>
        {agent ? <Identity agent={agent} /> : <Placeholder rows={2} height={56} />}
        {agent && <NameForm agent={agent} />}
        {agent && <Skills agent={agent} active={visible} />}
        <section ref={memRef} className="agent-memories-anchor">
          <Memories active={visible} name={agent?.name ?? "모시"} />
        </section>
        {agent && <Restart agent={agent} />}
      </Stack>
    </Screen>
  );
}

/** a list section title with its count as the trailing detail */
function Head({ id, title, detail }: { id: string; title: ReactNode; detail?: ReactNode }) {
  return (
    <div className="agent-head">
      <h2 className="list-section-title" id={id}>
        {title}
      </h2>
      {detail !== undefined && <span className="agent-head__detail tnum">{detail}</span>}
    </div>
  );
}

/** the face, its state, and the colour — saved on pick, like every other setting (critique Q3/Q4) */
function Identity({ agent }: { agent: AgentProfile }) {
  const [hue, setHue] = useState(hueOf(agent));
  const seq = useRef(0);
  const pending = useRef(0);
  // follow the server while no pick is in flight
  const saved = hueOf(agent);
  useEffect(() => {
    if (!pending.current) setHue(saved);
  }, [saved]);

  // the saved colour is always one of the swatches: it takes the place of the nearest preset
  const swatches = useMemo(() => {
    if (HUES.includes(saved)) return HUES;
    const dist = (h: number) => Math.min(Math.abs(h - saved), 360 - Math.abs(h - saved));
    const near = HUES.reduce((b, h) => (dist(h) < dist(b) ? h : b), HUES[0]!);
    return HUES.map((h) => (h === near ? saved : h));
  }, [saved]);

  const pick = (h: number) => {
    if (h === hue) return;
    const n = ++seq.current;
    setHue(h);
    pending.current++;
    ep.patchAgent({ avatar: { ...(agent.avatar ?? DEFAULT_AVATAR), hue: h } })
      .then((a) => {
        if (n === seq.current) setSessionAgent(a);
      })
      .catch((e) => {
        if (n !== seq.current) return;
        // §8.13: back to what the server holds, and say why
        setHue(hueOf(sessionStore.get().session?.agent));
        island.errorBanner(toApiError(e).message, "색을 바꾸지 못했어요");
      })
      .finally(() => {
        pending.current--;
      });
  };

  const st = STATUS[agent.status] ?? STATUS.idle;
  return (
    <section className="agent-identity-section" aria-label={agent.name}>
      <div className="list-card agent-identity">
        <div className="agent-identity__head">
          <Avatar spec={{ ...(agent.avatar ?? DEFAULT_AVATAR), hue }} size={64} breathing />
          <span className="agent-identity__who">
            <span className="agent-identity__status" data-tone={st.tone}>
              {st.label}
            </span>
            <span className="agent-identity__sub">{agent.lastActiveAt ? `마지막으로 일한 때 ${ago(agent.lastActiveAt)}` : "아직 일한 적이 없어요"}</span>
          </span>
        </div>
        <div className="agent-hues" role="radiogroup" aria-label="색">
          {swatches.map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={h === hue}
              aria-label={HUE_NAMES[h] ?? "지금 색"}
              className="agent-hue"
              data-on={h === hue || undefined}
              style={{ "--h": h } as React.CSSProperties}
              onClick={() => pick(h)}
            />
          ))}
        </div>
      </div>
      <Foot>색은 고르는 순간 저장돼요.</Foot>
    </section>
  );
}

/** name and persona: the only fields that wait for 저장하기 */
function NameForm({ agent }: { agent: AgentProfile }) {
  const [name, setName] = useState(agent.name);
  const [persona, setPersona] = useState(agent.persona);
  const [error, setError] = useState<string | undefined>();
  const personaId = useId();
  // follow server-side changes while the form is untouched
  const base = useRef(agent);
  useEffect(() => {
    const prev = base.current;
    base.current = agent;
    setName((v) => (v === prev.name ? agent.name : v));
    setPersona((v) => (v === prev.persona ? agent.persona : v));
  }, [agent]);

  const trimmed = name.trim();
  const dirty = trimmed !== agent.name || persona.trim() !== agent.persona;
  const nameError = !trimmed ? "이름을 정해 주세요" : trimmed.length > 12 ? "이름은 12자까지 쓸 수 있어요" : undefined;

  const save = async () => {
    setError(undefined);
    try {
      const next = await ep.patchAgent({ name: trimmed, persona: persona.trim() });
      setSessionAgent(next);
      void loadProfile();
    } catch (e) {
      setError(toApiError(e).message);
      throw e;
    }
  };

  return (
    <section className="agent-form-section" aria-labelledby="agent-who-h">
      <Head id="agent-who-h" title="이름과 성격" />
      <div className="list-card agent-identity">
        <TextField label="이름" value={name} onChange={setName} maxLength={12} variant="filled" error={dirty ? nameError : undefined} autoComplete="off" />
        <div className="tf tf--filled agent-persona">
          <label htmlFor={personaId} className="tf-label">
            성격과 말투
          </label>
          <div className="tf-box">
            <textarea
              id={personaId}
              className="tf-input agent-persona__input"
              value={persona}
              maxLength={300}
              rows={4}
              placeholder="예: 다정하고 짧게 말해요. 존댓말을 써요."
              onChange={(e) => setPersona(e.target.value)}
            />
          </div>
          <span className="tf-hint tnum">{persona.length}/300</span>
        </div>
        <InlineError>{error}</InlineError>
        <Button
          tone="primary"
          size="lg"
          fullWidth
          action={save}
          disabled={!dirty || !!nameError}
          busyLabel="저장하는 중"
          successLabel="저장했어요"
          errorLabel="다시 시도하기"
          className="agent-off"
        >
          저장하기
        </Button>
      </div>
    </section>
  );
}

function Skills({ agent, active }: { agent: AgentProfile; active: boolean }) {
  const res = useResource(skillsRes, active);
  const [enabled, setEnabled] = useState<string[]>(agent.enabledSkills);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(0);
  useEffect(() => {
    if (!pending.current) setEnabled(agent.enabledSkills);
  }, [agent.enabledSkills]);

  const groups = useMemo(() => {
    const m = new Map<string, SkillInfo[]>();
    for (const s of res.data) m.set(s.category, [...(m.get(s.category) ?? []), s]);
    return [...m.entries()];
  }, [res.data]);

  const toggle = (id: string, on: boolean) => {
    const prev = enabled;
    const next = on ? [...prev, id] : prev.filter((x) => x !== id);
    if (!next.length) {
      setError("기능은 하나 이상 켜 둬야 해요");
      return;
    }
    setError(null);
    setEnabled(next);
    pending.current++;
    ep.patchAgent({ enabledSkills: next })
      .then((a) => setSessionAgent(a))
      .catch((e) => {
        setEnabled(prev);
        const msg = toApiError(e).message;
        setError(msg);
        island.errorBanner(msg, "기능을 바꾸지 못했어요");
      })
      .finally(() => pending.current--);
  };

  const count = enabled.length;
  return (
    <section className="agent-skills" aria-labelledby="agent-skills-h">
      <Head id="agent-skills-h" title="할 수 있는 일" detail={`${count}/${res.data.length || agent.enabledSkills.length}개 켜짐`} />
      <Foot className="agent-foot">{josa(agent.name, "이가")} 대화에서 쓸 수 있는 기능이에요. 끄면 그 기능은 쓰지 않아요.</Foot>
      <InlineError>{error}</InlineError>
      {!res.loaded && res.loading ? (
        <Placeholder rows={4} height={60} />
      ) : res.error && !res.loaded ? (
        <InlineError>{res.error}</InlineError>
      ) : (
        <div className="agent-skill-groups">
          {groups.map(([cat, items]) => (
            <ListSection key={cat} title={cat} level={3}>
              {items.map((s) => {
                const on = enabled.includes(s.id);
                const last = on && count === 1;
                return (
                  <div key={s.id} className="agent-skill" data-skill={s.id}>
                    <span className="agent-skill__main">
                      <span className="agent-skill__title">
                        {s.title}
                        {!s.configured && !s.connection && <StatusPill tone="wait">키 필요</StatusPill>}
                      </span>
                      <span className="agent-skill__desc">
                        <Sentences text={s.description} />
                      </span>
                      {s.connection ? <SkillConnectButton service={s.connection} name={s.connectionName ?? s.title} configured={s.configured} /> : null}
                    </span>
                    <span className="agent-skill__end">
                      <Toggle label={`${s.title} 켜기`} checked={on} disabled={last} onChange={(v) => toggle(s.id, v)} />
                    </span>
                  </div>
                );
              })}
            </ListSection>
          ))}
        </div>
      )}
    </section>
  );
}

function Memories({ active, name }: { active: boolean; name: string }) {
  const res = useResource(memoriesRes, active);
  return (
    <div className="agent-memories">
      <Head id="agent-memories-h" title={`${josa(name, "이가")} 기억하는 것`} detail={res.loaded ? `${res.data.length}개` : undefined} />
      {!res.loaded && res.loading ? (
        <Placeholder rows={2} height={56} />
      ) : res.error && !res.loaded ? (
        <InlineError>{res.error}</InlineError>
      ) : res.data.length === 0 ? (
        <Foot className="agent-foot">아직 기억한 내용이 없어요. “내 생일은 3월 2일이야 기억해 줘”처럼 말하면 기억해요.</Foot>
      ) : (
        <ul className="list-card agent-memory-list" aria-labelledby="agent-memories-h">
          {res.data.map((m) => (
            <MemoryRow key={m.id} m={m} />
          ))}
        </ul>
      )}
    </div>
  );
}

function MemoryRow({ m }: { m: ep.MemoryItem }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="agent-memory" data-memory={m.id}>
      <span className="agent-memory__main">
        <span className="agent-memory__text">{m.text}</span>
        <span className="agent-memory__when">{ago(m.createdAt)}</span>
        <InlineError>{error}</InlineError>
      </span>
      <span className="agent-memory__del">
        <ConfirmButton
          label="잊기"
          confirmLabel="정말 잊기"
          tone="destructive"
          size="sm"
          fullWidth={false}
          onConfirm={async () => {
            setError(null);
            try {
              await forgetMemory(m.id);
            } catch (e) {
              setError(toApiError(e).message);
              throw e;
            }
          }}
        />
      </span>
    </li>
  );
}

/** a centred row with what it does said under it; loader → check once the server restarted the agent */
function Restart({ agent }: { agent: AgentProfile }) {
  const restart = async () => {
    const r = await ep.restartAgent();
    if (r && typeof r === "object" && "id" in r) setSessionAgent(r as AgentProfile);
  };
  return (
    <section className="agent-restart" aria-label="다시 시작">
      <div className="list-card agent-restart__group">
        <Button
          variant="plain"
          tone="neutral"
          size="lg"
          fullWidth
          style={{ height: 54, borderRadius: "var(--r-group)" }}
          className="agent-restart__row"
          action={restart}
          busyLabel="다시 시작하는 중"
          successLabel="다시 시작했어요"
          errorLabel="다시 시도하기"
        >
          {josa(agent.name, "을를")} 다시 시작하기
        </Button>
      </div>
      <Foot>대답이 멈추거나 이상하면 다시 시작해 보세요. 대화와 기억은 그대로예요.</Foot>
    </section>
  );
}
