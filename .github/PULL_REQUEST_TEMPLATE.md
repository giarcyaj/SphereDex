# PR checklist

- [ ] `src/paldeck.html` changed? Bundles rebuilt (`python tools/rebuild.py`) and committed together — CI's drift gate fails otherwise.
- [ ] Touched the carousel or scan review? `node tools/test_carousel.cjs` / `node tools/test_scan_review.cjs` pass.
- [ ] Guards + pipeline tests pass locally (`tools/test_*.py`, `tools/test_*.cjs`); CI runs them on this PR.
- [ ] No hand edits to generated files: `docs/app/index.html`, `docs/app/sw.js`, `app/src/main/assets/spheredex.html`, `ios/SphereDex/SphereDex/Resources/spheredex.html` (regenerate instead).
- [ ] Store/privacy-sensitive changes (SDKs, permissions, data flows) noted for the disclosure review.
