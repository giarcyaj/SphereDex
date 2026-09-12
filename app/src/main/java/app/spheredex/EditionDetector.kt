package app.spheredex

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.Executors

/**
 * Detects the Palworld 2nd-edition mark: a standalone Roman numeral "II" printed next to the
 * copyright line in the BOTTOM-RIGHT corner of a card that is otherwise identical to the 1st
 * edition. Everything else about the card (number, art, layout) is the same, so this is the only
 * signal. False positives are worse than misses, so the match is deliberately strict and the
 * default is always 1st edition.
 *
 * Uses ML Kit's on-device Latin text recognizer (already a project dependency). Heavy work runs on
 * a single background thread; the callback is always delivered on the main thread. Any failure
 * (bad bitmap, OCR error) resolves conservatively to 1 and never throws.
 */
object EditionDetector {

    // --- Tunables ---------------------------------------------------------------------------------
    /** Portion of the card WIDTH, measured in from the right edge, to inspect. */
    private const val RIGHT_FRACTION = 0.30f
    /** Portion of the card HEIGHT, measured up from the bottom edge, to inspect. */
    private const val BOTTOM_FRACTION = 0.14f
    /** Small crops are upscaled to roughly this long-edge (px) so the tiny glyphs give OCR more to read. */
    private const val TARGET_LONG_EDGE = 260
    /** Cap on that upscale so we never blow up a large crop. */
    private const val MAX_UPSCALE = 3.0f
    /** The exact accepted mark: two capital-I Roman numerals. */
    private const val MARK = "II"

    private const val FIRST_EDITION = 1
    private const val SECOND_EDITION = 2

    private val WHITESPACE = Regex("\\s+")

    /** One reusable recognizer for the app lifetime; ML Kit clients are thread-safe for process(). */
    private val recognizer: TextRecognizer by lazy {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    /**
     * @param bitmap upright, full-card frame (caller has already de-rotated the camera frame).
     * @param callback invoked once on the MAIN thread with 2 only when a standalone "II" is clearly
     *   found in the bottom-right corner, otherwise 1.
     */
    fun detect(bitmap: Bitmap, callback: (Int) -> Unit) {
        worker.execute {
            val crop = runCatching { cornerCrop(bitmap) }.getOrNull()
            if (crop == null) { reply(callback, FIRST_EDITION); return@execute }
            try {
                recognizer.process(InputImage.fromBitmap(crop, 0))
                    .addOnSuccessListener { text ->
                        reply(callback, if (hasMark(text)) SECOND_EDITION else FIRST_EDITION)
                    }
                    .addOnFailureListener { reply(callback, FIRST_EDITION) }
                    .addOnCompleteListener { recycle(crop, bitmap) }
            } catch (_: Throwable) {
                recycle(crop, bitmap)
                reply(callback, FIRST_EDITION)
            }
        }
    }

    /** Crops the bottom-right corner and upscales it if it is small, so OCR has enough pixels. */
    private fun cornerCrop(src: Bitmap): Bitmap? {
        val w = src.width
        val h = src.height
        if (w < 4 || h < 4) return null

        val left = (w - w * RIGHT_FRACTION).toInt().coerceIn(0, w - 1)
        val top = (h - h * BOTTOM_FRACTION).toInt().coerceIn(0, h - 1)
        val cw = (w - left).coerceIn(1, w - left)   // stay inside bounds
        val ch = (h - top).coerceIn(1, h - top)

        val crop = Bitmap.createBitmap(src, left, top, cw, ch)

        val longEdge = maxOf(crop.width, crop.height)
        if (longEdge in 1 until TARGET_LONG_EDGE) {
            val scale = minOf(MAX_UPSCALE, TARGET_LONG_EDGE.toFloat() / longEdge)
            if (scale > 1f) {
                val sw = (crop.width * scale).toInt().coerceAtLeast(1)
                val sh = (crop.height * scale).toInt().coerceAtLeast(1)
                val scaled = Bitmap.createScaledBitmap(crop, sw, sh, true)
                if (scaled !== crop) crop.recycle()
                return scaled
            }
        }
        return crop
    }

    /** True only if some recognised token, trimmed of surrounding punctuation, is exactly "II". */
    private fun hasMark(text: Text): Boolean {
        for (block in text.textBlocks)
            for (line in block.lines)
                for (element in line.elements)
                    if (isMark(element.text)) return true
        return false
    }

    /**
     * Strict, case-sensitive check. Splits on whitespace, strips leading/trailing non-alphanumerics,
     * then requires an exact "II". This rejects "11" (digits), "ll" (lowercase L), "H", "III", and any
     * token with adjacent characters like "II2024".
     */
    private fun isMark(raw: String): Boolean {
        for (token in raw.split(WHITESPACE)) {
            if (token.trim { !it.isLetterOrDigit() } == MARK) return true
        }
        return false
    }

    /** Recycles a bitmap we created, never the caller's input. */
    private fun recycle(crop: Bitmap, keep: Bitmap) {
        if (crop !== keep && !crop.isRecycled) crop.recycle()
    }

    private fun reply(callback: (Int) -> Unit, value: Int) = main.post { callback(value) }
}