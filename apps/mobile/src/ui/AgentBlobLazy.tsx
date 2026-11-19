import type { AvatarSpec } from "@pickle/protocol";
import { motion } from "framer-motion";
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { afterStartupEffects } from "../app/startup";
import { SPRING } from "../motion/springs";
import { useTierValue } from "../motion/tier";
import { Avatar, DEFAULT_AVATAR } from "./Avatar";

/**
 * The agent character with a designed still first (MOTION-SPEC §7): the SVG Avatar paints immediately; the 3D
 * AgentBlob chunk (three + R3F) loads only when optional effects are on and WebGL2 exists, once startup is over
 * (app/startup.ts: after load, the first screen's reads and the lazy-screen prefetch), then fades in on `fade` once its first frame is drawn. Context loss or any error → the poster stays.
 * This file must never import three or @react-three/fiber statically.
 */
const AgentBlob = lazy(() => import("../three/AgentBlob"));

let webgl2: boolean | null = null;
function hasWebGL2(): boolean {
  if (webgl2 !== null) return webgl2;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    webgl2 = !!gl;
    if (gl) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
      if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) webgl2 = false;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    webgl2 = false;
  }
  return webgl2;
}

class Boundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export interface AgentBlobLazyProps {
  size?: number;
  spec?: AvatarSpec;
  /** 0..1 voice amplitude */
  amplitude?: number;
  className?: string;
  /** accessible name for the character */
  label?: string;
}


export function AgentBlobLazy({ size = 160, spec = DEFAULT_AVATAR, amplitude = 0, className, label }: AgentBlobLazyProps) {
  const effects = useTierValue("effects");
  const [mount, setMount] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [posterGone, setPosterGone] = useState(false);
  const live = effects === "live" && !failed;

  useEffect(() => {
    if (!live || mount || !hasWebGL2()) return;
    let cancelled = false;
    void afterStartupEffects().then(() => !cancelled && setMount(true));
    return () => {
      cancelled = true;
    };
  }, [live, mount]);

  const showCanvas = live && mount;
  const lose = () => {
    setFailed(true);
    setReady(false);
    setPosterGone(false);
  };

  return (
    <div
      className={className}
      style={{ position: "relative", width: size, height: size, flex: "none" }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", visibility: posterGone && showCanvas ? "hidden" : undefined }}>
        <Avatar spec={spec} size={size} />
      </div>
      {showCanvas ? (
        <Boundary onError={lose}>
          <Suspense fallback={null}>
            <motion.div
              style={{ position: "absolute", inset: 0 }}
              initial={{ opacity: 0 }}
              animate={{ opacity: ready ? 1 : 0 }}
              transition={SPRING.fade}
              onAnimationComplete={() => {
                if (ready) setPosterGone(true);
              }}
            >
              <AgentBlob size={size} spec={spec} amplitude={amplitude} onReady={() => setReady(true)} onLost={lose} />
            </motion.div>
          </Suspense>
        </Boundary>
      ) : null}
    </div>
  );
}
