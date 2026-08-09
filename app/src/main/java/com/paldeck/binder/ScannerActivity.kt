package com.paldeck.binder

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.GradientDrawable
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.Executors

// Card numbers: E + short set-code letters + optional set digits + "-" + 3 digits + optional rarity letters.
private val CARD_NUMBER = Regex("E[A-Z]{1,4}\\d{0,2}-?\\d{3}[A-Z]{0,3}")
fun extractCardNumber(text: String): String? =
    CARD_NUMBER.find(text.uppercase().replace(" ", ""))?.value

/** Dims the frame except for a centered target window to line up the card number. */
private class ReticleView(ctx: Context) : View(ctx) {
    private val scrim = Paint().apply { color = 0x99000000.toInt() }
    private val clear = Paint().apply { isAntiAlias = true; xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR) }
    private val border = Paint().apply { color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 6f; isAntiAlias = true }
    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat(); val h = height.toFloat()
        val bw = w * 0.82f; val bh = bw * 0.26f
        val left = (w - bw) / 2f; val top = h * 0.40f
        val rect = RectF(left, top, left + bw, top + bh)
        val save = canvas.saveLayer(0f, 0f, w, h, null)
        canvas.drawRect(0f, 0f, w, h, scrim)
        canvas.drawRoundRect(rect, 22f, 22f, clear)
        canvas.restoreToCount(save)
        canvas.drawRoundRect(rect, 22f, 22f, border)
    }
}

/** Full-screen camera scanner with a target window and a confirm step before adding. */
class ScannerActivity : ComponentActivity() {
    private val store by lazy { BinderStore(applicationContext) }
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    private val exec = Executors.newSingleThreadExecutor()
    @Volatile private var paused = false
    private var pendingNumber: String? = null
    private var collectionName = ""

    private lateinit var previewView: PreviewView
    private lateinit var panel: LinearLayout
    private lateinit var nameText: TextView
    private lateinit var collText: TextView

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else finish()
        }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        collectionName = intent.getStringExtra("collection") ?: ""

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        previewView = PreviewView(this)
        root.addView(previewView, FrameLayout.LayoutParams(-1, -1))
        root.addView(ReticleView(this), FrameLayout.LayoutParams(-1, -1))

        val hint = TextView(this).apply {
            text = "Line up the card number in the box"
            setTextColor(Color.WHITE); textSize = 15f; setPadding(dp(20), dp(28), dp(20), 0)
        }
        root.addView(hint, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL))

        // --- Confirmation panel (hidden until a card is recognised) ---
        panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(dp(18), dp(16), dp(18), dp(16))
            background = GradientDrawable().apply { cornerRadius = dp(18).toFloat(); setColor(0xF21A1E28.toInt()) }
        }
        nameText = TextView(this).apply { setTextColor(Color.WHITE); textSize = 18f; typeface = Typeface.DEFAULT_BOLD }
        collText = TextView(this).apply { setTextColor(0xFFAAB3C6.toInt()); textSize = 13f; setPadding(0, dp(3), 0, dp(12)) }
        val btnRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val rescan = Button(this).apply { text = "Scan again"; setOnClickListener { paused = false; panel.visibility = View.GONE } }
        val add = Button(this).apply { text = "Add"; setOnClickListener { returnCard(pendingNumber) } }
        btnRow.addView(rescan, LinearLayout.LayoutParams(0, -2, 1f))
        btnRow.addView(add, LinearLayout.LayoutParams(0, -2, 1f))
        panel.addView(nameText); panel.addView(collText); panel.addView(btnRow)
        val pl = FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply { setMargins(dp(16), 0, dp(16), dp(28)) }
        root.addView(panel, pl)

        setContentView(root)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED) startCamera()
        else permLauncher.launch(Manifest.permission.CAMERA)
    }

    private fun returnCard(num: String?) {
        if (num.isNullOrEmpty()) return
        setResult(RESULT_OK, Intent().putExtra("card", num))
        finish()
    }

    private fun onMatch(number: String, name: String) {
        runOnUiThread {
            pendingNumber = number
            nameText.text = name
            collText.text = if (collectionName.isNotEmpty()) "Add to “$collectionName”" else "Add to your collection"
            panel.visibility = View.VISIBLE
        }
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(exec) { proxy ->
                val media = proxy.image
                if (media == null || paused) { proxy.close(); return@setAnalyzer }
                val input = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
                recognizer.process(input)
                    .addOnSuccessListener { result ->
                        if (paused) return@addOnSuccessListener
                        for (block in result.textBlocks) {
                            val num = extractCardNumber(block.text) ?: continue
                            val card = store.resolve(num)
                            if (card != null) { paused = true; onMatch(card.number, card.name); break }
                            break
                        }
                    }
                    .addOnCompleteListener { proxy.close() }
            }
            provider.unbindAll()
            provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        }, ContextCompat.getMainExecutor(this))
    }

    override fun onDestroy() {
        super.onDestroy()
        exec.shutdown()
    }
}
