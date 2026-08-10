# Build the SphereDex Android app — no Android Studio

GitHub compiles the APK for you in the cloud. You download it to your phone and install it. Nothing (no JDK, no SDK, no IDE) is installed on your own computer.

## Repo layout (important)

The workflow expects **this `android` folder to be the repository root** — i.e. `.github/` sits right next to `settings.gradle.kts`:

```
your-repo/
├─ .github/workflows/build-apk.yml   ← the workflow
├─ settings.gradle.kts
├─ build.gradle.kts
├─ gradle.properties
└─ app/…
```

If instead you push the whole `paldeck-app/` folder, move `.github/` up to `paldeck-app/` and add `working-directory: android` under the "Build debug APK" step.

## One-time setup

1. Create a new repo on GitHub (private is fine).
2. Push the contents of this `android` folder to it, on a branch called `main`.
   ```bash
   git init
   git add .
   git commit -m "SphereDex Android app"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. That push triggers the build automatically. (You can also start one anytime: **Actions tab → Build Android APK → Run workflow**.)

## Get the APK onto your phone

1. Open the repo's **Actions** tab and click the latest **Build Android APK** run.
2. Wait for the green tick (first run ~5–8 min while it downloads the SDK; later runs are cached and faster).
3. Scroll to **Artifacts** at the bottom → download **`spheredex-debug-apk`** (a `.zip` containing `app-debug.apk`).
   - Easiest on the phone: open the Actions run in **Chrome on the phone**, download the artifact, and unzip it with your Files app.
4. Tap `app-debug.apk`. Android will say installs from this source are blocked → tap **Settings → allow "Install unknown apps"** for your browser/Files app → back → **Install**.
5. Open **SphereDex** from your app drawer.

## Notes

- This is a **debug** build: signed with a throwaway debug key, fine for your own device, not for the Play Store.
- The app id is `app.spheredex`.
- If a build fails, open the failed step's log in the Actions run — it almost always points at the exact Gradle error.
- Want a shareable/installable **release** APK later (proper signing)? Say the word and I'll add a signed-release job.
