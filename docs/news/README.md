# Palworld TCG news feed

This file is the contract for the SphereDex Palworld TCG news list. The app reads it live, so a weekday update is a pull request that changes the JSON only. Do not rebuild the app, and do not edit the Android, iOS, or web bundles, for a news-only change.

## Location and live URL

| | |
| --- | --- |
| Path in this repo | `docs/news/palworld-tcg.json` |
| Live URL | `https://spheredex.app/news/palworld-tcg.json` |

`docs/` is the GitHub Pages site for spheredex.app (`docs/CNAME`). Pages publishes that folder as the site root, which is why `docs/privacy.html` is already `https://spheredex.app/privacy.html` and `docs/app/` is `https://spheredex.app/app/`. A file added at `docs/news/palworld-tcg.json` is therefore served at `https://spheredex.app/news/palworld-tcg.json` once it is on `main`. It is not under `/docs/` in the URL.

Pages sends `Access-Control-Allow-Origin: *`, so the web app, the Android WebView, and the iOS WebView can all read the file. `Cache-Control` is about ten minutes (`max-age=600`): after a PR merges, the new list can take that long to appear.

The official-site headlines already on the News screen (the backend `/api/news` feed, the bell, and release-date parsing) are a separate pipeline. Leave that alone. This file is the additional Palworld TCG list.

## Document

```json
{
  "updated_at": "2026-09-27T00:00:00Z",
  "items": []
}
```

Newest item first. `items` may be empty. The seed in git is an empty list on purpose: do not invent headlines or URLs.

| Field | Where | Type | Rule |
| --- | --- | --- | --- |
| `updated_at` | top level | string | ISO 8601 UTC timestamp for the moment this file was last edited. Bump it on every change. |
| `items` | top level | array | News entries, newest `published_at` first. |
| `id` | item | string | Stable slug of the URL. Unique in the file. Never change it once published. |
| `title` | item | string | Plain text, one line. |
| `url` | item | string | Absolute `https` URL of the original post or article. |
| `source` | item | string | One of `reddit`, `x`, `news`. |
| `source_name` | item | string | Subreddit (`PalworldTCG` or `r/PalworldTCG`), X handle (`PalworldOCG_EN` or `@PalworldOCG_EN`), or publication name. |
| `published_at` | item | string | ISO 8601. Date-only (`2026-09-27`) or a full timestamp (`2026-09-27T15:04:00Z`, offset allowed). |
| `category` | item | string | One of `official`, `release`, `reveal`, `preorder`, `pricing`, `tournament`, `community`, `leak`. |
| `summary` | item | string | One sentence, one line, no line break. |
| `unconfirmed` | item | boolean | `true` for leaks and rumours. `false` for everything confirmed. |

`source` values:

| Value | Use for |
| --- | --- |
| `reddit` | A Reddit thread or post. |
| `x` | A post on X. |
| `news` | A site or publication that is not Reddit or X, including official news pages. |

`category` values:

| Value | Use for |
| --- | --- |
| `official` | An official announcement that is not one of the more specific categories below. |
| `release` | A set or product release, including a release date. |
| `reveal` | A card, art, or product reveal. |
| `preorder` | Preorders opening or a preorder listing. |
| `pricing` | A price, MSRP, or street-price report. |
| `tournament` | Tournament dates, results, or prizing. |
| `community` | A notable community thread that is not a leak. |
| `leak` | An unofficial image, list, or rumour. Pair with `"unconfirmed": true`. |

## `id`

Derive `id` from the canonical URL so two sweeps of the same link produce the same id.

1. Drop the scheme (`https://`), the query string, and the fragment.
2. Lowercase the rest.
3. Replace every run of characters other than `a-z` and `0-9` with a single hyphen.
4. Trim hyphens from both ends.
5. If that is longer than 80 characters, keep the first 80 and trim a trailing hyphen.
6. If that id is already in the file, append a hyphen and the first 8 hex characters of the SHA-256 of the full URL.

Worked example. URL `https://www.reddit.com/r/PalworldTCG/comments/abc123/example_thread/?utm=1` becomes `www-reddit-com-r-palworldtcg-comments-abc123-example-thread`.

The id must match `^[a-z0-9]+(?:-[a-z0-9]+)*$` and be at most 96 characters.

## How to add items

1. Edit only `docs/news/palworld-tcg.json` (and this README if the schema itself changes).
2. Insert each new object into `items` so the array stays newest-first.
3. Set top-level `updated_at` to the current UTC time.
4. Do not renumber, rewrite, or delete an existing item to make a diff look tidy. Appending or inserting the new objects is the whole change. A correction to a field on an existing item is allowed when the original was wrong; keep its `id`.
5. Skip a URL that is already present.
6. Set `unconfirmed` to `true` for leaks and rumours, and `false` otherwise.
7. Open a pull request whose diff is this file. `node tools/test_tcg_news.cjs` checks the shape, the enums, unique ids, and newest-first order.

## Example item

Example only. Do not paste this into `palworld-tcg.json`.

```json
{
  "id": "example-invalid-palworld-tcg-example",
  "title": "Example headline",
  "url": "https://example.invalid/palworld-tcg/example",
  "source": "news",
  "source_name": "Example Publication",
  "published_at": "2026-09-26T15:00:00Z",
  "category": "official",
  "summary": "One sentence describing the item.",
  "unconfirmed": false
}
```

## What the app does with the file

The News screen (More, then News) has a **Palworld TCG** section under the existing official headlines. It fetches the live URL, shows items newest-first with the source, date, category badge, and an Unconfirmed label when `unconfirmed` is true, and opens `url` on tap.

If the fetch fails, the section shows the last good copy saved on that device (kept for 30 days), then the empty copy bundled in the app (`TCG_NEWS_FALLBACK` in `src/paldeck.html`). The bundled copy stays empty so this JSON can grow without an app release. The app also drops a row that does not match the rules above and sorts the rest newest-first, so one bad row does not blank the list. The test requires every row in the file to pass those rules anyway.
