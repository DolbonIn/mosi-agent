/*
 * Draft state switch (runs after ../_kit/kit.js). ?state=sheet → the 모닝콜 sheet over the list;
 * ?state=chat → the schedule card where it is made, in the conversation (critique shot 16).
 * Static stills only; the app's real motion is listed in notes.md.
 */
(function () {
  const state = new URLSearchParams(location.search).get("state") || "";
  const root = document.documentElement;
  if (state) root.dataset.state = state;
  if (state !== "scrolled") return;
  const screen = document.querySelector(".k-screen");
  const scroll = document.querySelector(".d-scroll");
  if (!screen || !scroll) return;
  const top = parseFloat(getComputedStyle(screen).paddingTop) || 0;
  const max = Math.max(0, scroll.offsetHeight - (screen.clientHeight - top));
  scroll.style.transform = `translateY(${-max}px)`;
  document.querySelectorAll("[data-rest]").forEach((el) => (el.hidden = true));
  document.querySelectorAll("[data-scrolled]").forEach((el) => (el.hidden = false));
})();
/* live toggles: flipping a schedule dims its row and swaps its meta line ("다음은 오늘" ↔ "꺼져 있어요") */
(function () {
  function sync(t) {
    const on = t.getAttribute("aria-checked") === "true";
    const row = t.closest(".d-sched");
    if (row) row.toggleAttribute("data-off", !on);
    document.querySelectorAll(`[data-for="${t.id}"]`).forEach((el) => (el.hidden = (el.dataset.show === "on") !== on));
  }
  document.querySelectorAll(".d-toggle").forEach((t) => {
    sync(t);
    t.addEventListener("click", () => {
      t.setAttribute("aria-checked", String(t.getAttribute("aria-checked") !== "true"));
      sync(t);
    });
  });
})();
/* tapping a row opens its sheet, the close button or the scrim closes it (the still for ?state=sheet is the same layer) */
(function () {
  const root = document.documentElement;
  document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => (root.dataset.state = "sheet")));
  document.querySelectorAll(".d-sheet-close, .d-scrim").forEach((b) => b.addEventListener("click", () => delete root.dataset.state));
})();
