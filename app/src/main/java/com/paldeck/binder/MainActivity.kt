package com.paldeck.binder

import android.annotation.SuppressLint
import android.graphics.Color as AndroidColor
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView

/**
 * The app is the full SphereDex web tracker (bundled in assets) running in a WebView,
 * plus a native camera "Scan" tab that feeds scanned card numbers straight into it.
 */
class MainActivity : ComponentActivity() {
    private lateinit var store: BinderStore
    private var web: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = BinderStore(applicationContext)

        // Let the device back button navigate the web app before leaving.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val w = web
                if (w != null && w.canGoBack()) w.goBack()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Root(store) { web = it }
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Root(store: BinderStore, onWeb: (WebView) -> Unit) {
    var tab by remember { mutableStateOf(0) }
    val context = LocalContext.current

    // Build the WebView once and keep it alive across tab switches.
    val webView = remember {
        WebView(context).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(AndroidColor.parseColor("#0b0e15"))
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
            loadUrl("file:///android_asset/spheredex.html")
        }
    }
    LaunchedEffect(webView) { onWeb(webView) }

    Scaffold(bottomBar = {
        NavigationBar {
            NavigationBarItem(
                selected = tab == 0, onClick = { tab = 0 },
                icon = { Icon(Icons.Default.GridView, null) }, label = { Text("Collection") }
            )
            NavigationBarItem(
                selected = tab == 1, onClick = { tab = 1 },
                icon = { Icon(Icons.Default.CameraAlt, null) }, label = { Text("Scan") }
            )
        }
    }) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            // The web app is always present; the scanner overlays it on the Scan tab.
            AndroidView(factory = { webView }, modifier = Modifier.fillMaxSize())
            if (tab == 1) {
                ScannerScreen(store) { cardNumber ->
                    val safe = cardNumber.replace("\\", "").replace("'", "")
                    webView.evaluateJavascript("window.SDScanAdd && window.SDScanAdd('$safe')", null)
                    tab = 0
                }
            }
        }
    }
}
