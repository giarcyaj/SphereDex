package app.spheredex

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.JavascriptInterface
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
            val card = res.data?.getStringExtra("card")
            if (res.resultCode == RESULT_OK && !card.isNullOrEmpty()) {
                val safe = card.replace("\\", "").replace("'", "")
                web.evaluateJavascript("window.SDScanAdd && window.SDScanAdd('$safe')", null)
            }
        }

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
            }
            addJavascriptInterface(WebBridge(), "AndroidScan")
            addJavascriptInterface(IconBridge(), "AndroidIcon")
            addJavascriptInterface(PushBridge(), "AndroidPush")
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

    private fun launchScanner(collection: String) {
        scanLauncher.launch(Intent(this, ScannerActivity::class.java).putExtra("collection", collection))
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

    /** Exposed to the web app as window.AndroidScan */
    inner class WebBridge {
        @JavascriptInterface
        fun scan() {
            runOnUiThread {
                // Read which collection a scan will go to, then open the camera.
                web.evaluateJavascript("(window.SDActiveCollection && window.SDActiveCollection()) || ''") { raw ->
                    val name = raw?.trim()?.removeSurrounding("\"")?.replace("\\\"", "\"")
                        ?.takeIf { it.isNotEmpty() && it != "null" } ?: ""
                    runOnUiThread { launchScanner(name) }
                }
            }
        }
    }
}
