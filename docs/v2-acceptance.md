# SphereDex V2 acceptance checks

Run these against the web preview, Android shell, and iOS shell before a V2 release. “Built” is not equivalent to passing these checks.

## Edition tracking

- [x] Automated: legacy first-edition and unspecified counts remain intact; mixed additions/removals preserve other editions.
- [x] Automated: CSV round trips retain all three raw count buckets; edition correction during cloud conflict does not double the total.
- [x] Automated: undoing an older capture preserves later copies and notes; variant correction carries captured edition; graded editions do not collapse on merge.
- [ ] Web/Android/iOS: add first- and second-edition copies in Card Detail, edit counts, save notes and relaunch; totals agree.
- [ ] Android/iOS: scan both editions, adjust extra copies in review, correct variant, undo an older capture.
- [ ] Android/iOS: import/export mixed-edition CSV and verify grades, edition quantities and totals.

## Navigation and collection loop

- [ ] Bottom bar retains Home and Add, and shows first three entries in Settings → Customise navigation.
- [ ] Reordering by six-dot handle changes bottom three immediately; later entries remain under More.
- [ ] More opens upward and every destination remains reachable.
- [ ] Back/gesture-back closes More before changing pages.
- [ ] Adding a card updates Collection, Missing, Home, set progress and Card Detail without refresh.
- [ ] Collection List remains readable on narrow screens; partial-playset filter matches printings with 1–3 raw-plus-graded copies and updates after edits.
- [ ] Export recency and cloud sync status are accurate; collection deletion export/cancel/failure safeguards never delete unexpectedly.
- [ ] Missing goals, Sphere wishlist and deck/wishlist controls work without duplicates; eligible Set Sphere persists after relaunch.
- [ ] Existing collections, backups, decks, wishlist and settings survive update; collector mode and no-account flows work.

## Push notifications and privacy

- [ ] Android/iOS permission denial leaves collection usable and does not register a token.
- [ ] Weekly recap, milestone and wishlist availability are distinct opt-ins/default off; opt-out removes associated state on next preference sync.
- [ ] Milestone opt-in seeds current thresholds silently; later pushes contain only aggregate/count text, never card identities.
- [ ] Availability alerts notify only on unavailable-to-available transition for a fresh exact-source eBay listing; fallback estimates do not trigger.
- [ ] Token removal and provider-reported dead-token cleanup remove associated token and dedupe state.
- [ ] Real APNs/FCM registration, delivery, opt-out cleanup and notification-tap navigation pass on iOS and Android.

## Market data

- [ ] Direct refresh uses reserved foreground budget; automatic on-open refresh remains cache-only.
- [ ] Protected market-readiness report returns only aggregate interest counts, never card IDs or account data.
- [ ] Validate source/lookup telemetry after production data accrues; do not change Spain/Italy budget/fallback before documented sample, coverage and success gates pass.

## News and X feed pipeline

- [x] 26 Sep 2026 workflow: official scrape extracted 21 entries as delivered CSV/JSON files under session `files/`.
- [x] Confirmed defect: old consolidator globbed only root `result.json`; old workflow let a failed X scrape prevent consolidation and posting.
- [x] Confirmed X limitation: Sieve Conservative refused `x.com/PalworldOCG_EN` because x.com robots.txt says `Disallow: /`; do not bypass this restriction.
- [x] Local unit coverage exercises downloaded JSON/CSV, inline output, deduplication, source tagging, refusal diagnostics and invalid rows; Python Sieve and app rebuild regression suites pass.
- [ ] Push the feed/workflow correction and verify a real run logs a nonzero official count, includes diagnostics/artifact, and backend POST returns HTTP 2xx while X is unavailable.
- [ ] Select permitted/consented X source; verify canonical post URL and image reaches `/api/news` and Home carousel.
- [ ] Verify next scheduled trigger (not just workflow_dispatch) and measure actual Sieve credit usage.

## Release gates

- [x] Backend migrations 0017–0019 and Worker deployment recorded as verified 23 Sep 2026; keep push features gated from release until device acceptance passes.
- [ ] Review Play/App Store disclosures against exact binaries, merged dependencies, server logging and retention before submission.
- [ ] Fresh install selects intent and first action, then adds a card within 30 seconds; value-tracking setup asks for market/currency before price UI.
