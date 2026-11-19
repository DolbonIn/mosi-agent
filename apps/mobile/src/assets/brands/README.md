# Brand app icons

`BrandIcon` shows a messenger's real app icon (rounded tile, brand colours, official mark) next to the provider's
visible name: connections list, connect sheet, vault, chat messenger cards. It is decorative (`aria-hidden`).

- `BrandIcon.tsx`: the component, `brandOf()` / `hasBrandIcon()` (bot providers map to their brand), `preloadBrandMarks()`.
- `brand-icon.css`: tile colours. They are the brands' own and do not change with the theme. White tiles (Slack, Teams,
  Webex) get a 0.5px hairline in light mode so they don't vanish on white paper. No hairline in dark mode.
- `marks.tsx`: **generated** by `source/gen.mjs` from the files in `source/`. Path data is copied verbatim. We only
  choose placement and scale inside a 100×100 tile. It loads as its own lazy chunk (5.4 KB gzip, preloaded at idle),
  never in the entry chunk. Only `BrandIcon.tsx` + `brand-icon.css` (≈1 KB gzip together) travel with whoever imports
  them. The chat messenger card does, so they sit in the entry, and the first frame already paints the brand tile colour.
- `webex.webp`: the official Webex app icon, rasterised unaltered (`source/raster-webex.mjs`, 160 px, 3.7 KB). The
  vector original is 90 KB of layered gradients, too heavy for a 30 px tile. Imported `?no-inline`, so it is its own
  file, fetched only when a Webex tile renders.
- No remote loading at runtime. Everything ships from this folder.

Retrieved 2026-11-12. Trademarks belong to their owners. We use the marks only to identify the service the user
connects (an integration listing), unaltered, at the brand's own colours.

| Brand | Source file | Source URL | Licence / terms | What we did |
|---|---|---|---|---|
| KakaoTalk | `source/kakaotalk.simple-icons.svg` | https://cdn.jsdelivr.net/npm/simple-icons@16.37.0/icons/kakaotalk.svg (simple-icons source: https://commons.wikimedia.org/wiki/File:KakaoTalk_logo.svg) | simple-icons path data CC0-1.0. Kakao publishes no app-icon SVG, only a login symbol (https://developers.kakao.com/docs/latest/ko/kakaologin/design-guide). | Dropped the monochrome outer tile subpath. Bubble filled KakaoTalk brown `#3C1E1E` (TALK knocked out) on Kakao yellow `#FEE500` (Kakao design guide). |
| Slack | `source/slack.mark.svg` | https://a.slack-edge.com/1f40066/marketing/img/nav/logo.svg (the mark slack.com serves today) | Slack Brand Terms: https://slack.com/terms-of-service/slack-brand, media kit https://slack.com/media-kit | Mark unaltered, 60% of a white tile. |
| Discord | `source/discord.symbol.svg` | https://cdn.prod.website-files.com/6257adef93867e50d84d30e2/66e3d7f4ef6498ac018f2c55_Symbol.svg (from https://discord.com/branding) | Discord brand guidelines: https://discord.com/branding | White symbol unaltered on Blurple `#5865F2`. |
| Telegram | `source/telegram.t_logo.svg` | https://telegram.org/img/t_logo.svg | Telegram logo, trademark of Telegram (https://telegram.org/tour/screenshots) | The official plane path and gradient (`#2AABEE → #229ED9`) on a rounded tile instead of the circle, as the Telegram app icon does. |
| LINE | `source/line.simple-icons.svg` | https://cdn.jsdelivr.net/npm/simple-icons@16.37.0/icons/line.svg (path from https://line.me/en/logo) | simple-icons path data CC0-1.0. LINE logo guidelines: https://line.me/en/logo (official vector is .ai only). | White bubble on LINE green `#06C755`, sampled from the official `LINE_Brand_icon.png`. Size and position matched to that PNG. |
| Instagram | `source/instagram.glyph-white.svg` | Meta IG brand asset pack 2023 (`IG_brand_asset_pack_2023.zip`, "01 Static Glyph/02 White Glyph") from https://about.meta.com/brand/resources/instagram/instagram-brand/ | Meta brand resources terms on that page | Official white glyph unaltered. The pack has no app-icon file, so the tile gradient is matched to the pack's gradient glyph (sampled colours, `brand-icon.css`). **This gradient is our match, not a Meta file.** |
| Microsoft Teams | `source/teams_48x1.svg` | https://res-1.cdn.office.net/files/fabric-cdn-prod_20240610.001/assets/brand-icons/product/svg/teams_48x1.svg (Microsoft Fluent brand icons) | Microsoft Trademark & Brand Guidelines: https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks | Icon unaltered (one empty bounding-box path removed, gradient id made unique per instance), on a white tile. |
| Webex | `webex.webp` | https://github.com/momentum-design/momentum-design/blob/main/packages/assets/brand-visuals/src/logos/webex-app-icon-color-container.svg (Cisco Momentum brand visuals) | Repository MIT. Webex is a Cisco trademark: https://www.cisco.com/c/en/us/about/legal/trademarks.html | Rasterised unaltered at 160 px, drawn at 80% of a white tile. |
| WhatsApp | `source/whatsapp.glyph-white.svg` | Meta WhatsApp Brand Resource Center (`WhatsApp-Brand-Resource-Center.zip`, "01_Glyph/01_Digital RGB/03_SVG/Digital_Glyph_White_RGB_2026.svg") from https://about.meta.com/brand/resources/whatsapp/whatsapp-brand/ | Meta brand resources terms on that page | Official white glyph unaltered on WhatsApp green `#25D366`. |

To add a brand: put its official SVG in `source/`, add a `MARKS` entry in `source/gen.mjs`, run
`node apps/mobile/src/assets/brands/source/gen.mjs`, then add the id to `BrandId` / `ALIASES` and a tile colour to
`brand-icon.css`.
