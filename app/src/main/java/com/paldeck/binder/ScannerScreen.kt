package com.paldeck.binder

import android.Manifest
import android.annotation.SuppressLint
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.Executors

// Card numbers look like EBP01-001, ETD01-005TSR, EPR-001, ESOUL-000:
// E + a short letter set-code + optional set digits + "-" + 3 digits + optional rarity letters.
private val CARD_NUMBER = Regex("E[A-Z]{1,4}\\d{0,2}-?\\d{3}[A-Z]{0,3}")

fun extractCardNumber(text: String): String? =
    CARD_NUMBER.find(text.uppercase().replace(" ", ""))?.value

@SuppressLint("MissingPermission")
@Composable
fun ScannerScreen(store: BinderStore, onScanned: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var granted by remember { mutableStateOf(
        ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED
    ) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { if (!granted) launcher.launch(Manifest.permission.CAMERA) }

    var lastMatch by remember { mutableStateOf<Card?>(null) }
    var cooldown by remember { mutableStateOf(0L) }
    var camProvider by remember { mutableStateOf<ProcessCameraProvider?>(null) }
    // Release the camera when the Scan tab is left.
    DisposableEffect(Unit) { onDispose { camProvider?.unbindAll() } }

    Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        if (granted) {
            val recognizer = remember { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
            val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
            AndroidView(factory = { ctx ->
                val previewView = PreviewView(ctx)
                val providerFuture = ProcessCameraProvider.getInstance(ctx)
                providerFuture.addListener({
                    val provider = providerFuture.get()
                    camProvider = provider
                    val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                    analysis.setAnalyzer(analysisExecutor) { proxy: ImageProxy ->
                        val media = proxy.image
                        if (media != null) {
                            val input = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
                            recognizer.process(input)
                                .addOnSuccessListener { result ->
                                    for (block in result.textBlocks) {
                                        val num = extractCardNumber(block.text) ?: continue
                                        val now = System.currentTimeMillis()
                                        val card = store.resolve(num)
                                        if (card != null && now > cooldown) {
                                            cooldown = now + 1500
                                            onScanned(card.number)
                                            lastMatch = card
                                        }
                                        break
                                    }
                                }
                                .addOnCompleteListener { proxy.close() }
                        } else proxy.close()
                    }
                    provider.unbindAll()
                    provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                }, ContextCompat.getMainExecutor(ctx))
                previewView
            }, modifier = Modifier.fillMaxSize())
        } else {
            Text("Camera access is needed to scan cards.", color = Color.White)
        }

        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.padding(top = 80.dp).size(250.dp, 120.dp).border(3.dp, Color.White.copy(alpha = 0.8f)))
            Spacer(Modifier.height(8.dp))
            Text("Point at the card number", color = Color.White)
        }

        lastMatch?.let { c ->
            Column(Modifier.align(Alignment.BottomCenter).padding(16.dp)
                .background(MaterialTheme.colorScheme.surface).padding(14.dp)) {
                Text("✓ ${c.name}", style = MaterialTheme.typography.titleMedium)
                Text("${c.number} · added to binder", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
