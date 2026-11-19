/**
 * The device element (Shell's rounded frame on desktop, the full screen on phones). Overlays (sheets, banners, the
 * adaptive pointer, the wallpaper) measure against it; portals render into its overlay layer so they stay inside the
 * device mask.
 */
let deviceEl: HTMLElement | null = null;
let overlayEl: HTMLElement | null = null;

export function setDeviceElements(device: HTMLElement | null, overlay: HTMLElement | null) {
  deviceEl = device;
  overlayEl = overlay;
}

export const getDeviceEl = () => deviceEl;
/** Portal target for sheets/banners/pointer: inside the device mask, above the shell. Falls back to <body>. */
export const getOverlayEl = () => overlayEl ?? (typeof document !== "undefined" ? document.body : null);

export function getDeviceRect(): DOMRect {
  if (deviceEl) return deviceEl.getBoundingClientRect();
  return new DOMRect(0, 0, typeof innerWidth === "number" ? innerWidth : 390, typeof innerHeight === "number" ? innerHeight : 844);
}

/** A client rect expressed relative to the device's top-left. */
export function toDevice(r: DOMRect | { left: number; top: number; width: number; height: number }) {
  const d = getDeviceRect();
  return { left: r.left - d.left, top: r.top - d.top, width: r.width, height: r.height };
}

/** The shell root (made `inert` while a modal overlay is open). */
let shellEl: HTMLElement | null = null;
export const setShellEl = (el: HTMLElement | null) => {
  shellEl = el;
};
export const getShellEl = () => shellEl;

/** Modal overlays (sheets, drawer) mark <html data-overlay> so floating effects (liquid-glass lens) step aside. */
const overlays = new Set<string>();
export function setOverlay(id: string, on: boolean) {
  if (on) overlays.add(id);
  else overlays.delete(id);
  if (typeof document === "undefined") return;
  if (overlays.size) document.documentElement.dataset.overlay = [...overlays].join(" ");
  else delete document.documentElement.dataset.overlay;
  const shell = shellEl;
  if (shell) {
    const modal = [...overlays].some((o) => o.startsWith("sheet"));
    if (modal) shell.setAttribute("inert", "");
    else shell.removeAttribute("inert");
  }
}
