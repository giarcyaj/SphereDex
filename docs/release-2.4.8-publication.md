# SphereDex 2.4.8 publication runbook

Both production stores offer 2.4.8, so this repository ships the live carousel banner. This file does not deploy the worker, change cron, store gates, or version selection code.

The bundled 2.4.8 notes correction is **not in this repository**. `src/index.ts` is not in SphereDex. `https://github.com/giarcyaj/spheredex-backend` did not resolve for this checkout (`git ls-remote` returned repository not found, and the GitHub API returned 404). No unfamiliar backend checkout was added. Nothing below has been deployed.

## Banner that ships

[PR 102](https://github.com/giarcyaj/SphereDex/pull/102) commits the **LIVE IN THE APP** banner. `RELEASE_ART["2.4.8"]` is `img/UPDATE_2_4_8.webp`. `tools/rebuild.py` mirrors `docs/app/img/UPDATE_2_4_8.webp` into the Android and iOS image folders. The public URL is `https://spheredex.app/app/img/UPDATE_2_4_8.webp`.

| Role | Path | sha256 |
|---|---|---|
| Live banner that ships, mirrored into the app image folders | `docs/app/img/UPDATE_2_4_8.webp` | `997f7832c868e7eb8c0dfc65fec78425015ff1d0a7eb0e4b5fd598af0becf332` |
| Preview bytes, not in the tree | (not shipped) | `c6a1578beb7a01599692f2f2fd21cf3c2b388c76eaeca3d9c139d75a4f0ceb7f` |

The preview caption was **UPDATE PREVIEW**. Those bytes are not the file at `https://spheredex.app/app/img/UPDATE_2_4_8.webp`.

The three lines already in the app, and the only notes this correction may write for 2.4.8, are in `src/paldeck.html` at lines 4279–4283:

- Print your collection, share wants and spares, and track cards out for grading
- Closest winning decks, built decks that hold their copies, and a place for each card
- A Daily Pal guess, a wishlist budget, and live and sold value on every set

## Deployed worker evidence, not a git commit

Read on 7 November 2026 16:15:39 GMT from the installed Cloudflare observability connector. `workers_list` named worker `spheredex-backend`, tag `8a7e9d9ebc3a4dd6baddfa57061d932e` (worker identity, not a deployment version id). Listed modified time 7 November 2026 13:17:14.903919 GMT. `workers_get_worker_code` returned deployed `index.js` in a multipart response, not a GitHub tree. No deployment version UUID, traffic weight, cron installation, binding value, or database row was read. This run did not remount that blob. The hash and line spans below are the ones recorded for that response.

Response SHA-256: `64a3d01c19dfd8c166a4f0b971813d3fda2e395b81dc650c39c431d088cb9d25`.

Spans include the multipart headers on lines 1–3.

- Lines 9373–9377: bundled `RELEASE_NOTES["2.4.8"]` is "Your collection value beneath every set", "Live listings in green and sold listings in blue", and "Owned quantities and graded card values included".
- Lines 9387–9389: bundled `RELEASE_ART` maps both 2.4.7 and 2.4.8 to `https://spheredex.app/app/img/UPDATE_2_4_7.webp`. The comment says 2.4.8 reuses the previous picture.
- Lines 11223–11229: `latestForPlatform` uses `APP_LATEST_IOS`, `APP_LATEST_ANDROID`, or `APP_LATEST_WEB`, then `APP_LATEST`. A detected store version replaces that floor only when it is higher, or when no floor exists. A floor can name 2.4.8 before the store listing does.
- Lines 11271–11286: notes come from `APP_LATEST_NOTES` when that value parses. A JSON array applies to every latest. An object may supply the array for that latest. Empty or invalid notes fall through to `RELEASE_NOTES[latest]`. Whether an override is set was not read.
- Lines 11287–11288: a non-empty trimmed `APP_LATEST_ART` replaces `RELEASE_ART[latest]`. The string must match `https://spheredex.app/app/img/[A-Za-z0-9_.-]+.webp`. An invalid non-empty override drops art. It does not fall back to the bundled map. Whether an override is set was not read.
- Lines 11289–11294: `app`, `released`, `notes`, and `art` are separate. Notes and art follow latest, not released. A floor of 2.4.8 can therefore expose 2.4.8 notes and art while `released` is still 2.4.7.
- Lines 11258–11269 and 11294: a `v` query writes version counters and is `no-store`. Without `v`, the response is `public, max-age=3600` and can be cached. It is not a fresh store reading.
- Lines 7512–7518: `releasedVersion` uses a stored or detected side, then that side's env floor, then `APP_LATEST`. If one side is missing it returns the other side. If both exist it returns the lower one. `released` is not, by itself, proof that both production stores are freshly verified on 2.4.8.
- Lines 7390–7404 and 7504–7509: store readings are `store_live:ios` and `store_live:android` metadata. The parser keeps a timestamp. It does not require the timestamp to be fresh.
- Lines 7457–7501: a failed refresh keeps the previous stored reading. A lower fetched version does not replace a higher stored version, while the seen time still moves forward. A stored version can outlive a rollback, a parser miss, or a stale observation.
- Lines 11515 and 11549–11551: the source names `NEWS_CRON` as `0 */2 * * *` and, on that event, calls `refreshStoreVersions` then `announceReleaseIfNew`. That is the handler. It is not proof the trigger is installed or that a run succeeded.
- Lines 11468–11480 and 7520–7524: the push uses `releasedVersion`. An empty `release:announced` value is seeded and no push is sent. A later higher version must win an atomic claim before send. The current metadata value was not read.
- Lines 11481–11485: the push reads `RELEASE_NOTES[now]` directly. It does not read `APP_LATEST_NOTES` or `APP_LATEST_ART`. Changing only those env values cannot correct the push text.
- Lines 7527–7535: the payload title is `SphereDex <version> is out`. The body uses only the first note, and only the text before a middot. With the bundled 2.4.8 first line, that body would be "Your collection value beneath every set. Update from your app store to get it." No artwork is attached.
- Lines 11479–11488: the claim is written before send. A failed send is logged and is not rolled back in this function.

Conditional only: if that news handler runs, `releasedVersion` moves forward to 2.4.8, a lower announced value exists, and the claim succeeds, this deployed source would push the stale first line. No separate launch approval sits on that path. An empty announced value seeds instead. A version already claimed does not send again through this function. None of those database values were read.

## Owner checks before any 2.4.8 announcement

Do not change cron, env vars, or metadata as part of reading them.

1. Confirm which deployed worker version is actually routed, and whether `0 */2 * * *` is installed. The source snapshot is not that confirmation.
2. Read, without copying secrets into chat or git, whether `APP_LATEST`, `APP_LATEST_IOS`, `APP_LATEST_ANDROID`, and `APP_LATEST_WEB` are set, and whether `APP_LATEST_NOTES` or `APP_LATEST_ART` is set. A global notes array would override every version. A non-empty art override would hide the map, including a corrected 2.4.8 entry.
3. Read `store_live:ios` and `store_live:android` versions and timestamps. Then check the live App Store and Play listings independently. `released` is not that check. Account for a one-sided fallback, a retained higher version, and an env floor.
4. Read `release:announced` and the `release_announced_app`, `release_announce_failed`, and `release_announce_seeded` logs. Do not reset them and do not retry a send from this runbook.

## Publication sequence

The current production App Store listing and the current production Play listing both offer 2.4.8. The image steps are done in this repository. The worker steps stay in the backend repository. Do not start the worker edit from `released` alone.

1. The live file is committed at `docs/app/img/UPDATE_2_4_8.webp`, and `tools/rebuild.py` copies it into the Android and iOS image folders. After this merges, `https://spheredex.app/app/img/UPDATE_2_4_8.webp` is that file.
2. That file matches sha256 `997f7832c868e7eb8c0dfc65fec78425015ff1d0a7eb0e4b5fd598af0becf332`. The preview sha256 `c6a1578beb7a01599692f2f2fd21cf3c2b388c76eaeca3d9c139d75a4f0ceb7f` is not in those folders.
3. In the backend repository, replace only the existing `2.4.8` entries. Do not add a second `2.4.8` key. Do not change the `2.4.7` art or notes. Do not edit cron, `releasedVersion`, `latestForPlatform`, or env bindings.

Notes replacement:

```js
"2.4.8": [
  "Print your collection, share wants and spares, and track cards out for grading",
  "Closest winning decks, built decks that hold their copies, and a place for each card",
  "A Daily Pal guess, a wishlist budget, and live and sold value on every set"
]
```

Art replacement:

```js
"2.4.8": "https://spheredex.app/app/img/UPDATE_2_4_8.webp"
```

4. After an authorized deploy of that reviewed source, request `/api/version` without a `v` parameter for `ios`, `android`, and `web`. A `v` parameter writes counters. A response without `v` may be cached for an hour. Expect the three lines above and the new art URL only when that platform's latest is 2.4.8. Then open the installed app and confirm an old build loads the https image, and a build that contains `RELEASE_ART["2.4.8"]` uses its bundled file.
5. The App Store and Play listings already offer 2.4.8. `released` in the JSON is not a substitute for those two listings.

This repository change performs the image steps. It does not edit the worker.
