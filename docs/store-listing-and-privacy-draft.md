# Store listing and privacy-disclosure draft

Prepared 23 September 2026 from the current Android/iOS app source and public privacy policy. These are drafts for the store consoles; they have **not** been submitted or published. Confirm the final release build and console responses before submission.

## Store copy

### Google Play

- App name: `SphereDex`
- Short description (79/80 characters): `Track Palworld TCG cards, scan cards and slabs, follow prices, and build decks.`
- Full description:

  > Build and organise your Palworld Trading Card Game collection with SphereDex.
  >
  > • Scan cards and graded slabs with your camera, then check the match before adding it.  
  > • Track your cards, editions, condition, graded slabs, sealed products and notes.  
  > • See collection values using available market-price data for your region.  
  > • Build decks and compare the cards you need with the cards you own.  
  > • Save cards to your wishlist and mark favourites.  
  > • Get push alerts for releases and news, with optional weekly collection recaps, card-collection milestones, and verified wishlist-card availability that you can switch on in Settings.  
  > • Export a spreadsheet (CSV) or a full JSON backup, and import a collection from a file.  
  > • Keep your collection on your device, or choose optional account sync across devices.  
  >
  > No account is needed to start. Scanning is processed on your phone; SphereDex does not upload camera images. Android's Google ML Kit scanner SDK does send limited device/app and scanner performance/utilisation metrics to Google. Read our Privacy Policy for details.
  >
  > SphereDex is a fan-made companion and is not affiliated with or endorsed by Pocketpair or Bushiroad. Card names, data and artwork belong to their respective owners.

### Apple App Store

- Name: `SphereDex`
- Subtitle (25/30 characters): `Palworld TCG Collection`
- Promotional text (draft): `Scan cards and graded slabs, organise your collection, follow market values, build decks and export a spreadsheet or backup.`
- Description: use the Google Play full description above, removing the first Android-specific sentence in the privacy paragraph and replacing it with: `On iPhone, card recognition runs on-device with Apple Vision. Camera images are not uploaded by SphereDex.`

## Privacy disclosure working sheet

This is a source-based checklist, not a completed legal/platform declaration. Console definitions change; answer each store questionnaire against the exact submitted build and SDK-generated reports.

### Source audit completed 23 September 2026

The Android app build declares Google ML Kit Text Recognition `16.0.1` and Barcode Scanning `17.3.0`; Firebase Messaging is used for push, with no analytics SDK directly declared in the app build file. Google’s current ML Kit disclosure lists device/app details and identifiers, performance, API configuration, feature input/output sizes, feature version, event types and error codes for diagnostics/usage analytics, encrypted in transit and not shared onward by ML Kit. The app's barcode scanner does not enable auto-zoom. This is a source-level review only: a release bundle and its merged dependency manifest still need checking for transitive SDKs and final declarations.

| Flow | Current implementation evidence | Console review note |
| --- | --- | --- |
| Camera frames and scan results | Android ML Kit and iOS Vision process frames locally. App code does not upload camera images. | Do not declare camera images collected by SphereDex based on current code. Mention on-device processing in the privacy policy/store copy. |
| Android ML Kit SDK metrics | App build declares Text Recognition `16.0.1` and Barcode Scanning `17.3.0`; scanner source does not enable barcode auto-zoom. Google documents device/app information, identifiers, API configuration, feature input/output size, version, events, errors and performance metrics for diagnostics/usage analytics; encrypted in transit and not shared onward by ML Kit. | Source review complete. Check the exact release bundle and merged dependency report, then answer Google Play Data safety for the shipped SDKs and any transitive collection. |
| Apple scanner | The app uses Apple's on-device Vision APIs; no third-party OCR SDK appears in the iOS project. | Verify final App Store privacy report/dependency declarations. Do not assume Android ML Kit categories apply to iOS. |
| Optional account and sync | Email, password hash, synced collection and settings are sent to SphereDex backend only when user signs in/enables sync. In-app account deletion exists. | Declare the applicable account/contact and user-content categories, purpose, linkage, encryption and deletion answers in both consoles. Verify backend retention/deletion behavior. |
| Price service and quality telemetry | Card identifiers/numbers, grade where applicable, selected market, and a random install tag/version are sent to SphereDex backend; backend requests prices from providers. A market-quality table records card number, market, source/outcome and aggregate result fields for 90 days. Server logs may include IP address. Not linked to an account by the app flow. | Review diagnostics/identifiers and financial or other user-generated data classification against current platform definitions and actual server logging. State whether each category is collected/shared and retention. |
| Push notifications | iOS/Android push tokens, platform, last check-in, preferences and market are registered with SphereDex backend; delivered via APNs/FCM. Not linked to account in app flow. Separate opt-ins send a weekly aggregate added-card count, an aggregate unique-card count for milestones, or wishlist card IDs for verified-listing checks. The milestone feature does not send identities or a collection snapshot. | Declare device/other identifiers and notification-related processing as applicable; confirm token retention and deletion. Disclose each optional payload separately and verify migration `0019_collection_milestones.sql` is applied before enabling milestone alerts in a release. |
| CSV/JSON exports | Generated locally from the active collection and handed to the OS/browser download or share flow. No automatic upload to SphereDex. | No new server collection from export itself. User may choose a separate destination in the system share sheet. |
| Contact message | User-submitted topic/message and optional reply email, plus app version/platform. Sent to SphereDex backend and delivered via Resend. | Declare messages/email and purpose; verify retention and deletion process. |

### Before submitting

- [ ] Generate/review the exact Android release bundle and merged dependency manifest; confirm Google Play Data safety answers include SDK collection from both ML Kit packages.
- [ ] Review App Store privacy answers against the iOS release binary and all included SDK/privacy manifests.
- [ ] Confirm backend request logs and price-lookup/install-tag retention with the backend configuration; adjust policy and declarations if those differ from the current description.
- [ ] Verify the weekly recap, aggregate-only milestone opt-in, and wishlist availability payloads against the deployed backend and privacy-policy wording; confirm migrations `0017`–`0019` are applied before those features ship.
- [ ] Confirm account deletion requests remove synced data and document any retained, unlinked notification tokens or operational logs.
- [ ] Add the current privacy-policy URL and support contact in both consoles; check store listing character limits after final edits.
- [ ] Submit and publish only after Craig reviews the disclosures in App Store Connect and Play Console.

## Verification references

- [Google ML Kit Android data disclosure](https://developers.google.com/ml-kit/android-data-disclosure)
- [Google ML Kit terms and privacy](https://developers.google.com/ml-kit/terms)
- [Apple App Privacy details](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy)
- [Google Play Data safety and app content](https://support.google.com/googleplay/android-developer/answer/9859455)
- [Google Play store listing requirements](https://support.google.com/googleplay/android-developer/answer/9859152)
