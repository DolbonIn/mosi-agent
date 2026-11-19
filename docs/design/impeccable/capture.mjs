// Impeccable critique capture (design-director). Run from the repo root:  node docs/design/impeccable/capture.mjs
//
// Renders every feature the critique scores at 390×844 (@2x), light + dark, installed Chrome (channel "chrome") +
// Playwright WebKit, against its OWN throwaway server + data dir. Never uses :8787 / :5173 (the user's preview with
// real data) or the other QA servers' ports. Never runs `playwright install`. Never opens a real camera or microphone:
// Chrome gets --use-fake-device-for-media-stream and both engines get a scripted getUserMedia / SpeechRecognition
// before any page script runs; /api/tts is answered 503 so no audio service is touched.
//
// Data: two API-created users (A = 하늘/깽이, B = 진우/콩이, friends through an invite), three schedules. Rich chat
// cards, the archive and extra drawer threads come from response fixtures (route interception) so every card type is
// on screen without an LLM call. Output: docs/design/impeccable/shots/<engine>-<theme>-NN-name.jpg + index.json.
// Env: CAP_OUT (another output dir) · CAP_DETECT (impeccable launcher path, see below) · CAP_ENGINES=chromium,webkit · CAP_THEMES=light,dark · CAP_ONLY=onboarding,chat,… · CAP_BUILD=0 (reuse dist)
//      CAP_SERVER_PORT=8743 · CAP_AUDIO_PORT=8744 · CAP_PORT=5243
import { chromium, webkit } from "playwright";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const appDir = path.join(repo, "apps/mobile");
const outDir = process.env.CAP_OUT ? path.resolve(process.env.CAP_OUT) : path.join(here, "shots");
// CAP_DETECT=<path to the impeccable launcher>: Chrome passes also run `impeccable detect --cdp` on every captured
// screen (Chrome gets a local-only DevTools port); findings go to <outDir>/detect.json. The launcher is not vendored.
const DETECT = process.env.CAP_DETECT || "";
const CDP_PORT = Number(process.env.CAP_CDP_PORT || 9333);
const SERVER_PORT = Number(process.env.CAP_SERVER_PORT || 8743);
const AUDIO_PORT = Number(process.env.CAP_AUDIO_PORT || 8744);
const PORT = Number(process.env.CAP_PORT || 5243);
const API = `http://127.0.0.1:${SERVER_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRETS = process.env.PICKLE_SECRETS || path.join(os.homedir(), ".config/pickle-clone/secrets.env");
const ENGINES = (process.env.CAP_ENGINES || "chromium,webkit").split(",");
const THEMES = (process.env.CAP_THEMES || "light,dark").split(",");
const ONLY = process.env.CAP_ONLY ? new Set(process.env.CAP_ONLY.split(",")) : null;
const want = (s) => !ONLY || ONLY.has(s);
const RESERVED = new Set([5173, 8787, 8789, 8781, 8782, 8790, 8791, 8792, 8769, 8799, 8796, 5199, 5186, 5182]);
const PASSWORD = "cap-pass-1234";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => crypto.randomBytes(3).toString("hex");
for (const p of [SERVER_PORT, AUDIO_PORT, PORT]) if (RESERVED.has(p)) throw new Error(`port ${p} belongs to another server`);
fs.mkdirSync(outDir, { recursive: true });

const portBusy = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
const killGroup = (proc) => {
  if (!proc || proc.exitCode !== null) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
};

// ── processes (pids recorded; only these are stopped) ──
const procs = [];
async function startServer() {
  for (const p of [SERVER_PORT, AUDIO_PORT]) if (await portBusy(p)) throw new Error(`port ${p} is in use (someone else's); pick another`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mosi-capture-"));
  const log = fs.openSync(path.join(dataDir, "server.log"), "a");
  const proc = spawn(process.env.BUN || "bun", [`--env-file=${SECRETS}`, "run", "apps/server/src/index.ts"], {
    cwd: repo,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, PORT: String(SERVER_PORT), PICKLE_DATA_DIR: dataDir, PICKLE_AUDIO_PORT: String(AUDIO_PORT), PICKLE_AUDIO_TUNNEL: "0",
      // QA-server rule: no Meet bot, no STT box, no Twilio, whatever the caller's shell holds
      MEET_BOT_URL: "off", STT_URL: "off", TWILIO_ACCOUNT_SID: "", TWILIO_AUTH_TOKEN: "", TWILIO_FROM: "" },
  });
  procs.push(proc);
  console.log(`server pid ${proc.pid} · data ${dataDir}`);
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) break;
    try {
      if ((await fetch(`${API}/api/health`)).ok) return { proc, dataDir };
    } catch {}
    await sleep(200);
  }
  throw new Error(`server did not start (log ${dataDir}/server.log)`);
}
async function startPreview() {
  if (await portBusy(PORT)) throw new Error(`port ${PORT} is in use; set CAP_PORT`);
  const dist = path.join(os.tmpdir(), "mosi-capture-dist");
  if (process.env.CAP_BUILD !== "0" || !fs.existsSync(path.join(dist, "index.html"))) {
    const b = spawnSync("bunx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], { cwd: appDir, stdio: "pipe", encoding: "utf8" });
    if (b.status !== 0) throw new Error(`build failed:\n${b.stdout.slice(-1500)}\n${b.stderr.slice(-1500)}`);
  }
  const proc = spawn("bunx", ["vite", "preview", "--outDir", dist, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: appDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PICKLE_API: API },
  });
  procs.push(proc);
  console.log(`preview pid ${proc.pid} · ${BASE}`);
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return proc;
    } catch {}
    await sleep(150);
  }
  throw new Error("vite preview did not start");
}

async function api(method, p, body, token) {
  const res = await fetch(API + p, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
}
async function signup(handle, displayName, agentName) {
  const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
  const r = await api("POST", "/api/auth/signup", { handle, password: PASSWORD, displayName, agentName, device: { id: `cap-${rand()}`, label: "capture", signingKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } } });
  if (r.status !== 200 && r.status !== 201) throw new Error(`signup ${handle}: ${r.status} ${JSON.stringify(r.body)}`);
  // the daily briefing off at once: an account made in its window (07:30 + 2 h KST) otherwise gets a real briefing turn
  // within 30 s, and its island and "오늘의 브리핑" banner land in the shots
  const off = await api("PATCH", "/api/settings", { notifications: { briefing: false } }, r.body.token);
  if (off.status !== 200) console.warn(`  briefing off for ${handle}: ${off.status}`);
  return { token: r.body.token, session: r.body.session, handle };
}

// ── fixtures (realistic copy taken from the server's own strings: phone.ts, meet.ts, auth.ts) ──
const T0 = Date.now() - 3 * 3600_000;
let mid = 0;
const msg = (threadId, role, text, extra = {}) => ({ id: `fx-m${++mid}`, threadId, role, text, cards: [], tools: [], attachments: [], createdAt: T0 + mid * 90_000, ...extra });
const tool = (name, title, state, summary, secs = 3) => ({ id: `fx-t${++mid}`, name, title, state, summary, startedAt: T0 + mid * 90_000, endedAt: state === "done" ? T0 + mid * 90_000 + secs * 1000 : undefined });
function cardThread(threadId, agent) {
  mid = 0;
  return [
    msg(threadId, "user", "오늘 서울 날씨 알려줘"),
    msg(threadId, "assistant", "지금 서울은 맑고 9도예요. 오후엔 13도까지 올라가고, 저녁부터 바람이 조금 불어요. 미세먼지는 보통이에요.", {
      tools: [tool("k_weather", "서울 날씨 확인", "done", "기상청 단기예보"), tool("k_air", "미세먼지 확인", "done", "에어코리아")],
      cards: [
        {
          type: "weather",
          place: "서울 중구",
          now: { tempC: 9, condition: "맑음", icon: "sun" },
          high: 13,
          low: 4,
          hourly: [
            { hour: "12시", tempC: 11, icon: "sun" },
            { hour: "15시", tempC: 13, icon: "sun" },
            { hour: "18시", tempC: 10, icon: "cloud", pop: 10 },
            { hour: "21시", tempC: 7, icon: "cloud", pop: 20 },
            { hour: "0시", tempC: 5, icon: "moon" },
          ],
          source: "기상청",
        },
      ],
    }),
    msg(threadId, "user", "내가 지금 신청할 수 있는 정부 지원사업 찾아줘"),
    msg(threadId, "assistant", "조건에 맞는 지원사업을 3개 찾았어요. 청년 월세 지원은 이번 달 말에 마감이라 먼저 보시는 게 좋아요.", {
      tools: [tool("k_gov24", "정부24 지원사업 검색", "done", "3건")],
      cards: [
        {
          type: "results",
          title: "신청할 수 있는 지원사업",
          source: "정부24",
          items: [
            { title: "청년 월세 한시 특별지원", subtitle: "월 최대 20만 원 · 12개월", meta: "11월 30일 마감", icon: "house" },
            { title: "국민내일배움카드", subtitle: "훈련비 최대 500만 원", meta: "상시", icon: "card" },
            { title: "청년도약계좌", subtitle: "정부 기여금 월 최대 3.3만 원", meta: "12월 신청", icon: "coins" },
          ],
        },
      ],
    }),
    msg(threadId, "user", "슬랙 오늘 나한테 온 것만 정리해 줘"),
    msg(threadId, "assistant", "오늘 나를 언급한 메시지는 2개예요. 디자인 리뷰가 4시로 당겨졌어요.", {
      tools: [tool("msg_read", "슬랙 읽기", "done", "#design · 2건")],
      cards: [
        // the room card shape msg_read sends since 0129451 (room, thread, 1–3 highlights); synthetic names only
        {
          type: "messenger",
          provider: "slack",
          action: "read",
          target: "#design",
          messages: [],
          room: { title: "#design", kind: "channel", memberCount: 12, unread: 5 },
          total: 8,
          highlights: ["fx-s3", "fx-s6"],
          thread: [
            { id: "fx-s1", at: T0 + 5 * 60_000, senderId: "u1", senderName: "수아", isMe: false, kind: "text", text: "오늘 리뷰 자료 폴더에 올려 뒀어요" },
            { id: "fx-s2", at: T0 + 12 * 60_000, senderId: "u2", senderName: "민호", isMe: false, kind: "file", text: "", attachment: { label: "시안_B_v3.pdf" } },
            { id: "fx-s3", at: T0 + 20 * 60_000, senderId: "u3", senderName: "지현", isMe: false, kind: "text", text: "@하늘 오늘 디자인 리뷰 4시로 당겨도 될까요?" },
            { id: "fx-s4", at: T0 + 24 * 60_000, senderId: "u1", senderName: "수아", isMe: false, kind: "text", text: "저는 4시 괜찮아요" },
            { id: "fx-s5", at: T0 + 31 * 60_000, senderId: "me", senderName: "하늘", isMe: true, kind: "text", text: "확인하고 답할게요" },
            { id: "fx-s6", at: T0 + 50 * 60_000, senderId: "u2", senderName: "민호", isMe: false, kind: "text", text: "@하늘 시안 B 피드백 남겨 뒀어요" },
            { id: "fx-s7", at: T0 + 52 * 60_000, senderId: "u3", senderName: "지현", isMe: false, kind: "emoticon", text: "", attachment: { label: "이모티콘" } },
            { id: "fx-s8", at: T0 + 58 * 60_000, senderId: "u1", senderName: "수아", isMe: false, kind: "text", text: "회의실은 3층 큰 방이에요" },
          ],
        },
      ],
    }),
    msg(threadId, "user", "카톡 안 읽은 대화도 정리해 줘"),
    msg(threadId, "assistant", "카카오톡을 읽으려면 로그인이 한 번 필요해요. 비밀번호는 이 기기에서 암호화돼서 저도 볼 수 없어요.", {
      tools: [tool("msg_read", "카카오톡 읽기", "needs_credential")],
      cards: [
        {
          type: "credential_request",
          service: "kakaotalk",
          serviceName: "카카오톡",
          reason: "안 읽은 대화를 가져오려면 카카오 계정으로 로그인해야 해요.",
          fields: [
            { key: "username", label: "카카오 계정", type: "email", autocomplete: "username", placeholder: "이메일 또는 전화번호" },
            { key: "password", label: "비밀번호", type: "password", autocomplete: "current-password" },
          ],
          status: "pending",
        },
      ],
    }),
    msg(threadId, "user", "이 회의 들어가서 받아 적어 줘 https://meet.google.com/abc-defg-hij"),
    msg(threadId, "assistant", "", {
      tools: [tool("sys_join_meet", "회의 참여", "done", "승인됨")],
      cards: [
        {
          type: "approval",
          approvalId: "fx-ap-meet",
          title: "Google Meet 회의(abc-defg-hij)에 참여할까요?",
          detail: `${agent}가 이 회의에 참여해 듣고 받아 적어요. 참석자들에게는 AI 비서라고 먼저 알려요.`,
          status: "approved",
        },
      ],
    }),
    msg(threadId, "event", "Google Meet 회의(abc-defg-hij)에 참여하러 갈게요."),
    msg(threadId, "event", "참여 요청을 보냈어요. 호스트가 수락하면 들어가요."),
    msg(threadId, "event", `회의에 들어왔어요. 지금부터 받아 적을게요. 회의 중에 '${agent}야'라고 부르면 대답해요.`),
    msg(threadId, "event", "회의가 끝나서 나왔어요."),
    msg(
      threadId,
      "assistant",
      "**회의 요약**\n\n**정한 것**\n- 출시일은 12월 2일로 확정했어요.\n- 랜딩 페이지는 시안 B로 가요.\n\n**할 일**\n- 하늘: 랜딩 문구 금요일까지\n- 지현: 앱 스토어 스크린샷 5장\n\n**다음 회의**\n- 11월 19일 화요일 오전 10시",
      { cards: [{ type: "artifact", artifactId: "fx-art-doc", title: "11월 12일 주간회의 회의록", kind: "document", preview: "참석 4명 · 42분 · 정한 것 2 · 할 일 2" }] },
    ),
    msg(threadId, "user", "매일 아침 7시에 날씨랑 뉴스 브리핑해줘"),
    msg(threadId, "assistant", "매일 아침 7시에 브리핑을 보내 드릴게요.", {
      tools: [tool("sys_schedule_create", "예약 만들기", "done", "매일 오전 7:00")],
      cards: [{ type: "schedule", scheduleId: "fx-sc-1", title: "아침 브리핑", when: "매일 오전 7:00", enabled: true }],
    }),
    msg(threadId, "user", "연세바른치과에 내일 3시 예약 되는지 전화해서 물어봐 줘"),
    msg(threadId, "assistant", "", {
      tools: [tool("sys_phone_call", "전화 걸기", "needs_approval")],
      cards: [
        {
          type: "approval",
          approvalId: "fx-ap-call",
          title: "연세바른치과에 전화할까요?",
          // title/detail stay masked (history, logs); the full number travels only in `call`, for the owner's card
          detail: "02-***-1234로 전화해서 이렇게 전할게요: “안녕하세요, 하늘 님 대신 연락드렸어요. 내일 오후 3시에 진료 예약이 가능한지 여쭤봐도 될까요?”",
          call: {
            target: "연세바른치과",
            number: "02-1234-1234",
            message: "안녕하세요, 하늘 님 대신 연락드렸어요. 내일 오후 3시에 진료 예약이 가능한지 여쭤봐도 될까요?",
          },
          status: "pending",
        },
      ],
    }),
  ];
}
// 11 / 11b: the KakaoTalk room card exactly as msg_read builds it since 0129451 (tools.ts: normalizeKakao → roomOf →
// pickHighlights → cardThread) over the SYNTHETIC fixture room the messenger tests use. Built at run time with bun, so
// it can't drift from the code. Fixture times are fixed (오후 7:12–7:30).
function kakaoRoomCard() {
  const m = (f) => JSON.stringify(path.join(repo, "packages/messengers", f));
  const code = [
    `import { LEFT_MEMBERS, ME_ID, ROOM_CHAT, ROOM_LOGS, ROOM_MEMBERS } from ${m("test/fixtures/kakao-room.ts")};`,
    `import { normalizeKakao } from ${m("src/adapters/kakao-normalize.ts")};`,
    `import { cardThread, pickHighlights, roomOf } from ${m("src/thread.ts")};`,
    `const names = new Map([...ROOM_MEMBERS, ...LEFT_MEMBERS].map((x) => [x.user_id, x.nickname]));`,
    `const msgs = normalizeKakao(ROOM_LOGS, { myUserId: ME_ID, names });`,
    `const room = roomOf({ listName: ROOM_CHAT.display_name, listKind: "group", unread: 7, info: { kind: "open", memberCount: 6 } }, msgs);`,
    `const { thread, highlights } = cardThread(msgs, pickHighlights(msgs, { myNames: ["지우"] }));`,
    `console.log(JSON.stringify({ type: "messenger", provider: "kakaotalk", action: "read", target: room.title, messages: [], room, thread, highlights, total: msgs.length }));`,
  ].join("\n");
  const r = spawnSync(process.env.BUN || "bun", ["-e", code], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`kakao room card: ${r.stderr.slice(-600)}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}
function messengerThread(threadId) {
  mid = 0;
  const card = kakaoRoomCard();
  const at = Math.max(...card.thread.map((x) => x.at || 0)) + 2 * 60_000;
  return [
    { ...msg(threadId, "user", "카톡 안 읽은 대화도 정리해 줘"), createdAt: at },
    {
      ...msg(threadId, "assistant", "회비 3만원을 오늘까지 입금해 달라는 부탁이 있었고, 토요일 리허설은 11월 15일 오후 2시 대학로 연습실이에요.", {
        tools: [{ ...tool("msg_read", `카카오톡 '${card.room.title}' 읽기`, "done", `메시지 ${card.total}개`, 2), startedAt: at + 1000, endedAt: at + 3000 }],
        cards: [card],
      }),
      createdAt: at + 4000,
    },
  ];
}
const ARTIFACTS = [
  {
    id: "fx-art-doc",
    threadId: null,
    title: "11월 12일 주간회의 회의록",
    kind: "document",
    content:
      "# 11월 12일 주간회의\n\n참석: 하늘, 지현, 민호, 다은 · 42분\n\n## 정한 것\n- 출시일은 **12월 2일**로 확정\n- 랜딩 페이지는 시안 B\n\n## 할 일\n- [ ] 하늘: 랜딩 문구 (금)\n- [ ] 지현: 앱 스토어 스크린샷 5장\n\n## 메모\n지난주 베타 피드백 중 \"알림이 너무 많다\"는 의견이 6건 있었어요. 알림 묶음 보내기를 다음 스프린트에 넣기로 했어요.",
    createdAt: T0,
    updatedAt: T0 + 3600_000,
  },
  {
    id: "fx-art-dash",
    threadId: null,
    title: "11월 지출 정리",
    kind: "dashboard",
    content: JSON.stringify({
      widgets: [
        { type: "stat", label: "이번 달 지출", value: "1,284,000원", delta: "지난달보다 8% 적어요" },
        { type: "bars", label: "주별 지출", points: [{ x: "1주", y: 312 }, { x: "2주", y: 428 }, { x: "3주", y: 276 }, { x: "4주", y: 268 }] },
        { type: "list", label: "많이 쓴 곳", items: ["배달의민족 182,000원", "쿠팡 164,500원", "카카오T 88,300원"] },
      ],
    }),
    createdAt: T0 - 86_400_000,
    updatedAt: T0 - 80_000_000,
  },
  {
    id: "fx-art-check",
    threadId: null,
    title: "이사 준비 체크리스트",
    kind: "checklist",
    content: "# 이사 준비\n\n- [x] 이사 업체 견적 3곳\n- [x] 전입신고 날짜 정하기\n- [ ] 인터넷 이전 신청\n- [ ] 도시가스 전출 신청\n- [ ] 우편물 주소 변경",
    createdAt: T0 - 3 * 86_400_000,
    updatedAt: T0 - 2 * 86_400_000,
  },
];
const extraThreads = (now) => [
  { id: "fx-th-call", kind: "call", title: "연세바른치과께 전화", subtitle: "깽이의 외부 통화", icon: "phone-out", archived: false, unread: true, createdAt: now - 600_000, updatedAt: now - 120_000 },
  { id: "fx-th-meet", kind: "call", title: "회의 참여", subtitle: "깽이의 회의 참여", icon: "people", archived: false, unread: false, createdAt: now - 7200_000, updatedAt: now - 3600_000 },
  { id: "fx-th-task", kind: "task", title: "이사 준비", subtitle: "체크리스트를 만들었어요", icon: "sparkles", archived: false, unread: false, createdAt: now - 86_400_000, updatedAt: now - 80_000_000 },
  { id: "fx-th-sched", kind: "schedule", title: "아침 브리핑", subtitle: "매일 오전 7:00", icon: "clock", archived: false, unread: false, createdAt: now - 2 * 86_400_000, updatedAt: now - 86_400_000 },
];

// ── in-page: never a real device ──
const NO_DEVICES = () => {
  const fakeMic = async () => {
    window.__micCtx ??= new AudioContext();
    return window.__micCtx.createMediaStreamDestination().stream;
  };
  try {
    MediaDevices.prototype.getUserMedia = fakeMic;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = fakeMic;
  } catch {}
  class ScriptedRecognition {
    constructor() {
      Object.assign(this, { lang: "", continuous: false, interimResults: false, maxAlternatives: 1, onresult: null, onerror: null, onend: null });
    }
    start() {}
    stop() {
      setTimeout(() => this.onend?.(), 0);
    }
    abort() {
      this.stop();
    }
  }
  window.SpeechRecognition = ScriptedRecognition;
  window.webkitSpeechRecognition = ScriptedRecognition;
};

// ── the pass ──
const index = [];
const detections = [];
/** stable file numbers (a partial CAP_ONLY re-run writes the same names as a full run) */
const ORDER = "onboarding signup-step1 signup-step2 login-sheet chat-welcome chat-welcome-briefing chat-empty-thread chat-cards-latest-phone-approval chat-weather-card chat-results-card chat-messenger-card chat-credential-card chat-meet-approved chat-meeting-events chat-meeting-summary-artifact chat-schedule-card composer-focused-typed call-overlay call-minimised-island drawer drawer-search explore explore-scrolled predelegate-sheet archive-artifacts artifact-sheet-document artifact-sheet-dashboard archive-media-empty profile profile-scrolled profile-bottom tickets-sheet privacy-sheet agent-settings agent-settings-scrolled account phone-sheet connections connections-scrolled connect-sheet-kakaotalk schedules schedule-sheet payment friends invite-sheet settings-notifications settings-privacy settings-display vault vault-access-log".split(" ");
// shots added later keep the numbering of everything after them: "11b" sorts right after 11
const BETWEEN = { "chat-messenger-open": "11b", "chat-meet-pending": "15a", "chat-meet-live": "15b", "chat-meet-ended": "15c" };
// meeting B (picked 2026-11-12, in 46588b9): the synthetic join thread and MeetView phases chat.spec uses, imported, not
// copied. Older HEADs don't have the file: those runs skip 15a–15c and keep 13–15 as before.
const MEET_FX = await import(pathToFileURL(path.join(appDir, "qa/fixtures/meet-thread.mjs")).href).catch(() => null);
async function runPass(engine, theme, ctx) {
  const cdp = DETECT && engine === "chromium" ? [`--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1"] : [];
  const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", ...cdp] });
  const ctxOpts = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: "no-preference", locale: "ko-KR", timezoneId: "Asia/Seoul" };
  let n = 0;
  const tag = `${engine}-${theme}`;
  const errors = [];
  const shot = async (page, name, feature) => {
    await sleep(450);
    const k = ORDER.indexOf(name);
    const file = `${tag}-${BETWEEN[name] ?? String(k >= 0 ? k + 1 : 90 + ++n).padStart(2, "0")}-${name}.jpg`;
    await page.screenshot({ path: path.join(outDir, file), type: "jpeg", quality: 84 });
    index.push({ engine, theme, feature, name, file });
    console.log(`  ${file}`);
    if (cdp.length) {
      let out = "";
      try {
        out = execFileSync(DETECT, ["detect", "--cdp", String(CDP_PORT), "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
      } catch (e) {
        out = e.stdout || "";
        if (!out) detections.push({ file, feature, error: String(e.stderr || e.message).split("\n")[0] });
      }
      if (out) {
        try {
          detections.push({ file, feature, theme, findings: JSON.parse(out) });
        } catch {
          detections.push({ file, feature, error: out.slice(0, 200) });
        }
      }
    }
  };
  const guard = async (label, page, fn) => {
    try {
      await fn();
    } catch (e) {
      errors.push(`${label}: ${e.message.split("\n")[0]}`);
      console.log(`  ! ${label}: ${e.message.split("\n")[0]}`);
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(400);
    }
  };

  // 1. onboarding (no token)
  if (want("onboarding")) {
    const c0 = await browser.newContext(ctxOpts);
    await c0.addInitScript(NO_DEVICES);
    const p0 = await c0.newPage();
    await p0.goto(BASE + "/");
    await p0.waitForSelector(".onb", { timeout: 20_000 });
    await sleep(1200);
    await shot(p0, "onboarding", "onboarding");
    await guard("onboarding sheet", p0, async () => {
      await p0.locator(".onb-actions button").first().click();
      await p0.waitForSelector(".onb-form", { timeout: 6000 });
      await sleep(700);
      await shot(p0, "signup-step1", "onboarding");
      const inputs = p0.locator(".onb-form input");
      await inputs.nth(0).fill(`cap${rand()}`);
      await inputs.nth(1).fill(PASSWORD);
      if ((await inputs.count()) > 2) await inputs.nth(2).fill(PASSWORD);
      await p0.locator(".sheet-root button", { hasText: "다음" }).first().click();
      await sleep(900);
      await shot(p0, "signup-step2", "onboarding");
    });
    await guard("login sheet", p0, async () => {
      // a fresh welcome (no token, so a reload starts over): since onboarding B (22854a7) Escape on step 2 no longer
      // leaves the sign-up sheet, and the sheet's own foot links reuse the .onb-login class
      await p0.reload();
      await p0.locator(".onb-actions .onb-login").waitFor({ timeout: 20_000 });
      await sleep(1200);
      await p0.locator(".onb-actions .onb-login").click();
      await sleep(800);
      await shot(p0, "login-sheet", "onboarding");
    });
    await c0.close();
  }

  // the signed-in context, with fixtures switchable per step
  const context = await browser.newContext(ctxOpts);
  await context.addInitScript(NO_DEVICES);
  await context.addInitScript((t) => localStorage.setItem("pickle.token", t), ctx.a.token);
  const mode = { msgs: "real", threads: "real", archive: "fixture", hold: false, meetItems: [], meet: null };
  const mainId = ctx.a.session.mainThreadId;
  await context.route("**/api/tts**", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "tts off in capture" } }) }));
  await context.route(/\/api\/threads\/[^/]+\/messages(\?.*)?$/, async (r) => {
    if (r.request().method() === "POST" && mode.hold) return; // held: the page's reload cancels it (06 only)
    if (r.request().method() !== "GET" || mode.msgs === "real") return r.fallback();
    const items =
      mode.msgs === "empty" ? [] : mode.msgs === "messenger" ? messengerThread(mainId) : mode.msgs === "meet" ? mode.meetItems : cardThread(mainId, ctx.agentName);
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(items) });
  });
  // GET /api/threads/:id/meet?approval= (MeetFollow): the meeting a join card started, only while a 15a–15c step sets a
  // phase; otherwise the throwaway server answers (no meeting → the plain receipt). Leave is never pressed here.
  await context.route(/\/api\/threads\/[^/]+\/meet(\?.*)?$/, async (r) => {
    if (r.request().method() !== "GET" || !MEET_FX || mode.meet === null) return r.fallback();
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meeting: MEET_FX.meetView(mode.meet, ctx.agentName) }) });
  });
  await context.route(/\/api\/threads(\?.*)?$/, async (r) => {
    if (r.request().method() !== "GET" || mode.threads === "real") return r.fallback();
    const res = await r.fetch();
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.items;
    const merged = [...list, ...extraThreads(Date.now())];
    return r.fulfill({ response: res, body: JSON.stringify(Array.isArray(body) ? merged : { ...body, items: merged }) });
  });
  await context.route(/\/api\/artifacts(\/[^/?]+)?(\?.*)?$/, async (r) => {
    if (r.request().method() !== "GET" || mode.archive !== "fixture") return r.fallback();
    const m = r.request().url().match(/\/api\/artifacts\/([^/?]+)/);
    if (m) {
      const a = ARTIFACTS.find((x) => x.id === decodeURIComponent(m[1]));
      return a ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(a) }) : r.fallback();
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ARTIFACTS) });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const back = async () => {
    await page.locator('.tb-circle[aria-label="뒤로"]').click();
    await sleep(800);
  };
  const closeSheet = async () => {
    const close = page.locator(".sheet-root .sheet-close");
    if (await close.count()) await close.first().click();
    else await page.keyboard.press("Escape");
    await page.locator(".sheet-root").waitFor({ state: "detached", timeout: 6000 }).catch(() => {});
    await sleep(300);
  };
  const tab = async (id) => {
    await page.click(`#tab-${id}`);
    await sleep(900);
  };
  const reveal = async (loc) => {
    await loc.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await sleep(400);
  };
  /** scroll the screen that is actually on top (hidden tab layers keep their own .screen-scroll) */
  const scrollActive = async (dy) => {
    await page.evaluate((d) => document.elementFromPoint(195, 520)?.closest(".screen-scroll, [data-qa-scroller]")?.scrollBy(0, d), dy);
    await sleep(200);
  };
  const scrollTop = async () => {
    await page.evaluate(() => document.querySelectorAll(".screen-scroll, [data-qa-scroller]").forEach((el) => el.scrollTo(0, 0)));
    await sleep(300);
  };
  const profileRow = async (label, file, feature) => {
    await tab("profile");
    await scrollTop();
    const r = page.locator(".screen-scroll .list-row", { hasText: label }).first();
    await reveal(r);
    await r.click();
    await sleep(1000);
    await shot(page, file, feature);
  };

  await page.goto(BASE + "/");
  await page.waitForSelector("#tab-explore", { timeout: 20_000 });
  await sleep(1500);

  // 2. chat: welcome (real) → empty → cards (fixture)
  if (want("chat")) {
    await shot(page, "chat-welcome", "chat");
    // 06 = the welcome card right after its first pick ("오늘 날씨 알려줘"). The welcome already sits at the list's
    // end, so a scroll alone captured 05 again. The POST is held in the browser and never reaches the server (no
    // LLM call, the seeded thread stays untouched); the reload below cancels it.
    await guard("chat-welcome-briefing", page, async () => {
      mode.hold = true;
      // empty-thread A: the rows are the buttons (button.brief-row); before it, the quick-reply chips under them
      await page.locator(".ccard-briefing button.brief-row, .ccard-briefing .quick-replies button").first().click();
      await sleep(2600);
      await shot(page, "chat-welcome-briefing", "empty");
    });
    mode.msgs = "empty";
    await page.reload();
    mode.hold = false;
    await page.waitForSelector("#tab-explore", { timeout: 20_000 });
    await sleep(1600);
    await shot(page, "chat-empty-thread", "empty");
    mode.msgs = "cards";
    await page.reload();
    await page.waitForSelector(".ccard-approval", { timeout: 20_000 }).catch(() => errors.push("cards fixture did not render"));
    await sleep(1500);
    await shot(page, "chat-cards-latest-phone-approval", "phone");
    for (const [sel, name, feature] of [
      [".ccard-weather", "chat-weather-card", "chat"],
      [".ccard-results", "chat-results-card", "chat"],
      ['[class*="ccard-cred"]', "chat-credential-card", "chat"],
      ['.ccard-approval[data-status="approved"]', "chat-meet-approved", "meet"],
      [".msg-event", "chat-meeting-events", "meet"],
      ['[class*="ccard-artifact"]', "chat-meeting-summary-artifact", "meet"],
      ['.ccard-sched', "chat-schedule-card", "schedules"],
    ])
      await guard(name, page, async () => {
        const el = page.locator(sel).first();
        await el.waitFor({ timeout: 4000 });
        await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
        await sleep(600);
        await shot(page, name, feature);
      });
    // 11 collapsed, 11b expanded: the KakaoTalk room thread (its own fixture), then back to the card thread
    await guard("chat-messenger-card", page, async () => {
      mode.msgs = "messenger";
      await page.reload();
      await page.waitForSelector("#tab-explore", { timeout: 20_000 });
      const card = page.locator(".mt-card").first();
      await card.waitFor({ timeout: 8000 });
      await sleep(1200);
      await card.evaluate((e) => e.scrollIntoView({ block: "center" }));
      await sleep(600);
      await shot(page, "chat-messenger-card", "connections");
      await page.locator(".mt-card .mt-toggle").first().click();
      await sleep(1200);
      // my bubble "저도 갈게요!" rests at y ≈ 330 (the frame draft-a's messenger-open state draws)
      await page.locator(".mt-card").getByText("저도 갈게요!").first().evaluate((el) => {
        let sc = el.parentElement;
        while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
        if (sc) sc.scrollTop += el.getBoundingClientRect().top - 330;
      });
      await sleep(700);
      await shot(page, "chat-messenger-open", "connections");
    });
    // 15a–15c: meeting B — the join card before approval, in the meeting (회의에서 내보내기), ended with the summary and
    // the minutes row. Each is the thread's last message, so the list's resting place (its end) is the frame.
    if (MEET_FX) {
      const approvedAt = Date.now() - 48 * 60_000;
      for (const [name, status, phase, summary] of [
        ["chat-meet-pending", "pending", null, false],
        ["chat-meet-live", "approved", "live", false],
        ["chat-meet-ended", "approved", "ended", true],
      ])
        await guard(name, page, async () => {
          mode.msgs = "meet";
          mode.meetItems = MEET_FX.meetThread(mainId, ctx.agentName, { status, decidedAt: status === "approved" ? approvedAt : undefined, summary });
          mode.meet = phase;
          await page.reload();
          await page.locator(`.ccard-approval[data-approval-id="${MEET_FX.MEET_APPROVAL}"]`).waitFor({ timeout: 20_000 });
          if (phase) await page.locator(".meet-follow").first().waitFor({ timeout: 8000 });
          await sleep(1600);
          await shot(page, name, "meet");
        });
      mode.meet = null;
    }
    mode.msgs = "cards";
    await page.reload();
    await page.waitForSelector(".ccard-approval", { timeout: 20_000 }).catch(() => errors.push("cards fixture did not come back"));
    await sleep(1200);
    await guard("composer focus", page, async () => {
      await page.locator("textarea.composer-field").click();
      await page.locator("textarea.composer-field").fill("내일 오전에 비 오면 우산 챙기라고 알려 줘");
      await sleep(700);
      await shot(page, "composer-focused-typed", "chat");
      await page.locator("textarea.composer-field").fill("");
      await page.locator("textarea.composer-field").blur();
    });
    await guard("call overlay", page, async () => {
      await page.locator(".composer-call").click();
      await page.waitForSelector(".call-card", { timeout: 8000 });
      await sleep(1800);
      await shot(page, "call-overlay", "call");
      const min = page.locator(".call-min");
      if (await min.count()) {
        await min.click();
        await sleep(1000);
        await shot(page, "call-minimised-island", "call");
      }
      if (!(await page.locator(".call-card").isVisible().catch(() => false))) {
        await page.locator(".island").first().click().catch(() => {});
        await sleep(900);
      }
      await page.locator(".call-btn[data-end]").first().click().catch(() => {});
      await sleep(1200);
    });
    mode.msgs = "real";
  }

  // 3. drawer (extra fixture threads)
  if (want("drawer")) {
    mode.threads = "fixture";
    await page.reload();
    await page.waitForSelector("#tab-explore", { timeout: 20_000 });
    await sleep(1400);
    await guard("drawer", page, async () => {
      await page.locator('.tb-circle[aria-label="메뉴"]').click();
      await page.waitForSelector(".dw", { timeout: 6000 });
      await sleep(900);
      await shot(page, "drawer", "drawer");
      await page.locator(".dw-search").click();
      await sleep(500);
      await page.keyboard.type("ㅎㅇ");
      await sleep(700);
      await shot(page, "drawer-search", "drawer");
      await page.keyboard.press("Escape");
      await sleep(400);
      await page.keyboard.press("Escape");
      await sleep(900);
    });
    mode.threads = "real";
  }

  // 4. explore
  if (want("explore")) {
    await guard("explore", page, async () => {
      await tab("explore");
      await page.waitForSelector(".tpl-row", { timeout: 15_000 });
      await sleep(700);
      await shot(page, "explore", "explore");
      await scrollActive(700);
      await sleep(600);
      await shot(page, "explore-scrolled", "explore");
      await scrollTop();
      const row = page.locator(".tpl-row").first();
      await reveal(row);
      await row.click();
      await page.waitForSelector(".sheet-root", { timeout: 6000 });
      await sleep(900);
      await shot(page, "predelegate-sheet", "explore");
      await closeSheet();
    });
  }

  // 5. archive (fixture artifacts) + media
  if (want("archive")) {
    await guard("archive", page, async () => {
      await tab("archive");
      await sleep(900);
      await shot(page, "archive-artifacts", "archive");
      const card = page.locator(".screen-scroll .arc-card").first();
      await card.click();
      await page.waitForSelector(".sheet-root", { timeout: 6000 });
      await sleep(1000);
      await shot(page, "artifact-sheet-document", "archive");
      await closeSheet();
      const dash = page.locator(".screen-scroll .arc-card").nth(1);
      if (await dash.count()) {
        await dash.click();
        await page.waitForSelector(".sheet-root", { timeout: 6000 });
        await sleep(1400);
        await shot(page, "artifact-sheet-dashboard", "archive");
        await closeSheet();
      }
      const media = page.locator('[role="radio"], [role="tab"]', { hasText: "미디어" }).first();
      await media.click();
      await sleep(900);
      await shot(page, "archive-media-empty", "archive");
      await page.locator('[role="radio"], [role="tab"]', { hasText: "아티팩트" }).first().click();
      await sleep(500);
    });
  }

  // 6. profile + its details
  if (want("profile")) {
    await guard("profile", page, async () => {
      await tab("profile");
      await scrollTop();
      await page.waitForSelector(".profile-quota", { timeout: 10_000 });
      await sleep(900);
      await shot(page, "profile", "profile");
      await scrollActive(640);
      await sleep(600);
      await shot(page, "profile-scrolled", "profile");
      await scrollActive(900);
      await sleep(600);
      await shot(page, "profile-bottom", "profile");
      await scrollTop();
      await page.click("[data-tickets]");
      await page.waitForSelector(".ticket-body", { timeout: 6000 });
      await sleep(800);
      await shot(page, "tickets-sheet", "profile");
      await closeSheet();
      const priv = page.locator(".profile-privacy");
      await reveal(priv);
      await priv.click();
      await page.waitForSelector(".privacy-body", { timeout: 6000 });
      await sleep(800);
      await shot(page, "privacy-sheet", "settings");
      await closeSheet();
    });
    await guard("agent", page, async () => {
      await tab("profile");
      await scrollTop();
      const el = page.locator(".screen-scroll .profile-agent").first();
      await reveal(el);
      await el.click();
      await sleep(1100);
      await shot(page, "agent-settings", "profile");
      await scrollActive(700);
      await sleep(500);
      await shot(page, "agent-settings-scrolled", "profile");
      await back();
    });
    await guard("account", page, async () => {
      await profileRow("내 계정", "account", "profile");
      await back();
    });
    await guard("phone sheet", page, async () => {
      await tab("profile");
      await scrollTop();
      const row = page.locator(".screen-scroll .profile-phone-row").first();
      await reveal(row);
      await row.click();
      await page.waitForSelector(".sheet-root", { timeout: 6000 });
      await sleep(900);
      await shot(page, "phone-sheet", "phone");
      await closeSheet();
    });
  }
  if (want("connections"))
    await guard("connections", page, async () => {
      await tab("profile");
      await scrollTop();
      const card = page.locator(".screen-scroll .profile-conns").first();
      await reveal(card);
      await card.click();
      await page.waitForSelector(".conn-row-kakaotalk", { timeout: 10_000 });
      await sleep(800);
      await shot(page, "connections", "connections");
      await scrollActive(700);
      await sleep(500);
      await shot(page, "connections-scrolled", "connections");
      await page.click(".conn-row-kakaotalk");
      await page.waitForSelector(".conn-sheet", { timeout: 6000 });
      await sleep(900);
      await shot(page, "connect-sheet-kakaotalk", "connections");
      await closeSheet();
      await back();
    });
  if (want("schedules"))
    await guard("schedules", page, async () => {
      await profileRow("예약된 일", "schedules", "schedules");
      const row = page.locator(".sched-row .sched-main").first();
      if (await row.count()) {
        await row.click();
        await page.waitForSelector(".sheet-root", { timeout: 6000 });
        await sleep(900);
        await shot(page, "schedule-sheet", "schedules");
        await closeSheet();
      }
      await back();
    });
  if (want("payment"))
    await guard("payment", page, async () => {
      await profileRow("연결된 결제 수단", "payment", "payment");
      await back();
    });
  if (want("friends"))
    await guard("friends", page, async () => {
      await profileRow("친구", "friends", "friends");
      await page.locator('button[aria-label="친구 초대"]').click();
      await page.waitForSelector("[data-invite-url]", { timeout: 8000 });
      await sleep(800);
      await shot(page, "invite-sheet", "friends");
      await closeSheet();
      await back();
    });
  if (want("settings")) {
    for (const [label, file] of [
      ["알림 설정", "settings-notifications"],
      ["정보 공개 범위 설정", "settings-privacy"],
      ["화면 및 디자인", "settings-display"],
      ["저장된 로그인", "vault"],
      ["접근 기록", "vault-access-log"],
    ])
      await guard(file, page, async () => {
        await profileRow(label, file, file.startsWith("vault") ? "settings" : "settings");
        await back();
      });
  }
  await context.close();
  await browser.close();
  return errors;
}

let server, preview;
const allErrors = {};
try {
  server = await startServer();
  preview = await startPreview();
  const agentName = "깽이";
  const a = await signup(`cap${rand()}a`, "하늘", agentName);
  const b = await signup(`cap${rand()}b`, "진우", "콩이");
  // pin the avatars: the default hue hashes the random user id, so every run drew a different 깽이. Hue 96 is the
  // green 깽이 the drafts' kit uses (?hue default), so 현재 and the drafts show the same agent.
  for (const [u, hue] of [[a, 96], [b, 28]]) {
    const r = await api("PATCH", "/api/agent", { avatar: { hue, shape: "blob", eyes: "dot" } }, u.token);
    if (r.status !== 200) throw new Error(`avatar pin: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const inv = await api("POST", "/api/invites", {}, a.token);
  const tok = inv.body?.token ?? String(inv.body?.url ?? "").split("/i/")[1];
  if (tok) await api("POST", `/api/invites/${encodeURIComponent(tok)}/accept`, {}, b.token);
  for (const s of [
    { title: "모닝콜", prompt: "7시 30분에 전화로 깨워 줘", rule: "daily@07:30" },
    { title: "출석체크", prompt: "평일 9시에 출석체크 알려 줘", rule: "weekly@1,2,3,4,5@09:00" },
    { title: "저녁 브리핑", prompt: "내일 일정과 날씨를 정리해 줘", rule: "daily@21:30", enabled: false },
  ])
    await api("POST", "/api/schedules", s, a.token);
  const ctx = { a, b, agentName };
  for (const engine of ENGINES)
    for (const theme of THEMES) {
      console.log(`\n── ${engine} · ${theme}`);
      allErrors[`${engine}-${theme}`] = await runPass(engine, theme, ctx);
    }
} finally {
  if (DETECT) fs.writeFileSync(path.join(outDir, "detect.json"), JSON.stringify(detections, null, 2));
  // merge with an earlier run's index (a partial re-run replaces only the files it wrote)
  let prev = { shots: [], errors: {} };
  try {
    prev = JSON.parse(fs.readFileSync(path.join(outDir, "index.json"), "utf8"));
  } catch {}
  const mine = new Set(index.map((x) => x.file));
  const shots = [...(prev.shots || []).filter((x) => !mine.has(x.file) && fs.existsSync(path.join(outDir, x.file))), ...index].sort((a, b) => a.file.localeCompare(b.file));
  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify({ at: new Date().toISOString(), viewport: "390x844@2x", shots, errors: { ...(prev.errors || {}), ...allErrors } }, null, 2));
  for (const p of procs) killGroup(p);
  if (server?.dataDir && process.env.CAP_KEEP !== "1") fs.rmSync(server.dataDir, { recursive: true, force: true });
}
console.log(`\n${index.length} shots → ${path.relative(repo, outDir)} · errors: ${JSON.stringify(allErrors)}`);
