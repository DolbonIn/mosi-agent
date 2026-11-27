import { useTopBarRight } from "../../../app/topBarStore";
import { useInvestLive } from "../data";

/**
 * The order mode on the top bar's right of the 투자 screens (DD 1935 §3-1): 모의 주문 (--label) or 실제 주문 (--danger),
 * always there, the same element as the mode changes (useTopBarRight keeps it and its colour follows). Pressed, it
 * opens 투자 설정's 주문 모드 (DD 2008 §1's next part); on 투자 설정 itself it only says the mode.
 */
export function useModeCapsule(onPress?: (el: HTMLElement) => void) {
  const real = useInvestLive();
  useTopBarRight({
    label: real ? "실제 주문" : "모의 주문",
    tone: real ? "danger" : undefined,
    ariaLabel: real ? "지금은 실제 주문이에요" : "지금은 모의 주문이에요",
    onPress,
  });
}
