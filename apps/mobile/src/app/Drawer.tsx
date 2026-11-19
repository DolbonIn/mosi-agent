import { motionValue, motion, useTransform } from "framer-motion";
import { useEffect, useRef, type ComponentType } from "react";
import { useUi } from "../api/store";
import { createStore, useStore } from "../lib/createStore";
import { haptic } from "../motion/haptics";
import { springTo } from "../motion/springs";
import { Icon } from "../ui/Icon";
import { setOverlay } from "./device";
import { nav, useNav } from "./nav";
import "./Drawer.css";

/**
 * Drawer FRAME (MOTION-SPEC §4 camera): it lies behind the main card; opening moves the camera — the main card slides
 * right to x ≈ drawer width − 24 and scales to .96 (§8.10) with a dim, while the drawer arrives from a −20 % parallax.
 * Edge-swipe from the left edge (Shell) drags it 1:1. Tap the dimmed card or press Esc to close.
 * Content: the server-driven destinations (UiDefinitions.drawer) plus a slot screens fill with
 * registerDrawerContent(Component) (e.g. the chat builder's thread list). Conversation-first content (§8.10) that
 * renders its own compact destination row passes `{ replaceDestinations: true }`: the frame then keeps only the
 * content. No agent head: the top bar already shows the agent's face and name (draft "drawer" B), so the drawer opens
 * on its search.
 *   drawerP: 0 closed … 1 open (a MotionValue the Shell uses for the card).
 */
export const drawerP = motionValue(0);
export const DRAWER_FRACTION = 0.82;

export interface DrawerContentOptions {
  /** hide the frame's server-driven destination list (the content shows the destinations itself) */
  replaceDestinations?: boolean;
  /** @deprecated spelling — same as replaceDestinations */
  replacesDestinations?: boolean;
}
type Slot = { C: ComponentType<{ close: () => void }>; replace: boolean } | null;
const slot = createStore<Slot>(null);
export function registerDrawerContent(c: ComponentType<{ close: () => void }> | null, opts: DrawerContentOptions = {}) {
  slot.set(c ? { C: c, replace: !!(opts.replaceDestinations ?? opts.replacesDestinations) } : null);
}

export function Drawer() {
  const open = useNav((s) => s.drawer);
  const tab = useNav((s) => s.tab);
  const ui = useUi();
  const content = useStore(slot);
  const Extra = content?.C ?? null;
  const replace = !!content?.replace;
  const panel = useRef<HTMLDivElement>(null);
  const x = useTransform(drawerP, (p) => `${(-20 * (1 - p)).toFixed(3)}%`);
  // invisible below p .1, so the tail of a close (snap) never leaves a ghost of the drawer beside the card
  const opacity = useTransform(drawerP, [0, 0.1, 0.4, 1], [0, 0, 0.6, 1]);

  useEffect(() => {
    // open on the camera; close on `snap` so the card is back and undimmed within ~200 ms (no lingering overlay)
    springTo(drawerP, open ? 1 : 0, open ? "camera" : "snap");
    setOverlay("drawer", open);
    if (open) {
      haptic("impact");
      const first = panel.current?.querySelector<HTMLElement>("button");
      first?.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") nav.closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <motion.aside
      ref={panel}
      className="drawer"
      aria-label="메뉴"
      aria-hidden={!open || undefined}
      inert={!open || undefined}
      style={{ x, opacity, width: `${DRAWER_FRACTION * 100}%` }}
    >
      {!replace && (
        <nav className="drawer-list" aria-label="이동">
          {ui.drawer.map((d) => {
            const on = d.target === tab;
            return (
              <button
                key={d.id}
                type="button"
                className="drawer-item"
                data-on={on || undefined}
                aria-current={on ? "page" : undefined}
                onClick={() => {
                  if (d.target === "friends") nav.push("friends", undefined, { title: d.title });
                  else nav.setTab(d.target);
                  nav.closeDrawer();
                }}
              >
                <span className="drawer-item-icon">
                  <Icon name={d.icon} size={20} weight={on ? "semibold" : "regular"} />
                </span>
                <span className="drawer-item-title">{d.title}</span>
              </button>
            );
          })}
        </nav>
      )}
      {Extra && (
        <div className="drawer-extra" data-alone={replace || undefined}>
          <Extra close={nav.closeDrawer} />
        </div>
      )}
    </motion.aside>
  );
}
