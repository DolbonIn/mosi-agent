/**
 * The shapes @pickle/quant reads and returns. Pure data: no network, database, clock or randomness anywhere in this
 * package, so the server, the app's cards and the deck compute the same numbers from the same input.
 */

/** One daily bar, oldest first in any array. `t` is the trading day, YYYY-MM-DD. */
export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** One dated observation of a series (FRED, a rate, a count), oldest first. `v` null: no value that day (FRED "."). */
export interface Point {
  t: string;
  v: number | null;
}

/** A value per input index; null before a window fills (warm-up) or where the value is undefined (a flat range). */
export type Num = number | null;

/** The master prompt's four marks: 🟢 normal, 🟡 caution, 🔴 risk, ⚪ not confirmed (never read as 🟢). */
export type Signal = "normal" | "caution" | "risk" | "unknown";

/** A condition: met, not met, or not known (missing data is never counted as not met). */
export type Tri = "met" | "unmet" | "unknown";
