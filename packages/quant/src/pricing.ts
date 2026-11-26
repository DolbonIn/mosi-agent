/**
 * A11, the reward-to-risk of a plan, from the entry (the zone's middle or the planned entry), a take-profit and a stop:
 * expected gain = (target / entry − 1) × 100, expected loss = (1 − stop / entry) × 100, ratio = (target − entry) /
 * (entry − stop). The same formula holds for an inverse ETF bought outright. 2 : 1 or more is looked at first, and a
 * target is never raised (nor a stop tightened) to reach it.
 */

export interface RiskReward {
  gainPct: number;
  lossPct: number;
  /** null when the stop is not below the entry */
  ratio: number | null;
}

export function riskReward(entry: number, target: number, stop: number): RiskReward {
  return {
    gainPct: (target / entry - 1) * 100,
    lossPct: (1 - stop / entry) * 100,
    ratio: entry - stop > 0 ? (target - entry) / (entry - stop) : null,
  };
}

/** the ratio A11 looks at first */
export const PREFERRED_RATIO = 2;
