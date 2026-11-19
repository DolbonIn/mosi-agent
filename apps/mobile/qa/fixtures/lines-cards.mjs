// The main thread the lines sweep reads for the chat's cards (lines.spec "cards"). Route interception serves it, so no
// model turn runs. It holds:
// - the welcome briefing (ListRows)
// - chat.spec's picks thread (fixtures/picks-thread.mjs): weather, results, a KakaoTalk room, the credential request
//   (its 보관 기간 sheet is ListRows) and a schedule
// - two approvals (a call, a meeting) and a document artifact
// - a '전부' answer on three html cards that the agent's own code draws (fixtures/lines-rows-cards.ts): their title
//   '(2/3)' and summary '카드 2/3 · 앞 카드에서 이어져요'
// - a long reply in markdown (fixtures/glue-reply.mjs › GLUE_REPLY, the newest message): the spots where a browser
//   breaks inside a word under keep-all (ui/Text.tsx › glued)
// Synthetic people only: 하늘 is the owner; the clinics, the room's members and the numbers are made up or masked.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { picksThread } from "./picks-thread.mjs";
import { GLUE_REPLY } from "./glue-reply.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");

/** the '전부' cards, drawn now by explore.ts (bun runs the TypeScript): { rows, cards: [{ title, html, shown, bytes }] } */
export function rowsCards() {
  const r = spawnSync("bun", [path.join(here, "lines-rows-cards.ts")], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`lines-rows-cards.ts: ${r.stderr || r.error}`);
  return JSON.parse(r.stdout);
}

/** { items: the thread's messages (oldest first), artifacts: id → artifact for GET /api/artifacts/:id } */
export function linesCardsThread(threadId, agent, drawn) {
  const now = Date.now();
  let n = 0;
  const msg = (at, role, text, extra = {}) => ({ id: `lc-m${++n}`, threadId, role, text, cards: [], tools: [], attachments: [], createdAt: at, ...extra });
  const tool = (name, title, state, at) => ({ id: `lc-t${++n}`, name, title, state, startedAt: at, endedAt: state === "done" ? at + 4000 : undefined });
  const T = now - 80 * 60_000;
  const at = (min) => T + min * 60_000;
  const artifacts = {};
  const html = drawn.cards.map((c, i) => {
    const id = `lc-html-${i + 1}`;
    artifacts[id] = { id, threadId, title: c.title, kind: "html", content: c.html, createdAt: at(30), updatedAt: at(30) };
    return { type: "artifact", artifactId: id, title: c.title, kind: "html", preview: `${c.shown}곳` };
  });
  artifacts["lc-doc"] = { id: "lc-doc", threadId, title: "이번 주 할 일 정리", kind: "document", content: "## 이번 주\n\n- 월세 이체 (금요일까지)\n- 주말 연극 리허설 (토 오후 2시)", createdAt: at(20), updatedAt: at(20) };
  const items = [
    msg(now - 5 * 3600_000, "assistant", `안녕하세요, 하늘 님. 저는 ${agent}예요.\n궁금한 걸 묻거나 귀찮은 일을 맡겨 주세요.`, {
      cards: [
        {
          type: "briefing",
          title: "이런 일을 맡겨 보세요",
          items: [
            { icon: "sun", text: "오늘 날씨와 미세먼지를 알려 드려요", action: { label: "오늘 날씨 알려 줘", send: "오늘 날씨 알려 줘" } },
            { icon: "doc", text: "지금 신청할 수 있는 정부 지원사업을 찾아 드려요", action: { label: "지원사업 찾아줘", send: "내가 지금 신청할 수 있는 정부 지원사업 찾아줘" } },
            { icon: "kakao", text: "카카오톡을 연결하면 안 읽은 대화를 정리해 드려요", action: { label: "카카오톡 연결하기", open: "connections" } },
            { icon: "clock", text: "매일 아침 브리핑을 먼저 보내 드려요", action: { label: "모닝 브리핑 예약", send: "매일 아침 7시에 날씨랑 뉴스 브리핑해줘" } },
          ],
        },
      ],
    }),
    ...picksThread(threadId, agent),
    msg(at(0), "user", "가온치과에 내일 3시 예약 되는지 전화해서 물어봐 줘"),
    msg(at(1), "assistant", "", {
      tools: [tool("sys_phone_call", "전화 걸기", "needs_approval", at(1))],
      cards: [
        {
          type: "approval",
          approvalId: "lc-ap-call",
          title: "가온치과에 전화할까요?",
          detail: "02-****-1234로 전화해서 이렇게 전할게요: “안녕하세요, 하늘 님 대신 연락드렸어요. 내일 오후 3시에 진료 예약이 가능한지 여쭤봐도 될까요?”",
          status: "pending",
          call: { target: "가온치과", number: "02-****-1234", message: "안녕하세요, 하늘 님 대신 연락드렸어요. 내일 오후 3시에 진료 예약이 가능한지 여쭤봐도 될까요?" },
        },
      ],
    }),
    msg(at(2), "user", "이 회의에도 들어가 줘 주간 회의 받아 적기"),
    msg(at(3), "assistant", "", {
      tools: [tool("sys_join_meet", "회의 참여", "needs_approval", at(3))],
      cards: [
        {
          type: "approval",
          approvalId: "lc-ap-meet",
          title: "Google Meet 회의(abc-****-hij)에 참여할까요?",
          detail: `${agent}가 이 회의에 참여해 듣고 받아 적어요. 참석자들에게는 AI 비서라고 먼저 알려요.\n목적: 주간 회의 받아 적기`,
          status: "pending",
          meet: { code: "abc-defg-hij" },
        },
      ],
    }),
    msg(at(10), "user", "이번 주 할 일 정리해 줘"),
    msg(at(11), "assistant", "이번 주 할 일을 문서로 정리했어요.", {
      tools: [tool("sys_create_artifact", "문서 만들기", "done", at(11))],
      cards: [{ type: "artifact", artifactId: "lc-doc", title: "이번 주 할 일 정리", kind: "document", preview: "할 일 2개 · 금요일 마감 1개" }],
    }),
    msg(at(28), "user", "일본에서 마운자로 처방하는 곳 전부 찾아줘"),
    msg(at(30), "assistant", `일본에서 마운자로를 처방하는 클리닉을 지역별로 묶었어요.\n\n카드 ${drawn.cards.length}장에 ${drawn.rows}곳을 모두 담았어요.`, {
      tools: [tool("web_search", "웹 찾기", "done", at(28)), tool("web_read", "페이지 읽기", "done", at(29)), tool("sys_create_artifact", "카드 만들기", "done", at(30))],
      cards: html,
    }),
    msg(at(38), "user", "다음 주 도쿄 일정 정리해 줘"),
    msg(at(39), "assistant", GLUE_REPLY),
  ];
  return { items, artifacts };
}
