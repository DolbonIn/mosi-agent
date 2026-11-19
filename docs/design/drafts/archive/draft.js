/*
 * draft-b runtime for the de-slop mocks (connections · onboarding · explore · archive · invite-friends).
 * Load after glyphs.js and before ../_kit/kit.js:
 *   <script src="glyphs.js"></script><script src="draft.js"></script><script src="../_kit/kit.js"></script>
 *
 *  - <i data-glyph="name" data-size="22" data-weight="regular|medium|semibold"> → the app's own glyph (ui/Icon.tsx)
 *  - <i data-brand-icon="kakaotalk" data-size="30"> → the real app icon tile (assets/brands, BrandIcon.tsx geometry)
 *  - [data-disclosure] buttons toggle aria-expanded on themselves (CSS animates the panel on the morph spring)
 *  - <i data-agent data-size="208" data-eyes="dot|oval|smile" data-shape="blob|round|drop"> → the agent character, a
 *    port of ui/Avatar.tsx (the designed still / poster of the 3D blob), tinted by ?hue (default 96, as kit.js)
 *  - ?state=<name> → <html data-state="name"> so one file can show a second resting state (e.g. "end": scrolled to the
 *    bottom with the advanced group open). A file named <V>-<state>.html (an identical copy of <V>.html, which is how
 *    the viewer finds extra states) gets that state from its own name.
 */
(function () {
  const G = window.DRAFT_GLYPHS || {};
  const M = window.DRAFT_MARKS || {};
  const STROKE = { regular: (1.75 * 24) / 22, medium: (2.0 * 24) / 22, semibold: (2.3 * 24) / 22 };
  const ALIAS = { slackbot: "slack", discordbot: "discord", telegrambot: "telegram", kakao: "kakaotalk", msteams: "teams" };

  document.querySelectorAll("[data-glyph]").forEach((el) => {
    const n = el.dataset.glyph;
    if (!G[n]) console.error(`draft.js: unknown glyph "${n}"`);
    const s = Number(el.dataset.size || 22);
    const w = STROKE[el.dataset.weight] || STROKE.regular;
    const cls = el.className ? ` class="${el.className}"` : "";
    el.outerHTML = `<svg${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${G[n] || ""}</svg>`;
  });

  // ui/Avatar.tsx, verbatim geometry
  const hue = Number.isFinite(Number(new URLSearchParams(location.search).get("hue"))) && new URLSearchParams(location.search).get("hue") !== null ? Number(new URLSearchParams(location.search).get("hue")) : 96;
  const BODY = {
    blob: "M52 12C74 12.5 89 27 90 48.5C91 71 77 88.5 50 88.5C23 88.5 9 72 10 49.5C11 27.5 29 11.5 52 12Z",
    round: "M50 9C79 9 91 21 91 50C91 79 79 91 50 91C21 91 9 79 9 50C9 21 21 9 50 9Z",
    drop: "M50 7C58.5 21 88 40 88 62C88 80 72 92.5 50 92.5C28 92.5 12 80 12 62C12 40 41.5 21 50 7Z",
  };
  const EYE_Y = { blob: 48, round: 47, drop: 58 };
  let aid = 0;
  document.querySelectorAll("[data-agent]").forEach((el) => {
    const h = (((el.dataset.hue ? Number(el.dataset.hue) : hue) % 360) + 360) % 360;
    const shape = BODY[el.dataset.shape] ? el.dataset.shape : "blob";
    const eyesKind = el.dataset.eyes || "dot";
    const s = Number(el.dataset.size || 40);
    const ink = `hsl(${h} 45% 11%)`;
    const ey = EYE_Y[shape];
    const id = `ag${aid++}`;
    const eyes =
      eyesKind === "smile"
        ? `<g fill="none" stroke="${ink}" stroke-width="3.6" stroke-linecap="round"><path d="M34 ${ey + 2}q6 -6.5 12 0"/><path d="M54 ${ey + 2}q6 -6.5 12 0"/></g>`
        : [40, 60]
            .map(
              (cx) =>
                (eyesKind === "dot" ? `<circle cx="${cx}" cy="${ey}" r="5.4" fill="${ink}"/>` : `<ellipse cx="${cx}" cy="${ey}" rx="4.6" ry="7" fill="${ink}"/>`) +
                `<circle cx="${cx - 1.4}" cy="${ey - (eyesKind === "dot" ? 1.8 : 2.8)}" r="1.6" fill="#fff" opacity="0.92"/>`,
            )
            .join("");
    const hy = shape === "drop" ? 44 : 29;
    const ring = el.dataset.ring !== undefined;
    el.outerHTML =
      `<svg class="avatar${el.className ? ` ${el.className}` : ""}" width="${s}" height="${s}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">` +
      `<defs><radialGradient id="${id}b" cx="36%" cy="30%" r="78%"><stop offset="0" stop-color="hsl(${h} 92% 72%)"/><stop offset="0.55" stop-color="hsl(${h} 80% 58%)"/><stop offset="1" stop-color="hsl(${h} 70% 43%)"/></radialGradient>` +
      `<radialGradient id="${id}s" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>` +
      (ring ? `<circle cx="50" cy="50" r="50" fill="#fff"/>` : "") +
      `<g${ring ? ' transform="translate(50 52) scale(0.8) translate(-50 -50)"' : ""}><path d="${BODY[shape]}" fill="url(#${id}b)"/>` +
      `<ellipse cx="35" cy="${hy}" rx="13" ry="7.5" transform="rotate(-24 35 ${hy})" fill="url(#${id}s)"/>${eyes}</g></svg>`;
  });

  let uid = 0;
  document.querySelectorAll("[data-brand-icon]").forEach((el) => {
    const raw = el.dataset.brandIcon;
    const b = ALIAS[raw] || raw;
    if (!M[b]) console.error(`draft.js: unknown brand "${raw}"`);
    const s = Number(el.dataset.size || 30);
    const r = el.dataset.radius ? Number(el.dataset.radius) : Math.round(s * 0.27);
    const id = `bm${uid++}`;
    el.outerHTML = `<span class="brand-icon brand-icon--${b}" style="width:${s}px;height:${s}px;border-radius:${r}px" data-brand="${b}" aria-hidden="true"><svg viewBox="0 0 100 100" width="${s}" height="${s}" focusable="false">${(M[b] || "").split("__ID__").join(id)}</svg></span>`;
  });

  const q = new URLSearchParams(location.search);
  const fileState = (location.pathname.match(/\/[A-Z]-([a-z0-9-]+)\.html$/i) || [])[1] || null;
  const state = q.get("state") || fileState;
  if (state) document.documentElement.dataset.state = state;

  document.querySelectorAll("[data-disclosure]").forEach((btn) => {
    if (state && btn.dataset.openIn && btn.dataset.openIn.split(" ").includes(state)) btn.setAttribute("aria-expanded", "true");
    btn.addEventListener("click", () => {
      btn.setAttribute("aria-expanded", btn.getAttribute("aria-expanded") === "true" ? "false" : "true");
    });
  });

  // a state that rests scrolled to the end: jump there without animation once layout is ready
  if (state === "end") {
    const sc = document.querySelector(".d-scroll");
    if (sc) {
      document.documentElement.dataset.noAnim = "";
      requestAnimationFrame(() => {
        sc.scrollTop = sc.scrollHeight;
        document.querySelector(".kit-phone")?.classList.add("is-scrolled");
      });
    }
  }
  // the large title collapses into the top-bar capsule once it has scrolled under the bar (LargeTitle sentinel)
  const sc = document.querySelector(".d-scroll");
  if (sc) {
    sc.addEventListener("scroll", () => {
      document.querySelector(".kit-phone")?.classList.toggle("is-scrolled", sc.scrollTop > 60);
    }, { passive: true });
  }
})();
