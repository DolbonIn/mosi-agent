import type { AvatarSpec } from "@pickle/protocol";
import { useId, useRef } from "react";
import { useBreathing } from "../motion/breathing";
import "./Avatar.css";

/**
 * The agent character as a procedural SVG (protocol AvatarSpec): a soft body (blob / round / drop) lit from the top
 * left, a small specular highlight, and eyes (dot / oval / smile). Content artwork, so it may carry a gradient.
 * `breathing` (opt-in, for the character on stage — not list / chrome avatars): MOTION-SPEC §8.11, period 3.2 s,
 * scale 1 → 1.02 (origin bottom centre), only while on screen, visible and within 10 s of input; still under reduced
 * motion. Deterministic.
 * Also the first-paint poster of the 3D AgentBlob (AgentBlobLazy).
 */
export const DEFAULT_AVATAR: AvatarSpec = { hue: 8, shape: "blob", eyes: "oval" };

export interface AvatarProps {
  spec?: AvatarSpec;
  size?: number;
  /** opt-in idle breathing (§8.11); default off */
  breathing?: boolean;
  className?: string;
  /** white plate behind the character (top-bar placement, like the real app) */
  ring?: boolean;
  /** accessible name; without it the avatar is decorative */
  label?: string;
}

const BODY: Record<AvatarSpec["shape"], string> = {
  blob: "M52 12C74 12.5 89 27 90 48.5C91 71 77 88.5 50 88.5C23 88.5 9 72 10 49.5C11 27.5 29 11.5 52 12Z",
  round: "M50 9C79 9 91 21 91 50C91 79 79 91 50 91C21 91 9 79 9 50C9 21 21 9 50 9Z",
  drop: "M50 7C58.5 21 88 40 88 62C88 80 72 92.5 50 92.5C28 92.5 12 80 12 62C12 40 41.5 21 50 7Z",
};

/** eye centre height per body (drop sits lower) */
const EYE_Y: Record<AvatarSpec["shape"], number> = { blob: 48, round: 47, drop: 58 };

export function Avatar({ spec = DEFAULT_AVATAR, size = 40, breathing = false, className, ring = false, label }: AvatarProps) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const breathe = useBreathing(svgRef, breathing);
  const h = ((spec.hue % 360) + 360) % 360;
  const light = `hsl(${h} 92% 72%)`;
  const mid = `hsl(${h} 80% 58%)`;
  const deep = `hsl(${h} 70% 43%)`;
  const ink = `hsl(${h} 45% 11%)`;
  const ey = EYE_Y[spec.shape] ?? 48;
  const body = BODY[spec.shape] ?? BODY.blob;

  const eyes =
    spec.eyes === "smile" ? (
      <g fill="none" stroke={ink} strokeWidth="3.6" strokeLinecap="round">
        <path d={`M34 ${ey + 2}q6 -6.5 12 0`} />
        <path d={`M54 ${ey + 2}q6 -6.5 12 0`} />
      </g>
    ) : (
      <g>
        {[40, 60].map((cx) => (
          <g key={cx}>
            {spec.eyes === "dot" ? <circle cx={cx} cy={ey} r="5.4" fill={ink} /> : <ellipse cx={cx} cy={ey} rx="4.6" ry="7" fill={ink} />}
            <circle cx={cx - 1.4} cy={ey - (spec.eyes === "dot" ? 1.8 : 2.8)} r="1.6" fill="#fff" opacity="0.92" />
          </g>
        ))}
      </g>
    );

  return (
    <svg
      ref={svgRef}
      className={`avatar${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <defs>
        <radialGradient id={`ab${uid}`} cx="36%" cy="30%" r="78%">
          <stop offset="0" stopColor={light} />
          <stop offset="0.55" stopColor={mid} />
          <stop offset="1" stopColor={deep} />
        </radialGradient>
        <radialGradient id={`as${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      {ring ? <circle cx="50" cy="50" r="50" fill="#fff" /> : null}
      <g transform={ring ? "translate(50 52) scale(0.8) translate(-50 -50)" : undefined}>
        <g className={breathe ? "avatar__breath" : undefined} data-loop={breathe ? "" : undefined}>
          <path d={body} fill={`url(#ab${uid})`} />
          <ellipse cx="35" cy={spec.shape === "drop" ? 44 : 29} rx="13" ry="7.5" transform={`rotate(-24 35 ${spec.shape === "drop" ? 44 : 29})`} fill={`url(#as${uid})`} />
          {eyes}
        </g>
      </g>
    </svg>
  );
}
