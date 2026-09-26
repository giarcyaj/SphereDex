# Push device-acceptance checklist — one session per platform

Working companion to `docs/v2-acceptance.md` ("Push notifications and privacy"). Sized for
~40 minutes on the Android phone, ~40 on the iPhone, plus a 10-minute next-morning pass —
some alerts only fire on the backend's scheduled passes (01:00–01:05 UTC), and faking those
in-session would test nothing real. Tick the source doc's boxes and note the evidence each
step records.

Grounded in the shipped client (`src/paldeck.html`): alerts are **native push only** (the
web build has no push), permission/registration is **denied-safe** (`nativePushIface()`),
and the toggles live in **Settings → Notifications**. Backend passes: nightly pricing
01:00 UTC → price-alert check 01:01 → recap/milestones 01:05; stock polling every 30 min.

## Before you start (5 min, once)

- [ ] Phone can receive notifications (no system-wide Do Not Disturb/Focus that silences the app).
- [ ] Note the device's eBay region in the app (Settings) — stock alerts only cover UK/US/AU/DE.
- [ ] Have the backend URL handy (`spheredex-backend.craigjayedit.workers.dev`) for log checks.
- [ ] Install/refresh the current build on each phone from `build-apk`'s artifact (Android) /
      TestFlight or local build (iOS) **before** the session, so you test the shipped bundle.

## Session A — Android (~40 min)

1. [ ] **Fresh state**: clear app data (or uninstall/reinstall) so onboarding and permission
      prompts appear. Open the app; complete onboarding.
2. [ ] **Denial path** (`v2-acceptance` box 1): at the notification-permission prompt, tap
      **Don't allow**. Verify: app fully usable; Settings → Notifications reachable.
      Evidence: app stays functional, no crash, no alert UI promises.
3. [ ] **Grant path**: enable notifications in system settings, force-close, reopen the app.
      Evidence: `Push.kt` registers on open — a token row should appear server-side.
4. [ ] **Opt-in hygiene** (box 2): in Settings → Notifications confirm **Weekly recap,
      Milestones, Wishlist availability are each OFF by default**. Turn one ON, then OFF.
      Evidence: no state lingers after opt-out; other toggles untouched.
5. [ ] **Stock alerts** (UK/US/AU/DE device): open a tracked sealed product (e.g. Dawn of
      Palpagos Booster Box), tap **Stock alerts on**. On a CA/FR/IT/ES device the button must
      be **absent**. Evidence: toggle persists across app restart.
6. [ ] **Price alert**: open any owned card → alert dialog → set "below £0.01" (fires
      immediately if price > 0) or "above" a huge number. Confirm it appears in the list.
7. [ ] **Push delivery, price kind**: wait for the next 01:01 UTC pass (or use an alert that
      crosses instantly). Evidence: a real push arrives naming the card; tapping it opens
      **that card's page** (tapped-route check, box 6).
8. [ ] **Token cleanup** (box 5): uninstall the app. Next day: token is gone from the backend
      and no pushes target the dead token.

## Session B — iPhone (~40 min)

1. [ ] **Fresh install** (or delete + reinstall). At the iOS permission prompt tap **Don't
      Allow**. Verify the app is usable (box 1 — iOS registers the token only once you allow).
2. [ ] Allow notifications in system settings; relaunch; confirm registration (WebViewController
      posts to `/api/push/register` only after permission).
3. [ ] Same **opt-in hygiene** as A4 (three distinct opt-ins, default off, clean opt-out).
4. [ ] **Milestone privacy** (box 3): opt into Milestones. Evidence: no immediate push about
      past milestones (silent seed); any later push text contains only counts, never card names/IDs.
5. [ ] **Wishlist availability** (box 4): add a cheap card to your wishlist, enable the toggle.
      Evidence: push fires only on an unavailable→available transition from a fresh exact-source
      eBay listing; setting it on an already-available card must NOT push.
6. [ ] **APNs delivery + tapped route** (box 6): capture a push (price alert crossing, or wait
      for 01:01 UTC). Tap it. Evidence: correct in-app destination, no blank page.
7. [ ] **Weekly recap** (optional, box 2): enable, wait for Monday 09:00 UTC or accept waiting;
      content is aggregate counts only.

## Next-morning pass (~10 min, both phones)

- [ ] Price alerts evaluated after 01:00 UTC pricing (fires/crosses recorded, one push per crossing).
- [ ] Opt-outs from yesterday removed server-side (no push for disabled kinds).
- [ ] Tokens for uninstalled apps cleaned; no duplicate pushes.
- [ ] Record results into `docs/v2-acceptance.md` checkboxes with dates + device/OS versions.

## Pass/fail notes

- A silent 01:01 pass with zero eligible alerts is **not** a failure — verify instead that the
  price refresh at 01:00 updated rows (`price_observations` evidence, see readiness board #3).
- Any failure in boxes 1–2 (denial/registration) blocks release; alert-content nits can be
  fixed and re-tested without repeating the whole session.
