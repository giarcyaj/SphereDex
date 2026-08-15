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
        let bridge = """
        window.AndroidScan = { scan: function () { window.webkit.messageHandlers.sdscan.postMessage(''); } };
        window.AndroidIcon = { setIcon: function () {} };
        window.IS_IOS = true;
        """
        controller.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(self, name: "sdscan")

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.allowsContentJavaScript = true
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

        if let url = URL(string: Self.appURL) {
            webView.load(URLRequest(url: url))
        }
    }

    // MARK: - Native scan bridge

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
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
