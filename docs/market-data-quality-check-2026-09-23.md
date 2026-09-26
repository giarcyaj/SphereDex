# Market-data quality check — 23 September 2026

Read-only review of the production D1 price cache plus local Worker/schema checks. No production rows or schema were changed.

## Production cache snapshot

“Native sold” counts rows with a non-converted source other than the Palworld baseline or eBay active listings. “Live eBay” counts exact `ebay-active`, non-converted rows. Freshness is the cache `as_of` time; it is not the date of the underlying sale.

| Market | Sold rows | Native sold | Native share | Live rows | Live eBay | Live share | Live rows older than 2 days |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Canada | 255 | 59 | 23.1% | 261 | 259 | 99.2% | 0 |
| United Kingdom | 255 | 209 | 82.0% | 261 | 259 | 99.2% | 0 |
| United States | 255 | 254 | 99.6% | 261 | 261 | 100.0% | 0 |
| Australia | 255 | 103 | 40.4% | 261 | 259 | 99.2% | 0 |
| Germany | 255 | 192 | 75.3% | 256 | 223 | 87.1% | 1 |
| Spain | 255 | 29 | 11.4% | 260 | 260 | 100.0% | 0 |
| France | 255 | 156 | 61.2% | 255 | 165 | 64.7% | 1 |
| Italy | 257 | 3 | 1.2% | 259 | 258 | 99.6% | 0 |

All sold-cache rows were refreshed within 14 days. The database has zero `ebay-active` rows in the sold table, zero sold rows with a missing currency, and zero price rows outside the current backend catalogue. Cache row totals can differ by market where a source returns no result for some cards.

## Interpretation and decision

- Spain is below the existing 35% native-sold coverage threshold (29/255, 11.4%). Hold any Spain budget/fallback experiment.
- Italy is also severely under-covered (3/257, 1.2%). Review it alongside demand and paid-lookup outcome evidence before reallocating spend; this cache-only snapshot does not establish market demand.
- Live listing coverage is strong in most markets, but Germany and France each have one cache row older than the 2-day freshness target, and France has the lowest live-result coverage (165/255, 64.7%).
- Although cache timestamps are recent, the cache snapshot by itself cannot validate last-sale age, sample sizes, lookup success rate, or the Spain eligibility rule end to end.

## Backend/schema checks

- `npx tsc --noEmit`: passed.
- Local D1: no pending migrations; local Worker catalogue route returned 200 and market-readiness correctly returned 403 without an admin key.
- Production D1: migrations `0013`–`0019` were applied at 17:46 UTC on 23 September. A read-only query confirmed the new schema versions; no row writes were performed by the check.
- Wrangler deployment history shows the latest production Worker deployment at 18:01 UTC on 23 September, after the migrations. At 19:11 UTC, read-only aggregate queries found zero rows in both `price_observations` and `price_lookup_events`, so the new telemetry has been deployed but has not yet collected evidence.

## Remaining validation gates

1. Let the next 01:00 UTC scheduled pricing pass run (02:00 BST on 24 September), then confirm source observations and lookup outcomes are being recorded.
2. After enough data accrues, check source-observation ages and 90-day lookup outcomes by market; require at least 25 outcomes, 35% native sold coverage, and 50% success before even considering a Spain experiment.
3. Keep budget/fallback changes manual and evidence-led. Do not infer demand or raise paid spend from cache coverage alone.
4. Test push opt-ins, token cleanup, and notification delivery on real iOS/Android builds; migrations and Worker deployment are now complete, but device acceptance remains.
