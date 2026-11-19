import { animate, cancelFrame, frame, motion, useMotionValue, useTransform, type MotionValue } from "framer-motion";
import { isValidElement, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { TabId } from "@pickle/protocol";
import { EXIT, SPRING, springTo } from "../motion/springs";
import { getTier } from "../motion/tier";
import { getScreen, getTabRoot, navStore, setOverriddenTabs, TAB_ORDER, tabSwitchedAt, useNav, useRegistryVersion, type Route } from "./nav";
import { layers, mv, rootKey } from "./navLayers";
import { createActiveSource, RouteActiveContext } from "./routeActive";
import { prefetchLazyScreens } from "./startup";
import "./NavStack.css";

/**
 * Renders the tabs and their stacks.
 *  - Tabs stay mounted once visited (state is preserved, HIG). Switching (MOTION-SPEC §8.2): the old page is removed
 *    at once (no exit, no blur); the new one enters with opacity 0→1 in 180 ms linear + y 6→0 on the camera spring.
 *    The droplet in the tab bar carries the direction. No page-sized `filter` animation anywhere.
 *  - Push: the detail arrives from 40px (camera) while the list recedes 24px and fades; pop reverses.
 *  - Back swipe from the left edge drags the detail 1:1 (the list underneath comes forward with it); release is
 *    projected along the velocity → pop (continuing at the finger's speed) or settle back.
 * `override` replaces the tab content entirely (onboarding); a per-tab map `{ chat: <Gallery/>, … }` replaces only
 * those tabs' roots and keeps the real tab layers + transitions (the dev gallery uses it).
 */
export type TabOverrides = Partial<Record<TabId, ReactNode>>;
const isTabMap = (o: unknown): o is TabOverrides =>
  !!o && typeof o === "object" && !isValidElement(o) && !Array.isArray(o) && Object.keys(o).every((k) => (TAB_ORDER as string[]).includes(k));

export function NavStack({ override }: { override?: ReactNode | TabOverrides }) {
  const tab = useNav((s) => s.tab);
  const [visited, setVisited] = useState<TabId[]>([tab]);
  useEffect(() => {
    setVisited((v) => (v.includes(tab) ? v : [...v, tab]));
  }, [tab]);
  useRegistryVersion();
  // lazyScreen() chunks come in on idle once the first screen is up, so a push / tab switch rarely waits for one
  useEffect(() => {
    void prefetchLazyScreens();
  }, []);
  // tabs whose root is replaced (gallery) never wait for their registered root's chunk
  const overridden = isTabMap(override) ? (Object.keys(override) as TabId[]).join() : override ? TAB_ORDER.join() : "";
  useLayoutEffect(() => {
    setOverriddenTabs(overridden ? (overridden.split(",") as TabId[]) : []);
  }, [overridden]);

  if (isTabMap(override)) {
    return (
      <div className="nav-root">
        {TAB_ORDER.filter((t) => visited.includes(t)).map((t) => (
          <TabLayer key={t} tab={t} active={t === tab} content={override[t]} />
        ))}
      </div>
    );
  }
  if (override) {
    return (
      <div className="nav-root">
        <div className="tab-layer" data-active="">
          {override}
        </div>
      </div>
    );
  }
  return (
    <div className="nav-root">
      {TAB_ORDER.filter((t) => visited.includes(t)).map((t) => (
        <TabLayer key={t} tab={t} active={t === tab} />
      ))}
    </div>
  );
}

/**
 * §8.2 tab enter — FIRST visit only: opacity on a 0→1 / 180 ms linear ramp timed from the tap (what the eye reads) +
 * a 6px rise on `camera`. Every frame reads the clock (floor .12, so the first frame already shows the page): a first
 * render or frames that land late no longer push the whole fade back. The old ramp ran .12 → 1 from the commit; in
 * WebKit under load the first frame came 40-90 ms after the tap and the page still read .12 at 80 ms, opaque ~240 ms.
 * Returning to a visited tab shows it complete on the first frame (no re-entrance): the user saw content that had
 * been on screen come back faded/"closed" for a moment and rejected it.
 */
const TAB_ENTER_FROM = 0.12;
const TAB_ENTER_MS = 180;
const POP_EXIT = { duration: 0.14, ease: [0, 0, 0.2, 1] } as const;

/** the entrance ramp, set from the clock now and on every frame until it is whole; returns its stop */
function rampFromTap(o: MotionValue<number>, at: number): () => void {
  const from = at > 0 && at <= performance.now() ? at : performance.now();
  const value = () => Math.min(1, Math.max(TAB_ENTER_FROM, (performance.now() - from) / TAB_ENTER_MS));
  const tick = () => {
    const v = value();
    o.set(v);
    if (v >= 1) cancelFrame(tick);
  };
  o.set(value());
  frame.update(tick, true);
  return () => cancelFrame(tick);
}

function TabLayer({ tab, active, content }: { tab: TabId; active: boolean; content?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // a tab visited for the first time mounts already active: it still enters (only the app's first tab doesn't)
  const entering = useRef(active && navStore.get().last === "tab" && !getTier().reduceMotion);
  const l = mv(`tab:${tab}`, { x: 0, o: active && !entering.current ? 1 : entering.current ? TAB_ENTER_FROM : 0 });
  const y = useMotionValue(entering.current ? 6 : 0);
  const prev = useRef<boolean | null>(null);
  // the entrance ramp stops itself once whole (no unmount cleanup: StrictMode's re-run would end it at .12)
  const stopRamp = useRef<(() => void) | null>(null);
  const [activeSrc] = useState(() => createActiveSource(active));
  useLayoutEffect(() => activeSrc.set(active), [active, activeSrc]);

  useLayoutEffect(() => {
    // react to real changes of `active` only (StrictMode runs this twice on mount with the same value)
    if (prev.current === active) return;
    const firstRun = prev.current === null;
    prev.current = active;
    if (firstRun) {
      if (entering.current) {
        stopRamp.current = rampFromTap(l.o, tabSwitchedAt());
        springTo(y, 0, "camera");
      }
      return;
    }
    stopRamp.current?.();
    stopRamp.current = null;
    if (!active) {
      // removed at once: no exit, no blur
      l.o.stop();
      y.stop();
      l.o.jump(0);
      y.jump(0);
      return;
    }
    // a visited tab comes back as it was, on the first frame
    l.o.stop();
    y.stop();
    l.o.jump(1);
    y.jump(0);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <motion.div
      ref={ref}
      className="tab-layer"
      data-active={active || undefined}
      aria-hidden={!active || undefined}
      inert={!active || undefined}
      style={{ x: l.x, y, opacity: l.o, visibility: active ? "visible" : "hidden" }}
    >
      <RouteActiveContext.Provider value={activeSrc}>{content ?? <Stack tab={tab} />}</RouteActiveContext.Provider>
    </motion.div>
  );
}

interface Rendered {
  route: Route;
  leaving: boolean;
}

function Stack({ tab }: { tab: TabId }) {
  const stack = useNav((s) => s.stacks[tab]);
  const [rendered, setRendered] = useState<Rendered[]>(() => stack.map((route) => ({ route, leaving: false })));
  const prev = useRef(stack);

  // reconcile: pushed routes mount and animate in; popped ones play their exit before unmounting
  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = stack;
    if (before === stack) return;
    const { instant } = navStore.get();
    const reduce = getTier().reduceMotion || instant;
    const keys = new Set(stack.map((r) => r.key));
    const added = stack.filter((r) => !before.some((b) => b.key === r.key));
    const removed = before.filter((b) => !keys.has(b.key));
    const under = (i: number) => (i > 0 ? stack[i - 1]!.key : rootKey(tab));

    for (const r of added) {
      const i = stack.indexOf(r);
      const top = mv(r.key, reduce ? { x: 0, o: 1 } : { x: 40, o: 0 });
      const below = mv(under(i));
      if (reduce) {
        below.o.set(0);
      } else {
        springTo(top.x, 0, "camera");
        animate(top.o, 1, { ...SPRING.fade, delay: 0.06 });
        springTo(below.x, -24, "camera");
        animate(below.o, 0, EXIT);
      }
    }
    if (removed.length) {
      const newTop = stack.length ? stack[stack.length - 1]!.key : rootKey(tab);
      const nt = mv(newTop);
      for (const r of removed) {
        const l = layers.get(r.key);
        if (!l || reduce) continue;
        springTo(l.x, 40, "camera");
        // the leaving page clears out fast (ease-out) so it never sits over the page coming back
        animate(l.o, 0, POP_EXIT);
      }
      if (instant && !getTier().reduceMotion) {
        // the back swipe already brought the layer underneath forward; finish its opacity now
        nt.o.stop();
        nt.o.jump(1);
      } else if (reduce) {
        nt.x.set(0);
        nt.o.set(1);
      } else {
        // the page underneath was on screen before: it is complete on the first frame of the pop (no fade-in, no
        // delay — a 60 ms delay + fade read as a blank "closed" page); only its 24 px parallax slides back
        nt.o.stop();
        nt.o.jump(1);
        springTo(nt.x, 0, "camera");
      }
    }
    setRendered((cur) => {
      const next: Rendered[] = stack.map((route) => ({ route, leaving: false }));
      if (!reduce) for (const r of removed) next.push({ route: r, leaving: true });
      return next.length === cur.length && next.every((n, i) => n.route.key === cur[i]?.route.key && n.leaving === cur[i]?.leaving) ? cur : next;
    });
    if (!reduce && removed.length) {
      const t = window.setTimeout(() => {
        setRendered((cur) => cur.filter((x) => !x.leaving));
        for (const r of removed) layers.delete(r.key);
      }, 450);
      return () => window.clearTimeout(t);
    }
    for (const r of removed) layers.delete(r.key);
  }, [stack, tab]);

  const Root = getTabRoot(tab);
  const rootRoute: Route = { key: rootKey(tab), screen: `${tab}.root` };
  const topKey = stack.length ? stack[stack.length - 1]!.key : rootRoute.key;
  return (
    <>
      <Layer route={rootRoute} isTop={topKey === rootRoute.key}>
        {Root ? <Root route={rootRoute} /> : null}
      </Layer>
      {rendered.map(({ route, leaving }) => {
        const S = getScreen(route.screen);
        return (
          <Layer key={route.key} route={route} isTop={!leaving && topKey === route.key} leaving={leaving}>
            {S ? <S route={route} /> : <MissingScreen name={route.screen} />}
          </Layer>
        );
      })}
    </>
  );
}

function Layer({ route, isTop, leaving, children }: { route: Route; isTop: boolean; leaving?: boolean; children: ReactNode }) {
  const l = mv(route.key);
  const tabSrc = useContext(RouteActiveContext);
  const [activeSrc] = useState(() => createActiveSource(isTop, tabSrc));
  useLayoutEffect(() => activeSrc.set(isTop), [isTop, activeSrc]);
  const visibility = useTransform(l.o, (o) => (o <= 0.001 && !isTop ? "hidden" : "visible"));
  return (
    <motion.section
      className="stack-layer"
      data-top={isTop || undefined}
      data-leaving={leaving || undefined}
      aria-hidden={!isTop || undefined}
      inert={!isTop || undefined}
      style={{ x: l.x, opacity: l.o, visibility }}
    >
      <RouteActiveContext.Provider value={activeSrc}>{children}</RouteActiveContext.Provider>
    </motion.section>
  );
}

function MissingScreen({ name }: { name: string }) {
  return (
    <div style={{ padding: "140px 24px", color: "var(--label-2)", textAlign: "center" }}>
      <p>등록되지 않은 화면이에요</p>
      <p className="t-footnote">{name}</p>
    </div>
  );
}
