import { sessionStore } from "../../api/store";
import { registerDrawerContent } from "../../app/Drawer";
import { registerScreen, registerTabRoot, setComposeHandler } from "../../app/nav";
import { CallScreen, ChatTab, ThreadScreen } from "./ChatScreens";
import { requestComposerFocus } from "./composerStore";
import { DrawerContent } from "./DrawerContent";

/** Owned by the chat screens builder: chat tab, "thread", "call", drawer content (onboarding is gated in App.tsx). */
export function registerChatScreens() {
  registerTabRoot("chat", ChatTab);
  registerScreen("thread", ThreadScreen);
  registerScreen("call", CallScreen);
  registerDrawerContent(DrawerContent, { replaceDestinations: true });
  // nav.compose(text, threadId?) from empty states elsewhere: the draft goes into that thread's composer, nothing is sent
  setComposeHandler((text, threadId) => {
    const id = threadId ?? sessionStore.get().session?.mainThreadId;
    if (id) requestComposerFocus(id, text);
  });
}
