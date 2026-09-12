package app.spheredex

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.Executors

/** Grading label read off a slab: company (normalised), grade ("10"/"9.5"/"9" or ""), numeric cert or null. */
data class SlabInfo(val grader: String, val grade: String, val cert: String?)

/**
 * Detects a graded slab from an upright camera frame and reads its label with ML Kit.
 * OCR + barcode run on a background thread; the callback is delivered on the main thread.
 * Returns null when no grading company can be identified (i.e. it looks like a raw card).
 */
object SlabReader {

    // Single reused worker; ML Kit clients are thread-safe singletons kept for the app's life.
    private val worker = Executors.newSingleThreadExecutor { r ->
        Thread(r, "SlabReader").apply { isDaemon = true }
    }
    private val main = Handler(Looper.getMainLooper())
    private val textRecognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
    private val barcodeScanner by lazy { BarcodeScanning.getClient() }

    // Ambiguous short tokens (ACE, TAG) are last so a more specific company wins first. BECKETT -> BGS.
    private val COMPANY_TOKENS = listOf("PSA", "BGS", "BECKETT", "CGC", "SGC", "HGA", "GMA", "ACE", "TAG")

    // Grade waterfall, most specific first. Group 1 is the number; 1-10 with optional .5 / .0.
    private val NUM = "(10(?:\\.0)?|[1-9](?:\\.5)?)"
    private val GRADE_PATTERNS = listOf(
        Regex("GEM\\s*-?\\s*MT\\s*$NUM", RegexOption.IGNORE_CASE),
        Regex("GEM\\s*MINT\\s*$NUM", RegexOption.IGNORE_CASE),
        Regex("MINT\\s*$NUM", RegexOption.IGNORE_CASE),
        Regex("\\b(?:PSA|BGS|BECKETT|CGC|SGC|ACE|TAG|HGA|GMA)\\s*$NUM", RegexOption.IGNORE_CASE),
        Regex("\\b$NUM\\b")
    )

    /** bitmap = upright full frame. Callback fires on the main thread; null when it is not a slab. */
    fun read(bitmap: Bitmap, callback: (SlabInfo?) -> Unit) {
        worker.execute {
            val result = try { analyze(bitmap) } catch (_: Throwable) { null }
            main.post { callback(result) }
        }
    }

    /** Runs on the worker thread. Barcode on the full frame, OCR on the top strip. */
    private fun analyze(bitmap: Bitmap): SlabInfo? {
        val cert = readCert(bitmap)
        val label = cropTop(bitmap, 0.25f) ?: bitmap
        val grader = detectCompany(label) ?: return null   // no company => treat as raw card
        return SlabInfo(grader, detectGrade(label), cert)
    }

    /** Longest all-digit barcode raw value (graded slabs encode the numeric cert). */
    private fun readCert(bitmap: Bitmap): String? = try {
        val barcodes: List<Barcode> = Tasks.await(barcodeScanner.process(InputImage.fromBitmap(bitmap, 0)))
        var best: String? = null
        for (b in barcodes) {
            val raw = b.rawValue ?: continue
            if (raw.isNotEmpty() && raw.all(Char::isDigit) && (best == null || raw.length > best!!.length)) {
                best = raw
            }
        }
        best
    } catch (_: Throwable) { null }

    /** OCR the top strip once; reused by company + grade detection. */
    private fun ocr(crop: Bitmap): String = try {
        Tasks.await(textRecognizer.process(InputImage.fromBitmap(crop, 0))).text
    } catch (_: Throwable) { "" }

    /** First grading company token found (word-boundary, case-insensitive); BECKETT normalises to BGS. */
    private fun detectCompany(crop: Bitmap): String? {
        val text = ocr(crop)
        if (text.isEmpty()) return null
        for (tok in COMPANY_TOKENS) {
            if (Regex("\\b${Regex.escape(tok)}\\b", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
                return if (tok == "BECKETT") "BGS" else tok
            }
        }
        return null
    }

    /** Grade number via the waterfall, normalised ("10","9.5","9"); "" when nothing readable. */
    private fun detectGrade(crop: Bitmap): String {
        val text = ocr(crop)
        if (text.isEmpty()) return ""
        for (p in GRADE_PATTERNS) {
            val g = p.find(text)?.groupValues?.getOrNull(1)
            if (!g.isNullOrEmpty()) return normaliseGrade(g)
        }
        return ""
    }

    /** "10.0"->"10", "9.0"->"9", "9.5" stays; junk -> "". */
    private fun normaliseGrade(raw: String): String {
        val n = raw.toDoubleOrNull() ?: return ""
        return if (n == Math.floor(n)) n.toInt().toString() else n.toString()
    }

    /** Top [fraction] of the frame where the label sits; null on any failure (caller falls back to full frame). */
    private fun cropTop(src: Bitmap, fraction: Float): Bitmap? = try {
        val h = (src.height * fraction).toInt().coerceIn(1, src.height)
        Bitmap.createBitmap(src, 0, 0, src.width, h)
    } catch (_: Throwable) { null }
}