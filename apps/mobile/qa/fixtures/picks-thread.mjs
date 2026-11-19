// The main thread the chat B / empty-thread A checks read (chat.spec "picks"): one of each record the picks restyled —
// weather (hours into the night, so 0시 draws the moon), results with subtitle + meta, a KakaoTalk room card with my
// own line and unread messages, the credential request (two fields), then a schedule. Served by route interception,
// so no LLM call. Synthetic people only (하늘 is the owner; the room's members are made up).

export function picksThread(threadId, agent) {
  const T = Date.now() - 3 * 3600_000;
  let n = 0;
  const msg = (role, text, extra = {}) => ({ id: `pk-m${++n}`, threadId, role, text, cards: [], tools: [], attachments: [], createdAt: T + n * 60_000, ...extra });
  // steps that took 1 min 33 s together (the folded head should read "2단계 · 1분 33초" once agentVocab uses durationKo)
  const tool = (name, title, state, summary, start, ms) => ({ id: `pk-t${++n}`, name, title, state, summary, startedAt: T + start, endedAt: state === "done" ? T + start + ms : undefined });
  const at = (min) => T + min * 60_000;
  return [
    msg("user", "오늘 서울 날씨 알려줘"),
    msg("assistant", "지금 서울은 맑고 9도예요. 오후엔 13도까지 올라가고, 저녁부터 바람이 조금 불어요. 미세먼지는 보통이에요.", {
      tools: [tool("k_weather", "서울 날씨 확인", "done", "기상청 단기예보", 0, 61_000), tool("k_air", "미세먼지 확인", "done", "에어코리아", 61_000, 32_000)],
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
    msg("user", "내가 지금 신청할 수 있는 정부 지원사업 찾아줘"),
    msg("assistant", "조건에 맞는 지원사업을 3개 찾았어요. 청년 월세 지원은 이번 달 말에 마감이라 먼저 보시는 게 좋아요.", {
      tools: [tool("k_gov24", "정부24 지원사업 검색", "done", "3건", 200_000, 3000)],
      cards: [
        {
          type: "results",
          title: "신청할 수 있는 지원사업",
          source: "정부24",
          items: [
            { title: "청년 월세 한시 특별지원", subtitle: "월 최대 20만 원 · 12개월", meta: "11월 30일 마감", url: "https://example.invalid/a" },
            { title: "국민내일배움카드", subtitle: "훈련비 최대 500만 원", meta: "상시", url: "https://example.invalid/b" },
            { title: "청년도약계좌", subtitle: "정부 기여금 월 최대 3.3만 원", meta: "12월 신청", url: "https://example.invalid/c" },
          ],
        },
      ],
    }),
    msg("user", "카톡 안 읽은 대화 정리해 줘"),
    msg("assistant", "회비 3만 원을 오늘까지 입금해 달라는 부탁이 있었고, 토요일 리허설은 오후 2시예요.", {
      tools: [tool("msg_read", "카카오톡 '주말 연극 모임' 읽기", "done", "메시지 6개", 400_000, 2000)],
      cards: [
        {
          type: "messenger",
          provider: "kakaotalk",
          action: "read",
          target: "주말 연극 모임",
          messages: [],
          room: { title: "주말 연극 모임", kind: "open", memberCount: 6, unread: 7 },
          total: 6,
          highlights: ["pk-k2", "pk-k5"],
          thread: [
            { id: "pk-k1", at: at(-50), senderId: "u1", senderName: "도윤", isMe: false, kind: "text", text: "이번 주 리허설 장소 정해졌어요" },
            { id: "pk-k2", at: at(-48), senderId: "u1", senderName: "도윤", isMe: false, kind: "text", text: "토요일 오후 2시 대학로 연습실이에요. 회비 3만 원은 오늘까지 보내 주세요" },
            { id: "pk-k3", at: at(-44), senderId: "u2", senderName: "초롱별", isMe: false, kind: "text", text: "저는 조금 늦을 수도 있어요" },
            { id: "pk-k4", at: at(-41), senderId: "me", senderName: "지우", isMe: true, kind: "text", text: "저도 갈게요!" },
            { id: "pk-k5", at: at(-39), senderId: "u3", senderName: "새벽별", isMe: false, kind: "text", text: "@지우 대본 3장 수정본 올려 주실 수 있어요?" },
            { id: "pk-k6", at: at(-38), senderId: "u2", senderName: "초롱별", isMe: false, kind: "emoticon", text: "", attachment: { label: "이모티콘" } },
          ],
        },
      ],
    }),
    msg("user", "카톡으로 도윤 님한테 입금했다고 보내 줘"),
    msg("assistant", "카카오톡을 보내려면 로그인이 한 번 필요해요.", {
      tools: [tool("msg_send", "카카오톡 보내기", "needs_credential", undefined, 600_000, 0)],
      cards: [
        {
          type: "credential_request",
          service: "kakaotalk",
          serviceName: "카카오톡",
          reason: "카카오톡으로 보내려면 카카오 계정으로 로그인해야 해요.",
          fields: [
            { key: "username", label: "카카오 계정", type: "email", autocomplete: "username", placeholder: "이메일 또는 전화번호" },
            { key: "password", label: "비밀번호", type: "password", autocomplete: "current-password" },
          ],
          status: "pending",
        },
      ],
    }),
    msg("user", "매일 아침 7시에 날씨랑 뉴스 브리핑해줘"),
    msg("assistant", `매일 아침 7시에 ${agent}가 브리핑을 보내 드릴게요.`, {
      tools: [tool("sys_schedule_create", "예약 만들기", "done", "매일 오전 7:00", 900_000, 1000)],
      cards: [{ type: "schedule", scheduleId: "pk-sc-1", title: "아침 브리핑", when: "매일 오전 7:00", enabled: true }],
    }),
  ];
}
