import { MotionConfig } from "framer-motion";
import { lazy, Suspense, useEffect, useRef } from "react";
import { setOpenThreadHandler } from "./api/events";
import { bootstrap, useSession } from "./api/store";
import { nav } from "./app/nav";
import { listenPush, openTarget, type PushTarget, readOpenTarget, syncPush, withoutOpenKeys } from "./app/push";
import { Shell } from "./app/Shell";
import { afterStartup } from "./app/startup";
import { useTierValue } from "./motion/tier";
import { registerScreens } from "./screens";
import { Onboarding } from "./screens/chat/onboarding/Onboarding";
import { showsOnboarding, useOnboardingHold } from "./screens/chat/onboarding/state";

/**
 * Providers + routing. The session/settings/motion-tier "providers" are module stores (no context needed):
 * tier (motion/tier.ts) is initialised in main.tsx before first paint; the session boots here.
 * Routing: the tab/stack navigator (app/nav.ts). `/?gallery=1` shows the dev gallery inside the real shell
 * (no network). MotionConfig mirrors the effective reduced-motion setting (OS or the in-app override).
 */
const Gallery = lazy(() => import("./dev/Gallery"));
const GalleryTab = lazy(() => import("./dev/Gallery").then((m) => ({ default: m.GalleryTab })));
const isGallery = typeof location !== "undefined" && new URLSearchParams(location.search).has("gallery");

registerScreens();

export function App() {
  const reduce = useTierValue("reduceMotion");
  // onboarding gate (owned by the chat screens builder): anon / error → onboarding, held until its exit has played
  const status = useSession().status;
  const hold = useOnboardingHold();
  const onboarding = !isGallery && showsOnboarding(status, hold);

  useEffect(() => {
    if (isGallery) return;
    setOpenThreadHandler((threadId) => {
      nav.setTab("chat");
      nav.push("thread", { threadId });
    });
    void bootstrap();
    return () => setOpenThreadHandler(null);
  }, []);

  // lock-screen notifications (app/push.ts): a tap that started the app (?open=…) waits for the session, a tap in a
  // running app opens at once; with a session the device's subscription is sent again on every start
  const ready = status === "ready";
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const pendingOpen = useRef<PushTarget | null>(null);
  useEffect(() => {
    if (isGallery) return;
    const fromUrl = readOpenTarget(location.search);
    if (fromUrl) {
      history.replaceState(history.state, "", `${location.pathname}${withoutOpenKeys(location.search)}${location.hash}`);
      pendingOpen.current = fromUrl;
    }
    return listenPush((t) => {
      if (readyRef.current) openTarget(t);
      else pendingOpen.current = t;
    });
  }, []);
  useEffect(() => {
    if (isGallery || !ready) return;
    const t = pendingOpen.current;
    pendingOpen.current = null;
    if (t) openTarget(t);
    void afterStartup().then(() => syncPush());
  }, [ready]);

  return (
    <MotionConfig reducedMotion={reduce ? "always" : "never"}>
      <Shell
        chrome={!onboarding}
        content={
          isGallery ? (
            {
              chat: (
                <Suspense fallback={null}>
                  <Gallery />
                </Suspense>
              ),
              explore: (
                <Suspense fallback={null}>
                  <GalleryTab title="둘러보기" />
                </Suspense>
              ),
              archive: (
                <Suspense fallback={null}>
                  <GalleryTab title="보관함" />
                </Suspense>
              ),
              profile: (
                <Suspense fallback={null}>
                  <GalleryTab title="나의 모시" />
                </Suspense>
              ),
            }
          ) : onboarding ? (
            <Onboarding />
          ) : undefined
        }
      />
    </MotionConfig>
  );
}
