package app.spheredex

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
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

/**
 * The app is the full SphereDex web tracker (bundled in assets) running full-screen in a WebView.
 * A JavaScript bridge lets the in-app "Scan" button launch the native camera and drop the
 * recognised card straight into the web app's collection.
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView

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
            }
            addJavascriptInterface(WebBridge(), "AndroidScan")
            addJavascriptInterface(IconBridge(), "AndroidIcon")
            loadUrl("file:///android_asset/spheredex.html")
        }
        setContentView(web)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })
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
