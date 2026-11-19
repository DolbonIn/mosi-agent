import type { TabId } from "@pickle/protocol";
import type { CSSProperties, ReactNode } from "react";
import { useAgent, useSession } from "../../api/store";
import { BrandIcon, hasBrandIcon } from "../../assets/brands/BrandIcon";
import { nav, useNav } from "../../app/nav";
import { R } from "../../ui/geometry";
import { Icon, type AppIconName } from "../../ui/Icon";
import { copy } from "../../ui/Text";
import "./more.css";

/**
 * Small shared pieces for the explore / archive / profile half. Paper and lists come from the foundation; these only
 * add the bits those screens repeat (tinted plates, status pills, inline errors, section stacks).
 */

/** true while this tab root is the visible page (not covered by a pushed screen, tab active) */
export function useTabVisible(tab: TabId): boolean {
  return useNav((s) => s.tab === tab && s.stacks[tab].length === 0);
}

/** the route is the top of the visible tab */
export function useRouteVisible(routeKey: string): boolean {
  return useNav((s) => {
    const stack = s.stacks[s.tab];
    return stack[stack.length - 1]?.key === routeKey;
  });
}

export const useAgentName = () => useAgent()?.name ?? "모시";
export const useUserId = () => useSession().session?.user.id ?? null;

/** Push a detail screen whose large title morphs out of the row that opened it. */
export function pushDetail(screen: string, title: string, params?: Record<string, unknown>, layoutId?: string) {
  nav.push(screen, params, { title, titleLayoutId: layoutId });
}

/** vertical rhythm for a page: sections 24px apart */
export function Stack({ children, gap = 24, className, style }: { children: ReactNode; gap?: number; className?: string; style?: CSSProperties }) {
  return (
    <div className={`more-stack${className ? ` ${className}` : ""}`} style={{ gap, ...style }}>
      {children}
    </div>
  );
}

/** Token radius for a plate or logo of this size: the list plate (r8) up to 34px, the in-card tile (r12) above. */
export const plateRadius = (size: number) => (size <= 34 ? R.plate : R.tile);

/** A hue-tinted plate with a white glyph (templates, providers). Decorative. */
export function Plate({ icon, hue, size = 44, radius, glyph, className }: { icon: AppIconName; hue: number; size?: number; radius?: number; glyph?: number; className?: string }) {
  const r = radius ?? plateRadius(size);
  return (
    <span
      className={`more-plate${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size, borderRadius: r, "--h": hue } as CSSProperties}
      aria-hidden="true"
    >
      <Icon name={icon} size={glyph ?? Math.round(size * 0.5)} weight="medium" />
    </span>
  );
}

/**
 * A provider's real app icon (assets/brands) when we have its official mark, else the hue plate with its glyph.
 * Decorative: always next to the provider's visible name.
 */
export function ProviderIcon({ provider, size = 44, radius, glyph, className }: { provider: { id: string; icon: AppIconName; hue: number } | null | undefined; size?: number; radius?: number; glyph?: number; className?: string }) {
  const r = radius ?? plateRadius(size);
  if (provider && hasBrandIcon(provider.id)) return <BrandIcon provider={provider.id} size={size} radius={r} className={className} />;
  return <Plate icon={provider?.icon ?? "key"} hue={provider?.hue ?? 220} size={size} radius={r} glyph={glyph} className={className} />;
}

export type PillTone = "neutral" | "ok" | "wait" | "error";
/** Status pill: never colour alone — always an icon and words (MOTION-SPEC §7). */
export function StatusPill({ tone, icon, children, className }: { tone: PillTone; icon?: AppIconName; children: ReactNode; className?: string }) {
  const glyph: AppIconName = icon ?? (tone === "ok" ? "check-circle" : tone === "error" ? "exclamation" : tone === "wait" ? "clock" : "info");
  return (
    <span className={`more-pill more-pill--${tone}${className ? ` ${className}` : ""}`}>
      <Icon name={glyph} size={14} weight="semibold" />
      <span>{children}</span>
    </span>
  );
}

/** Korean server message next to the control that failed (role=alert). */
export function InlineError({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p className={`more-error${className ? ` ${className}` : ""}`} role="alert">
      <Icon name="exclamation" size={15} weight="semibold" />
      <span>{children}</span>
    </p>
  );
}

/** the text of children written as JSX text with expressions ("…{name}도 …"), or null when a child is markup */
function plainText(children: ReactNode): string | null {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (!Array.isArray(children)) return null;
  let out = "";
  for (const c of children) {
    if (c === null || c === undefined || typeof c === "boolean") continue;
    if (typeof c !== "string" && typeof c !== "number") return null;
    out += c;
  }
  return out;
}

/**
 * Korean copy for a slot (ui/Text copy(): breaks between sentences, tight spots tied). Text written as JSX text with
 * expressions is joined first so it gets the same; markup is left as it is.
 */
export const copyOf = (children: ReactNode): ReactNode => copy(plainText(children) ?? children);

/** Small caption under a group or inside a sheet. The copy sits in one span: the caption is a flex row with its icon. */
export function Note({ children, icon, className }: { children: ReactNode; icon?: AppIconName; className?: string }) {
  return (
    <p className={`more-note${className ? ` ${className}` : ""}`}>
      {icon && <Icon name={icon} size={15} weight="medium" />}
      <span className="t-copy">{copyOf(children)}</span>
    </p>
  );
}

/** A sheet's lead paragraph (17 px, label), under its title. */
export function Lead({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={`more-sheet-lead t-copy${className ? ` ${className}` : ""}`}>{copyOf(children)}</p>;
}

/** A footnote under a block that is not a List (a List or ListSection takes `footer`): the foundation's footer look. */
export function Foot({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={`list-footer t-copy${className ? ` ${className}` : ""}`}>{copyOf(children)}</p>;
}

/**
 * A section title (13px 600, label-2). On a screen it sits under the large title (h1), so it is an h2 by default;
 * inside a sheet, whose title is the h2, pass `level={3}`.
 */
export function SectionLabel({ children, id, level = 2 }: { children: ReactNode; id?: string; level?: 2 | 3 }) {
  const H = level === 3 ? "h3" : "h2";
  return (
    <H className="more-label" id={id}>
      {children}
    </H>
  );
}

/** Still placeholder rows at the final size (no shimmer, research §4-4 4-6): shown only on the first load. */
export function Placeholder({ rows = 3, height = 64 }: { rows?: number; height?: number }) {
  return (
    <div className="more-placeholder" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} style={{ height }} />
      ))}
    </div>
  );
}
