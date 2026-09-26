# SphereDex V2.0 delivery checklist

> Visual tracker: [v2-checklist.html](v2-checklist.html). Public roadmap: [roadmap.html](roadmap.html).

Updated 26 September 2026. This list distinguishes implementation from acceptance: `[x]` means implementation is present; `[~]` means partial/deployed but awaiting evidence or acceptance; `[ ]` means future or deferred. Built does not mean released or verified on each device.

## P0 — collecting action loop

- [x] Configurable navigation, persistent Home/Add, More menu, history-aware Back/Escape.
- [x] Action-led Home, onboarding intent and first collection action.
- [x] Missing Cards goals and selectors/filters; shared completion and Set Sphere calculations.
- [x] Deck builder, missing quantities, wishlist flow and legality checks.
- [x] PalDex and typo-tolerant local global search.

## P1 — retention and convenience

- [x] Mixed 1st/2nd edition raw copies, manual/scanner changes, undo, CSV and cloud conflict handling; automated regression coverage passes.
- [x] Quick/review/bulk scanning and batch review/correction/undo.
- [x] Local While You Were Away and weekly collection summary.
- [x] Fail-soft nightly operational digest (recorded deployed 24 Sep 2026).
- [x] Release timeline, promo grouping, rewards and push-only preferences.
- [x] Collection list, partial-playset filter, export/sync recency and safe collection deletion.
- [x] Privacy review: no product-event or scanner-image/correction upload in V2.
- [~] Collection-milestone and weekly recap implementation exists; real-device delivery and opt-out acceptance remains.
- [~] Exact-source eBay availability implementation exists; real listing and device acceptance remains.
- [~] Store/privacy drafts exist; review against exact release binaries/dependencies, logs and retention before submission.
- [~] Edition, backup, list/filter and onboarding flows still need web/native acceptance.

## P1 — market-data quality

- [~] Observation ledger and Worker deployed; production observations must accrue before validating source quality.
- [~] Bounded demand-aware lookup allocation deployed; collect outcomes before judging its quality or changing spend.
- [~] Aggregate per-market reports available; validate once telemetry is populated.
- [~] Spain/Italy native-sold coverage is below the recorded 35% gate; keep budget/fallback unchanged until sample and success thresholds pass.

## News and X feed — confirmed defect and blocker

- [x] 26 Sep run evidence: official source returned 21 items as delivered CSV/JSON in `stage/sieve/<session>/files/`.
- [x] Old consolidator searched only `stage/sieve/*/result.json`, so it ignored those downloads. Old workflow also stopped before consolidation when X failed.
- [x] Current X request is refused by Sieve Conservative policy: x.com robots.txt states `Disallow: /`. This is a compliance refusal, not an exhausted-credit error. Do not bypass it.
- [~] Local feed consolidator and workflow fix now handle downloaded CSV/JSON, continue if either scrape fails, retain artifacts and log item counts/refusal details. Unit tests pass; workflow and live-post result still need confirmation.
- [ ] Publish the local Sieve fix and verify official feed gets a successful backend POST despite X failure.
- [ ] Choose a permitted/consented X reveal source and verify an image-bearing post reaches `/api/news` and Home carousel.
- [ ] Verify an actual scheduled event and measure Sieve credits per call; cost varies by compute.

## Acceptance and release — outstanding

- [ ] Web/Android/iOS acceptance: editions, scanner/batch review, CSV, navigation, collection list/filter, safe deletion, onboarding and migration.
- [ ] Real Android/iOS push: permissions, APNs/FCM registration, opt-out cleanup, payload and tap routes.
- [ ] Final store disclosure review against shipped binaries/dependencies and backend logs/retention.
- [ ] Scheduled (not only manual) Sieve run; confirm consolidation counts, backend HTTP 2xx, and visible feed/carousel update.

## P2/P3 — future and gated

- [ ] Deck-need alerts only after explicit consent to share the minimum necessary card IDs/quantities.
- [ ] Privacy-safe public binders, visibility controls and read-only trade lists after P1 and consent/revocation review.
- [ ] Advanced collector goals, community/market intelligence and event features after core validation.
- [ ] Product analytics and scanner-feedback uploads remain off unless separately approved with opt-in and retention constraints.
