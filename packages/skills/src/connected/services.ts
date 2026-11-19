/**
 * The k-skill services a person connects with their own account (docs/architecture/KSKILL-CONNECTIONS.md): the
 * connect sheet asks for `fields` (sealed on the device), `verify` runs one cheap authenticated read right after the
 * save. None of these services has a token revocation endpoint we use, so there is no `revoke` (disconnect only
 * deletes the sealed row and drops the in-memory session).
 *
 * Not here on purpose (lead decisions, 2026-11-12): 숲나들e (`foresttrip-vacancy`) is parked: its login runs the
 * site's anti-automation checks (/com/crawlingCheck.do, NetFunnel), and we don't get past those, neither with forged
 * requests nor with a headless browser running their JS. 사람인 (terms forbid automation) is excluded; 번개장터 gets
 * no login connection; 잡코리아 and CODEF are parked; 헤이유미 waits on the owner's decision.
 */
import type { ConnectionService } from "@pickle/agent";
import { COUPANG, COUPANG_FIELDS, verifyCoupang } from "./coupang";
import { NAVER_AD, NAVER_AD_FIELDS, verifyNaverAd } from "./naverad";
import { POPBILL, POPBILL_FIELDS, verifyPopbill } from "./popbill";
import { RISS, RISS_FIELDS, verifyRiss } from "./riss";
import { TOSS, TOSS_FIELDS, verifyToss } from "./toss";

const SERVICES: readonly ConnectionService[] = [
  { id: TOSS.id, name: TOSS.name, description: "내 앱 키로 계좌·보유 주식·주문 내역·현재가 조회 (주문은 넣지 않아요)", kind: "token", fields: TOSS_FIELDS, verify: verifyToss },
  { id: NAVER_AD.id, name: NAVER_AD.name, description: "광고 성과와 키워드 검색량 조회 (입찰가는 바꾸지 않아요)", kind: "token", fields: NAVER_AD_FIELDS, verify: verifyNaverAd },
  { id: POPBILL.id, name: POPBILL.name, description: "전자세금계산서 조회, 승인 후 발행", kind: "token", fields: POPBILL_FIELDS, verify: verifyPopbill },
  { id: COUPANG.id, name: COUPANG.name, description: "내 파트너스 키로 쿠팡 상품 검색", kind: "token", fields: COUPANG_FIELDS, verify: verifyCoupang },
  { id: RISS.id, name: RISS.name, description: "기관에서 받은 검색 API 키로 학술자료 검색", kind: "token", fields: RISS_FIELDS, verify: verifyRiss },
];

/** The catalog the server registers (`ConnectionRegistry({ services: () => skills.connectionServices() })`). */
export function connectionServices(): ConnectionService[] {
  return SERVICES.map((s) => ({ ...s, fields: s.fields.map((f) => ({ ...f })) }));
}
