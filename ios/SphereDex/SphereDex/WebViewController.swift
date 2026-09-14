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
        // IOSFile.save hands CSV / JSON exports to the native share sheet (a web download can't work here).
        let bridge = """
        window.AndroidScan = { scan: function () { window.webkit.messageHandlers.sdscan.postMessage(''); } };
        window.AndroidIcon = { setIcon: function () {} };
        window.IOSPush = {
            setPrefs: function (json) { try { window.webkit.messageHandlers.sdpush.postMessage(String(json)); } catch (e) {} },
            getPrefs: function () { return ""; }
        };
        window.IOSFile = { save: function(name, mime, text){ try { window.webkit.messageHandlers.sdfile.postMessage({name:String(name||""), mime:String(mime||""), text:String(text==null?"":text)}); return true; } catch(e){ return false; } } };
        window.IS_IOS = true;
        """
        controller.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(self, name: "sdscan")
        controller.add(self, name: "sdpush")
        controller.add(self, name: "sdfile")

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

        // Warm up on-device full-card recognition: first launch extracts the bundled card images and
        // computes their Vision feature prints in the background, so "Full card" mode is ready to match.
        CardImageMatcher.shared.prepare()
    }

    // MARK: - Native bridges (scan + push prefs + file export)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Settings Notifications toggles: persist the device's push category prefs and re-register.
        if message.name == "sdpush" {
            if let json = message.body as? String { Push.applyPrefs(json) }
            return
        }
        // Collection export (CSV / JSON backup): write it to a temp file and offer the share sheet.
        if message.name == "sdfile" {
            shareTextFile(message.body)
            return
        }
        guard message.name == "sdscan" else { return }
        // Read the scan prefs the web Settings exposes (default mode + whether to show the on-camera
        // toggle), then present the camera. Falls back to sensible defaults if the bridge isn't there.
        webView.evaluateJavaScript("window.SDScanPrefs ? window.SDScanPrefs() : ''") { [weak self] result, _ in
            guard let self = self else { return }
            var mode = "full"
            var showToggle = true
            if let json = result as? String, let data = json.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let m = obj["mode"] as? String { mode = m }
                if let t = obj["toggle"] as? Bool { showToggle = t }
            }
            let scanner = ScannerViewController(resolver: self.resolver, mode: mode, showToggle: showToggle) { [weak self] outcome in
                guard let self = self, let outcome = outcome else { return }
                self.deliverScan(outcome)
            }
            scanner.modalPresentationStyle = .fullScreen
            self.present(scanner, animated: true)
        }
    }

    /// Hand a scan result to the web app's rich add dialog:
    /// SDScanAdd(number, edition, graded{grader,grade,cert}|null, lowConfidence).
    private func deliverScan(_ outcome: ScanOutcome) {
        let num = outcome.number.replacingOccurrences(of: "\\", with: "").replacingOccurrences(of: "'", with: "")
        var gradedJS = "null"
        if let slab = outcome.slab {
            let dict: [String: String] = ["grader": slab.grader, "grade": slab.grade, "cert": slab.cert ?? ""]
            if let data = try? JSONSerialization.data(withJSONObject: dict),
               let str = String(data: data, encoding: .utf8) {
                gradedJS = str
            }
        }
        let lowConf = outcome.lowConfidence ? "true" : "false"
        let js = "window.SDScanAdd && window.SDScanAdd('\(num)', \(outcome.edition), \(gradedJS), \(lowConf))"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - File export (IOSFile.save -> share sheet)

    /// Write a text export from the web app to a fresh temp dir and present the system share sheet,
    /// so "Save to Files", AirDrop, Mail etc. all work. Reports back through window.SDFileDone.
    /// Body is {name, mime, text} (a JSON string is accepted too, in case an older bridge sends one).
    private func shareTextFile(_ body: Any) {
        var payload = body as? [String: Any]
        if payload == nil, let json = body as? String, let data = json.data(using: .utf8) {
            payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        guard let info = payload, let text = info["text"] as? String else { fileDone(false); return }
        // One sheet at a time (not over the scanner or another sheet), and only while we're on screen.
        guard presentedViewController == nil, view.window != nil else { fileDone(false); return }

        let fm = FileManager.default
        Self.sweepExportDirs()   // nothing is presented, so any earlier export dir is finished with
        let name = Self.exportFileName((info["name"] as? String) ?? "", mime: (info["mime"] as? String) ?? "")
        let dir = fm.temporaryDirectory.appendingPathComponent("sdfile-" + UUID().uuidString, isDirectory: true)
        let fileURL = dir.appendingPathComponent(name)
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: nil)
            try Data(text.utf8).write(to: fileURL, options: .atomic)   // UTF-8, BOM kept if the web app sent one
        } catch {
            try? fm.removeItem(at: dir)
            fileDone(false)
            return
        }

        let sheet = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        // iPad presents the sheet as a popover, which crashes without a source: anchor it mid screen, no arrow.
        if let pop = sheet.popoverPresentationController {
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
            pop.permittedArrowDirections = []
        }
        // Can fire more than once per sheet (false when backing out of one activity with the sheet still up).
        // The sheet is finished when an activity completed or it was dismissed (activityType == nil); the
        // temp file is removed a few seconds later so a receiving app has finished reading it.
        sheet.completionWithItemsHandler = { [weak self] activityType, completed, _, _ in
            DispatchQueue.main.async {
                self?.fileDone(completed)
                if completed || activityType == nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                        try? FileManager.default.removeItem(at: dir)
                    }
                }
            }
        }
        present(sheet, animated: true)
    }

    /// Tell the web app how the export went. It only acts on true (fires its success toast).
    private func fileDone(_ ok: Bool) {
        let flag = ok ? "true" : "false"
        webView.evaluateJavaScript("window.SDFileDone && window.SDFileDone(\(flag))", completionHandler: nil)
    }

    /// A safe export file name: ASCII letters, digits, "-" and "_" only (anything else becomes "_"),
    /// base capped at 200 chars (keeping its last 11, the date) and never empty; a short extension is kept, else inferred from the mime.
    private static func exportFileName(_ raw: String, mime: String) -> String {
        let allowed: Set<Character> = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        var base = raw
        var ext = ""
        if let dot = raw.lastIndex(of: ".") {
            let candidate = String(raw[raw.index(after: dot)...])
            if (1...5).contains(candidate.count),
               candidate.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) {
                ext = candidate.lowercased()
                base = String(raw[..<dot])
            }
        }
        if ext.isEmpty {
            let m = mime.lowercased()
            ext = m.contains("csv") ? "csv" : (m.contains("json") ? "json" : "txt")
        }
        var clean = String(base.map { (c: Character) -> Character in allowed.contains(c) ? c : "_" })
        clean = clean.trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        // ASCII only, so chars == bytes; cap well under APFS's 255 and keep the "-YYYY-MM-DD" tail.
        if clean.count > 200 { clean = String(clean.prefix(189)) + String(clean.suffix(11)) }
        if clean.isEmpty { clean = "spheredex-export" }
        return clean + "." + ext
    }

    /// Clear export temp dirs left by earlier shares (e.g. the app was killed while a sheet was up).
    private static func sweepExportDirs() {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(at: fm.temporaryDirectory, includingPropertiesForKeys: nil) else { return }
        for item in items where item.lastPathComponent.hasPrefix("sdfile-") {
            try? fm.removeItem(at: item)
        }
    }

    // The bundled page finished loading: release any deep link queued from a cold-start notification tap.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        PushRouter.shared.pageReady()
    }

    // MARK: - Open real web links (eBay, Buy Me a Coffee) and mailto/tel outside the app

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // A stray download link (<a download>, blob: export) must never replace the app page.
        if navigationAction.shouldPerformDownload { decisionHandler(.cancel); return }
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
