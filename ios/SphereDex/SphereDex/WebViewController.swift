import UIKit
import WebKit

/// Hosts the bundled SphereDex web app in a WKWebView and wires the native bridge.
///
/// The web app already supports a native shell: it looks for `window.AndroidScan.scan`
/// (which we shim below), calls `window.SDActiveCollection()` to know which collection a
/// scan targets, and expects the recognised card back via `window.SDScanAdd('<number>')`.
/// `window.AndroidIcon.setIcon` is a no-op on iOS (Android-only launcher icon feature).
///
/// The web app is served through a custom URL scheme (not file://) so it has a stable,
/// secure origin and `localStorage` — where the whole collection lives — persists across launches.
final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {

    private static let appScheme = "spheredex"
    private static let appURL = "spheredex://app/spheredex.html"
    private static let bgColor = UIColor(red: 0.043, green: 0.055, blue: 0.082, alpha: 1) // #0b0e15

    private var webView: WKWebView!
    private let resolver = CardResolver()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.bgColor

        let controller = WKUserContentController()
        // Shim so the existing web code detects a native shell (IS_NATIVE) and routes scan/icon to us.
        // Shim so the web app detects a native shell: scan/icon route to us, and the Settings
        // Notifications toggles (gated on a native push bridge) drive per-device push categories.
        let bridge = """
        window.AndroidScan = { scan: function () { window.webkit.messageHandlers.sdscan.postMessage(''); } };
        window.AndroidIcon = { setIcon: function () {} };
        window.IOSPush = {
            setPrefs: function (json) { try { window.webkit.messageHandlers.sdpush.postMessage(String(json)); } catch (e) {} },
            getPrefs: function () { return ""; }
        };
        window.IS_IOS = true;
        """
        controller.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(self, name: "sdscan")
        controller.add(self, name: "sdpush")

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // Allow window.open without a user gesture so a notification-tap deep link (which opens an
        // external news article via window.open) reaches createWebViewWith and the system browser.
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: Self.appScheme)

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = Self.bgColor
        webView.scrollView.backgroundColor = Self.bgColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never   // web app owns its safe-area handling
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = true
        view.addSubview(webView)

        // Let a tapped-notification deep link route into this web view once the page is ready.
        PushRouter.shared.register(webView)

        if let url = URL(string: Self.appURL) {
            webView.load(URLRequest(url: url))
        }
    }

    // MARK: - Native bridges (scan + push prefs)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Settings Notifications toggles: persist the device's push category prefs and re-register.
        if message.name == "sdpush" {
            if let json = message.body as? String { Push.applyPrefs(json) }
            return
        }
        guard message.name == "sdscan" else { return }
        let scanner = ScannerViewController(resolver: resolver) { [weak self] number in
            guard let self, let number else { return }
            // Hand the recognised card back to the web app, which shows its rich add dialog.
            let safe = number.replacingOccurrences(of: "\\", with: "").replacingOccurrences(of: "'", with: "")
            self.webView.evaluateJavaScript("window.SDScanAdd && window.SDScanAdd('\(safe)')", completionHandler: nil)
        }
        scanner.modalPresentationStyle = .fullScreen
        present(scanner, animated: true)
    }

    // The bundled page finished loading: release any deep link queued from a cold-start notification tap.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        PushRouter.shared.pageReady()
    }

    // MARK: - Open real web links (eBay, Buy Me a Coffee) and mailto/tel outside the app

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           navigationAction.navigationType == .linkActivated,
           ["http", "https", "mailto", "tel"].contains(scheme) {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // target="_blank" links: open in the system browser rather than a new in-app web view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }
}

/// Serves the bundled single-file web app under a custom scheme so localStorage persists.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              let htmlURL = Bundle.main.url(forResource: "spheredex", withExtension: "html"),
              let data = try? Data(contentsOf: htmlURL) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/html; charset=utf-8",
                           "Cache-Control": "no-store"])!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

/// Push registration + per-device notification prefs, the iOS counterpart of Android's Push.kt.
/// Prefs are pushed from the web Settings UI via the IOSPush bridge and stored in UserDefaults;
/// registering (or re-registering) sends them to the backend so it filters by category. Best-effort.
enum Push {
    private static let backend = "https://spheredex-backend.craigjayedit.workers.dev"
    private static let prefsKey = "spheredex_push_prefs"
    // Default: everything on until the user changes it in Settings. Matches Android's DEFAULT_PREFS.
    private static let defaultPrefs = "{\"releases\":true,\"news\":true,\"newSets\":true}"

    /// The most recent APNs device token this launch, so a prefs change can re-register immediately.
    private static var lastToken: String?

    /// The device's current notification prefs as a JSON string (source of truth is the web Settings UI).
    static var currentPrefs: String {
        UserDefaults.standard.string(forKey: prefsKey) ?? defaultPrefs
    }

    /// Store new prefs (JSON from the web bridge) and re-register the token so the backend sees them.
    static func applyPrefs(_ json: String) {
        guard (try? JSONSerialization.jsonObject(with: Data(json.utf8))) != nil else { return } // ignore malformed
        UserDefaults.standard.set(json, forKey: prefsKey)
        if let token = lastToken { registerToken(token) }
    }

    /// POST { token, platform:"ios", prefs } to the backend on a background task. Logged-free best-effort.
    static func registerToken(_ token: String) {
        lastToken = token
        guard let url = URL(string: "\(backend)/api/push/register") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["token": token, "platform": "ios"]
        if let prefs = try? JSONSerialization.jsonObject(with: Data(currentPrefs.utf8)) { body["prefs"] = prefs }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req).resume()
    }
}

/// Routes a tapped-notification deep link into the live web view once it exists and is ready.
/// The AppDelegate (which receives the tap) and the WebViewController (which owns the web view) are
/// created independently by SwiftUI, so this shared holder bridges them; the url waits if it arrives
/// before the web view registers.
final class PushRouter {
    static let shared = PushRouter()
    private weak var webView: WKWebView?
    private var pending: String?
    private var ready = false        // set once the web page has finished loading

    func register(_ webView: WKWebView) { self.webView = webView; flush() }
    func pageReady() { ready = true; flush() }   // called from WKNavigationDelegate didFinish
    func open(_ url: String) { pending = url; flush() }

    // Deliver a pending deep link only once the web view exists AND the page has loaded (so
    // window.SDOpenPush is defined), mirroring Android's pageLoaded gate. A tap that arrives during a
    // cold start waits here until didFinish instead of firing into a not-yet-loaded page and vanishing.
    private func flush() {
        guard ready, let webView = webView, let url = pending else { return }
        pending = nil
        let safe = url.replacingOccurrences(of: "\\", with: "").replacingOccurrences(of: "'", with: "")
        DispatchQueue.main.async {
            webView.evaluateJavaScript("window.SDOpenPush && window.SDOpenPush('\(safe)')", completionHandler: nil)
        }
    }
}
