import SwiftUI
import UserNotifications

// SphereDex iOS: a thin native shell around the same web app that ships on Android and the web.
// The native pieces are camera card-scanning (Vision OCR) and push notifications; everything else is
// the shared web app. Scanning also satisfies App Store guideline 4.2 (more than a website).
@main
struct SphereDexApp: App {
    // Owns push registration and notification-tap routing. Push is entirely inert until the user
    // grants permission and the backend has the APNs key, so this changes nothing until then.
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            WebHost()
                .ignoresSafeArea()      // the web app draws full-screen and handles insets via env(safe-area-inset-*)
        }
    }
}

/// Bridges the UIKit WebViewController (which owns the WKWebView and presents the scanner) into SwiftUI.
struct WebHost: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebViewController { WebViewController() }
    func updateUIViewController(_ vc: WebViewController, context: Context) {}
}

/// Handles APNs registration and notification taps. Mirrors the Android MainActivity push plumbing:
/// ask permission, register for remote notifications, hand the device token to the backend, and
/// deep-link a tapped notification's `url` into the web app. All best-effort and non-fatal.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // Ask for notification permission; on grant, register for APNs. Declining is fine - the app
        // works fully without it and the user can enable notifications later in iOS Settings.
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }
        return true
    }

    // APNs handed us a device token: register it with the backend (with this device's category prefs).
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Push.registerToken(hex)
    }

    // No APNs available (e.g. a Simulator without a paired Mac, or before entitlements are provisioned).
    // Nothing to do - the app is unaffected and simply won't receive pushes.
    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    // Foreground delivery: still show the banner so the user sees new-set/news alerts while in the app.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    // Tapped notification: deep-link into the web app if the push carried a `url` (best-effort, like Android).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let url = response.notification.request.content.userInfo["url"] as? String, !url.isEmpty {
            PushRouter.shared.open(url)
        }
        completionHandler()
    }
}
