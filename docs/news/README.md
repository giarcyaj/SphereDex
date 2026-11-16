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
| `image` | item, optional | string | Absolute `https` URL of the story's own picture, such as the banner at the top of an official page. The Home news card shows it. Leave it out rather than guess: a story without one shows its product's box art. |

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

## Japanese name glossary (`ja-glossary.json`)

A second file lives next to the news list. It is not news and the app does not read it: the backend does, when it translates posts from the official Japanese X account (@PalworldOCG) into English with Cloudflare Workers AI. A general model does not know this game and tends to spell Japanese names out in Latin letters, so a reveal of アグニドラ would read "Agunidora" instead of Jormuntide Ignis. The glossary hands the model the official English for every card, Pal and epithet the app knows, plus a short list of set and product names.

| | |
| --- | --- |
| Path in this repo | `docs/news/ja-glossary.json` |
| Live URL | `https://spheredex.app/news/ja-glossary.json` |
| Built by | `python tools/build_ja_glossary.py` |
| Checked by | `python tools/build_ja_glossary.py --check`, and `tools/test_build_ja_glossary.py` fails while it is out of date |

Because Pages serves it, a new set reaches the translator once the change is on `main`, but allow up to about an hour and ten minutes: Pages caches the file for about ten minutes, and the backend keeps its own copy for an hour before it fetches again. No backend deploy is needed.

### Document

```json
{
  "updated_at": "2026-10-14T16:01:39Z",
  "terms": [
    {"ja": "荒ぶる溶岩竜 – アグニドラ", "en": "Jormuntide Ignis – Savage Lava Dragon", "kind": "card"},
    {"ja": "目覚めし伝説", "en": "Legends Awaken", "kind": "set"},
    {"ja": "アグニドラ", "en": "Jormuntide Ignis", "kind": "pal"}
  ]
}
```

| Field | Where | Type | Rule |
| --- | --- | --- | --- |
| `updated_at` | top level | string | ISO 8601 UTC. Moves only when the terms change, so a rerun with nothing new leaves the file as it was. |
| `terms` | top level | array | Longest `ja` first, so a translator that walks the list matches a full card name before the Pal name inside it. |
| `ja` | term | string | The Japanese as printed. Each one appears once in the file. |
| `en` | term | string | The official English. |
| `kind` | term | string | One of `card`, `pal`, `epithet`, `set`, `term`. |

| `kind` | Meaning |
| --- | --- |
| `card` | A full card name, such as `荒ぶる溶岩竜 – アグニドラ` or `パルスフィア` (Pal Sphere). |
| `pal` | The Pal half of a Pal card's name, such as `アグニドラ` (Jormuntide Ignis). |
| `epithet` | The other half, such as `荒ぶる溶岩竜` (Savage Lava Dragon). |
| `set` | A set or product name, such as `目覚めし伝説` (Legends Awaken). |
| `term` | A game or rules word, such as `ブースターパック` (Booster Pack) or `ラッキーパル` (Lucky Pal). |

### Where the terms come from

- **Cards.** Both languages are read from `src/paldeck.html`: the English name each card is built with (the `RAW` and `RAW2` tables) and its printed Japanese name (`CARD_TEXT_JA`, baked by `tools/bake_card_text_ja.py` from the official Japanese site and verified card by card). The two languages order a Pal card's name differently: Japanese prints the epithet first (`荒ぶる溶岩竜 – アグニドラ`), English prints the Pal first (`Jormuntide Ignis – Savage Lava Dragon`). The build checks that order against the data and refuses to write if it ever flips.
- **Ambiguous names are left out.** A Japanese term that would map to two different English ones is dropped rather than guessed. Every Japanese Soul card prints `ソウル`, for example, whatever Pals are on it.
- **Fixed terms.** Set names, product lines and card kinds are a hand checked list, `FIXED_TERMS` in `tools/build_ja_glossary.py`, and always win over anything derived. Each entry was confirmed on the official Japanese site and the official English one (same product page and same release date for the sets). Anything that could not be confirmed is left out.

Card names keep the en dash they are printed with, because that is the official name. The English words in `FIXED_TERMS` are ours, so they follow the copy rule and carry no hyphens or dashes.

### How to extend it

1. New cards: bake their Japanese text first (`python tools/bake_card_text_ja.py`), then run `python tools/build_ja_glossary.py`.
2. A new set or product name: add it to `FIXED_TERMS` with a comment saying where it was confirmed, then run the build. Only add a name that both official sites show for the same product.
3. Do not edit `ja-glossary.json` by hand. The next build would overwrite the edit, and the test fails until the file matches the build.
4. Run `cd tools && python -m unittest test_build_ja_glossary` and open a pull request with the script change (if any) and the regenerated JSON.
