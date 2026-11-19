import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { SPRING } from "../motion/springs";
import { useTierValue } from "../motion/tier";
import "./Odometer.css";

/**
 * Odometer (MOTION-SPEC §3 Counters): tabular digits that roll per digit (35 ms stagger, `snap`) ONLY when the value
 * changed since the last visit (persisted per `id`) or while mounted. First paint shows the final value. Non-digit
 * characters ("," "%" ".") never roll. Screen readers get one plain number; the strips are aria-hidden.
 * Reduced motion: plain text.
 *
 *   <Odometer value={quota.usedPct} id="quota-pct" suffix="%" />
 */
export interface OdometerProps {
  value: number;
  /** persistence key: "pickle.odo.<id>" holds the last value seen */
  id?: string;
  format?: (n: number) => string;
  className?: string;
  prefix?: string;
  suffix?: string;
}

const defaultFormat = (n: number) => n.toLocaleString("ko-KR");
const STAGGER = 0.035;

function readSeen(id?: string): number | null {
  if (!id) return null;
  try {
    const raw = localStorage.getItem(`pickle.odo.${id}`);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeSeen(id: string | undefined, value: number) {
  if (!id) return;
  try {
    localStorage.setItem(`pickle.odo.${id}`, String(value));
  } catch {
    /* private mode */
  }
}

export function Odometer({ value, id, format = defaultFormat, className, prefix = "", suffix = "" }: OdometerProps) {
  const reduce = useTierValue("reduceMotion");
  // the value the strips start from: last visit's value (if it differs), else the final value (no roll)
  const [from, setFrom] = useState<number>(() => {
    const seen = readSeen(id);
    return seen !== null && seen !== value ? seen : value;
  });
  const prev = useRef(value);
  const [rolling, setRolling] = useState(from !== value);

  useEffect(() => {
    if (prev.current !== value) {
      setFrom(prev.current);
      setRolling(true);
      prev.current = value;
    }
    writeSeen(id, value);
  }, [value, id]);

  const text = format(value);
  const full = `${prefix}${text}${suffix}`;

  if (reduce) {
    return <span className={`odo tnum${className ? ` ${className}` : ""}`}>{full}</span>;
  }

  const fromText = format(from);
  const chars = text.split("");
  const fromChars = fromText.split("");
  const n = chars.length;
  // align digits from the right so 99 → 100 rolls the right columns
  const fromAt = (i: number) => fromChars[fromChars.length - (n - i)];
  let digitIndex = 0;
  const columns = chars.map((ch, i) => {
    const posFromRight = n - 1 - i;
    if (!/\d/.test(ch)) {
      return (
        <span key={`c${posFromRight}`} className="odo-char">
          {ch}
        </span>
      );
    }
    const d = Number(ch);
    const f = fromAt(i);
    const fd = f !== undefined && /\d/.test(f) ? Number(f) : 0;
    const delay = (digitIndex++) * STAGGER;
    const roll = rolling && fd !== d;
    return (
      <span key={`d${posFromRight}`} className="odo-col">
        <motion.span
          className="odo-strip"
          initial={roll ? { y: `${-fd * 10}%` } : false}
          animate={{ y: `${-d * 10}%` }}
          transition={{ ...SPRING.snap, delay: roll ? delay : 0 }}
        >
          {DIGITS}
        </motion.span>
      </span>
    );
  });

  return (
    <span className={`odo tnum${className ? ` ${className}` : ""}`}>
      <span className="sr-only">{full}</span>
      <span className="odo-visual" aria-hidden="true">
        {prefix && <span className="odo-char">{prefix}</span>}
        {columns}
        {suffix && <span className="odo-char">{suffix}</span>}
      </span>
    </span>
  );
}

const DIGITS = Array.from({ length: 10 }, (_, i) => <span key={i}>{i}</span>);
