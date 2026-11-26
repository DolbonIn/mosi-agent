/**
 * D7, the margin-call threshold: bought with an equity share e (the rest on credit), the account reaches the 140 %
 * maintenance ratio when P / P0 = 1.40 × (1 − e), so the price move that triggers forced selling is 1.40 × (1 − e) − 1
 * (the table's "추가 하락": −30 % at e = 50 %).
 * Inverted, a gap between the price and the buyers' average (D7 approximates it by individuals' 20-day VWAP) gives the
 * equity share standing right at the threshold. Neither is a fact about the market: with no confirmed credit balance
 * the master prompt describes a share inside the usual range as "possibly at the threshold", never as certain.
 */

/** the maintenance ratio D7 uses (담보비율 140 %) */
export const MARGIN_RATIO = 1.4;
/** individuals' usual credit share range in D7 (30–50 %) */
export const TYPICAL_CREDIT_SHARE: readonly [number, number] = [0.3, 0.5];

/** the price move, in % (negative: a fall), that brings an account with equity share e (0–1) to the ratio:
 * (1.40 × (1 − e) − 1) × 100 */
export function marginCallMove(e: number, ratio = MARGIN_RATIO): number {
  return (ratio * (1 - e) - 1) * 100;
}

/** the price at which an account bought at p0 with equity share e reaches the ratio: p0 × 1.40 × (1 − e) */
export function marginCallPrice(p0: number, e: number, ratio = MARGIN_RATIO): number {
  return p0 * ratio * (1 - e);
}

/** the equity share (0–1) that stands exactly at the ratio when the price is p against an average cost p0:
 * e = 1 − (p / p0) / 1.40 */
export function impliedEquityShare(p: number, p0: number, ratio = MARGIN_RATIO): number {
  return 1 - p / p0 / ratio;
}

/** whether a share (0–1) falls inside the usual credit range, so the threshold may really be in play */
export function inTypicalCreditRange(e: number): boolean {
  return e >= TYPICAL_CREDIT_SHARE[0] && e <= TYPICAL_CREDIT_SHARE[1];
}
