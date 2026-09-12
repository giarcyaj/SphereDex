package app.spheredex

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.SystemClock
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

// Card numbers: E + short set-code letters + optional set digits + "-" + 3 digits + optional rarity letters.
private val CARD_NUMBER = Regex("E[A-Z]{1,4}\\d{0,2}-?\\d{3}[A-Z]{0,3}")
fun extractCardNumber(text: String): String? =
    CARD_NUMBER.find(text.uppercase().replace(" ", ""))?.value

/** Shared reticle geometry so the drawn window and the AR-overlay anchor never diverge. */
private fun computeReticle(w: Float, h: Float, fullCard: Boolean): RectF {
    val rw = w * 0.82f
    val rh = if (!fullCard) rw * 0.26f                        // wide, short strip for the number
             else minOf(rw / (400f / 559f), h * 0.7f)          // full portrait card frame
    val left = (w - rw) / 2f
    val top = h / 2f - rh / 2f
    return RectF(left, top, left + rw, top + rh)
}

/** Dims the frame except for a centered target window. The window switches shape with the mode. */
private class ReticleView(ctx: Context) : View(ctx) {
    /** true = full portrait card frame; false = the short code strip. */
    var fullCard = true
        set(v) { field = v; invalidate() }
    private val scrim = Paint().apply { color = 0x99000000.toInt() }
    private val clear = Paint().apply { isAntiAlias = true; xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR) }
    private val border = Paint().apply { color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 6f; isAntiAlias = true }
    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat(); val h = height.toFloat()
        val rect = computeReticle(w, h, fullCard)
        val save = canvas.saveLayer(0f, 0f, w, h, null)
        canvas.drawRect(0f, 0f, w, h, scrim)
        canvas.drawRoundRect(rect, 22f, 22f, clear)
        canvas.restoreToCount(save)
        canvas.drawRoundRect(rect, 22f, 22f, border)
    }
}

/**
 * Full-screen live camera scanner with two modes (mirrors the iOS ScannerViewController):
 *   "code" - ML Kit OCR of the printed card number (original, always reliable).
 *   "full" - on-device whole-card image recognition (CardImageMatcher, perceptual hash) with a live
 *            English AR overlay; OCR runs alongside as a fast, reliable tie-breaker.
 * Once a card is identified it also reads the 2nd-edition "II" mark (EditionDetector) and any
 * graded-slab label (SlabReader), then returns the whole outcome so the WebView shows its rich
 * confirmation (image, edition, price glance, grading fields). Tap anywhere to force a scan of the
 * current frame; after Add/Cancel the web app reopens the camera (the continuous loop).
 */
class ScannerActivity : ComponentActivity() {
    private val store by lazy { BinderStore(applicationContext) }
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    private val exec = Executors.newSingleThreadExecutor()

    @Volatile private var handled = false          // an outcome has been returned; ignore everything after
    @Volatile private var processing = false        // finalising a candidate (edition/slab); blocks new work
    @Volatile private var mode = "full"             // "full" | "code"; may change on the UI thread mid-scan
    private val forceCapture = AtomicBoolean(false) // set on tap; the next frame is a deliberate capture
    private var lastFullMatch = 0L                  // throttle full-mode live image matching (exec thread only)

    private lateinit var root: FrameLayout
    private lateinit var previewView: PreviewView
    private lateinit var reticle: ReticleView
    private lateinit var hint: TextView
    private lateinit var overlay: TranslationOverlay
    private lateinit var flashView: View
    private var toggleBar: LinearLayout? = null
    private var codeBtn: TextView? = null
    private var fullBtn: TextView? = null

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else finish()
        }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // Auto-accept a whole-card image match at/above this confidence; below it, wait for a stronger
    // frame or a tap. Show the AR label from a lower bar so it appears early. dHash confidence runs
    // ~0.57 (reject boundary) to 1.0, so these differ from the iOS feature-print thresholds. Tuning
    // knobs: verify on-device, then adjust. OCR is the always-reliable fallback in both modes.
    private companion object {
        const val FULL_AUTOACCEPT_CONFIDENCE = 0.78f
        const val FULL_OVERLAY_CONFIDENCE = 0.55f
        const val FULL_MATCH_INTERVAL_MS = 250L
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        mode = if (intent.getStringExtra("mode") == "code") "code" else "full"
        val showToggle = intent.getBooleanExtra("toggle", true)

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        previewView = PreviewView(this)
        root.addView(previewView, FrameLayout.LayoutParams(-1, -1))

        reticle = ReticleView(this).apply { fullCard = (mode != "code") }
        root.addView(reticle, FrameLayout.LayoutParams(-1, -1))

        overlay = TranslationOverlay(this)
        root.addView(overlay, FrameLayout.LayoutParams(-1, -1))

        hint = TextView(this).apply {
            text = hintText()
            setTextColor(Color.WHITE); textSize = 15f; setPadding(dp(20), dp(28), dp(20), dp(10))
        }
        root.addView(hint, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL))

        if (showToggle) addModeToggle()

        // White flash on capture, on top of everything; never intercepts touches.
        flashView = View(this).apply { setBackgroundColor(Color.WHITE); alpha = 0f; isClickable = false }
        root.addView(flashView, FrameLayout.LayoutParams(-1, -1))

        // Tap anywhere (outside the mode toggle, which consumes its own taps) forces a capture.
        root.isClickable = true
        root.setOnClickListener { screenTapped() }

        // Draw the camera edge-to-edge, then keep the hint clear of the status bar / camera cutout and
        // the mode toggle clear of the navigation bar by padding for the real insets.
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars() or
                androidx.core.view.WindowInsetsCompat.Type.displayCutout()
            )
            hint.setPadding(dp(20), bars.top + dp(16), dp(20), dp(10))
            toggleBar?.let { bar ->
                (bar.layoutParams as? FrameLayout.LayoutParams)?.let { lp ->
                    lp.bottomMargin = bars.bottom + dp(20)
                    lp.rightMargin = bars.right + dp(16)
                    bar.layoutParams = lp
                }
            }
            insets
        }

        setContentView(root)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED) startCamera()
        else permLauncher.launch(Manifest.permission.CAMERA)
    }

    private fun hintText() =
        if (mode == "code") "Line up the card number in the box" else "Fit the whole card in the frame"

    // MARK: - Mode toggle

    private fun addModeToggle() {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = GradientDrawable().apply {
                cornerRadius = dp(12).toFloat(); setColor(0x8C000000.toInt()); setStroke(dp(1), 0x4DFFFFFF)
            }
        }
        val cb = modeButton("Code", "code")
        val fb = modeButton("Full card", "full")
        bar.addView(cb); bar.addView(fb)
        codeBtn = cb; fullBtn = fb
        val lp = FrameLayout.LayoutParams(-2, dp(40), Gravity.BOTTOM or Gravity.END).apply {
            bottomMargin = dp(20); rightMargin = dp(16)
        }
        root.addView(bar, lp)
        toggleBar = bar
        refreshToggle()
    }

    private fun modeButton(title: String, value: String) = TextView(this).apply {
        text = title
        gravity = Gravity.CENTER
        textSize = 14f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(dp(18), dp(8), dp(18), dp(8))
        isClickable = true
        setOnClickListener {
            if (mode != value) {
                mode = value
                reticle.fullCard = (mode != "code")
                // Qualify: inside this TextView's apply/lambda, bare `hint`/`overlay` would resolve to
                // View.getHint()/getOverlay(), not our Activity fields.
                this@ScannerActivity.hint.text = hintText()
                this@ScannerActivity.overlay.hide()
                lastFullMatch = 0L
                refreshToggle()
            }
        }
    }

    private fun refreshToggle() {
        codeBtn?.let { styleModeButton(it, mode == "code") }
        fullBtn?.let { styleModeButton(it, mode != "code") }
    }

    private fun styleModeButton(tv: TextView, on: Boolean) {
        if (on) {
            tv.background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(0xE622D3EE.toInt()) }
            tv.setTextColor(0xFF05212B.toInt())
        } else {
            tv.background = null
            tv.setTextColor(Color.WHITE)
        }
    }

    // MARK: - Tap to scan

    private fun screenTapped() {
        if (handled || processing) return
        root.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        flash()
        forceCapture.set(true)   // the next frame is treated as a deliberate capture
    }

    private fun flash() {
        flashView.alpha = 0.85f
        flashView.animate().alpha(0f).setDuration(280L).start()
    }

    private fun currentReticle(): RectF =
        computeReticle(overlay.width.toFloat(), overlay.height.toFloat(), mode != "code")

    // MARK: - Camera + frame processing

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(exec) { proxy ->
                if (handled || processing) { proxy.close(); return@setAnalyzer }
                val forced = forceCapture.getAndSet(false)
                val upright = try { proxy.toUprightBitmap() } finally { proxy.close() }
                if (upright == null) return@setAnalyzer
                try {
                    if (mode == "code") processCode(upright, forced) else processFull(upright, forced)
                } catch (_: Throwable) {
                    if (!upright.isRecycled) upright.recycle()
                }
            }
            provider.unbindAll()
            provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        }, ContextCompat.getMainExecutor(this))
    }

    /** ImageProxy (YUV) -> upright ARGB bitmap, de-rotated by the frame's rotationDegrees. Null on failure. */
    private fun ImageProxy.toUprightBitmap(): Bitmap? = try {
        val bmp = toBitmap()
        val rot = imageInfo.rotationDegrees
        if (rot == 0) bmp
        else {
            val m = Matrix().apply { postRotate(rot.toFloat()) }
            Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true).also { if (it !== bmp) bmp.recycle() }
        }
    } catch (_: Throwable) { null }

    /** Code mode: OCR the printed number, resolve, finalise. Blocking OCR is fine on the single exec
     *  thread (KEEP_ONLY_LATEST just drops the frames we skip). */
    private fun processCode(upright: Bitmap, forced: Boolean) {
        val number = ocrResolve(upright)
        if (number != null) identify(upright, number, false) else upright.recycle()
    }

    /** Full mode: OCR first (fast + reliable when the number is legible), then a throttled whole-card
     *  image match that drives the AR overlay and auto-accepts a confident card (or, on a tap, accepts
     *  the best current match, flagged low-confidence when weak). */
    private fun processFull(upright: Bitmap, forced: Boolean) {
        val ocrNumber = ocrResolve(upright)
        if (ocrNumber != null) { identify(upright, ocrNumber, false); return }
        if (handled || processing) { upright.recycle(); return }

        val now = SystemClock.elapsedRealtime()
        val due = forced || (now - lastFullMatch) >= FULL_MATCH_INTERVAL_MS
        if (!due || !CardImageMatcher.isReady) { upright.recycle(); return }
        lastFullMatch = now

        val match = CardImageMatcher.match(upright)
        val card = match?.let { store.resolve(it.first) }
        if (match == null || card == null) {
            runOnUiThread { overlay.hide() }
            upright.recycle()
            return
        }
        val confidence = match.second
        if (confidence >= FULL_OVERLAY_CONFIDENCE) {
            runOnUiThread { if (!handled) overlay.show(card.name, card.number, null, currentReticle()) }
        }
        when {
            confidence >= FULL_AUTOACCEPT_CONFIDENCE -> identify(upright, card.number, false)
            forced -> identify(upright, card.number, true)   // tap accepted a weak match
            else -> upright.recycle()
        }
    }

    /** OCR one upright frame and resolve the first card number found; null if none. Runs on exec. */
    private fun ocrResolve(bmp: Bitmap): String? = try {
        val result = Tasks.await(recognizer.process(InputImage.fromBitmap(bmp, 0)))
        var found: String? = null
        for (block in result.textBlocks) {
            val num = extractCardNumber(block.text) ?: continue
            val card = store.resolve(num) ?: continue
            found = card.number; break
        }
        found
    } catch (_: Throwable) { null }

    /** A card number was identified. Read the 2nd-edition "II" mark and any graded-slab label from the
     *  same upright frame (in parallel), then return the whole outcome. Fires at most once. */
    private fun identify(bmp: Bitmap, number: String, lowConf: Boolean) {
        if (handled || processing) { if (!bmp.isRecycled) bmp.recycle(); return }
        processing = true
        runOnUiThread { overlay.hide() }

        var edition = 1
        var slab: SlabInfo? = null
        val pending = AtomicInteger(2)   // edition + slab; both callbacks land on the main thread
        val done = {
            if (pending.decrementAndGet() == 0) {
                if (!bmp.isRecycled) bmp.recycle()
                returnOutcome(number, edition, slab, lowConf)
            }
        }
        EditionDetector.detect(bmp) { e -> edition = e; done() }
        SlabReader.read(bmp) { s -> slab = s; done() }
    }

    private fun returnOutcome(number: String, edition: Int, slab: SlabInfo?, lowConf: Boolean) {
        if (handled) return
        handled = true
        val data = Intent()
            .putExtra("number", number)
            .putExtra("edition", edition)
            .putExtra("lowConf", lowConf)
        if (slab != null) {
            val g = JSONObject().put("grader", slab.grader).put("grade", slab.grade).put("cert", slab.cert ?: "")
            data.putExtra("graded", g.toString())
        }
        setResult(RESULT_OK, data)
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        exec.shutdown()
        try { recognizer.close() } catch (_: Exception) {}   // release ML Kit native OCR resources
    }
}
