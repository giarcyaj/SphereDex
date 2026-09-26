# App source

`paldeck.html` is the canonical single-file source of the SphereDex web app.
The deployed `docs/app/index.html` and the Android `app/src/main/assets/spheredex.html`
are generated from it (font + card-image + PWA-head/SW injections). Edit this file,
then regenerate both targets. Keep it committed so it is never lost.

## Featured carousel section

The Home featured carousel is fenced by `FEATURED CAROUSEL BEGIN/END` marker comments:
CSS between the `(styles)` markers (~line 785), all `feat*` logic between the `(logic)`
markers (~line 6975). Nothing carousel-related may be defined outside those markers, and
outside callers must go through the `FEATURED_CAROUSEL` API object at the end of the
section (also exposed as `window.FEATURED_CAROUSEL`) rather than reaching into internals.

`tools/test_carousel.cjs` guards this: markers exist exactly once, no carousel definition
leaks outside them, all four shipped copies (src + the three bundles) carry an identical
section (modulo line endings), and the real section is executed in a `vm` sandbox against a
stub DOM covering slides, dedupe, autoplay, taps/swipes/keyboard and listener binding.
Run `node tools/test_carousel.cjs` after touching anything carousel-related.

The continuous-scan session and review sheet are fenced the same way, by `SCAN REVIEW
BEGIN/END` markers (styles ~line 1543, logic ~line 7906) with a `SCAN_REVIEW` seam
(`window.SCAN_REVIEW`), guarded by `tools/test_scan_review.cjs`. The same rules apply:
nothing scan-session-related outside the markers, outside callers through the seam,
run the guard suite after touching the section. Wishlist undo keeps per-capture history:
wasWished is never rewritten by an undo, and a pre-existing wish survives undoing every
capture of that card (a scan-added wish is removed once no wishlist capture remains).
