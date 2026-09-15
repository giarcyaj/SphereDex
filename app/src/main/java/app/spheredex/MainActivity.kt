package app.spheredex

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

/**
 * The app is the full SphereDex web tracker (bundled in assets) running full-screen in a WebView.
 * A JavaScript bridge lets the in-app "Scan" button launch the native camera and drop the
 * recognised card straight into the web app's collection.
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var insetJs: String? = null
    private var pageLoaded = false
    private var pendingPushUrl: String? = null

    // Android 13+ notification permission. Result ignored: if declined, the user can still opt in
    // later from system settings, and the app works fully without it.
    private val notifPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /** Push the current safe-area insets into the web app as CSS variables (--sat/--sab/--sal/--sar). */
    private fun applyInsets() { insetJs?.let { js -> web.evaluateJavascript(js, null) } }

    private val scanLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            val number = res.data?.getStringExtra("number")
            if (res.resultCode == RESULT_OK && !number.isNullOrEmpty()) {
                // Deliver the rich scan outcome to the web app's add dialog:
                // SDScanAdd(number, edition, graded{grader,grade,cert}|null, lowConfidence).
                val safe = number.replace("\\", "").replace("'", "")
                val edition = res.data?.getIntExtra("edition", 1) ?: 1
                val graded = res.data?.getStringExtra("graded")     // JSON object string, or null for a raw card
                val lowConf = res.data?.getBooleanExtra("lowConf", false) ?: false
                val gradedArg = if (graded.isNullOrEmpty()) "null" else graded   // valid JS object literal
                web.evaluateJavascript(
                    "window.SDScanAdd && window.SDScanAdd('$safe', $edition, $gradedArg, $lowConf)", null
                )
            }
        }

    // Export "Save as" state (window.AndroidFiles.save). The text stays in this field, never in an Intent
    // extra (Binder transactions cap out around 1MB); saveBusy rejects a save while another is in progress.
    private val saveLock = Any()
    @Volatile private var saveBusy = false
    @Volatile private var pendingSaveText: String? = null
    @Volatile private var pendingSaveMime = "text/plain"
    private val mimeRe = Regex("^[a-z0-9.+-]+/[a-z0-9.+-]+$")
    private val acceptRe = Regex("^([a-z0-9.+-]+|\\*)/([a-z0-9.+-]+|\\*)$")

    /** System "Save as" picker. The MIME is applied per launch (the constructor type is only a default). */
    private val saveLauncher =
        registerForActivityResult(object : ActivityResultContracts.CreateDocument("text/plain") {
            override fun createIntent(context: Context, input: String): Intent =
                super.createIntent(context, input).addCategory(Intent.CATEGORY_OPENABLE).setType(pendingSaveMime)
        }) { uri -> onSaveTarget(uri) }

    // Pending <input type="file"> callback (UI thread only). Must be resolved exactly once.
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    /** System document picker behind the web app's file inputs (collection import). */
    private val openDocLauncher =
        registerForActivityResult(object : ActivityResultContracts.OpenDocument() {
            override fun createIntent(context: Context, input: Array<String>): Intent =
                super.createIntent(context, input).addCategory(Intent.CATEGORY_OPENABLE)
        }) { uri -> deliverChosen(if (uri != null) arrayOf(uri) else null) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0b0e15"))
            with(settings) {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = true
                useWideViewPort = true
                loadWithOverviewMode = true
                builtInZoomControls = false
                setSupportZoom(false)
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
                setSupportMultipleWindows(true)   // so target="_blank" links reach onCreateWindow (below)
                javaScriptCanOpenWindowsAutomatically = true   // let SDOpenPush's window.open (no user gesture on a notification tap) reach onCreateWindow
            }
            overScrollMode = WebView.OVER_SCROLL_NEVER
            // Keep the app inside the WebView, but open real web links (eBay, Buy Me a Coffee) in the browser.
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                    val u = req.url
                    val s = u.scheme
                    // Open web links (eBay, Buy Me a Coffee) and mailto/tel (Contact page) outside the WebView.
                    if (s == "http" || s == "https" || s == "mailto" || s == "tel") {
                        try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) {}
                        return true
                    }
                    return false
                }
                // Re-apply insets once the page's DOM exists (the listener may fire before load).
                override fun onPageFinished(view: WebView, url: String) {
                    applyInsets()
                    pageLoaded = true
                    applyPendingPushUrl()   // a notification tapped before the page loaded
                }
            }
            // Make window.prompt/confirm/alert work (WebView blocks them by default),
            // so "New collection", rename, and delete confirmations pop up natively.
            webChromeClient = object : WebChromeClient() {
                override fun onJsAlert(v: WebView?, url: String?, msg: String?, r: JsResult): Boolean {
                    AlertDialog.Builder(this@MainActivity).setMessage(msg)
                        .setPositiveButton("OK") { _, _ -> r.confirm() }
                        .setOnCancelListener { r.cancel() }.show()
                    return true
                }
                override fun onJsConfirm(v: WebView?, url: String?, msg: String?, r: JsResult): Boolean {
                    AlertDialog.Builder(this@MainActivity).setMessage(msg)
                        .setPositiveButton("OK") { _, _ -> r.confirm() }
                        .setNegativeButton("Cancel") { _, _ -> r.cancel() }
                        .setOnCancelListener { r.cancel() }.show()
                    return true
                }
                override fun onJsPrompt(v: WebView?, url: String?, msg: String?, def: String?, r: JsPromptResult): Boolean {
                    val input = EditText(this@MainActivity).apply { setText(def ?: "") }
                    AlertDialog.Builder(this@MainActivity).setMessage(msg).setView(input)
                        .setPositiveButton("OK") { _, _ -> r.confirm(input.text.toString()) }
                        .setNegativeButton("Cancel") { _, _ -> r.cancel() }
                        .setOnCancelListener { r.cancel() }.show()
                    return true
                }
                // A target="_blank" / window.open link: capture its URL with a throwaway WebView and hand it
                // to the system browser, so external links (eBay, Amazon, shops) never open a dead in-app popup.
                override fun onCreateWindow(v: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
                    val tmp = WebView(v.context)
                    tmp.webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(w: WebView, r2: WebResourceRequest): Boolean {
                            try { startActivity(Intent(Intent.ACTION_VIEW, r2.url)) } catch (_: Exception) {}
                            w.post { w.destroy() }   // defer teardown off this WebView's own callback stack
                            return true
                        }
                    }
                    (resultMsg.obj as WebView.WebViewTransport).webView = tmp
                    resultMsg.sendToTarget()
                    return true
                }
                // <input type="file"> (collection import): open the system document picker. Accept types are
                // widened because providers label .json/.csv files inconsistently (text/plain, octet-stream).
                override fun onShowFileChooser(v: WebView?, callback: ValueCallback<Array<Uri>>?, params: WebChromeClient.FileChooserParams?): Boolean {
                    deliverChosen(null)   // resolve a stale request before taking the new one
                    fileCallback = callback
                    try { openDocLauncher.launch(chooserMimes(params?.acceptTypes)) }
                    catch (_: Exception) { deliverChosen(null) }
                    return true
                }
            }
            addJavascriptInterface(WebBridge(), "AndroidScan")
            addJavascriptInterface(IconBridge(), "AndroidIcon")
            addJavascriptInterface(PushBridge(), "AndroidPush")
            addJavascriptInterface(FileBridge(), "AndroidFiles")
            loadUrl("file:///android_asset/spheredex.html")
        }
        setContentView(web)

        // Edge-to-edge (mandatory on Android 15 / API 35): draw the themed web background behind the
        // system bars, and feed the real safe-area insets to the web app so no content is cut off.
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(web) { _, insets ->
            val bars = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars() or
                    androidx.core.view.WindowInsetsCompat.Type.displayCutout()
            )
            // Keyboard (IME) inset: report its height to the web app as --kb (CSS px). The web layer uses
            // it to lift the detail sheet and page content above the keyboard. We deliberately do NOT pad
            // the WebView here: padding does not shrink position:fixed overlays (which is where Notes lives),
            // so it left the field hidden. An explicit --kb the CSS can react to is reliable on both themes.
            val ime = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime()).bottom
            if (web.paddingBottom != 0) web.setPadding(0, 0, 0, 0)
            val d = resources.displayMetrics.density
            insetJs = "var r=document.documentElement.style;" +
                "r.setProperty('--sat','${bars.top / d}px');" +
                "r.setProperty('--sab','${bars.bottom / d}px');" +
                "r.setProperty('--sal','${bars.left / d}px');" +
                "r.setProperty('--sar','${bars.right / d}px');" +
                "r.setProperty('--kb','${ime / d}px');"
            applyInsets()
            insets
        }
        androidx.core.view.ViewCompat.requestApplyInsets(web)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        // Warm up on-device full-card recognition: first launch after an install or update reads the bundled
        // card images in assets/img and builds their perceptual-hash table in the background (cached thereafter),
        // so "Full card" mode is ready to match by the time the user opens the scanner.
        CardImageMatcher.prepare(this)

        // Push notifications. All inert until app/google-services.json is added: the channel/permission
        // are harmless without it, and fetchAndRegister no-ops while Firebase has no default app.
        Push.ensureChannel(this)
        askNotificationPermission()
        Push.fetchAndRegister(this)
        handleDeepLink(intent)   // launched by tapping a notification (cold start)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)        // keep getIntent() in sync
        handleDeepLink(intent)   // notification tapped while the app was already running
    }

    /** Ask for POST_NOTIFICATIONS on Android 13+. On older versions it is granted at install. */
    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    /** A tapped notification may carry a "url" extra (a route into the web app). Defer until loaded. */
    private fun handleDeepLink(intent: Intent?) {
        intent?.getStringExtra("url")?.takeIf { it.isNotBlank() }?.let {
            pendingPushUrl = it
            applyPendingPushUrl()
        }
    }

    private fun applyPendingPushUrl() {
        if (!pageLoaded) return
        val u = pendingPushUrl ?: return
        pendingPushUrl = null
        val safe = u.replace("\\", "").replace("'", "")
        web.evaluateJavascript("window.SDOpenPush && window.SDOpenPush('$safe')", null)
    }

    private fun launchScanner(collection: String, mode: String, showToggle: Boolean) {
        scanLauncher.launch(
            Intent(this, ScannerActivity::class.java)
                .putExtra("collection", collection)
                .putExtra("mode", mode)
                .putExtra("toggle", showToggle)
        )
    }

    /** Resolve the pending file chooser exactly once: the field is cleared first, since a second
     *  onReceiveValue on the same callback throws. */
    private fun deliverChosen(uris: Array<Uri>?) {
        val cb = fileCallback ?: return
        fileCallback = null
        try { cb.onReceiveValue(uris) } catch (_: Exception) {}
    }

    /** Map an input's accept list to a lenient MIME array for OpenDocument (any type when nothing usable). */
    private fun chooserMimes(accept: Array<String>?): Array<String> {
        val out = LinkedHashSet<String>()
        accept?.flatMap { it.split(',') }?.map { it.trim().lowercase() }?.filter { it.isNotEmpty() }?.forEach { t ->
            when (t) {
                ".json", "application/json" -> out.addAll(listOf("application/json", "text/json", "text/plain"))
                ".csv", "text/csv" -> out.addAll(listOf("text/csv", "text/comma-separated-values", "application/csv",
                    "application/vnd.ms-excel", "text/plain"))
                ".txt", "text/plain" -> out.add("text/plain")
                else -> if (acceptRe.matches(t)) out.add(t)
            }
        }
        if (out.isEmpty()) return arrayOf("*/*")
        out.add("text/*")
        out.add("application/octet-stream")
        return out.toTypedArray()
    }

    private fun clearSave() {
        synchronized(saveLock) { pendingSaveText = null; pendingSaveMime = "text/plain"; saveBusy = false }
    }

    /** Report an export's outcome to the web app (UI thread). Only true fires its success callback. */
    private fun fileDone(ok: Boolean) {
        web.evaluateJavascript("window.SDFileDone && window.SDFileDone($ok)", null)
    }

    /** "Save as" result: write the pending text as UTF-8 to the chosen document off the UI thread. */
    private fun onSaveTarget(uri: Uri?) {
        val text = pendingSaveText
        if (uri == null) { clearSave(); fileDone(false); return }
        if (text == null) {
            // Process was killed while the picker was open: remove the empty document the picker just
            // created. Only a zero byte file is deleted, so an existing file picked to overwrite is kept.
            clearSave()
            Thread {
                try {
                    val size = contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)
                        ?.use { c -> if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null }
                    if (size == 0L) android.provider.DocumentsContract.deleteDocument(contentResolver, uri)
                } catch (_: Exception) {}
            }.start()
            fileDone(false); return
        }
        Thread {
            val ok = try {
                val bytes = text.toByteArray(Charsets.UTF_8)
                // "wt" truncates; plain "w" does not on API 29+, which would leave old bytes after a shorter export.
                val os = (try { contentResolver.openOutputStream(uri, "wt") }
                    catch (_: IllegalArgumentException) { null }
                    catch (_: UnsupportedOperationException) { null }
                    catch (_: java.io.FileNotFoundException) { null })
                    ?: contentResolver.openOutputStream(uri, "w")
                os?.use { it.write(bytes); true } ?: false
            } catch (_: Throwable) { false }
            clearSave()
            runOnUiThread { fileDone(ok) }
        }.start()
    }

    // Reward key -> launcher activity-alias. "default"/"pal" share the blue classic icon.
    private val iconAliases = linkedMapOf(
        "default" to "AliasDefault",
        "pal" to "AliasDefault",
        "mega" to "AliasMega",
        "giga" to "AliasGiga",
        "hyper" to "AliasHyper",
        "ultra" to "AliasUltra",
        "legendary" to "AliasLegendary",
    )

    /** Enable the chosen sphere's launcher alias and disable the others. The launcher may briefly
     *  relaunch the app when the home-screen icon changes — that's normal Android behaviour. */
    private fun applyIcon(key: String) {
        val chosen = iconAliases[key] ?: "AliasDefault"
        val pm = packageManager
        // Distinct alias set (default/pal collapse to one), so exactly one launcher stays enabled.
        for (alias in iconAliases.values.toSet()) {
            val state = if (alias == chosen) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                        else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
            pm.setComponentEnabledSetting(
                ComponentName(packageName, "$packageName.$alias"),
                state,
                PackageManager.DONT_KILL_APP,
            )
        }
    }

    /** Exposed to the web app as window.AndroidIcon */
    inner class IconBridge {
        @JavascriptInterface
        fun setIcon(key: String) {
            runOnUiThread { try { applyIcon(key) } catch (_: Exception) {} }
        }
    }

    /** Exposed to the web app as window.AndroidPush. The Settings UI calls setPrefs() with a JSON
     *  object of category toggles; we persist it and re-register the token so the backend honours it.
     *  getPrefs() lets the web read the device's stored prefs to seed the toggles. */
    inner class PushBridge {
        @JavascriptInterface
        fun setPrefs(json: String) {
            try { Push.applyPrefs(this@MainActivity, json) } catch (_: Exception) {}
        }
        @JavascriptInterface
        fun getPrefs(): String = try { Push.currentPrefs(this@MainActivity) } catch (_: Exception) { "" }
    }

    /** Exposed to the web app as window.AndroidFiles. save() opens the system "Save as" picker for an
     *  export (CSV/JSON); the outcome arrives via window.SDFileDone(true|false). Returns false when a
     *  save is already in progress. */
    inner class FileBridge {
        @JavascriptInterface
        fun save(name: String?, mime: String?, text: String?): Boolean {
            val type = mime?.trim()?.lowercase()?.takeIf { mimeRe.matches(it) } ?: "text/plain"
            val title = name?.replace('/', '_')?.replace('\\', '_')?.trim()?.takeIf { it.isNotEmpty() } ?: "spheredex.txt"
            synchronized(saveLock) {
                if (saveBusy) return false
                saveBusy = true
                pendingSaveText = text ?: ""
                pendingSaveMime = type
            }
            runOnUiThread {
                try { saveLauncher.launch(title) }
                catch (_: ActivityNotFoundException) { clearSave(); fileDone(false) }
                catch (_: Exception) { clearSave(); fileDone(false) }
            }
            return true
        }
    }

    /** Exposed to the web app as window.AndroidScan */
    inner class WebBridge {
        @JavascriptInterface
        fun scan() {
            runOnUiThread {
                // Read the scan prefs (default recognizer mode + whether to show the on-camera toggle),
                // then which collection a scan targets, then open the camera. Sensible defaults if either
                // bridge value is missing. evaluateJavascript returns a JSON-encoded string, so a JS string
                // arrives wrapped in quotes with inner quotes escaped: unwrap before parsing.
                web.evaluateJavascript("(window.SDScanPrefs && window.SDScanPrefs()) || ''") { rawPrefs ->
                    var mode = "full"
                    var showToggle = true
                    try {
                        val json = rawPrefs?.trim()?.removeSurrounding("\"")?.replace("\\\"", "\"")
                        if (!json.isNullOrEmpty() && json != "null") {
                            val obj = org.json.JSONObject(json)
                            mode = if (obj.optString("mode", "full") == "code") "code" else "full"
                            showToggle = obj.optBoolean("toggle", true)
                        }
                    } catch (_: Exception) {}
                    web.evaluateJavascript("(window.SDActiveCollection && window.SDActiveCollection()) || ''") { raw ->
                        val name = raw?.trim()?.removeSurrounding("\"")?.replace("\\\"", "\"")
                            ?.takeIf { it.isNotEmpty() && it != "null" } ?: ""
                        runOnUiThread { launchScanner(name, mode, showToggle) }
                    }
                }
            }
        }
    }
}
