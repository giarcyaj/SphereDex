---
description: How to change the SphereDex web app safely.
---

# paldeck.html workflow

1. Edit only `src/paldeck.html` for app UI and logic.
2. Run `python tools/rebuild.py`.
3. If cards changed, bump `CATALOGUE_VERSION` and run
   `python tools/make_native_catalog.py`.
4. Run the matching Node guard suite, then the full suite before finish.
5. Never edit generated bundles by hand. CI fails on drift.

Fenced sections must keep exactly one BEGIN and one END marker each.
