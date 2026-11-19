import { registerChatScreens } from "./chat/register";
import { registerMoreScreens } from "./more/register";

/** Each screens builder owns one register module (src/screens/chat/**, src/screens/more/**). */
export function registerScreens() {
  registerChatScreens();
  registerMoreScreens();
}
