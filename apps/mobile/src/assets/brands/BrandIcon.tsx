import { useEffect, useId, useSyncExternalStore, type CSSProperties } from "react";
import "./brand-icon.css";

/**
 * Real app icons for messenger providers (KakaoTalk, Slack, Discord, …), drawn like an iOS Settings row icon: a rounded
 * tile in the brand's own colours with its official mark. Sources and licences: ./README.md.
 *
 * The tile colour paints on the first frame (brand-icon.css). The marks live in a separate lazy chunk (./marks),
 * preloaded at idle, so they never weigh on the entry chunk. Decorative: always sits next to the visible provider name.
 *
 *   <BrandIcon provider="kakaotalk" size={30} />      // provider id from the server; bot variants map to their brand
 *   hasBrandIcon(id) ? <BrandIcon provider={id} /> : <Plate … />
 */
export type BrandId = "kakaotalk" | "slack" | "discord" | "telegram" | "line" | "instagram" | "teams" | "webex" | "whatsapp";

const ALIASES: Record<string, BrandId> = {
  kakaotalk: "kakaotalk",
  kakao: "kakaotalk",
  slack: "slack",
  slackbot: "slack",
  discord: "discord",
  discordbot: "discord",
  telegram: "telegram",
  telegrambot: "telegram",
  line: "line",
  instagram: "instagram",
  teams: "teams",
  msteams: "teams",
  webex: "webex",
  whatsapp: "whatsapp",
};

export function brandOf(provider: string | null | undefined): BrandId | null {
  return provider ? (ALIASES[provider.toLowerCase()] ?? null) : null;
}

export const hasBrandIcon = (provider: string | null | undefined) => brandOf(provider) !== null;

type Marks = typeof import("./marks").MARKS;
let marks: Marks | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Loads the marks chunk once (safe to call repeatedly; a failed load retries on the next call). */
export function preloadBrandMarks(): Promise<void> {
  loading ??= import("./marks").then(
    (m) => {
      marks = m.MARKS;
      for (const l of listeners) l();
    },
    () => {
      loading = null;
    },
  );
  return loading;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getMarks = () => marks;

export interface BrandIconProps {
  /** provider id ("kakaotalk", "slackbot", …) or brand id */
  provider: string;
  size?: number;
  /** corner radius in px (default ≈ 27% of size, the list plate ratio) */
  radius?: number;
  className?: string;
}

export function BrandIcon({ provider, size = 30, radius, className }: BrandIconProps) {
  const brand = brandOf(provider);
  const m = useSyncExternalStore(subscribe, getMarks, getMarks);
  const uid = `b${useId().replace(/[^\w-]/g, "")}`;
  useEffect(() => {
    if (!marks) void preloadBrandMarks();
  }, []);
  if (!brand) return null;
  return (
    <span
      className={`brand-icon brand-icon--${brand}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size, borderRadius: radius ?? Math.round(size * 0.27) } as CSSProperties}
      data-brand={brand}
      aria-hidden="true"
    >
      {m && (
        <svg viewBox="0 0 100 100" width={size} height={size} focusable="false">
          {m[brand](uid)}
        </svg>
      )}
    </span>
  );
}
