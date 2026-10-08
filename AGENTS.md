# AGENTS.md — SphereDex app

SphereDex is a free, fan-made Palworld TCG collection tracker. One web app ships three ways:
the PWA (GitHub Pages, `docs/app/`), an Android WebView wrapper (`app/`) and an iOS WKWebView
wrapper (`ios/SphereDex/`). Only the camera scanners are native. The backend lives in a
separate repo (`spheredex-backend`, Cloudflare Workers + D1).

This folder is its own git repository (remote `github.com/giarcyaj/SphereDex`). The parent
`paldeck-app/` folder is a separate workspace repo that ignores `android/`.

## The one rule that matters most

`src/paldeck.html` is the **canonical single-file app** (vanilla HTML/CSS/JS, no framework,
no bundler). Everything below is **generated** from it by `python tools/rebuild.py` and must
never be hand-edited:

- `docs/app/index.html`, `docs/app/sw.js` (web/PWA)
- `app/src/main/assets/spheredex.html` (Android)
- `ios/SphereDex/SphereDex/Resources/spheredex.html` (iOS)
- the mirrored image folders `app/src/main/assets/img/` and the iOS `img/` copy (mirrored from `docs/app/img/`)

Workflow for any app change:

1. Edit `src/paldeck.html`.
2. Run `python tools/rebuild.py`.
3. Commit the source **and** all regenerated bundles together. CI fails the push on drift.

`rebuild.py` is deterministic. If it produces a diff you didn't expect, investigate rather
than committing it blindly.

## Fenced sections

Two sections of `src/paldeck.html` are fenced by marker comments. Each marker must appear
exactly once (CI greps for them).

- **Featured carousel**: `FEATURED CAROUSEL BEGIN/END` markers, for both `(styles)` and `(logic)`.
  Callers outside it go through `FEATURED_CAROUSEL` / `window.FEATURED_CAROUSEL`.
- **Scan review**: `SCAN REVIEW BEGIN/END` markers, for both `(styles)` and `(logic)`.
  Callers outside it go through `SCAN_REVIEW` / `window.SCAN_REVIEW`.

Nothing related to these features may be defined outside its markers, and nothing outside
may reach into their internals. Wishlist undo in scan review keeps per-capture history:
`wasWished` is never rewritten by an undo.

## Tests

Everything is stdlib only, so there is no install step. Run from this folder:

```bash
# Node 22 guard suites
node tools/test_carousel.cjs
node tools/test_scan_review.cjs
node tools/test_editions.cjs
node tools/test_v21.cjs
node tools/test_tcg_news.cjs
node tools/test_upcoming_cards.cjs
node tools/test_tournament_decks.cjs

# Python 3.11 pipeline tests
cd tools && python -m unittest discover -p 'test_*.py' -v
```

After touching the carousel or scan review, run its guard suite. Before finishing any change
to `src/paldeck.html`, run the full set above plus `python tools/rebuild.py`.

CI: `.github/workflows/tests.yml` runs these as a gate, called by `build-apk.yml` on every
push to `main` and on PRs. A failure blocks the APK build.

## Card catalogue

The native scanners read `paldeck_cards.json`, which must match the card table baked into
the web app. After adding cards to `src/paldeck.html` (and bumping `CATALOGUE_VERSION`), run:

```bash
python tools/make_native_catalog.py          # refreshes all three copies byte-identically
python tools/make_native_catalog.py --check  # fails if any copy is stale
```

Never hand-edit `paldeck_cards.json`.

## Platform constraints

- **One app everywhere.** Every UI change ships to web, Android and iOS, so check behaviour
  in both native wrappers, not just a desktop browser.
- **Old Android WebViews**: flex `gap` can collapse. Keep the `.no-flexgap` margin fallback working.
- **Storage**: the whole collection lives in `localStorage`. iOS serves the app via the
  `spheredex://` scheme so storage persists, and Android loads it from `file:///android_asset/`.
  Don't change those origins.
- **Native bridges**: `window.AndroidScan` (scanner), `window.AndroidIcon.setIcon` (Android
  only, a no-op on iOS). Feature-detect them. Never assume they exist.
- **Navigation**: a floating bottom bar with user-configurable slots, plus a More sheet. The
  hidden legacy tab-chip row is still the source for the More list and page routing, so don't delete it.
- Wishlist, Favourites and Graded are **modes of the Collection page**, not separate sections.

## Code style

- LF line endings everywhere. `.gitattributes` pins them for the source and bundles, and the
  tests assert byte-exact LF.
- 2-space indent for HTML/CSS/JS/JSON. 4-space for Kotlin, Swift and Python (see `.editorconfig`).
- Android: Kotlin, Gradle 8.7, JDK 17. There's no Gradle wrapper; CI installs Gradle directly.
- iOS: SwiftUI + WKWebView, project generated with XcodeGen (`ios/SphereDex/project.yml`).

## Product and copy rules

- **No dashes in user-facing copy.** No hyphens, en dashes or em dashes in in-app strings,
  release notes, store text or promo copy. Rewrite around them. (This rule is for copy, not code.)
- Always credit Pocketpair / Bushiroad for cards and art. Never imply the app is official.
- Real art only: never ship a placeholder tile for a card or sealed product.
- Never invent testimonials, reviews, user counts or press quotes.
- The Paldeck look is the brand. Refine it, don't replace it. Design details are in
  `../DESIGN.md` and `../PRODUCT.md` in the parent workspace.

## Secrets

Secrets live in **Infisical** and are injected as environment variables. Never commit keys,
and never print a secret's value in logs, output or built pages. The runbook is `SECRETS.md`.
Don't commit `app/google-services.json`, `local.properties`, `.env`, keystores or anything
under `stage/` or `tmp/` (all gitignored). CI writes `google-services.json` from a secret at
build time.

The Sieve news tooling (`tools/sieve.py`, `tools/sieve_run.py`) is server-side and opt-in.
See `tools/SIEVE.md`.

## PR checklist

Follow `.github/PULL_REQUEST_TEMPLATE.md`: bundles rebuilt, guard suites passing, no hand
edits to generated files, and privacy-sensitive changes (SDKs, permissions, data flows)
flagged for store disclosure review.
