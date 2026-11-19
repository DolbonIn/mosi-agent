/*
 * Draft state switch (runs after ../_kit/kit.js). Static stills; the app's real motion is listed in notes.md.
 *   ?state=sheet      the ticket sheet over the hub          ?state=privacy  the 개인 정보 보호 sheet over the hub
 *   ?state=phone      the 내 전화번호 sheet over the hub      ?state=scrolled the hub scrolled to its end (31)
 *   ?state=mid        the hub scrolled to 내 계정 (30)        ?state=agent    깽이 settings (34)
 *   ?state=agent-end  깽이 settings scrolled to its skills (35)  ?state=account  내 계정 (36)
 * Scrolling collapses the large title into the top bar: [data-rest] hides, [data-scrolled] shows (per screen).
 */
(function () {
  const q = new URLSearchParams(location.search);
  const state = q.get("state") || "";
  const root = document.documentElement;
  if (state) root.dataset.state = state;

  // 깽이 colour swatches: the saved hue takes the place of the nearest preset (AgentScreen does the same)
  const hue = Number.isFinite(Number(q.get("hue"))) && q.get("hue") !== null ? Number(q.get("hue")) : 96;
  const dist = (h) => Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue));
  document.querySelectorAll(".d-hues").forEach((group) => {
    const items = [...group.querySelectorAll(".d-hue")];
    if (!items.length) return;
    const near = items.reduce((b, el) => (dist(Number(el.dataset.hue)) < dist(Number(b.dataset.hue)) ? el : b), items[0]);
    near.dataset.hue = String(hue);
    near.style.setProperty("--h", String(hue));
    near.setAttribute("aria-label", "지금 색");
    near.setAttribute("aria-checked", "true");
  });

  // live switches (skills): flip on tap
  document.querySelectorAll(".d-toggle").forEach((t) =>
    t.addEventListener("click", () => t.setAttribute("aria-checked", String(t.getAttribute("aria-checked") !== "true"))),
  );

  function scrollTo(layer, target) {
    const scope = layer ? document.querySelector(layer) : document.querySelector(".d-on-hub");
    if (!scope) return;
    const screen = scope.querySelector(".k-screen");
    const scroll = scope.querySelector(".d-scroll");
    if (!screen || !scroll) return;
    const top = parseFloat(getComputedStyle(screen).paddingTop) || 0;
    const max = Math.max(0, scroll.offsetHeight - (screen.clientHeight - top));
    let y = max;
    if (target) {
      const el = scope.querySelector(target);
      if (el) y = Math.min(max, el.getBoundingClientRect().top - scroll.getBoundingClientRect().top);
    }
    scroll.style.transform = `translateY(${-y}px)`;
    scope.querySelectorAll("[data-rest]").forEach((el) => (el.hidden = true));
    scope.querySelectorAll("[data-scrolled]").forEach((el) => (el.hidden = false));
  }
  if (state === "scrolled") scrollTo(null, null);
  if (state === "mid") scrollTo(null, "[data-mid-anchor]");
  if (state === "agent-end") scrollTo(".d-on-agent", "[data-end-anchor]");
})();
