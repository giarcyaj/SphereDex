# Upcoming PalDex cards

This file is the contract for PalDex tiles that have no printed card yet. The app reads it live, so a daily reveal update is a pull request that changes the JSON only. Do not rebuild the app, and do not edit the Android, iOS, or web bundles, for a reveal-only change.

## Location and live URL

| | |
| --- | --- |
| Path in this repo | `docs/paldex/upcoming-cards.json` |
| Live URL | `https://spheredex.app/paldex/upcoming-cards.json` |

`docs/` is the GitHub Pages site for spheredex.app. A file at `docs/paldex/upcoming-cards.json` is served at `https://spheredex.app/paldex/upcoming-cards.json` once it is on `main`. Pages sends `Access-Control-Allow-Origin: *`, so the web app and the store WebViews can read it.

The app also ships a copy inside `src/paldeck.html` (`UPCOMING_CARDS_FALLBACK`) for offline use. That copy updates only when the app is rebuilt. Until then, a device that can reach the live URL uses the file. A device that cannot uses the last saved copy, then the bundled one.

## Document

```json
{
  "updated_at": "2026-09-28T10:49:15Z",
  "entries": []
}
```

| Field | Where | Type | Rule |
| --- | --- | --- | --- |
| `updated_at` | top level | string | ISO 8601 UTC timestamp for the moment this file was last edited. Bump it on every change. |
| `entries` | top level | array | One object per official reveal. Order does not matter. Append new objects at the end. |
| `pal` | entry | string | PalDex name, exactly as in the app (`Anubis`, `Chillet Ignis`). Not a card subtitle. |
| `set` | entry | string | Set name shown on the tile, such as `Legends Awaken`. |
| `set_code` | entry | string | Product or card prefix, such as `EBP02` or `SS01`. Uppercase letters and digits. |
| `release_date` | entry | string | `YYYY-MM-DD`. The label hides once this date is in the past. |
| `card_name` | entry | string or null | Printed card name when official. `null` when only artwork was shown. Never guess. |
| `card_number` | entry | string or null | Printed number when official, such as `EBP02-049`. `null` when unknown. |
| `source_url` | entry | string | Absolute `https` URL of the official post or page. |
| `revealed_at` | entry | string | ISO 8601 timestamp of that post. |

A row is a duplicate when `pal`, `set_code`, `card_number` (empty when null) and `source_url` are all the same. Two reveals of the same Pal are two rows when the post or the card number differs.

Leave out anything that is not a Pal. Do not add rumours. The app ignores a row that breaks this table.

## How the tile uses it

The phrase `Card upcoming in <set>` is shown only when that Pal has no cards in the app catalogue and `release_date` is today or later. The soonest such set is the one named on the tile. After the date, or once a real card for that Pal is in the card data, the tile goes back to the ordinary "not printed yet" wording. Pals that already have cards are unchanged, even if this file mentions them.
