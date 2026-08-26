package app.spheredex

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
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

/**
 * Full-screen camera scanner with a target window. On the first recognised card it returns the
 * card number to the WebView, which shows the rich confirmation (image, wishlist/collection,
 * raw/graded, grading company + grade, which collection). No native confirm step, so there is
 * only one confirmation instead of two.
 */
class ScannerActivity : ComponentActivity() {
    private val store by lazy { BinderStore(applicationContext) }
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    private val exec = Executors.newSingleThreadExecutor()
    @Volatile private var handled = false

    private lateinit var previewView: PreviewView

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else finish()
        }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        previewView = PreviewView(this)
        root.addView(previewView, FrameLayout.LayoutParams(-1, -1))
        root.addView(ReticleView(this), FrameLayout.LayoutParams(-1, -1))

        val hint = TextView(this).apply {
            text = "Line up the card number in the box"
            setTextColor(Color.WHITE); textSize = 15f; setPadding(dp(20), dp(28), dp(20), dp(10))
        }
        root.addView(hint, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL))

        // Draw the camera edge-to-edge, then keep the hint clear of the status bar / camera cutout
        // by padding it down by the real top inset (the fixed 28dp was hidden under the notch on some phones).
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val top = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars() or
                androidx.core.view.WindowInsetsCompat.Type.displayCutout()
            ).top
            hint.setPadding(dp(20), top + dp(16), dp(20), dp(10))
            insets
        }

        setContentView(root)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED) startCamera()
        else permLauncher.launch(Manifest.permission.CAMERA)
    }

    private fun returnCard(num: String) {
        if (handled) return
        handled = true
        runOnUiThread {
            setResult(RESULT_OK, Intent().putExtra("card", num))
            finish()
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
                if (media == null || handled) { proxy.close(); return@setAnalyzer }
                val input = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
                recognizer.process(input)
                    .addOnSuccessListener { result ->
                        if (handled) return@addOnSuccessListener
                        for (block in result.textBlocks) {
                            val num = extractCardNumber(block.text) ?: continue
                            val card = store.resolve(num) ?: continue   // keep scanning later blocks (matches iOS)
                            returnCard(card.number); break
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
        try { recognizer.close() } catch (_: Exception) {}   // release ML Kit native OCR resources
    }
}
