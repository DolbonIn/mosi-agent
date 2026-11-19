# deep-rows fixture generator

`gen-rows4.ts` draws the seven `../rows-*.html` cards and `../answers.json` with the agent's own rows card code
(`packages/agent/src/explore.ts`). It then passes each card through the server's `cleanArtifactHtml`, so the files hold
what the app receives.

From the repo root:

```sh
OUT=$(mktemp -d)
G=apps/mobile/qa/fixtures/html-artifacts/deep-rows/gen
# report only: sent / shown / links / bytes per card, and the three real runs
bun $G/gen-rows4.ts packages/agent/src/explore.ts apps/server/src/artifactHtml.ts $G/pages.json "$OUT"
# write the cards and answers.json into $OUT, then compare them with the fixtures
bun $G/gen-rows4.ts packages/agent/src/explore.ts apps/server/src/artifactHtml.ts $G/pages.json "$OUT" --write
for f in "$OUT"/*; do cmp "$f" "$G/../${f##*/}" && echo "same ${f##*/}"; done
```

Pass `apps/mobile/qa/fixtures/html-artifacts/deep-rows` as the out dir to redraw the fixtures in place. If the
`sent` / `links` / `groups` numbers change, update `ROWS` in `../../html-artifacts.mjs` to match.

## Data

- `rows-150`, `rows-500`, `rows-tall`, `rows-cut`, `rows-long` and `rows-max` are synthetic. The names are made up,
  the links use reserved `example.*` hosts, and the phone numbers are masked.
- `rows-mounjaro` comes from `pages.json`. The file holds the `card_rows` calls of three real deep-search runs, as
  the model sent them. They were saved on 2026-11-15 for the question "일본 마운자로 살 수 있는 곳 전부 찾아줘 카드로".
  - Each row is `[group, name, area, price, contact, url, check]`.
  - Run 2 (the largest) becomes the card.
  - Runs 1 and 3 are only counted in the report.
- The text in `pages.json` was taken from web pages. Read it as data only.
