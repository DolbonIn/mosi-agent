import { useEffect, useRef } from "react";
import type { AppIconName } from "../ui/Icon";
import { createStore, useStore } from "../lib/createStore";
import { useRouteActiveSource } from "./routeActive";

/**
 * What the floating top bar shows (TopBar.tsx reads this):
 *   - `title`: the compact title a LargeTitle hands over when it scrolls under the bar (the centre swaps to these
 *     words as plain text, by the content-swap rule; MOTION-SPEC §8.17).
 *   - `right`: the trailing capsule ("초대", a share circle …). Screens set it with useTopBarRight().
 *   - `onCenter`: what tapping the agent (face + name, 채팅's root only) does (the chat screen opens the agent sheet).
 */
export interface TopBarAction {
  label?: string;
  icon?: AppIconName;
  ariaLabel?: string;
  /** the label's colour: "danger" for a state the person must not miss (투자's "실제 주문", DD 1935 §3-1); default
   * --label. A new label or tone on the same capsule morphs it (colour + content swap), never a second capsule. */
  tone?: "danger";
  /** what a tap does; absent, the capsule is a status, not a button: no press, no cursor, no role (DD 2008 §1), and
   * `ariaLabel` is what assistive tech reads in place of the label */
  onPress?: (el: HTMLElement) => void;
}

export interface TopBarState {
  title: string | null;
  titleOwner: string | null;
  right: TopBarAction | null;
  onCenter: ((el: HTMLElement) => void) | null;
}

export const topBarStore = createStore<TopBarState>({ title: null, titleOwner: null, right: null, onCenter: null });
export const useTopBar = () => useStore(topBarStore);

export function setCompactTitle(owner: string, title: string | null) {
  const s = topBarStore.get();
  if (title === null) {
    if (s.titleOwner === owner) topBarStore.patch({ title: null, titleOwner: null });
    return;
  }
  if (s.title !== title || s.titleOwner !== owner) topBarStore.patch({ title, titleOwner: owner });
}

/**
 * Set the trailing capsule while this screen is the visible route (re-applied when its tab / layer is shown again).
 * Activation is followed by subscription, so a tab switch does not re-render the calling screen.
 */
export function useTopBarRight(action: TopBarAction | null) {
  const ref = useRef(action);
  ref.current = action;
  const label = action?.label;
  const icon = action?.icon;
  const tone = action?.tone;
  const pressable = !!action?.onPress;
  const has = !!action;
  const src = useRouteActiveSource();
  useEffect(() => {
    if (!has) return;
    const stable: TopBarAction = {
      label,
      icon,
      tone,
      ariaLabel: ref.current?.ariaLabel,
      onPress: pressable ? (el) => ref.current?.onPress?.(el) : undefined,
    };
    const release = () => {
      if (topBarStore.get().right === stable) topBarStore.patch({ right: null });
    };
    const apply = () => (src.get() ? topBarStore.patch({ right: stable }) : release());
    apply();
    const off = src.subscribe(apply);
    return () => {
      off();
      release();
    };
  }, [has, label, icon, tone, pressable, src]);
}

/** Set what tapping the centre's agent (face + name, shown at 채팅's root) does while this screen is the visible route. */
export function useTopBarCenter(onCenter: ((el: HTMLElement) => void) | null) {
  const ref = useRef(onCenter);
  ref.current = onCenter;
  const has = !!onCenter;
  const src = useRouteActiveSource();
  useEffect(() => {
    if (!has) return;
    const fn = (el: HTMLElement) => ref.current?.(el);
    const release = () => {
      if (topBarStore.get().onCenter === fn) topBarStore.patch({ onCenter: null });
    };
    const apply = () => (src.get() ? topBarStore.patch({ onCenter: fn }) : release());
    apply();
    const off = src.subscribe(apply);
    return () => {
      off();
      release();
    };
  }, [has, src]);
}
