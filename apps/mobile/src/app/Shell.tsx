import { motion, useTransform, type MotionValue } from "framer-motion";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createVelocityTracker } from "../motion/rubberBand";
import { springTo } from "../motion/springs";
import { useTier } from "../motion/tier";
import { SheetHost } from "../ui/Sheet";
import { WallpaperHost } from "../three/WallpaperHost";
import { BannerHost } from "./BannerHost";
import { setDeviceElements, setShellEl } from "./device";
import { DRAWER_FRACTION, Drawer, drawerP } from "./Drawer";
import { AgentLive } from "./AgentLive";
import { DynamicIsland } from "./DynamicIsland";
import { NavStack, type TabOverrides } from "./NavStack";
import { backSwipe } from "./navLayers";
import { nav, navStore, useNav } from "./nav";
import { BottomChrome } from "./TabBar";
import { TopBar } from "./TopBar";
import "./Shell.css";

// fine pointers only (desktop): phones never download it
const AdaptivePointer = lazy(() => import("../ui/AdaptivePointer").then((m) => ({ default: m.AdaptivePointer })));
function AdaptivePointerHost() {
  const tier = useTier();
  if (!tier.finePointer || tier.reduceMotion) return null;
  return (
    <Suspense fallback={null}>
      <AdaptivePointer />
    </Suspense>
  );
}

/**
 * The app shell.
 *   desktop (≥ 600px wide): a 402 × 874 device (r55) centred on the stage, simulated safe areas, status bar and home
 *   indicator; phone: full-bleed with env(safe-area-*) and the hardware island.
 * Layers inside the device: drawer (behind) → main card (wallpaper, nav stack, top bar group, bottom chrome group,
 * dim) → Dynamic Island → overlay layer (banners, sheets) → adaptive pointer.
 * Edge gestures (left 20px of the main card): back swipe when the tab has a pushed screen, otherwise the drawer.
 * `content` replaces the tab screens (onboarding), or per tab with a `{ chat: …, profile: … }` map (dev gallery).
 * `chrome={false}` (onboarding): no top bar, no bottom chrome, no drawer / edge gestures — the wallpaper, island,
 * banners, sheets and the device frame stay.
 */
const EDGE = 20;

export function Shell({ content, chrome = true }: { content?: ReactNode | TabOverrides; chrome?: boolean }) {
  const [frame, setFrame] = useState<"device" | "phone">(() => (typeof matchMedia !== "undefined" && matchMedia("(min-width: 600px)").matches ? "device" : "phone"));
  const device = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(402);

  useLayoutEffect(() => {
    setDeviceElements(device.current, overlay.current);
    setShellEl(shell.current);
    const el = device.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => {
      ro.disconnect();
      setShellEl(null);
    };
  }, []);

  useEffect(() => {
    const mq = matchMedia("(min-width: 600px)");
    const on = () => setFrame(mq.matches ? "device" : "phone");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // software keyboard → --kb (phone)
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const on = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      device.current?.style.setProperty("--kb", `${Math.round(kb)}px`);
    };
    vv.addEventListener("resize", on);
    vv.addEventListener("scroll", on);
    return () => {
      vv.removeEventListener("resize", on);
      vv.removeEventListener("scroll", on);
    };
  }, []);

  // bars-free (onboarding): make sure no drawer is left open underneath
  useEffect(() => {
    if (!chrome && navStore.get().drawer) nav.closeDrawer();
  }, [chrome]);

  const drawerW = width * DRAWER_FRACTION;
  const x = useTransform(drawerP, (p) => p * (drawerW - width * 0.03 + 10));
  const scale = useTransform(drawerP, [0, 1], [1, 0.96]); // §8.10: .96 keeps text crisp
  // rounded only while the drawer is open (a rounded overflow clip at rest would break the bar groups' clipped
  // backdrop-filter in Chromium; the device's own corners are painted by .device-corners instead of clipped)
  const radius = useTransform(drawerP, (p) => Math.min(1, p * 3) * (frame === "device" ? 55 : 44));
  const dim = useTransform(drawerP, (p) => Math.max(0, (p - 0.05) / 0.95)); // gone before the close spring's tail
  const dimEvents = useTransform(drawerP, (p) => (p > 0.01 ? "auto" : "none"));

  // ── edge gestures ──
  const g = useRef<{ pid: number; x0: number; y0: number; mode: "pending" | "back" | "drawer" | "close" | "none"; p0: number; vt: ReturnType<typeof createVelocityTracker> } | null>(null);
  const onPointerDownCapture = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!chrome || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    const box = card.current!.getBoundingClientRect();
    const open = navStore.get().drawer;
    if (open) {
      g.current = { pid: e.pointerId, x0: e.clientX, y0: e.clientY, mode: "close", p0: drawerP.get(), vt: createVelocityTracker() };
      return;
    }
    if (e.clientX - box.left > EDGE) return;
    g.current = { pid: e.pointerId, x0: e.clientX, y0: e.clientY, mode: "pending", p0: drawerP.get(), vt: createVelocityTracker() };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = g.current;
    if (!s || s.pid !== e.pointerId) return;
    const dx = e.clientX - s.x0;
    const dy = e.clientY - s.y0;
    if (s.mode === "pending" || (s.mode === "close" && !card.current!.hasPointerCapture(e.pointerId))) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        g.current = s.mode === "close" ? s : null;
        if (s.mode !== "close") return;
        return;
      }
      if (s.mode === "pending") s.mode = backSwipe.begin(width) ? "back" : "drawer";
      try {
        card.current!.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    s.vt.push(dx, e.timeStamp);
    if (s.mode === "back") backSwipe.move(dx);
    else if (s.mode === "drawer" || s.mode === "close") {
      drawerP.stop();
      drawerP.set(Math.max(0, Math.min(1, s.p0 + dx / drawerW)));
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = g.current;
    if (!s || s.pid !== e.pointerId) return;
    g.current = null;
    const dx = e.clientX - s.x0;
    const v = e.type === "pointercancel" ? 0 : s.vt.velocity(e.timeStamp);
    const captured = card.current!.hasPointerCapture(e.pointerId);
    if (s.mode === "back") {
      backSwipe.end(dx, v);
    } else if ((s.mode === "drawer" || s.mode === "close") && captured) {
      const projected = drawerP.get() + (v * 0.18) / drawerW;
      const open = projected > 0.5;
      const vel = v / drawerW;
      if (open !== navStore.get().drawer) {
        if (open) nav.openDrawer();
        else nav.closeDrawer();
      }
      springTo(drawerP, open ? 1 : 0, open ? "camera" : "snap", { velocity: vel });
    }
  };

  return (
    <div className="stage" data-frame={frame}>
      <div className="device-wrap">
      <div ref={device} className="device">
        {chrome && <Drawer />}
        <motion.div
          ref={card}
          className="main-card"
          style={{ x, scale, borderRadius: radius }}
          onPointerDownCapture={onPointerDownCapture}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div ref={shell} id="app-shell" className="app-shell">
            <WallpaperHost />
            <NavStack override={content} />
            {chrome && <TopBar />}
            {chrome && <BottomChrome />}
          </div>
          <MainDim dim={dim} events={dimEvents} />
        </motion.div>
        {frame === "device" && <StatusBar />}
        <DynamicIsland />
        <AgentLive />
        <div ref={overlay} className="overlay-layer">
          <BannerHost />
          <SheetHost />
        </div>
        <AdaptivePointerHost />
        {frame === "device" && <div className="home-indicator" aria-hidden="true" />}
        {frame === "device" && <div className="device-corners" aria-hidden="true" />}
      </div>
      </div>
    </div>
  );
}

function StatusBar() {
  return (
    <div className="status-bar" aria-hidden="true">
      <span className="status-time tnum">9:41</span>
      <span className="status-glyphs">
        <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor">
          <rect x="0" y="8" width="3" height="4" rx="1" />
          <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
          <rect x="10" y="3" width="3" height="9" rx="1" />
          <rect x="15" y="0" width="3" height="12" rx="1" />
        </svg>
        <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor">
          <path d="M8 2.2c2.4 0 4.6.9 6.2 2.5l1.3-1.3A10.6 10.6 0 0 0 8 .4C5.1.4 2.5 1.5.5 3.4l1.3 1.3A8.8 8.8 0 0 1 8 2.2Zm0 3.6c1.4 0 2.7.5 3.7 1.5L13 6a7 7 0 0 0-10 0l1.3 1.3c1-1 2.3-1.5 3.7-1.5Zm0 3.6c-.6 0-1.2.2-1.6.7L8 11.7l1.6-1.6c-.4-.5-1-.7-1.6-.7Z" />
        </svg>
        <svg width="27" height="13" viewBox="0 0 27 13" fill="none">
          <rect x="0.5" y="0.5" width="23" height="12" rx="3.8" stroke="currentColor" opacity="0.4" />
          <rect x="2" y="2" width="20" height="9" rx="2.5" fill="currentColor" />
          <path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="currentColor" opacity="0.45" />
        </svg>
      </span>
    </div>
  );
}

/** the card's dim while the drawer is open; once a close starts the content is live again at once (the dim no longer
 * swallows taps while the card returns). Its own component so a drawer toggle re-renders only this. */
function MainDim({ dim, events }: { dim: MotionValue<number>; events: MotionValue<"none" | "auto"> }) {
  const open = useNav((s) => s.drawer);
  return <motion.div className="main-dim" style={{ opacity: dim, pointerEvents: open ? events : "none" }} onClick={() => nav.closeDrawer()} aria-hidden="true" />;
}
