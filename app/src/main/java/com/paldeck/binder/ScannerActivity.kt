package com.paldeck.binder

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
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

/** Full-screen camera scanner. Returns the matched card number to the caller and finishes. */
class ScannerActivity : ComponentActivity() {
    private val store by lazy { BinderStore(applicationContext) }
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    private val exec = Executors.newSingleThreadExecutor()
    @Volatile private var done = false
    private lateinit var previewView: PreviewView

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else { finish() }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        previewView = PreviewView(this)
        root.addView(previewView, FrameLayout.LayoutParams(-1, -1))
        val hint = TextView(this).apply {
            text = "Point at the card number"
            setTextColor(Color.WHITE)
            textSize = 15f
            setPadding(24, 24, 24, 96)
        }
        root.addView(hint, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
        setContentView(root)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED) startCamera()
        else permLauncher.launch(Manifest.permission.CAMERA)
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
                if (media == null || done) { proxy.close(); return@setAnalyzer }
                val input = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
                recognizer.process(input)
                    .addOnSuccessListener { result ->
                        for (block in result.textBlocks) {
                            val num = extractCardNumber(block.text) ?: continue
                            val card = store.resolve(num)
                            if (card != null && !done) {
                                done = true
                                setResult(RESULT_OK, Intent().putExtra("card", card.number))
                                finish()
                            }
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
