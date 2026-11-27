import { useRef, useState, type ReactNode } from "react";
import { ChromePortal } from "../app/ChromePortal";
import { island } from "../app/island";
import { Screen } from "../app/Screen";
import { useTopBarCenter, useTopBarRight } from "../app/topBarStore";
import { useOnScreen } from "../motion/breathing";
import { ContentSwap, SwapText } from "../motion/ContentSwap";
import { setDisplayPrefs, useTier } from "../motion/tier";
import { AgentBlobLazy } from "../ui/AgentBlobLazy";
import { Avatar } from "../ui/Avatar";
import { BarChart } from "../ui/BarChart";
import { Button, type ButtonState } from "../ui/Button";
import { Card, CardHeader, CardTile } from "../ui/Card";
import { Chip, ChipGroup } from "../ui/Chip";
import { ConfirmButton } from "../ui/ConfirmButton";
import { SendButton, type SendButtonMode } from "../ui/SendButton";
import { EmptyState } from "../ui/EmptyState";
import { BlurGroup, Glass } from "../ui/Glass";
import { R } from "../ui/geometry";
import { Icon, ICON_NAMES } from "../ui/Icon";
import { IvDisclaimer, IvFoot, IvHero, IvRow, IvRows, IvStages, ModeWord, SignalLabel } from "../ui/Invest";
import { LargeTitle } from "../ui/LargeTitle";
import { List, ListRow } from "../ui/List";
import { Odometer } from "../ui/Odometer";
import { ProgressBar } from "../ui/ProgressBar";
import { SegmentedControl, SegmentedPanels } from "../ui/SegmentedControl";
import { presentSheet, Sheet } from "../ui/Sheet";
import { Slider } from "../ui/Slider";
import { Spotlight } from "../ui/Spotlight";
import { copy } from "../ui/Text";
import { TextField } from "../ui/TextField";
import { Toggle } from "../ui/Toggle";
import { estimate, footLine, krw, kstWithEastern, pct, pp, rate, shares, usd, type Signal } from "@pickle/quant";
import { STAGE_STATES } from "./stageStates";
import "./Gallery.css";

const SIGNALS: Signal[] = ["risk", "caution", "normal", "unknown"];

/**
 * Dev gallery (/?gallery=1): every primitive in every state inside the real shell (top bar, tab bar, island,
 * wallpaper), with theme / reduced-motion / reduced-transparency / text-size switches at the top.
 */
/** the other tabs in gallery mode: real tab layers, so the §8.2 tab transition can be seen and measured */
export function GalleryTab({ title }: { title: string }) {
  return (
    <Screen routeKey={`gallery-tab-${title}`}>
      <LargeTitle title={title} subtitle="탭 전환 확인용 화면" />
      <Section id={`tab-${title}`} title="이번 주">
        <div className="gal-stack">
          <Card padding={16}>
            <CardHeader title="이번 주 요약" detail="11월 2주" />
            <div className="gal-tiles">
              <CardTile>
                <span className="label-2 t-footnote">맡긴 일</span>
                <span className="t-title2 tnum">24</span>
              </CardTile>
              <CardTile>
                <span className="label-2 t-footnote">아낀 시간</span>
                <span className="t-title2 tnum">3.5h</span>
              </CardTile>
            </div>
          </Card>
          <List header="바로가기">
            <ListRow icon="paintbrush" title="화면 및 디자인" detail="시스템 따름" chevron onClick={() => {}} />
            <ListRow icon="bell" title="알림" detail="켜짐" chevron onClick={() => {}} />
            <ListRow icon="link" title="연결된 서비스" detail="2개" chevron onClick={() => {}} />
          </List>
        </div>
      </Section>
    </Screen>
  );
}

/** the four button states; the spinner only spins while the row is on screen (idle screens run no animation, §8.16) */
function StateRow() {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useOnScreen(ref);
  return (
    <div ref={ref}>
      <Row label="상태 (primary)">
        {(["idle", "loading", "success", "error"] as ButtonState[]).map((s) => (
          <Button key={s} state={s === "loading" && !shown ? "idle" : s} holdSuccess size="md">
            저장하기
          </Button>
        ))}
      </Row>
    </div>
  );
}

function SendDemo() {
  const [mode, setMode] = useState<SendButtonMode>("mic");
  return (
    <Row label="보내기 ↔ 멈추기 (턴 실행 중)">
      <SendButton mode={mode} onMic={() => setMode("send")} onSend={() => setMode("stop")} onStop={() => setMode("mic")} />
      <Button size="md" tone="neutral" stop={mode === "stop"} icon="arrow-up" onClick={() => setMode(mode === "stop" ? "mic" : "stop")}>
        보내기
      </Button>
    </Row>
  );
}

/** the gallery's <Screen composer> follows this toggle, like a chat screen (content clears the composer, the
 * bottom edge fades out above it) */
function ComposerDemo({ composer, setComposer }: { composer: boolean; setComposer: (on: boolean) => void }) {
  return (
    <Row label="하단 컴포저 슬롯 · 탭 막대는 크기가 바뀌지 않아요">
      <span className="gal-toggle">
        <Toggle checked={composer} onChange={setComposer} label="컴포저" />
        <span aria-hidden="true">컴포저</span>
      </span>
      {composer && (
        <ChromePortal group="bottom">
          <Glass blur="group" radius={R.card} text className="gal-composer">
            <Button variant="circle" tone="neutral" size="sm" icon="plus" ariaLabel="첨부" />
            <span className="gal-composer-field">깽이에게 부탁하기</span>
            <SendButton mode="mic" />
          </Glass>
        </ChromePortal>
      )}
    </Row>
  );
}

function Section({ id, title, children, note, bare }: { id: string; title: string; children: ReactNode; note?: string; bare?: boolean }) {
  return (
    <section className="gal-section" id={`gal-${id}`} data-testid={`gal-${id}`} aria-labelledby={`gal-${id}-h`}>
      <h2 id={`gal-${id}-h`} className="gal-h">
        {title}
      </h2>
      {note && <p className="gal-note">{note}</p>}
      {/* bare: straight on the page (a thread is not inside a card) */}
      {bare ? children : <Card padding={16}>{children}</Card>}
    </section>
  );
}

function Row({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="gal-row-wrap">
      {label && <span className="gal-label">{label}</span>}
      <div className="gal-row">{children}</div>
    </div>
  );
}

const SEARCH_ITEMS = [
  { id: "display", title: "화면 및 디자인", sub: "다크 모드, 글자 크기", icon: "paintbrush" as const },
  { id: "notifications", title: "알림", sub: "배너, 소리", icon: "bell" as const },
  { id: "payments", title: "결제 수단", sub: "카드, 계좌", icon: "card" as const },
  { id: "logins", title: "로그인 정보", sub: "비밀번호 보관", icon: "key" as const },
  { id: "privacy", title: "개인정보 보호", sub: "데이터, 권한", icon: "shield" as const },
  { id: "connections", title: "연결된 서비스", sub: "카카오톡, 슬랙", icon: "link" as const },
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** a generic app-logo stand-in for ListRow `leading` (screens pass real brand icons) */
function DemoLogo() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
      <rect width="30" height="30" rx="8" fill="#34c759" />
      <path d="M15 8.5c-4.4 0-8 2.8-8 6.3 0 2.2 1.4 4.1 3.6 5.2l-.8 3 3.4-2.1c.6.1 1.2.2 1.8.2 4.4 0 8-2.8 8-6.3s-3.6-6.3-8-6.3z" fill="#fff" />
    </svg>
  );
}

/** a body taller than any sheet, under a start-aligned two-line title (foundation.spec: the head keeps the title) */
// 줄바꿈 fixtures: lines as they were when they broke badly (WebKit's pretty ended "봐요(" and started "·뮤지컬"; a
// second sentence wrapped mid-way), kept verbatim so qa/lines.spec.mjs can show the foundation's copy slots hold them
const LINE_FIXTURES = [
  "계좌와 보유 종목, 시세를 봐요(주문은 하지 않아요).",
  "KOPIS에서 지역·장르·기간별 공연(연극·뮤지컬·콘서트)을 찾아줘요.",
  "전자세금계산서를 조회하고, 내가 승인하면 발행하거나 다시 보내요. 입력한 정보는 이 기기에서 암호화한 뒤에만 보내요.",
  "01*** · 3일 전 연결 · 키는 30일 동안 보관해요 · 언제든 지울 수 있어요",
];

const LONG_SHEET_ROWS = Array.from({ length: 16 }, (_, i) => ({ day: `11월 ${i + 10}일`, what: i % 2 ? "호텔 예약 변경" : "항공권 가격 추적" }));
function LongSheetBody() {
  return (
    <List>
      {LONG_SHEET_ROWS.map((r) => (
        <ListRow key={r.day} icon="ticket" title={r.what} detail={r.day} />
      ))}
    </List>
  );
}

/** Declarative sheet demo with its own state (opening it re-renders only this). */
function SheetDemo() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [memo, setMemo] = useState("항공권 가격 추적");
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={btn} size="md" onClick={() => setOpen(true)} className="gal-sheet-btn">
        시트 열기
      </Button>
      <Sheet
        open={open}
        busy={busy}
        onClose={() => setOpen(false)}
        source={btn}
        title="티켓 사용"
        footer={
          <Button
            fullWidth
            action={async () => {
              setBusy(true);
              try {
                await wait(1100);
              } finally {
                setBusy(false);
              }
            }}
            onSuccess={() => setOpen(false)}
          >
            사용하기
          </Button>
        }
      >
        <div className="gal-stack">
          <p className="t-copy">
            <span className="t-s">
              티켓 1장으로 <b>항공권 가격 추적</b>을 맡길게요.
            </span>{" "}
            <span className="t-s">결제는 승인 후에만 진행돼요.</span>
          </p>
          <TextField label="메모" value={memo} onChange={setMemo} />
          <List>
            <ListRow icon="ticket" title="남은 티켓" detail={<span className="tnum">12장</span>} />
            <ListRow icon="clock" title="예상 시간" detail="약 2분" />
          </List>
        </div>
      </Sheet>
    </>
  );
}

export default function Gallery() {
  const tier = useTier();
  const [seg, setSeg] = useState<"a" | "b" | "c">("a");
  const [seg2, setSeg2] = useState<"artifacts" | "media">("artifacts");
  const [t1, setT1] = useState(true);
  const [t2, setT2] = useState(false);
  const [vol, setVol] = useState(0.6);
  const [chips, setChips] = useState<string[]>(["추천"]);
  const [name, setName] = useState("깽이");
  const [email, setEmail] = useState("hello@pickle");
  const [count, setCount] = useState(1280);
  const [progress, setProgress] = useState(0.42);
  const [bar, setBar] = useState(3);
  const [swap, setSwap] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [composer, setComposer] = useState(false);
  const [capsule, setCapsule] = useState<"invite" | "mock" | "real">("invite");

  // 초대 (a button), or 투자's order-mode capsule (a status, DD 2008 §1): 모의 ↔ 실제 morphs the same capsule
  useTopBarRight(
    capsule === "invite"
      ? { label: "초대", onPress: () => island.banner({ icon: "people", title: "초대 링크를 복사했어요", body: "친구가 가입하면 티켓 3장을 드려요." }) }
      : capsule === "real"
        ? { label: "실제 주문", tone: "danger", ariaLabel: "지금은 실제 주문이에요" }
        : { label: "모의 주문", ariaLabel: "지금은 모의 주문이에요" },
  );
  // the centre's agent (at the top, before the large title scrolls under the bar) opens a sheet like 채팅's: a source
  // with its own opacity transition (foundation.spec "close": it is whole on the first close frame)
  useTopBarCenter((el) => presentSheet({ source: el, title: "나의 모시", render: () => <p className="label-2">상단 바 가운데에서 열린 시트예요. 닫으면 이름이 그 자리에 바로 있어요.</p> }));

  const theme = tier.prefs.theme;
  return (
    <Screen routeKey="gallery" composer={composer}>
      <LargeTitle title="컴포넌트 갤러리" subtitle="모든 프리미티브, 모든 상태" />

      <Section id="settings" title="환경">
        <div className="gal-stack">
          <SegmentedControl
            role="radiogroup"
            label="테마"
            value={theme}
            onChange={(v) => setDisplayPrefs({ theme: v })}
            options={[
              { value: "system", label: "시스템" },
              { value: "light", label: "라이트" },
              { value: "dark", label: "다크" },
            ]}
          />
          <List>
            <ListRow
              icon="bolt"
              title="동작 줄이기"
              accessory={<Toggle label="동작 줄이기" checked={tier.reduceMotion} onChange={(on) => setDisplayPrefs({ reduceMotion: on ? "on" : "off" })} />}
            />
            <ListRow
              icon="eye"
              title="투명도 줄이기"
              accessory={<Toggle label="투명도 줄이기" checked={tier.reduceTransparency} onChange={(on) => setDisplayPrefs({ reduceTransparency: on ? "on" : "off" })} />}
            />
          </List>
          <Slider
            label="글자 크기"
            value={tier.textScale}
            min={0.9}
            max={1.3}
            step={0.05}
            minIcon="doc"
            maxIcon="doc"
            format={(v) => `${Math.round(v * 100)}%`}
            showValue
            onChange={(v) => setDisplayPrefs({ textScale: Math.round(v * 100) / 100 })}
          />
        </div>
      </Section>

      <Section id="buttons" title="버튼">
        <div className="gal-stack">
          <StateRow />
          <Row label="동작 (서버 확인 후 체크)">
            <Button action={() => wait(1200)}>티켓 사용하기</Button>
            <Button tone="secondary" action={() => wait(900).then(() => Promise.reject(new Error("x")))}>
              실패해 보기
            </Button>
          </Row>
          <Row label="톤">
            <Button tone="glass" size="md" icon="share">
              공유
            </Button>
            <Button tone="secondary" size="md">
              나중에
            </Button>
            <Button tone="destructive" size="md" icon="trash">
              삭제
            </Button>
            <Button variant="plain" size="md">
              더 보기
            </Button>
          </Row>
          <Row label="크기 · 원형">
            <Button size="lg">큰 버튼</Button>
            <Button size="md">중간</Button>
            <Button size="sm">작게</Button>
            <Button variant="circle" icon="plus" ariaLabel="추가" />
            <Button variant="circle" tone="glass" size="md" icon="mic" ariaLabel="음성" />
            <Button variant="circle" tone="secondary" size="sm" icon="close" ariaLabel="닫기" />
          </Row>
          <Row label="중립 (화면당 강조색 1곳 · 글로우 없음)">
            <Button tone="neutral" size="md" icon="people">
              초대
            </Button>
            <Button tone="neutral" variant="circle" size="md" icon="phone" ariaLabel="전화" />
            <Button tone="neutral" variant="circle" icon="plus" elevated ariaLabel="새 대화" />
            <Button tone="neutral" variant="plain" size="md">
              모두 보기
            </Button>
          </Row>
          <SendDemo />
          <Row label="위험한 승인: 1.2초 길게 누르기 또는 두 번 누르기">
            <ConfirmButton label="39,000원 결제하기" onConfirm={() => wait(900)} />
            <ConfirmButton label="연결 해제" tone="destructive" onConfirm={() => wait(900)} />
          </Row>
          <Row label="비활성">
            <Button disabled size="md">
              보내기
            </Button>
            <Button disabled tone="secondary" size="md">
              보내기
            </Button>
          </Row>
          <Button fullWidth action={() => wait(1000)}>
            전체 너비 버튼
          </Button>
        </div>
      </Section>

      <Section id="segmented" title="세그먼트">
        <div className="gal-stack">
          <SegmentedControl
            label="기간"
            value={seg}
            onChange={setSeg}
            options={[
              { value: "a", label: "일간" },
              { value: "b", label: "주간" },
              { value: "c", label: "월간" },
            ]}
          />
          <SegmentedControl
            idBase="gal-arch"
            label="보관함"
            size="sm"
            value={seg2}
            onChange={setSeg2}
            options={[
              { value: "artifacts", label: "아티팩트", icon: "doc" },
              { value: "media", label: "미디어", icon: "photo" },
            ]}
          />
          <SegmentedPanels value={seg2} order={["artifacts", "media"]} idBase="gal-arch">
            <CardTile>{seg2 === "artifacts" ? "아티팩트 패널 — 방향에 맞춰 16px 이동해요." : "미디어 패널 — 두 사본이 겹쳐 보이지 않아요."}</CardTile>
          </SegmentedPanels>
        </div>
      </Section>

      <Section id="controls" title="토글 · 슬라이더 · 칩">
        <div className="gal-stack">
          <Row label="토글">
            <Toggle label="켜짐" checked={t1} onChange={setT1} />
            <Toggle label="꺼짐" checked={t2} onChange={setT2} />
            <Toggle label="비활성" checked disabled onChange={() => {}} />
            <Toggle label="비활성 꺼짐" checked={false} disabled onChange={() => {}} />
          </Row>
          <Slider label="음량" value={vol} onChange={setVol} minIcon="speaker-off" maxIcon="speaker" />
          <Slider label="비활성" value={0.3} onChange={() => {}} disabled />
          <ChipGroup label="카테고리">
            {["추천", "혜택", "쇼핑", "여행", "사람"].map((c) => (
              <Chip key={c} label={c} selected={chips.includes(c)} onClick={() => setChips((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]))} />
            ))}
            <Chip label="비활성" disabled />
          </ChipGroup>
          <ChipGroup label="작은 칩">
            <Chip size="sm" icon="star" label="새 기능" selected />
            <Chip size="sm" icon="clock" label="최근" />
            <Chip size="sm" icon="star" label="즐겨찾기" />
          </ChipGroup>
        </div>
      </Section>

      <Section id="list" title="목록">
        <List header="설정" footer="행 전체가 눌러지는 영역이에요 (44px 이상).">
          <ListRow icon="paintbrush" title="화면 및 디자인" detail="시스템" chevron onClick={() => {}} />
          <ListRow icon="bell" title="알림" subtitle="배너와 소리" accessory={<Toggle label="알림" checked={t1} onChange={setT1} />} />
          <ListRow icon="card" title="결제 수단" detail="2개" chevron onClick={() => {}} />
          <ListRow leading={<DemoLogo />} title="메신저 연결" subtitle="leading: 앱 로고 자리 (30×30)" detail="연결됨" chevron onClick={() => {}} />
          <ListRow leading={<DemoLogo />} title="연결 안 된 서비스" disabled chevron />
          <ListRow icon="lock" title="잠긴 항목" disabled chevron />
          <ListRow icon="trash" title="대화 기록 삭제" destructive onClick={() => {}} />
        </List>
      </Section>

      <Section id="fields" title="입력">
        <div className="gal-stack">
          <TextField label="이름" value={name} onChange={setName} hint="에이전트가 부를 이름이에요" />
          <TextField label="이메일" type="email" value={email} onChange={setEmail} error={email.includes("@") && email.includes(".") ? undefined : "이메일 형식을 확인해 주세요"} />
          <TextField label="빈 칸" value="" onChange={() => {}} placeholder="무엇이든 맡겨보세요" />
          <TextField label="비활성" value="수정할 수 없어요" onChange={() => {}} disabled />
          <TextField label="채움형" variant="filled" value="" onChange={() => {}} placeholder="검색" />
        </div>
      </Section>

      <Section id="lines" title="줄바꿈" note="옛 문구 그대로 · 끊는 자리는 기본 요소(Text.tsx)가 정해요">
        <div className="gal-stack">
          <List footer={LINE_FIXTURES[1]}>
            <ListRow icon="card" title="토스증권" subtitle={LINE_FIXTURES[0]} chevron onClick={() => {}} />
            <ListRow title="KOPIS 공연" subtitle={LINE_FIXTURES[1]} />
            <ListRow icon="ticket" title="팝빌" subtitle={LINE_FIXTURES[2]} detail="다시 연결" />
            <ListRow title="네이버 검색광고" subtitle={LINE_FIXTURES[3]} chevron onClick={() => {}} />
            <ListRow icon="bell" title="쿠팡 파트너스" subtitle={LINE_FIXTURES[1]} detail="연결 전" chevron onClick={() => {}} />
          </List>
          <TextField label="SecretKey" value="" onChange={() => {}} hint={LINE_FIXTURES[2]} />
          <TextField label="Client ID" value="" onChange={() => {}} error={LINE_FIXTURES[0]} />
          <EmptyState icon="ticket" title="아직 연결한 서비스가 없어요" body={LINE_FIXTURES[2]} />
        </div>
      </Section>

      <Section id="data" title="진행 · 숫자 · 차트">
        <div className="gal-stack">
          <ProgressBar value={progress} label="이번 달 티켓" showValue />
          <ProgressBar value={0.86} label="저장 공간" tone="label" height={4} />
          <Row>
            <span className="gal-odo">
              <Odometer value={count} suffix="원" format={(n) => n.toLocaleString("ko-KR")} />
            </span>
            <Button size="sm" tone="secondary" onClick={() => setCount((c) => c + Math.round(37 + Math.random() * 900))}>
              늘리기
            </Button>
            <Button size="sm" tone="secondary" onClick={() => setProgress((p) => (p > 0.9 ? 0.1 : p + 0.17))}>
              진행
            </Button>
          </Row>
          <BarChart
            id="gal-chart"
            ariaLabel="요일별 맡긴 일"
            unit="건"
            selected={bar}
            data={["월", "화", "수", "목", "금", "토", "일"].map((label, i) => ({ label, value: [3, 5, 2, 8, 6, 4, 7][i]! }))}
          />
          <Row>
            <Button size="sm" tone="secondary" onClick={() => setBar((b) => (b + 1) % 7)}>
              다음 막대
            </Button>
          </Row>
        </div>
      </Section>

      <Section id="avatars" title="아바타">
        <Row>
          <Avatar size={56} spec={{ hue: 8, shape: "blob", eyes: "oval" }} label="깽이" breathing />
          <Avatar size={56} spec={{ hue: 210, shape: "round", eyes: "dot" }} />
          <Avatar size={56} spec={{ hue: 150, shape: "drop", eyes: "smile" }} />
          <Avatar size={40} spec={{ hue: 280, shape: "blob", eyes: "smile" }} ring />
          <Avatar size={32} breathing={false} />
        </Row>
        <div className="gal-blob">
          <AgentBlobLazy size={140} label="에이전트 캐릭터" />
        </div>
      </Section>

      <Section id="island" title="에이전트 상태 · 아일랜드 · 배너" note="idle은 정지 · 막대는 실제 값(토큰 속도)만 · 2초 뒤 경과 시간">
        <div className="gal-stack">
          <Row>
            <Button size="sm" tone="neutral" onClick={() => island.thinking("gallery")}>
              생각
            </Button>
            <Button size="sm" tone="neutral" onClick={() => island.tool("k_weather")}>
              도구
            </Button>
            <Button
              size="sm"
              tone="neutral"
              onClick={() => {
                let n = 0;
                const t = setInterval(() => {
                  island.tokens(6 + Math.round(Math.random() * 10));
                  if (++n > 30) clearInterval(t);
                }, 70);
              }}
            >
              답하는 중
            </Button>
            <Button size="sm" tone="neutral" onClick={() => island.awaitingApproval("메일 보내기")}>
              승인 대기
            </Button>
          </Row>
          <Row>
            <Button size="sm" tone="neutral" onClick={() => island.done()}>
              완료
            </Button>
            <Button size="sm" tone="neutral" onClick={() => island.error()}>
              오류
            </Button>
            <Button size="sm" tone="neutral" onClick={() => island.debugAge(16000)}>
              +16초
            </Button>
            <Button size="sm" tone="neutral" onClick={() => island.idle()}>
              대기
            </Button>
          </Row>
          <Row>
            <Button size="sm" tone="neutral" icon="phone" onClick={() => island.call({ name: "깽이" })}>
              통화
            </Button>
            <Button size="sm" tone="neutral" onClick={() => island.toggleCallExpanded()}>
              접기/펼치기
            </Button>
            <Button size="sm" tone="neutral" onClick={() => island.endCall()}>
              끊기
            </Button>
          </Row>
          <Row>
            <Button size="sm" tone="neutral" icon="bell" onClick={() => island.banner({ icon: "card", title: "결제 승인이 필요해요", body: "쿠팡 · 32,400원 · 눌러서 확인하기", onPress: () => {} })}>
              배너
            </Button>
            <Button size="sm" tone="neutral" onClick={() => island.errorBanner("인터넷 연결을 확인해 주세요.", "보내지 못했어요")}>
              오류 배너
            </Button>
            <Button size="sm" tone="neutral" onClick={() => island.undo({ title: "모닝콜을 만들었어요", body: "내일 오전 7:00", onUndo: () => wait(300) })}>
              실행 취소 배너
            </Button>
          </Row>
          <ComposerDemo composer={composer} setComposer={setComposer} />
        </div>
      </Section>

      <Section id="sheet" title="시트">
        <Row>
          <SheetDemo />
          <Button
            size="md"
            tone="secondary"
            onClick={(e) =>
              presentSheet({
                source: e.currentTarget,
                title: "알림 설정",
                render: (s) => (
                  <div className="gal-stack">
                    <p className="label-2 t-copy">{copy("presentSheet()로 어디서든 열 수 있어요. 한 번에 하나만 떠요.")}</p>
                    <Button fullWidth action={() => wait(800)} onSuccess={s.close}>
                      확인
                    </Button>
                  </div>
                ),
              })
            }
          >
            명령형 시트
          </Button>
        </Row>
        <Row>
          <Button
            size="md"
            tone="secondary"
            className="gal-longsheet-btn"
            onClick={(e) =>
              presentSheet({
                source: e.currentTarget,
                title: "항공권 가격 추적과 호텔 예약 변경 요청",
                titleAlign: "start",
                render: () => <LongSheetBody />,
                footer: (s) => (
                  <Button fullWidth onClick={s.close}>
                    확인
                  </Button>
                ),
              })
            }
          >
            긴 제목 시트
          </Button>
        </Row>

      </Section>

      <Section id="spotlight" title="스포트라이트 (초성 검색)">
        <Spotlight
          label="설정 검색"
          items={SEARCH_ITEMS}
          getKey={(i) => i.id}
          getLabel={(i) => i.title}
          getSubtitle={(i) => i.sub}
          getIcon={(i) => i.icon}
          onSelect={(i) => setPicked(i.title)}
          placeholder="ㅎㅁ, 결제, 알림…"
          emptyText="일치하는 설정이 없어요"
        />
        {picked && <p className="gal-note">선택: {picked}</p>}
      </Section>

      <Section id="glass" title="글래스" note="세 면이 하나의 블러를 나눠 써요 (BlurGroup).">
        <BlurGroup className="gal-glass-row">
          <Glass blur="group" radius={R.card} interactive className="gal-glass">
            기본
          </Glass>
          <Glass blur="group" radius={R.card} variant="clear" interactive className="gal-glass">
            클리어
          </Glass>
          <Glass blur="group" radius={R.card} text className="gal-glass">
            텍스트
          </Glass>
        </BlurGroup>
      </Section>

      <Section id="swap" title="콘텐츠 전환">
        <Row>
          <span className="gal-swap">
            <SwapText text={["무엇이든 맡겨보세요", "일정을 정리했어요", "결제를 기다리는 중이에요"][swap % 3]!} />
          </span>
          <Button size="sm" tone="secondary" onClick={() => setSwap((n) => n + 1)}>
            바꾸기
          </Button>
        </Row>
        <ContentSwap swapKey={swap % 2} display="block" as="div">
          <CardTile className="t-copy">{swap % 2 ? "두 번째 카드 — 흐림 6px, 축소 .96, 120ms 퇴장" : "첫 번째 카드 — 60ms 뒤 morph 스프링으로 등장"}</CardTile>
        </ContentSwap>
      </Section>

      <Section id="cards" title="카드 · 빈 상태">
        <div className="gal-stack">
          <Card padding={16}>
            <CardHeader title="이번 주 요약" detail="11월 2주" action={<Button variant="plain" size="sm">전체</Button>} />
            <div className="gal-tiles">
              <CardTile>
                <span className="label-2 t-footnote">맡긴 일</span>
                <span className="t-title2 tnum">24</span>
              </CardTile>
              <CardTile>
                <span className="label-2 t-footnote">아낀 시간</span>
                <span className="t-title2 tnum">3.5h</span>
              </CardTile>
            </div>
          </Card>
          <EmptyState icon="archive" title="아직 만든 아티팩트가 없어요" body="채팅에서 만든 문서와 표가 여기에 모여요." action={<Button size="md" tone="secondary">채팅으로 가기</Button>} />
        </div>
      </Section>

      {/* a thread with cards, straight on the page as in chat: foundation QA measures the tab label's contrast on its
          droplet with this content (and the list above) passing under the bar — synthetic copy only */}
      <Section id="thread" title="대화 · 카드" note="스레드 위로 콘텐츠가 지나갈 때 탭 라벨 대비를 재는 자리예요." bare>
        <div className="gal-thread">
          <p className="gal-bubble">내일 오후 3시에 치과 예약 되는지 전화해서 물어봐 줘</p>
          <p className="gal-asst" data-lines="prose">
            전화로 물어볼게요. 이렇게 전할게요.
          </p>
          <Card padding={16}>
            <CardHeader title="치과에 전화할까요?" />
            <p className="gal-card-body">“안녕하세요, 내일 오후 3시에 진료 예약이 가능한지 여쭤봐도 될까요?”</p>
            <Button tone="primary" fullWidth>
              전화 걸기
            </Button>
          </Card>
          <p className="gal-bubble">고마워. 오늘 날씨도 알려 줘</p>
          <Card padding={16}>
            <CardHeader title="오늘 날씨" detail="맑음" />
            <div className="gal-tiles">
              <CardTile>
                <span className="label-2 t-footnote">낮 최고</span>
                <span className="t-title2 tnum">14°</span>
              </CardTile>
              <CardTile>
                <span className="label-2 t-footnote">밤 최저</span>
                <span className="t-title2 tnum">3°</span>
              </CardTile>
            </div>
          </Card>
          <p className="gal-asst" data-lines="prose">
            오후에는 바람이 조금 불어요. 가벼운 외투를 챙기세요.
          </p>
        </div>
      </Section>

      <Section id="icons" title={`아이콘 (${ICON_NAMES.length})`}>
        <div className="gal-icons">
          {ICON_NAMES.map((n) => (
            <span key={n} className="gal-icon" title={n}>
              <Icon name={n} size={22} />
              <span className="gal-icon-name">{n}</span>
            </span>
          ))}
        </div>
      </Section>

      {/* 투자's shared parts (DD 1935 §0-4, §1): synthetic figures, formatted by @pickle/quant */}
      <Section id="invest" title="투자 · 신호 · 행" note="숫자는 모두 합성 값이에요." bare>
        <div className="gal-stack">
          <SegmentedControl
            role="radiogroup"
            label="상단 바 캡슐"
            value={capsule}
            onChange={setCapsule}
            options={[
              { value: "invite", label: "초대" },
              { value: "mock", label: "모의" },
              { value: "real", label: "실제" },
            ]}
          />
          <Card padding={16} className="gal-invest">
            <div className="gal-invest-signals">
              {SIGNALS.map((s) => (
                <SignalLabel key={s} signal={s} />
              ))}
            </div>
            <IvHero value={usd(32.57)} />
            <IvRows>
              <IvRow label="오늘" value={pct(-1.04)} />
              <IvRow label="손절선까지" value={pct(-7.39)} />
              <IvRow label="보유" value={shares(47)} />
              <IvRow label="평가액" value={estimate(usd(1204))} />
              {/* a row value's boxes (DD 2225 I2, DD 2131 ③): " · " items, a bracketed part, an estimate's tail with words */}
              <IvRow label="신호" value="악화 2/8 · 심각 0/5 · 회복 3/6" />
              <IvRow label="체결 시각" value={kstWithEastern(Date.UTC(2026, 10, 26, 15, 47))} />
              <IvRow label="예상 금액" value={`약 ${usd(1204.14)}(추정, 관측가 기준)`} />
              <IvRow label="HY 스프레드" value={rate(4.12)} />
              <IvRow label="전월 대비" value={pp(0.24)} />
              <IvRow label="삼성전자" value={krw(189_400)} />
              <IvRow label="시장 단계" value={<SignalLabel signal="caution" />} />
              <IvRow label="공매도 잔고" value={null} />
              <IvRow label="주문 모드" value={<ModeWord mode={capsule === "real" ? "real" : "mock"} />} />
            </IvRows>
            <IvFoot>{footLine(kstWithEastern(Date.UTC(2026, 10, 26, 15, 45)), "토스증권", "A")}</IvFoot>
            <IvDisclaimer />
          </Card>
        </div>
      </Section>

      {/* ① 시장 단계's board in its five states (DD 0059 §1-3, DD 0141): synthetic server words */}
      <Section id="invest-stages" title="투자 · 단계 보드" note="다섯 상태 모두 합성 값이에요." bare>
        <div className="gal-stack">
          {STAGE_STATES.map((st) => (
            <List key={st.name} header={<h3 className="list-section-title">{st.name}</h3>} className="gal-stage" label={st.name}>
              <div className="list-row gal-stage-row" data-state={st.name}>
                <div className="list-row-main gal-stage-main">
                  <IvStages stages={st.stages} />
                </div>
              </div>
            </List>
          ))}
        </div>
      </Section>
    </Screen>
  );
}
