import { useLayoutEffect, useRef, useState } from "react";
import { useAgent } from "../api/store";
import { ContentSwap } from "../motion/ContentSwap";
import { t } from "../motion/springs";
import { Avatar, DEFAULT_AVATAR } from "../ui/Avatar";
import { BlurGroup, Glass } from "../ui/Glass";
import { R } from "../ui/geometry";
import { Icon } from "../ui/Icon";
import { nav, useNav } from "./nav";
import { useTopBar, type TopBarAction } from "./topBarStore";
import "./TopBar.css";

/**
 * Floating top bar (REA layout, Liquid Glass): menu circle (left; becomes a back chevron on pushed screens), the
 * centre, and a trailing control (screen-owned via useTopBarRight). Glass faces share ONE backdrop-filter (BlurGroup
 * "top"); 48px circles r24.
 * The centre is never glass (shared top-bar rule, MOTION-SPEC §8.17): plain text on the scroll edge.
 *   - 채팅's root: the agent — face 30 + name — the one place you talk to it; tapping runs what the screen set with
 *     useTopBarCenter (the agent sheet).
 *   - every other root and every pushed screen: empty at rest, then the compact title a LargeTitle hands over when it
 *     scrolls under the bar (content swap). Never the agent's name.
 */
export function TopBar() {
  const { title, right, onCenter } = useTopBar();
  const canBack = useNav((s) => s.stacks[s.tab].length > 0);
  const chatRoot = useNav((s) => s.tab === "chat" && s.stacks.chat.length === 0);
  const agent = useAgent();
  const name = agent?.name ?? "깽이";
  const spec = agent?.avatar ?? DEFAULT_AVATAR;

  return (
    <BlurGroup name="top" className="topbar">
      <Glass
        as="button"
        blur="group"
        text
        radius={R.topbar}
        interactive
        lens
        className="tb-circle"
        aria-label={canBack ? "뒤로" : "메뉴"}
        onClick={() => (canBack ? nav.pop() : nav.toggleDrawer())}
      >
        <ContentSwap swapKey={canBack ? "back" : "menu"}>
          <Icon name={canBack ? "chevron-left" : "menu"} size={22} weight="medium" />
        </ContentSwap>
      </Glass>
      <Center title={title} agent={chatRoot} name={name} spec={spec} onCenter={onCenter} />
      <div className="tb-right-slot">
        {right && <Trailing action={right} />}
      </div>
    </BlurGroup>
  );
}

/**
 * The trailing control: a circle (icon only) or a capsule. A new label or tone re-shapes the same capsule (FB4-1, never
 * a second capsule faded in): its width springs to the new words' (`morph`, measured on a hidden copy), its colour
 * eases, and the words swap (content swap). With no onPress it is a status: plain glass, no press, no role, its
 * ariaLabel read in place of the label (DD 2008 §1).
 */
function Trailing({ action }: { action: TopBarAction }) {
  const { label, icon, tone, onPress } = action;
  const sizer = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  // the capsule's resting width = a hidden copy's (same class, so the same padding, gap and type, and text scale)
  useLayoutEffect(() => {
    const el = sizer.current;
    if (!el) return setWidth(null);
    const update = () => setWidth(el.offsetWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [label]);
  const inner = (
    <>
      {icon && <Icon name={icon} size={20} weight="medium" />}
      {label && (
        <ContentSwap swapKey={label} className="tb-capsule-label">
          {label}
        </ContentSwap>
      )}
    </>
  );
  const shape = label ? "tb-capsule" : "tb-circle";
  const size = label && width ? { initial: false as const, animate: { width }, transition: t("morph") } : {};
  const copy = label && (
    <span ref={sizer} className="tb-capsule tb-sizer" aria-hidden="true">
      {icon && <Icon name={icon} size={20} weight="medium" />}
      <span className="tb-capsule-label">{label}</span>
    </span>
  );
  if (!onPress)
    return (
      <>
        <Glass as="div" blur="group" text radius={R.topbar} className={`${shape} tb-status`} data-tone={tone} {...size}>
          <span className="sr-only">{action.ariaLabel ?? label}</span>
          <span className="tb-status-face" aria-hidden="true">
            {inner}
          </span>
        </Glass>
        {copy}
      </>
    );
  return (
    <>
      <Glass
        as="button"
        blur="group"
        text
        radius={R.topbar}
        interactive
        lens
        className={shape}
        data-tone={tone}
        aria-label={action.ariaLabel ?? label}
        onClick={(e: React.MouseEvent<HTMLElement>) => onPress(e.currentTarget)}
        {...size}
      >
        {inner}
      </Glass>
      {copy}
    </>
  );
}

function Center({ title, agent, name, spec, onCenter }: { title: string | null; agent: boolean; name: string; spec: typeof DEFAULT_AVATAR; onCenter: ((el: HTMLElement) => void) | null }) {
  const host = useRef<HTMLDivElement>(null);

  // cap: the centre stays centred in the bar and 8px or more from either side (back/menu circle, trailing control);
  // longer titles end in "…". When the centred room is under 96px (a wide capsule at 320, text size 130 %: DD 2224),
  // the cap is the whole room between the two sides and the centre moves off the middle only as far as it must to
  // keep its 8px (a short title stays centred).
  useLayoutEffect(() => {
    const el = host.current;
    const bar = el?.closest<HTMLElement>(".topbar");
    if (!el || !bar) return;
    const left = bar.querySelector<HTMLElement>(":scope > .tb-circle");
    const right = bar.querySelector<HTMLElement>(":scope > .tb-right-slot");
    const GAP = 8;
    const MIN = 96;
    const set = (k: string, v: string) => {
      if (bar.style.getPropertyValue(k) !== v) bar.style.setProperty(k, v);
    };
    const update = () => {
      const w = bar.clientWidth;
      const lw = left?.offsetWidth ?? 48;
      const rw = right?.offsetWidth ?? 0;
      const centred = w - 2 * (Math.max(lw, rw) + GAP);
      if (centred >= MIN) {
        set("--tb-center-max", `${Math.floor(centred)}px`);
        set("--tb-center-shift", "0px");
        return;
      }
      const lo = lw + GAP;
      const hi = w - rw - GAP;
      set("--tb-center-max", `${Math.max(0, Math.floor(hi - lo))}px`);
      // where the grid put it under the new cap (a side wider than its 1fr track pushes it already); the shift is a
      // transform, so it changes neither number
      const cw = el.offsetWidth;
      const start = el.offsetLeft;
      let shift = 0;
      if (start + cw > hi) shift = hi - (start + cw);
      if (start + shift < lo) shift = lo - start;
      set("--tb-center-shift", `${Math.round(shift * 2) / 2}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(bar);
    // the words' box, one level below the sides: the cap resizes it inside a side's callback, and an observed box at
    // the sides' own depth would end the loop undelivered (WebKit reports "ResizeObserver loop completed …")
    const words = el.querySelector<HTMLElement>(":scope > .swap-host");
    if (words) ro.observe(words);
    if (left) ro.observe(left);
    if (right) ro.observe(right);
    return () => ro.disconnect();
  }, []);

  const mode = title ? "title" : agent ? "agent" : "none";
  const who = (
    <>
      <Avatar spec={spec} size={30} />
      <span className="tb-name">{name}</span>
    </>
  );
  return (
    <div ref={host} className="tb-center" data-mode={mode}>
      <ContentSwap swapKey={mode === "title" ? `t:${title}` : mode}>
        {mode === "title" ? (
          <span className="tb-title">{title}</span>
        ) : mode === "agent" ? (
          onCenter ? (
            <button type="button" className="tb-agent" aria-label={`${name} 프로필`} onClick={(e) => onCenter(e.currentTarget)}>
              {who}
            </button>
          ) : (
            <span className="tb-agent">{who}</span>
          )
        ) : null}
      </ContentSwap>
    </div>
  );
}
