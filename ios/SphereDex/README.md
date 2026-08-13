# SphereDex for iOS

A native iOS shell around the same SphereDex web app that ships on Android and the web.
It loads the bundled `spheredex.html` in a `WKWebView` and adds one native feature: camera
card-scanning using Apple's Vision OCR. That native scanning is also what satisfies App Store
Review Guideline 4.2 (the app does more than display a website).

Everything else (collections, prices, sealed editions, RRP, decklists, charts, cloud sync) is
the shared web app, so this stays in lockstep with the other platforms automatically.

## What's here

```
SphereDex/
  project.yml                      XcodeGen spec (generates the .xcodeproj)
  SphereDex/
    SphereDexApp.swift             App entry (SwiftUI) hosting the web view controller
    WebViewController.swift        WKWebView + native bridge + custom URL scheme handler
    Scanner.swift                  Camera + Vision OCR card scanner
    CardResolver.swift             Matches an OCR read to a real card (bundled catalog)
    Info.plist                     Camera usage string, status bar, orientations
    Resources/
      spheredex.html               The web app (same bundle as Android)
      paldeck_cards.json           Card catalog, used only to validate scans
```

## Prerequisites (one-time)

1. **Full Xcode** (not just Command Line Tools). Install from the Mac App Store, then point the
   toolchain at it:
   ```
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   ```
2. **XcodeGen** to generate the project:
   ```
   brew install xcodegen
   ```
3. An **Apple Developer account** ($99/year) if you want to run on a physical device or submit.

## Generate and open

From this folder (`ios/SphereDex`):

```
xcodegen generate
open SphereDex.xcodeproj
```

In Xcode:
- Select the **SphereDex** target > **Signing & Capabilities** > pick your **Team**. Automatic
  signing will handle the rest. The bundle identifier is **`app.spheredex`**.
- Choose a simulator or your connected iPhone and press **Run**.

> Note: card scanning needs a real device (the Simulator has no camera). Everything else,
> including the whole web app, runs fine in the Simulator.

### No XcodeGen? Manual alternative
`File > New > Project > iOS App` (Interface: SwiftUI, name: SphereDex, bundle id: `app.spheredex`),
delete the generated `ContentView`/`App` file, then drag the four `.swift` files, `Info.plist`,
and the `Resources` folder into the project (check "Copy items if needed" and add to the target).
Set the Info.plist under Build Settings > Packaging, and add the camera usage string if needed.

## Keeping the web bundle in sync

`Resources/spheredex.html` is a copy of the Android bundle. Whenever the web app is rebuilt,
refresh it here too:

```
cp ../../android/app/src/main/assets/spheredex.html SphereDex/Resources/spheredex.html
```

(Both `spheredex.html` files are generated the same way from the canonical `paldeck.html`.)

## Before submitting to the App Store

- **App icon**: add an `AppIcon` set in an asset catalog (Assets.xcassets). The app builds and
  runs without one, but the store requires it.
- **Screenshots, description, privacy labels, age rating** in App Store Connect (the privacy
  labels are the equivalent of Google Play's Data Safety form).
- If a reviewer raises **Guideline 4.2** ("minimum functionality"), point them at the native
  camera scanning as the native feature beyond the web content.

## Notes / known considerations

- The web app is served through a custom `spheredex://` URL scheme rather than `file://` so it
  has a stable, secure origin and **`localStorage` (where the whole collection lives) persists**
  across launches.
- Live price pulls hit the Cloudflare backend over HTTPS. If they fail on device, the backend's
  CORS may need to allow the app origin (the web app on spheredex.app already works, so it likely
  allows any origin, but worth checking if prices don't load).
- Reward app-icon switching is Android-only; `window.AndroidIcon.setIcon` is a no-op on iOS.
