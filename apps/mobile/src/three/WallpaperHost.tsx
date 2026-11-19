import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { useAgent } from "../api/store";
import "./Wallpaper.css";

/**
 * The wallpaper (MOTION-SPEC §0): `--bg` plus one soft light from above tinted by the agent's colour — CSS only, in
 * the first-load chunk, painted with the first frame. No WebGL, no drift, no parallax, no rAF: nothing runs at rest.
 * The agent's hue (profile colour dots) arrives with the session; before that, and for an agent without a colour, the
 * light is neutral. When the hue changes later (the user saves a new colour) the light re-tints once on the camera
 * curve (Wallpaper.css; instant under reduced motion).
 */
export function WallpaperHost() {
  const hue = useAgent()?.avatar?.hue;
  const el = useRef<HTMLDivElement>(null);
  const prev = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const host = el.current;
    const was = prev.current;
    prev.current = hue;
    if (!host) return;
    // the first hue (session load) paints as is; only a change re-tints on the curve
    if (was === undefined || hue === undefined || was === hue) {
      delete host.dataset.tintAnim;
      return;
    }
    host.dataset.tintAnim = "";
    const t = setTimeout(() => delete host.dataset.tintAnim, 1000);
    return () => clearTimeout(t);
  }, [hue]);

  const tinted = typeof hue === "number" && Number.isFinite(hue);
  return (
    <div
      ref={el}
      className="wallpaper"
      data-wallpaper="css"
      data-tint={tinted ? "" : undefined}
      style={tinted ? ({ "--wp-hue": ((hue % 360) + 360) % 360 } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      <div className="wallpaper-light" />
    </div>
  );
}
