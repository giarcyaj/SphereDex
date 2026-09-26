# V2.0 readiness board — 26 September 2026 (end of session)

Status snapshot for publishing 2.0. ✅ verified this session (tests, CI, live probes).
❌ still blocks release. ⚠️ decision or small task left.

## Done and verified

| Item | Evidence |
|---|---|
| Carousel keyboard navigation (arrows, focus-follows-slide, autoplay parks on focus) | `7af6239`, browser-verified |
| FEATURED CAROUSEL fence + `FEATURED_CAROUSEL` API seam | 18-test guard suite |
| SCAN REVIEW fence + `SCAN_REVIEW` API seam | 12-test guard suite |
| Wishlist-undo fix: pre-existing wish survives undoing every capture | `f9ff59f` |
| LF-only endings enforced (rebuild.py + .gitattributes); guards byte-exact | `fec1ee2` |
| **Gated CI verified on the runner**: Tests run once inside Build Android APK, build waits on it | run `a611df6`: tests/Node ✅, tests/Python ✅, build ✅ |
| Bundle-sync discipline: src edit without rebuild fails CI | drift gate, fresh-worktree simulation |
| Marker belt-and-braces grep (8 markers, exactly-once) | `fe6e54d`, positive+negative tested |
| Card-reveal source implemented (option A): official REST API → Sieve-style session | `c748497`, 11 tests, live run clean (0 reveal posts in current window — expected) |
| Sieve feed publishing fix | 71/71 Python tool tests |
| News pipeline live end to end | `/api/news` 200, fresh items |
| Stock sources live (Shopify products.json with availability) | Card Vault 200; Universe TCG robots `Allow: /` |
| **Stock-alert mirror corrected**: 8 markets × 9 products, verified against deployed stock.ts | `2e60e0b` (supersedes the `a611df6` trim — comments were stale, backend commit `85972bd` widened to 8 markets) |
| Hygiene: `.idea/` untracked; `.idea/`, `.freebuff/`, `stage/` ignored; tree clean | `3a21bb5` |
| Docs: reviews, X-reveal proposal, readiness board, push device checklist | `b6b6574` + working tree |

## What remains before tagging 2.0

1. ❌ **Push `2e60e0b`** (market restore) and watch the gated run go green — minutes.
2. ❌ **Device push acceptance, iOS + Android** — the only substantive open gate.
   Checklist ready: `docs/push-device-acceptance-checklist.md` (2 × ~40 min + 10 min
   next-morning pass). Covers denial path, registration, opt-in hygiene, milestone privacy,
   availability transitions, APNs/FCM delivery, tapped routes, token cleanup.
3. ❌ **Alert-checker telemetry confirmation** — crons are verified live (`1 1 * * *` and
   `5 1 * * *` created Sep 24; pricing 01:00; weekly Mon 09:00; stock */30). Remaining: one
   D1 read to confirm `price_observations` / `price_lookup_events` rows:
   `npx wrangler d1 execute DB --remote --command "SELECT (SELECT COUNT(*) FROM price_observations), (SELECT COUNT(*) FROM price_lookup_events)"`
   (or grant the Cloudflare connector D1 read scope). Also glance at `/api/movers` (empty
   array today — may be normal, may be missing previous-day baseline).
4. ❌ **Scheduled Sieve run verified for real** — the publishing fix and the card-reveal
   fetcher are pushed and unit-tested, but no cron-triggered run (08:00/20:00 UTC) has yet
   been recorded showing nonzero official count + HTTP 2xx POST. This is its own roadmap
   line (`v2-todo.md`); check the next scheduled run's logs and record counts/POST status
   in both trackers.
5. ⚠️ **US pack alerts** — backend matches whatever its 3 US shops stock; packs appear only
   if Flipside/Gamers Guild/Lumius list them. Check their products.json; if absent, add a US
   shop that stocks packs (backend change, not a client gate).
6. ⚠️ **Store disclosures** — Play Data safety / App Store privacy answers against the exact
   release bundle (ML Kit 16.0.1, Barcode 17.3.0, FCM), per `store-listing-and-privacy-draft.md`.
7. ⚠️ **Commit `docs/v2-readiness-board.md` + `docs/push-device-acceptance-checklist.md`** —
   done in this docs commit; item closes with the next push.

## Deferred / not needed for 2.0

- X-reveal slide: implemented via the permitted official REST API (option A). If zero reveal
  posts persist for weeks, option C (paid X API) remains available but is not required.
- RSS news backstop (option B) — nice-to-have reliability, not a release gate.

## Suggested order to the tag

1. Push `2e60e0b` + this docs commit → gated green (closes 1 and 7).
2. Run the two device sessions (2) — record evidence into `docs/v2-acceptance.md`.
3. Run the D1 count query (3); if rows exist, telemetry gate closes.
4. Confirm the next scheduled Sieve run (4): nonzero official count, 2xx POST, feed/carousel update.
5. Store disclosures against the release bundle (6).
6. Tag 2.0 → `release.yml` builds the release APK/AAB from a guarded tree.
