/*
 * Draft state + interaction (runs after ../_kit/kit.js).
 *   ?state=confirm        the "보내기 전에 묻기" off-confirm is open (A: a sheet from the toggle, B: the row grows in place)
 *   ?state=off            the switch is off (reversible: turning it back on needs no confirm)
 *   ?state=notifications  알림 설정 instead of 정보 공개 범위
 *   ?state=display        화면 및 디자인 (48); the theme note follows ?theme (라이트 / 다크)
 * The page is also live: every toggle flips, the guarded one asks first, and text tied to a toggle swaps with it.
 */
(function () {
  const root = document.documentElement;
  const state = new URLSearchParams(location.search).get("state") || "";
  if (state) root.dataset.state = state;
  const inline = document.querySelector(".d-inline-confirm");
  const guard = document.querySelector(".d-toggle[data-guard]");

  function sync(t) {
    const on = t.getAttribute("aria-checked") === "true";
    document.querySelectorAll(`[data-for="${t.id}"]`).forEach((el) => {
      el.hidden = (el.dataset.show === "on") !== on;
      if (el.matches("dd")) el.toggleAttribute("data-on", on && el.dataset.show === "on");
    });
  }
  function set(t, on) {
    t.setAttribute("aria-checked", String(on));
    sync(t);
  }
  // B (inline): opening by hand moves focus to 취소; 취소, 끄기 or Esc closes it and returns focus to the switch.
  // The ?state=confirm still is drawn without focus so the capture shows no focus ring.
  function openConfirm(byHand) {
    if (inline) {
      inline.closest("[data-confirm-host]").setAttribute("data-confirming", "");
      if (byHand) inline.querySelector('[data-act="cancel"]').focus();
    } else root.dataset.state = "confirm";
  }
  function closeConfirm() {
    if (inline) {
      const host = inline.closest("[data-confirm-host]");
      if (!host.hasAttribute("data-confirming")) return;
      host.removeAttribute("data-confirming");
      if (guard) guard.focus();
    } else if (root.dataset.state === "confirm") {
      delete root.dataset.state;
      if (guard) guard.focus();
    }
  }

  document.querySelectorAll(".d-toggle").forEach((t) => {
    sync(t);
    t.addEventListener("click", () => {
      if (t.disabled) return;
      const on = t.getAttribute("aria-checked") === "true";
      if (t.hasAttribute("data-guard") && on) return openConfirm(true);
      set(t, !on);
    });
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeConfirm());
  document.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.act === "off" && guard) set(guard, false);
      closeConfirm();
    }),
  );

  if (state === "off" && guard) set(guard, false);
  if (state === "confirm") openConfirm();
})();
