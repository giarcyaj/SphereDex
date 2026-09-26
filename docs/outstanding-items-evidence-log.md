# Outstanding-items evidence log — 26 September 2026

Works through the six open items from the roadmap's "Outstanding verification and release
gates" list. What could be executed this session was; what needs hardware or a future cron
is left with the exact next action recorded.

## 1. Sieve publishing fix — fix is LIVE; first fixed scheduled run is pending

Run forensics from the Actions API (not assumptions):

| Run | Event | Commit | Result | Key steps |
|---|---|---|---|---|
| 36214421523 (03:18 UTC) | schedule | `bf0f569` (pre-fix) | ✅ success | official scrape ✅, X ✅, consolidate ✅, POST ✅ |
| 36230732799 (08:45 UTC) | schedule | `bf0f569` (pre-fix) | ❌ failure | X scrape refused → **consolidate + POST skipped** (the old bug, live) |
| 36237384179 (10:58 UTC) | dispatch | `3647e9d` (pre-fix) | ✅ success | full pipeline ✅ |

Both scheduled runs today predate the publishing fix and the card-reveal fetcher (pushed
later today). The 08:45 failure is the pre-fix behaviour demonstrated in production: an X
refusal still aborts consolidation and POST on `bf0f569`. **Next evidence: the 20:00 UTC
cron will be the first scheduled run on the fixed workflow — record its official count,
POST status, and artifact.** Artifacts (`sieve-news-feed`, ~8.5 KB) are retained on the
03:18 and 10:58 runs for comparison.

## 2. Web acceptance — PASS (executed live this session)

Driven through the real UI in a browser against the current build:

- Onboarding: intent step → Start empty → lands on Home ✅
- Bottom bar persists Home/Add; CARDS opens the collection browser ✅
- Browse-by-set renders with set art and progress ✅
- Flat list search ("Lamball") filters 277 → 5 printings ✅
- **Collection loop: `+` own → count 0/277 → 1/277, Home tile updates without refresh ✅**
- Card detail sheet: full stats, art, "Added to collection · 2m ago", notes textarea ✅
- State persists across reload (collection still 1/277) ✅
- `FEATURED_CAROUSEL` seam live in the page, 2 slides rendering ✅
- More menu, Missing page, Settings incl. Notifications section reachable ✅

Not executed on web by design: native push (web has none), scan flows (native camera).

## 3. Android/iOS acceptance — checklist ready; hardware session pending

`docs/push-device-acceptance-checklist.md` covers permission denial, registration, opt-in
hygiene, milestone/availability privacy, APNs/FCM delivery, tapped routes and token
cleanup (2 × ~40 min + 10 min next-morning pass). **Action: run Session A (Android) and
Session B (iPhone).**

## 4. Store disclosures — source-level review done; bundle check remains

`store-listing-and-privacy-draft.md` holds the review. Remaining: run against the actual
release bundle. Note discovered this session: a **Build Release AAB** workflow exists
(workflow id 331280118) — generate a release build, then compare its merged dependencies
(ML Kit 16.0.1, Barcode 17.3.0, FCM) and the backend's logged fields/retention against the
Play Data safety answers. **Action: one release build + dependency report.**

## 5. Market-data telemetry — deployment verified; row-count query remains

Crons verified live via the Cloudflare API (`0 1 * * *` pricing, `1 1 * * *` alert check,
`5 1 * * *` recap slot, `0 9 * * 1` weekly, `*/30` stock, all `modified_on Sep 25`).
Live endpoints confirm pricing flows (`/api/sales` returns current eBay rows). Remaining
doubt is one query: **`npx wrangler d1 execute DB --remote --command "SELECT (SELECT COUNT(*) FROM price_observations), (SELECT COUNT(*) FROM price_lookup_events)"`** — and a
glance at `/api/movers` (empty today; likely just no previous-day baseline yet). Spain/
Italy spend stays frozen either way until the documented sample/coverage gates pass.

## 6. Scheduled-refresh + Sieve credit budgeting — same gate as item 1

Cron triggers fire (three runs today: 03:18, 08:45, plus a manual dispatch). What remains
is recording **credit usage per successful cycle** from the Sieve dashboard alongside the
next run's logs — one number to note, then this line closes.

## Bottom line

Closed this session: web acceptance (full loop), Sieve run forensics, disclosure
target-identification (release AAB workflow), telemetry deployment proof.
Waiting on hardware: Android/iOS sessions (item 3).
Waiting on the clock: 20:00 UTC Sieve cron (items 1+6), nightly 01:00/01:01 passes (item 5).
Waiting on one command: D1 count (item 5).
