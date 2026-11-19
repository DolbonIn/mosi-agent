/**
 * SYNTHETIC KakaoTalk open-chat room — the shape of the room in the user's bug report (an unnamed group of 5 whose
 * list title is the joined, profile-tagged nicknames; a host-hidden feed leaking as JSON; raw 18-digit author ids),
 * with invented names, ids and text. Never real data. Used by the unit tests and by the mobile QA server.
 *
 * Times: 2026-11-12 19:12–19:30 KST.
 */
import type { KakaoChat, KakaoMember, KakaoMessage } from "agent-messenger/kakaotalk";

export const ROOM_CHAT_ID = "9000000000000001";
export const ME_ID = "7000000000000001"; // the logged-in user (safe integer, like a normal account id)

// open-chat profile ids: 18 digits, beyond 2^53 — they arrive as BSON Long objects
const big = (digits: string) => {
  const v = BigInt(digits);
  return { low: Number(v & 0xffffffffn) | 0, high: Number((v >> 32n) & 0xffffffffn) | 0, unsigned: false };
};
export const IDS = {
  doyun: "840000000000000101",
  happy: "840000000000000102",
  chorong: "840000000000000103",
  moka: "840000000000000104",
  moon: "840000000000000105", // leaves during the read; only resolvable via getMembersByIds
  dawn: "840000000000000106", // a quiet member who never writes
};
export const NICK = {
  doyun: "김도윤/남/68년생/사진",
  happy: "해피/남/5*/연극",
  chorong: "초롱별/여/51/무용",
  moka: "BTR-moka",
  moon: "달빛 고양이",
  dawn: "새벽별",
  me: "지우",
};

export const ROOM_CHAT: KakaoChat = {
  chat_id: ROOM_CHAT_ID,
  type: 13, // open group
  display_name: [NICK.moon, NICK.happy, NICK.chorong, NICK.moka, NICK.doyun].join(", "),
  title: null,
  active_members: 6,
  unread_count: 7,
  last_message: null,
};

const member = (user_id: string, nickname: string): KakaoMember => ({
  user_id,
  nickname,
  profile_image_url: null,
  full_profile_image_url: null,
  original_profile_image_url: null,
  status_message: null,
  country_iso: null,
  user_type: 1000,
  open_token: null,
  open_profile_link_id: null,
  open_permission: 2,
});

/** GETMEM snapshot: everyone still in the room (달빛 고양이 left; the list title above is stale, as KakaoTalk's is). */
export const ROOM_MEMBERS: KakaoMember[] = [
  member(ME_ID, NICK.me),
  member(IDS.doyun, NICK.doyun),
  member(IDS.happy, NICK.happy),
  member(IDS.chorong, NICK.chorong),
  member(IDS.moka, NICK.moka),
  member(IDS.dawn, NICK.dawn),
];
export const LEFT_MEMBERS: KakaoMember[] = [member(IDS.moon, NICK.moon)];

const T0 = Date.UTC(2026, 10, 12, 10, 12) / 1000; // 19:12 KST, in seconds like LOCO
const at = (min: number, sec = 0) => T0 + min * 60 + sec;
let seq = 0;
const logId = () => `39716353241085194${String(10 + seq++).padStart(2, "0")}`;

type Spec = Partial<KakaoMessage> & { author: string; min: number; sec?: number };
function msg(s: Spec): KakaoMessage {
  const { author, min, sec, ...rest } = s;
  const authorId = author === ME_ID ? Number(ME_ID) : (big(author) as unknown as number);
  return { log_id: logId(), type: 1, author_id: authorId, author_name: null, message: "", attachment: null, sent_at: at(min, sec), ...rest };
}

const LONG =
  "공연 끝나고 뒤풀이는 극장 근처 식당으로 예약해 두었어요. 인원이 아직 확정이 안 돼서 대략 열두 명으로 잡았는데, 못 오시는 분은 금요일까지 꼭 말씀해 주세요. 그리고 의상은 각자 챙겨 오시고 소품은 제가 차로 가져갈게요. 리허설 때 동선 한 번 더 맞춰 보면 좋겠어요. 혹시 주차가 필요하신 분은 따로 알려 주시면 주차권을 미리 받아 둘게요. 길이 막힐 수 있으니 여유 있게 출발하세요!";

export const SPAM_TEXT = "무료 이벤트 참여하세요 http://spam.example/win";
const spam = msg({ author: IDS.moon, min: 5, sec: 30, message: SPAM_TEXT });
const rehearsal = msg({ author: IDS.doyun, min: 3, message: "토요일 리허설은 11월 15일 오후 2시, 대학로 연습실에서 해요" });

/** Raw logs in send order (the SDK sorts by sent_at; the normaliser does too). */
export const ROOM_LOGS: KakaoMessage[] = [
  msg({ author: IDS.moka, min: 0, type: 0, message: `{"feedType":4,"members":[{"userId":${IDS.moka},"nickName":"${NICK.moka}"}]}` }),
  msg({ author: IDS.doyun, min: 1, message: "다들 이번 주 공연 준비 잘 되고 있죠?" }),
  msg({ author: IDS.chorong, min: 1, sec: 20, message: "ㅋㅋㅋㅋ" }),
  msg({ author: IDS.happy, min: 2, type: 12, message: "", attachment: { path: "4412.emot_001.png", type: "image/png" } }),
  rehearsal,
  msg({ author: IDS.chorong, min: 4, type: 2, message: "사진", attachment: { w: 1280, h: 960, k: "x", s: 1, mt: "image/jpeg", cs: "x" } }),
  spam,
  // the host hides the spam: this feed must never render, and the spam must disappear with it
  msg({ author: IDS.doyun, min: 6, type: 0, message: `{"feedType":25,"logId":${spam.log_id},"hidden":true,"targetRevision":1}` }),
  msg({
    author: IDS.happy,
    min: 8,
    type: 26,
    message: "저 그날 3시쯤 도착할 것 같아요",
    attachment: { attach_only: false, attach_type: 0, src_logId: rehearsal.log_id, src_userId: IDS.doyun, src_message: rehearsal.message, src_type: 1, src_mentions: [], mentions: [] },
  }),
  msg({ author: IDS.moka, min: 9, message: "티켓 예매 링크예요 https://tickets.example.com/show/123" }),
  msg({ author: ME_ID, min: 10, message: "저도 갈게요!" }),
  msg({ author: IDS.chorong, min: 12, message: LONG }),
  msg({ author: IDS.moon, min: 13, type: 0, message: `{"feedType":2,"member":{"userId":${IDS.moon},"nickName":"${NICK.moon}"},"kicked":false}` }),
  msg({
    author: IDS.doyun,
    min: 16,
    message: "@지우 회비 3만원 오늘까지 입금 부탁드려요",
    mentions: [{ user_id: ME_ID, at: [1], len: 2 }],
  }),
  msg({ author: IDS.happy, min: 17, message: "넵" }),
  msg({ author: IDS.chorong, min: 18, type: 27, message: "사진", attachment: { kl: ["a", "b", "c"], wl: [1, 1, 1], hl: [1, 1, 1], mtl: [], sl: [], csl: [] } }),
  msg({ author: IDS.moka, min: 18, sec: 20, type: 18, message: "파일", attachment: { name: "공연_큐시트.pdf", s: 120000, k: "x", mt: "application/pdf", cs: "x" } }),
  msg({ author: IDS.happy, min: 18, sec: 40, type: 1 + 16384, message: "" }),
];

/** ids in the fixture that must never appear in anything the user or the LLM sees */
export const PRIVATE_IDS = [ME_ID, ...Object.values(IDS), "3971635324108519"];
