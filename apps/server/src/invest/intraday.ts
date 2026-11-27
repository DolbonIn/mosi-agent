/**
 * B2c-2: what the session's checks read besides the rules (A14's 급격한 갭, 추격 금지, 분할·병합; team-lead 0747 8 ·
 * 0856, agent-runtime 0845). Operational definitions — the master prompt gives no numbers for these — written in
 * SERVER-CONTRACT.md. Pure: no clock, no database, no network.
 */

/** a gap or a run above a buy zone counts at this many ATR14 or more … */
export const BIG_MOVE_ATR = 1;
/** … and at this many percent or more, both (team-lead 0747 8b: a 3x ETF's and a stock's gaps read alike) */
export const BIG_MOVE_PCT = 3;
/** a split or reverse split: yesterday's last price against today's previous close at one of these ratios … */
export const SPLIT_RATIOS = [2, 3, 4, 5, 8, 10, 15, 20, 25, 50] as const;
/** … within this share of it (a source rewrites yesterday's close by the ratio; a crash leaves it as it was) */
export const SPLIT_TOLERANCE = 0.01;

export interface Gap {
  up: boolean;
  /** |open / prevClose − 1| in percent */
  pct: number;
  /** |open − prevClose| in ATR14 */
  atrs: number;
}

/** the open against the previous close: a gap when it is BIG_MOVE_ATR × ATR14 or more and BIG_MOVE_PCT % or more */
export function gapOf(open: number, prevClose: number, atr14: number | null): Gap | null {
  if (!(open > 0) || !(prevClose > 0) || atr14 == null || !(atr14 > 0)) return null;
  const move = Math.abs(open - prevClose);
  const pct = (move / prevClose) * 100;
  const atrs = move / atr14;
  return atrs >= BIG_MOVE_ATR && pct >= BIG_MOVE_PCT ? { up: open > prevClose, pct, atrs } : null;
}

export interface Run {
  /** price − the zone's top */
  over: number;
  /** (price / top − 1) in percent */
  pct: number;
  atrs: number;
}

/**
 * A14 추격 금지: the price at the check before was inside the buy zone or under it, and now it is above the zone's top
 * by BIG_MOVE_ATR × ATR14 or more and BIG_MOVE_PCT % or more. The card says to look at the strategy again; it never
 * says to buy.
 */
export function runAbove(prevPrice: number | null, price: number, hi: number, atr14: number | null): Run | null {
  if (prevPrice == null || !(prevPrice <= hi) || !(price > hi) || !(hi > 0) || atr14 == null || !(atr14 > 0)) return null;
  const over = price - hi;
  const pct = (over / hi) * 100;
  const atrs = over / atr14;
  return atrs >= BIG_MOVE_ATR && pct >= BIG_MOVE_PCT ? { over, pct, atrs } : null;
}

export interface Split {
  /** merge: `ratio` shares became one (the price went up by it); split: one share became `ratio` */
  kind: "merge" | "split";
  ratio: number;
}

/**
 * yesterday's last price this server saw against the previous close the source gives today: a ratio in SPLIT_RATIOS
 * (or its inverse) within SPLIT_TOLERANCE is a split or a merge. Null when either is unknown.
 */
export function splitOf(seenYesterday: number | null, prevClose: number | null): Split | null {
  if (seenYesterday == null || prevClose == null || !(seenYesterday > 0) || !(prevClose > 0)) return null;
  const r = prevClose / seenYesterday;
  for (const k of SPLIT_RATIOS) {
    if (Math.abs(r / k - 1) <= SPLIT_TOLERANCE) return { kind: "merge", ratio: k };
    if (Math.abs(r * k - 1) <= SPLIT_TOLERANCE) return { kind: "split", ratio: k };
  }
  return null;
}
