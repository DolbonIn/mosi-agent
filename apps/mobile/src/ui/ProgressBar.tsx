import { motion, useMotionValue, useTransform } from "framer-motion";
import { useEffect } from "react";
import { springTo } from "../motion/springs";
import { Odometer } from "./Odometer";
import "./ProgressBar.css";

/**
 * ProgressBar (MOTION-SPEC §6.6 quota card): a capsule that FILLS on `morph` — from 0 on first mount, from where it is
 * on change (retargets keep velocity). The fill is a full-width capsule revealed by clip-path inset(… round 999px), so
 * both ends stay true capsules at every frame (no scaleX squash). Progress moves on real values only.
 *
 *   <ProgressBar value={quota.usedPct / 100} label="일일 사용량 한도" showValue id="quota" />
 */
export interface ProgressBarProps {
  /** 0..1 */
  value: number;
  label?: string;
  /** render the percentage (rolling Odometer, persisted under `id`) */
  showValue?: boolean;
  id?: string;
  tone?: "accent" | "label";
  height?: number;
  className?: string;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

export function ProgressBar({ value, label, showValue, id, tone = "accent", height = 6, className }: ProgressBarProps) {
  const target = clamp01(value);
  const p = useMotionValue(0);
  const clip = useTransform(p, (v) => `inset(0 ${((1 - clamp01(v)) * 100).toFixed(3)}% 0 0 round 999px)`);

  useEffect(() => {
    const controls = springTo(p, target, "morph");
    return () => controls.stop();
  }, [p, target]);

  const pct = Math.round(target * 100);
  return (
    <div className={`progress${className ? ` ${className}` : ""}`}>
      {(label || showValue) && (
        <div className="progress-head">
          {label && <span className="progress-label">{label}</span>}
          {showValue && (
            <span className="progress-value">
              <Odometer value={pct} id={id ? `${id}-pct` : undefined} suffix="%" />
            </span>
          )}
        </div>
      )}
      <div
        className="progress-track"
        style={{ height, borderRadius: height / 2 }}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct}%`}
      >
        <motion.div className={`progress-fill progress-fill--${tone}`} style={{ clipPath: clip, WebkitClipPath: clip }} />
      </div>
    </div>
  );
}
