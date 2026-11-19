import { useLayoutEffect, useRef } from "react";
import { useAgent } from "../api/store";
import { ContentSwap } from "../motion/ContentSwap";
import { Avatar, DEFAULT_AVATAR } from "../ui/Avatar";
import { BlurGroup, Glass } from "../ui/Glass";
import { R } from "../ui/geometry";
import { Icon } from "../ui/Icon";
import { nav, useNav } from "./nav";
import { useTopBar } from "./topBarStore";
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
        {right && (
          <Glass
            as="button"
            blur="group"
            text
            radius={R.topbar}
            interactive
            lens
            className={right.label ? "tb-capsule" : "tb-circle"}
            aria-label={right.ariaLabel ?? right.label}
            onClick={(e: React.MouseEvent<HTMLElement>) => right.onPress(e.currentTarget)}
          >
            {right.icon && <Icon name={right.icon} size={20} weight="medium" />}
            {right.label && <span className="tb-capsule-label">{right.label}</span>}
          </Glass>
        )}
      </div>
    </BlurGroup>
  );
}

function Center({ title, agent, name, spec, onCenter }: { title: string | null; agent: boolean; name: string; spec: typeof DEFAULT_AVATAR; onCenter: ((el: HTMLElement) => void) | null }) {
  const host = useRef<HTMLDivElement>(null);

  // cap: the centre stays centred in the bar without reaching either side (back/menu circle, trailing control) —
  // longer titles end in "…"
  useLayoutEffect(() => {
    const bar = host.current?.closest<HTMLElement>(".topbar");
    if (!bar) return;
    const left = bar.querySelector<HTMLElement>(":scope > .tb-circle");
    const right = bar.querySelector<HTMLElement>(":scope > .tb-right-slot");
    const GAP = 8;
    const update = () => {
      const side = Math.max(left?.offsetWidth ?? 48, right?.offsetWidth ?? 0);
      const centre = bar.clientWidth - 2 * (side + GAP);
      bar.style.setProperty("--tb-center-max", `${Math.max(96, Math.floor(centre))}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(bar);
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
