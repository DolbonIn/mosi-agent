// The chat's connection_request card line (skillCatalog.requestLine): for a service the app has words for, the card
// says what the agent does with the login (the connect sheet's scope line) instead of repeating why it's needed — the
// answer above and the title already say that. Any other service keeps the server's reason.
import { expect, test } from "bun:test";
import { requestLine, sentencesOf, SKILL_COPY, skillCopy } from "../src/screens/more/connections/skillCatalog";

test("a catalogued service: the sheet's scope line, whatever the server's reason says", () => {
  const line = requestLine({ service: "toss-investment", reason: "보유 주식을 보려면 토스증권 연결이 필요해요" });
  expect(line).toBe(skillCopy("toss-investment")!.does);
  expect(line).toBe("계좌와 보유 종목, 시세를 조회만 해요. 주문은 넣지 않아요.");
});

test("every offered service has a scope line of its own", () => {
  for (const id of ["toss-investment", "naver-searchad", "popbill", "coupang-partners", "riss"]) {
    const line = requestLine({ service: id, reason: "x" });
    expect(line).not.toBe("x");
    expect(line.length).toBeGreaterThan(10);
  }
});

test("a service the app has no words for keeps the server's reason (trimmed); none → empty", () => {
  expect(requestLine({ service: "some-new-service", reason: "  새 서비스 연결 기간이 끝났어요. 다시 연결해 주세요. " })).toBe("새 서비스 연결 기간이 끝났어요. 다시 연결해 주세요.");
  expect(requestLine({ service: "some-new-service" })).toBe("");
});

test("a line is cut after each sentence, and only there (Sentences breaks between them)", () => {
  expect(sentencesOf("계좌와 보유 종목, 시세를 조회만 해요. 주문은 넣지 않아요.")).toEqual(["계좌와 보유 종목, 시세를 조회만 해요.", "주문은 넣지 않아요."]);
  expect(sentencesOf("특허와 실용신안을 검색만 해요.")).toEqual(["특허와 실용신안을 검색만 해요."]);
  expect(sentencesOf("건물의 층수 · 용도 · 면적을 조회만 해요.")).toHaveLength(1);
  expect(sentencesOf("  ")).toEqual([]);
  // every scope line and notice joins back to itself
  for (const c of SKILL_COPY) for (const t of [c.does, c.notice ?? ""]) expect(sentencesOf(t).join(" ")).toBe(t.trim());
});
