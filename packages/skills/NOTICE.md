# Third-party notices — @pickle/skills

This package calls the hosted k-skill proxy over HTTP (no proxy code is vendored) and contains TypeScript ports of
helper logic from the MIT-licensed projects below. No dependency on any of them is installed.

| Where | Ported from | Licence |
| --- | --- | --- |
| `src/tools/*` (tool shapes, proxy routes) | NomaDamas/k-skill skills (`*/instruction.md`, helper scripts) | MIT, "Copyright (c) 2026" (NomaDamas/k-skill LICENSE) |
| `src/connected/toss.ts` | k-skill `packages/toss-investment/src/official-client.js` (token, re-issue, account header, read-only surface) | MIT, same |
| `src/connected/naverad.ts` | k-skill `naver-ad-performance` (signature, stats fields); upstream credits NariP/naver-searchad (MIT) for the signing design | MIT, same |
| `src/connected/popbill.ts` | Linkhub `linkhub` 1.6.0 (`linkhub.py`: token HMAC) and `popbill` 1.64.2 (`base.py`, `taxinvoiceService.py`: endpoints, headers, invoice fields), driven by k-skill `popbill` | MIT, Copyright (c) 2014 Linkhub |
| `src/connected/riss.ts` | k-skill `keris-academic-search/scripts/keris_academic.py` (request fields, XML envelope, type aliases) | MIT, "Copyright (c) 2026" (NomaDamas/k-skill LICENSE) |
| `src/connected/coupang.ts` | our own implementation of Coupang's public Partners Open API signing spec (k-skill `coupang-product-search` only uses the proxy) | — |

The upstream services' own terms still apply to each call (토스증권 Open API, 네이버 검색광고 API, 팝빌, 쿠팡 파트너스,
RISS Open API). Each connected tool runs only with the owner's own key or login. 숲나들e (k-skill `foresttrip-vacancy`)
is deliberately not supported: its login is guarded by the site's anti-automation checks, which we don't bypass.

## MIT License (applies to each MIT entry above, with its copyright line)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
