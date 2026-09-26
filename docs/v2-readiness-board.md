# V2.0 readiness board — 26 September 2026

Status snapshot for publishing 2.0. Everything marked ✅ was verified this session
(tests run locally, CI observed green, live endpoints probed). ❌ blocks release.
⚠️ needs a decision or a small fix before submission.

## Done and verified this session

| Item | Evidence |
|---|---|
| Carousel keyboard navigation (arrows, focus-follows-slide, autoplay parks on focus) | commit `7af6239`, browser-verified, CI green |
| FEATURED CAROUSEL fence + `FEATURED_CAROUSEL` API seam | markers in src, 18-test guard suite green |
| SCAN REVIEW fence + `SCAN_REVIEW` API seam | 12-test guard suite green |
| Wishlist-undo data-loss quirk fixed (pre-existing wish survives undoing every capture) | `f9ff59f`, test asserts corrected behavior |
| LF-only line endings, enforced in rebuild.py + .gitattributes; guards byte-exact | `fec1ee2` |
| CI: Tests workflow (Node guards + Python pipeline tests + bundle-drift gate) | first run on real runner: both jobs ✅ (`ca0be29`) |
| Bundle-sync discipline: src edit without rebuild fails CI | drift gate exit 0 in fresh worktree simulation |
| APK build gated on Tests | `fe6e54d` (awaiting first gated push) |
| Marker belt-and-braces grep in CI (fails if a fence vanishes/duplicates) | `fe6e54d` |
| All 4 shipped copies in byte-identical sync (src/web/Android/iOS) | guard suites, run #last: 18+12+8 green |
| Sieve feed publishing fix | 60/60 Python tool tests |
| News pipeline live end to end | `GET /api/news` 200 with fresh items (probed 26 Sep) |
| Shopify stock-alert sources reachable | The Card Vault `products.json` 200 with `available` flags; Universe TCG robots `Allow: /` |
| Review docs committed | `b6b6574`: market data, privacy/sharing, store draft, X-reveal proposal, P1 previews |

## Release blockers (must close before 2.0 ships)

1. ❌ **Push the 3 local commits** (`f9ff59f`, `fe6e54d`, `b6b6574`) and confirm the first
   *gated* run: Tests once → APK builds only if green. Currently `main` is ahead 3.
2. ❌ **Real-device push acceptance (iOS + Android)** — the single biggest open gate.
   Per acceptance docs: permission denial path, APNs/FCM registration, opt-in/out cleanup,
   push content, tapped routes. Backend + migrations 0017–0019 are deployed; devices are not tested.
3. ❌ **Alert-checker telemetry evidence** — as of 23 Sep, `price_observations` and
   `price_lookup_events` had zero rows. Gate #1 of the market-data doc: let scheduled passes run,
   then confirm rows exist before trusting price-alert evaluation in production.
4. ✅ **Stock-alert copy/map drift** — client reconciled (map trimmed to the polled UK/US/AU/DE
   markets, comment now states the mirror rule, Settings copy matches). Remaining half: backend
   `spheredex-backend/src/stock.ts` STOCK_SOURCES must equal the client map (see commit message);
   no public endpoint exists to verify it from here.

## Decide before submission

5. ⚠️ **X card-reveal slide source** — blocked by robots.txt (verified). Options ranked in
   `docs/x-reveal-source-proposal.md`: official cardlist (recommended), RSS backstop, paid X API
   (~$0.15/mo), or ship 2.0 with the graceful fallback. Decision only, no code forced.
6. ⚠️ **`.idea` machine-state churn** (modified gradle.xml/misc.xml/deviceStreaming.xml,
   untracked *.iml/vcs.xml) — recommend gitignore + untrack; do not commit `ms-21` JDK rename.
7. ⚠️ **`stage/` pipeline output** — decide: commit as seed feed or gitignore (workflow writes
   it fresh and POSTs; artifact upload already covers runs).
8. ⚠️ **Store disclosures** — Play Data safety / App Store privacy answers must match shipped
   SDKs (ML Kit, FCM) per `store-listing-and-privacy-draft.md`; release-bundle dependency check
   still pending.

## Working-tree leftovers (not blocking, keep or clean)

- Untracked: `.freebuff/` (ignore), `.idea/android.iml`, `.idea/runConfigurations.xml`, `.idea/vcs.xml`
- Modified: `.idea/caches/deviceStreaming.xml`, `.idea/gradle.xml`, `.idea/misc.xml`
- Untracked: `stage/news-feed.json`, `stage/pals/pal_art.json` (see #7)

## Suggested order to 2.0

1. Push → watch the gated run (minutes, closes #1).
2. Reconcile stock-alert drift + commit (#4) — small code change, bundle rebuild.
3. Choose X-reveal option (#5) — cardlist fetch is a half-day with tests.
4. Device acceptance pass on iOS + Android (#2) using `docs/v2-acceptance.md`.
5. Confirm alert telemetry accruing (#3) after a couple of scheduled passes.
6. Store disclosures against the release bundle (#8), then tag/release via `release.yml`.
