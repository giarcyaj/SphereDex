import SwiftUI

// SphereDex iOS: a thin native shell around the same web app that ships on Android and the web.
// The only native piece is camera card-scanning (Vision OCR), which also satisfies App Store
// guideline 4.2 (the app does more than display a website).
@main
struct SphereDexApp: App {
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
