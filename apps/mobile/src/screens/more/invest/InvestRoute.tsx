import type { ScreenProps } from "../../../app/nav";
import { InvestScreen } from "./InvestScreen";
import { InvestSymbolScreen } from "./InvestSymbolScreen";
import { symbolTarget } from "./rules";

/** the `invest` route: 투자, or with `{ symbol }` that symbol's screen (②'s row, a chat card's 규칙 보기; DD 0914 D6) */
export function InvestRoute(props: ScreenProps) {
  return symbolTarget(props.route.params) ? <InvestSymbolScreen {...props} /> : <InvestScreen {...props} />;
}
