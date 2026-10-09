# Sealed product images

This file is the contract for sealed product art that can change without an app update. The app reads it live. A new packshot is a pull request that adds one WebP and one row here. Do not rebuild the app for that, and do not edit the Android, iOS, or web bundles.

## Location and live URL

| | |
| --- | --- |
| Path in this repo | `docs/sealed/images.json` |
| Image files | `docs/sealed/img/` |
| Live URL | `https://spheredex.app/sealed/images.json` |

`docs/` is the GitHub Pages site for spheredex.app. A file at `docs/sealed/images.json` is served at `https://spheredex.app/sealed/images.json` once it is on the branch Pages publishes. Pages sends `Access-Control-Allow-Origin: *`, so the web app and the store WebViews can read it.

The app also ships a copy inside `src/paldeck.html` (`SEALED_IMAGES_FALLBACK`) for when that fetch fails. That copy updates only when the app is rebuilt. Until then, a device that can reach the live URL uses the file. A device that cannot uses the last saved copy, then the bundled one.

## Document

```json
{
  "updated_at": "2026-10-09T10:45:00Z",
  "products": []
}
```

| Field | Where | Type | Rule |
| --- | --- | --- | --- |
| `updated_at` | top level | string | ISO 8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`) for the moment this file was last edited. Bump it on every change. |
| `products` | top level | array | One object per product id. Sorted by `id`, A to Z. Each `id` appears once. |
| `id` | product | string | A product id from `SEALED` in `src/paldeck.html`, or one `/api/releases` already publishes. Lowercase letters, digits, and hyphens. Do not invent an id the app does not have. |
| `edition` | product | string | `en` or `jp`. Which printing this art is. The tile does not swap when the price edition changes, so a product has one row. |
| `box` | product | string | Absolute URL of the Sealed tile and detail image. Omit when this row does not set one. |
| `banner` | product | string | Absolute URL of the Releases timeline image. Omit when this row does not set one. |
| `source_url` | product | string | Absolute `https` URL of the official page the image was taken from. |
| `official` | product | boolean | `true` when the file is Pocketpair / Bushiroad art. This feed only lists official images. |
| `replace` | product | boolean | Optional. `true` lets this row replace a `box` or `banner` the product already has. Leave it out otherwise. |

A row needs `box`, `banner`, or both. Image URLs must match `https://spheredex.app/sealed/img/<FILE>.webp`, and `<FILE>.webp` must be the file in `docs/sealed/img/`. The app ignores any other URL.

## Image files

| Kind | File name | Limits |
| --- | --- | --- |
| Packshot (tile) | anything except `BOX_BANNER_*` | WebP, each side at most 700 px, at most 512 KiB |
| Banner (timeline) | `BOX_BANNER_*` | WebP, width at most 840 px, height at most 1050 px, at most 512 KiB |

Packshots are trimmed product renders. A 16:9 banner lands at 840×473. A taller official graphic, such as the Dawn of Palpagos 2nd Edition poster, stays inside 840×1050 and can still fill an empty `box` when no packshot exists. `BOX_EBP02` is the Legends Awaken box. The bundled `BOX_BP02` file is the "On Sale October 30" announcement, and no product should point at it.

`ss-vol1` sets `replace` because the bundled `BOX_SS01` file is the sleeve design, not the box.

Only add a row for a product that is already in `SEALED` or that `/api/releases` already returns. An image for a product the app does not know about is never shown.

## How the app uses it

At launch, next to `fetchReleases()`, the app fetches the live file (`cache: "no-store"`), keeps a copy in `localStorage` for 30 days, and falls back to `SEALED_IMAGES_FALLBACK` when that fetch fails. The failure is ignored, so the rest of the app still opens offline.

For each row whose `id` matches a `SEALED` product, each accepted URL is stored on `CARD_IMG` under the file name (`BOX_EBP02` for `.../BOX_EBP02.webp`). An empty `box` or `banner` is then pointed at that key. A key that already has art is left alone unless the row sets `replace` to `true`. If anything changed after the live file arrived, Sealed and Releases render again.

Images and card art belong to Pocketpair / Bushiroad. SphereDex is a fan made tracker and is not an official app.
