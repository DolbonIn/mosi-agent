// Probe fixture (not part of the app): mounts ui/InvestChart over the app page served by the vite dev server, with the
// app's own tokens, theme and text size, for a browser probe of the part alone (before a screen uses it). A probe
// imports it from /qa/fixtures/invest-chart-mount.tsx. A tall spacer below lets a vertical drag scroll the host.
import { createRoot, type Root } from "react-dom/client";
import { PHONE_CARD } from "@pickle/quant";
import { InvestChart } from "../../src/ui/InvestChart";
import type { ChartInput } from "../../src/ui/investChartFit";

let root: Root | null = null;

/** `layout: "card"`: the chat card's (quant PHONE_CARD: no volume profile, no MACD); default the full view */
export function mount(input: ChartInput, props: { crosshair?: boolean; days?: boolean; width?: number; layout?: "card" } = {}) {
  let host = document.getElementById("ivc-probe");
  if (!host) {
    host = document.createElement("div");
    host.id = "ivc-probe";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:var(--bg);overflow:auto;padding:24px 16px 0";
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const { width, layout, ...rest } = props;
  root!.render(
    <>
      <div id="ivc-probe-box" style={{ width: width ? `${width}px` : "100%" }}>
        <InvestChart input={input} {...rest} {...(layout === "card" ? { layout: PHONE_CARD } : {})} />
      </div>
      <div style={{ height: 1200 }} />
    </>,
  );
}

export function unmount() {
  root?.unmount();
  root = null;
  document.getElementById("ivc-probe")?.remove();
}
