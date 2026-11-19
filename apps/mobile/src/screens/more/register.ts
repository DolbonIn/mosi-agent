import { lazyScreen, registerScreen, registerTabRoot } from "../../app/nav";
import { wireMoreData } from "./data";

/**
 * screens-more: 둘러보기 / 보관함 / 나의 모시 tab roots and their detail screens. Screen names are the contract other
 * builders push to (nav.push("connections") etc.).
 *
 * Every screen is its own chunk (none is on screen at first paint: tabs mount on first visit). nav prefetches all
 * lazy chunks once startup settles, and setTab / push wait for a chunk before transitioning, so nothing slides in
 * empty. The data layer stays eager: caches, live invalidation and the archive prefetch start with the session.
 * Nothing else may import these screen modules statically, or they fall back into the entry chunk.
 */
export function registerMoreScreens() {
  wireMoreData();
  registerTabRoot("explore", lazyScreen(() => import("./explore/ExploreScreen").then((m) => m.ExploreScreen)));
  registerTabRoot("archive", lazyScreen(() => import("./archive/ArchiveScreen").then((m) => m.ArchiveScreen)));
  registerTabRoot("profile", lazyScreen(() => import("./profile/ProfileScreen").then((m) => m.ProfileScreen)));
  registerScreen("connections", lazyScreen(() => import("./connections/ConnectionsScreen").then((m) => m.ConnectionsScreen)));
  registerScreen("vault", lazyScreen(() => import("./vault/VaultScreen").then((m) => m.VaultScreen)));
  registerScreen("friends", lazyScreen(() => import("./friends/FriendsScreen").then((m) => m.FriendsScreen)));
  registerScreen("schedules", lazyScreen(() => import("./schedules/SchedulesScreen").then((m) => m.SchedulesScreen)));
  registerScreen("settings.notifications", lazyScreen(() => import("./settings/NotificationsScreen").then((m) => m.NotificationsScreen)));
  registerScreen("settings.privacy", lazyScreen(() => import("./settings/PrivacyScreen").then((m) => m.PrivacyScreen)));
  registerScreen("settings.display", lazyScreen(() => import("./settings/DisplayScreen").then((m) => m.DisplayScreen)));
  registerScreen("agent", lazyScreen(() => import("./agent/AgentScreen").then((m) => m.AgentScreen)));
  registerScreen("payment", lazyScreen(() => import("./payment/PaymentScreen").then((m) => m.PaymentScreen)));
  registerScreen("account", lazyScreen(() => import("./profile/AccountScreen").then((m) => m.AccountScreen)));
}
