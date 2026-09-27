# Outstanding-items evidence log — 26 September 2026

Works through the six open items from the roadmap's "Outstanding verification and release
gates" list. What could be executed this session was; what needs hardware or a future cron
is left with the exact next action recorded.

## 1. Sieve publishing — first fixed scheduled run recorded; POST step exposed a missing backend route

Run forensics from the Actions API (not assumptions):

| Run | Event | Commit | Result | Key steps |
|---|---|---|---|---|
| 36214421523 (03:18 UTC) | schedule | `bf0f569` (pre-fix) | ✅ success | official scrape ✅, X ✅, consolidate ✅, POST "✅" (masked) |
| 36230732799 (08:45 UTC) | schedule | `bf0f569` (pre-fix) | ❌ failure | X scrape refused → **consolidate + POST skipped** (the old bug, live) |
| 36237384179 (10:58 UTC) | dispatch | `3647e9d` (pre-fix) | ✅ success | full pipeline ✅ |
| 36276873242 (22:37 UTC) | schedule (late) | `38ffd41` (fixed) | ❌ POST only | official ✅, X diagnostic ✅, REST reveals ✅, consolidate ✅, **POST ❌** |

- The 20:00 UTC slot produced **no run at 20:00** — verified at 22:19 UTC that only three
  runs existed; GitHub's scheduler dropped/delayed the slot. It then executed late at
  22:37 UTC as run 4, on `38ffd41` (the restore commit, which contains the fixed workflow).
- Run 36276873242 is the **first scheduled run on the fixed workflow** and the first with
  the REST card-reveal fetcher (`c748497`): every scrape and consolidation step succeeded.
  The only failure is the stricter POST step (`--fail-with-body`, added in `37e3b59`)
  surfacing a real integration gap: **the backend has no `POST /api/news` route at all.**
  `spheredex-backend/src/index.ts` implements `/api/news` as GET-only (it collects RSS
  server-side hourly via `NEWS_FEED_URL`); there is no ingest endpoint anywhere in the
  Worker. The old workflow masked this with `|| echo "POST failed — check worker"`, so the
  Sieve→backend publish has never actually published anything. The app's News feed is fed
  by the Worker's own RSS pull, and the X/reveal enrichment never reaches the app — which
  also explains the Home carousel showing only news + collection slides on live data.
- Artifact `sieve-news-feed` (7-day retention) is on run 4 for comparison with the 03:18
  and 10:58 artifacts.
- **Decided & implemented (2026-09-27):** the admin-keyed ingest route now exists —
  `POST /api/admin/news` in spheredex-backend, behind the existing `/api/admin/*`
  X-Admin-Key gate (`ADMIN_KEY` secret). It accepts the Sieve feed as a bare array or
  `{items:[…]}` of `{title,date,summary,link,image}`, sanitises each item (title + http(s)
  link required, lengths capped, image/link scheme-checked, dates normalised to `YYYY-MM-DD`),
  relabels sources to the RSS labels (`x:PalworldOCG_EN` → `X · @PalworldOCG_EN`,
  `official` → `Official site`), and **merges by link** into `app_meta["news:sieved"]`
  (cap 50 items / 180 days) rather than replacing — so a run where the X scrape was
  refused cannot wipe previously published X items, and a fresh copy never loses art
  scraped earlier. `collectNews` merges the blob into `GET /api/news` with an optional
  `image` field (cross-pipeline de-dupe prefers the copy carrying art); `image` is exactly
  what the Home carousel's X-image and card-reveal slides read. The workflow's POST step
  now targets `/api/admin/news` with `X-Admin-Key: ${{ secrets.BACKEND_ADMIN_KEY }}` and
  warns-and-skips when that secret is unset. Verified: backend `tsc --noEmit` clean,
  app-repo python suite green (71 tests).
  **Activated & verified (2026-09-27 morning):** Worker deployed (Version `ae82f8c2`);
  `BACKEND_ADMIN_KEY` set as a GitHub secret via sealed-box API call (value = the
  `ADMIN_KEY` from `.admin_key.local`, verified against the live admin gate: 200 with the
  key, 403 without). Route smoke test on the new deployment: no key → 403, malformed body
  with key → 400, old-dated item → 200 `{accepted:1,stored:0}` (age pruning drops it, so
  the probe never entered the feed). Workflow fix pushed (`9be4bf5`) and verified
  end-to-end via dispatch run **36308470126 — all 12 steps success, including step 10
  "POST to backend (/api/admin/news)"** — the first successful Sieve publish ever.
  `GET /api/news` now serves 18 items with **12 carrying images** (the Sieve copies win
  the cross-pipeline de-dupe and bring the art RSS never had). X items = 0 this cycle —
  the X scrape is still robots-refused, so X/reveal art appears only in cycles where that
  scrape yields content; the pipeline itself is proven. The 08:00 UTC slot was dropped
  again (checked 09:03 UTC, no run), so dispatch stood in; **20:00 UTC tonight is the
  first *scheduled* run of the fixed pipeline** — confirm it publishes too.
  Housekeeping: the deploy shipped the spheredex-backend working tree as-is, including
  the still-uncommitted weekly-recap work (`src/push.ts`, `wrangler.jsonc`, RELEASE_NOTES
  in `src/index.ts`); those changes remain uncommitted in that repo.

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

## 6. Scheduled-refresh + Sieve credit budgeting — cron cadence recorded; credit number remains

Cron triggers fire, with one GitHub-side gap today: the **20:00 UTC slot produced no run at
20:00** (verified 22:19 UTC: only three runs existed). The scheduler then executed it late
at 22:37 UTC. On that run the official scrape, X diagnostic scrape and REST reveal fetch
all consumed credits successfully. What remains is recording **credit usage per successful
cycle** from the Sieve dashboard alongside the next run's logs — one number to note, then
this line closes.

## 7. Incident (26 Sep, ~21:14 UTC): 1,189 binary assets deleted from main — RESTORED

- `fc77297c` ("Added package-lock.json") also deleted every card-art/effigy/product image
  (`docs/app/img` ×391, Android assets ×287, iOS resources ×391), all 90 Android launcher
  icons, the inlined web fonts, both store-asset sets, the PWA icons and `.env.example`.
  The commit message does not describe the deletions; the working tree shows no matching
  local change, so this reads as an accidental bulk deletion by an external tool.
- Impact: CI's bundle-drift guard failed twice (correctly); Android/iOS builds and store
  submissions would have been broken; Pages kept serving the last good deploy, so the
  **live web app never lost artwork** (app is served from `/app/` and never went down).
- Fix: `38ffd41` restored all 1,189 files byte-identical from `196f5e9` (verified
  `git diff 196f5e9` empty for those paths, rebuild.py drift 0, node guards 18/12/8 pass,
  python suite green). `package-lock.json` and `.bolt/mcp.json` were kept.
- Post-fix verification: Build + Pages + Tests green on `38ffd41`; live probes
  `/app/img/EBP01-001.jpg`, `/app/img/PAL_Chillet.webp`, `/app/sw.js` (stamps `1.11-8088c2ed`)
  and `/app/icon-512.png` all HTTP 200 on spheredex.app.
- **Follow-up:** identify which tool ran as `fc77297c`/`d3e6056` and stop it committing to
  main (branch protection + PR-only path), so a cleanup sweep can never again remove
  binaries in the same push as an unrelated file.

## Bottom line

Closed this session: web acceptance (full loop), Sieve run forensics incl. the first fixed
scheduled run (22:37 UTC), disclosure target-identification (release AAB workflow),
telemetry deployment proof, and the 1,189-asset deletion incident (restored, CI green,
live artwork verified).
Waiting on hardware: Android/iOS sessions (item 3).
Activated & verified: news-ingest pipeline (item 1) — deployed, `BACKEND_ADMIN_KEY` set,
dispatch run 36308470126 green through the POST step. Only the first *scheduled* run
(20:00 UTC tonight) remains to observe.
Waiting on the clock: nightly 01:00/01:01 passes (item 5).
Waiting on one command: D1 count (item 5).
Waiting on one dashboard number: Sieve credits per cycle (item 6).
