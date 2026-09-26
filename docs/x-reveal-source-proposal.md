# Permitted sources for the X card-reveal carousel slide

Date: 2026-09-26. Status: proposal — no code changed.

## The blocker, verified live

`https://x.com/robots.txt` today still ends with:

```
User-agent: *
Disallow: /
```

So any Sieve scrape of x.com is refused by policy — the pipeline already records the
refusal (`tools/test_news_feed.py` models it) and the roadmap rule stands: do not bypass
robots.txt. What the carousel actually needs is modest: `{title, date, link, image}` rows
where `image` is a card-image URL (the reveal slide picks any row whose image matches
`/cardlist|palworld.*card/`, or whose title/summary says "reveal").

Permitted sources checked live on 2026-09-26:

| Source | robots.txt | Notes |
|---|---|---|
| x.com | `User-agent: *` → `Disallow: /` | Blocked for all general crawlers. Only named engines get narrow `Allow`s. |
| en.palworld-official-cardgame.com | Only `/wordpress/wp-admin/` disallowed | **Everything the app uses is permitted**, incl. `/news/`, uploads and `/cardlist/`. Already the app's "official" source. |
| en.bushiroad.com | WooCommerce paths only | Palworld brand page and news permitted. |
| palworld-official-cardgame.com (JP) | Only `/wordpress/wp-admin/` disallowed | JP news page permitted, incl. JP-only reveals. |
| youtube.com | `/feeds/videos.xml` explicitly disallowed | Channel/watch pages are *not* disallowed, but the cheap feed route is off-limits. |

## Options, ranked

### Option A — cardlist "What's new"/reveal section on the official site (recommended)

The official cardlist hosts the card art as static PNGs the app already ships
(`stage/pals/pal_art.json` maps `EBP01-001.png` etc.). A Sieve run (or plain HTTP fetch —
robots permits) against the cardlist "newly revealed" area yields real card titles, dates
and `…/cardlist/EBP01/EBP01-0XX.png` images. These rows classify as `official` today; tag
them `reveal` (or keep source `official` and let the reveal slide's existing regex pick
them up — `title` contains "reveal", image matches `/cardlist/`).

- Effort: small — one new Sieve instruction or a `tools/` fetch; zero app changes.
- Cadence: follows the existing twice-daily Sieve schedule; no extra quota if merged into
  the official-site session.
- Coverage: official English reveals; misses X-only teasers (which by policy we cannot
  fetch anyway).

### Option B — official-site RSS (`/feed/`) merged into the news pipeline

Live RSS exists and is permitted (`application/rss+xml`, hourly `sy:updatePeriod`). It
duplicates the scraped news list but with dates, permalinks and inline images in one
well-formed document. As a *reliability* backstop for slide 1 and the reveal slide it is
cheap: parse `<item>` → title/pubDate/link/`<description>` image. Robots-permitted.

- Effort: small — a small parser next to `tools/news_feed.py`, run on the same schedule.
- Bonus: removes dependence on Sieve for the "official news" slide entirely.

### Option C — X API (paid, fully permitted by ToS and robots)

X's robots.txt is irrelevant to the API. Current pricing (checked 2026-09-26): pay-per-use,
$0.005/post read, no free search of substance; recent-search on Free tier is 1 req/15 min
but effectively unusable for media lookups; Basic ≈ $200/mo (15k reads). A single daily
recent-search for `from:PalworldOCG_EN has:media` is ~30 reads/day ≈ **$0.15/mo** on
pay-per-use — trivially cheap and unambiguously permitted.

- Effort: medium — a `tools/x_api_reveal.py` (auth, `GET /2/users/by/username/_id`,
  recent search with `expansions=attachments.media_keys`, map `media.preview_image_url` or
  photo variants to `image`, map to the same `{title,date,link,image}` rows).
- Catch: an X developer account + billing/secrets (Infisical already used for keys).
- This is the only option that literally fills the "from @PalworldOCG_EN" slide.

### Option D — keep the current fallback (no new source)

The reveal slide already degrades gracefully: official cardlist art shows via slide 1/art
fallback, and `stage/news-feed.json`'s seeded placeholder exercises the render path. Zero
work; zero new signal.

## Recommendation

Do A now (permitted, tiny, real card art), add B as the reliability backstop, and treat C
as the optional premium path if/when X-native reveal posts are wanted. Retire the seeded
placeholder row in `stage/news-feed.json` once A or C delivers a real reveal.

## Deliberately rejected

- Any HTML/JS-side scraper of x.com (robots refused).
- Nitter/mirrors: ToS-violating and unstable.
- YouTube `/feeds/videos.xml`: explicitly Disallowed; scraping watch pages is permitted but
  yields no card-image URLs and no easy reveal detection.
