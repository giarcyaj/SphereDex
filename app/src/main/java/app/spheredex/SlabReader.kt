package app.spheredex

import android.graphics.Bitmap
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

/**
 * Grading label read off a slab: company (normalised; "Other" when the frame is clearly a slab but the
 * company could not be read, so the popup asks), grade ("10"/"9.5"/"9" or ""), numeric cert or null,
 * and the OCR lines of the label band. The label prints the card's name and number in clean, high
 * contrast type, so the scanner identifies a slabbed card from THESE lines instead of trying to read the
 * card through the plastic (glare + the label covering the top is what used to defeat graded cards).
 */
data class SlabInfo(
    val grader: String,
    val grade: String,
    val cert: String?,
    val labelLines: List<String> = emptyList(),
)

/**
 * Detects a graded slab from an upright camera frame and reads its label with ML Kit.
 *
 * Slab signals, any one of which marks the frame as a slab: a barcode / QR on the label (the numeric cert,
 * or the grader's cert-page URL), or a grading company printed in the label band. The company comes from
 * the QR URL's host when present (certain), else the label text, else "Other". Returns null only when no
 * slab signal is present at all, i.e. it looks like a raw card. Mirrors iOS SlabReader.
 */
object SlabReader {

    // ML Kit clients are thread-safe singletons kept for the app's life.
    private val textRecognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
    private val barcodeScanner by lazy { BarcodeScanning.getClient() }

    // Fraction of the frame height, from the top, that counts as the label band: the label sits across the
    // top of a slab, and 0.40 still covers it when the whole slab is fitted in the reticle. The band is
    // what gets OCR'd and where a code has to START to count (a barcode lower down is packaging or a
    // price sticker, not a cert). Keep in step with iOS labelBandFraction.
    private const val LABEL_BAND = 0.40f

    // Retail symbologies never appear on a grading label; a booster box or price sticker in shot must
    // not turn a raw card into a slab.
    private val RETAIL_FORMATS = setOf(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E)

    // Shortest all-digit payload accepted as a cert (real certs are 7+ digits).
    private const val MIN_CERT_DIGITS = 7

    // Ambiguous short tokens (ACE, TAG) are last so a more specific company wins first. BECKETT -> BGS.
    private val COMPANY_TOKENS = listOf("PSA", "BGS", "BECKETT", "CGC", "SGC", "HGA", "GMA", "ACE", "TAG")

    // Newer slabs carry a QR that encodes the grader's cert page; the host names the company for certain.
    private val CODE_HOSTS = listOf(
        "psacard.com" to "PSA", "beckett.com" to "BGS", "cgccards.com" to "CGC", "cgccomics.com" to "CGC",
        "sgccard.com" to "SGC", "hybridgrading.com" to "HGA", "gmagrading.com" to "GMA",
        "acegrading.com" to "ACE", "taggrading.com" to "TAG",
    )

    // Grade waterfall, most specific first. Group 1 is the number; 1-10 with optional .5 / .0.
    private val NUM = "(10(?:\\.0)?|[1-9](?:\\.5)?)"
    private val GRADE_PATTERNS = listOf(
        Regex("GEM\\s*-?\\s*MT\\s*$NUM", RegexOption.IGNORE_CASE),
        Regex("GEM\\s*MINT\\s*$NUM", RegexOption.IGNORE_CASE),
        Regex("MINT\\s*$NUM", RegexOption.IGNORE_CASE),
        Regex("\\b(?:PSA|BGS|BECKETT|CGC|SGC|ACE|TAG|HGA|GMA)\\s*$NUM", RegexOption.IGNORE_CASE),
        Regex("\\b$NUM\\b")
    )

    /** What the barcode / QR pass yielded: the numeric cert and, from a cert-URL QR, the company. */
    private class CodeInfo(val cert: String?, val company: String?)

    /** Synchronous probe for a caller already off the main thread (the scanner's analysis executor).
     *  Null when the frame shows no slab signal. Does not recycle [bitmap]. */
    fun probe(bitmap: Bitmap): SlabInfo? = try { analyze(bitmap) } catch (_: Throwable) { null }

    /** Codes in the label band; OCR the label band ONCE and reuse that text for company, grade and the
     *  card lines. A slab needs a code (cert or cert URL) or a company on the label; grade alone never
     *  counts, since a raw card's top edge can carry a stray "10". */
    private fun analyze(bitmap: Bitmap): SlabInfo? {
        val code = readCode(bitmap)
        val label = cropTop(bitmap, LABEL_BAND) ?: bitmap
        val text = try { ocr(label) } finally { if (label !== bitmap) label.recycle() }
        val lines = ArrayList<String>()
        if (text != null) for (b in text.textBlocks) for (l in b.lines) lines.add(l.text)
        val raw = text?.text ?: ""
        val company = code.company ?: detectCompany(raw)
        if (code.cert == null && company == null) return null           // no slab signal => raw card
        return SlabInfo(company ?: "Other", detectGrade(raw), code.cert, lines)
    }

    /** Longest all-digit payload is the cert. A URL payload (cert-page QR) names the company by its host
     *  and usually carries the cert as the longest digit run in its path. Only codes that start inside
     *  the label band count, and never retail symbologies or short digit strings, so a booster box,
     *  price sticker or packaging QR beside a raw card does not read as a slab. */
    private fun readCode(bitmap: Bitmap): CodeInfo = try {
        val barcodes: List<Barcode> = Tasks.await(barcodeScanner.process(InputImage.fromBitmap(bitmap, 0)))
        val bandBottom = bitmap.height * LABEL_BAND
        var cert: String? = null
        var company: String? = null
        for (b in barcodes) {
            val raw = b.rawValue?.trim() ?: continue
            if (raw.isEmpty()) continue
            if (b.format in RETAIL_FORMATS) continue
            val box = b.boundingBox
            if (box != null && box.top > bandBottom) continue
            if (raw.all(Char::isDigit)) {
                if (raw.length >= MIN_CERT_DIGITS && (cert == null || raw.length > cert!!.length)) cert = raw
                continue
            }
            val lower = raw.lowercase()
            if (lower.contains("://") || lower.contains("www.") || lower.contains(".com")) {
                if (company == null) for ((host, name) in CODE_HOSTS) if (lower.contains(host)) { company = name; break }
                val run = Regex("\\d{5,}").findAll(raw).map { it.value }.maxByOrNull { it.length }
                if (run != null && (cert == null || run.length > cert!!.length)) cert = run
            }
        }
        CodeInfo(cert, company)
    } catch (_: Throwable) { CodeInfo(null, null) }

    /** OCR one crop; null on any failure. */
    private fun ocr(crop: Bitmap): Text? = try {
        Tasks.await(textRecognizer.process(InputImage.fromBitmap(crop, 0)))
    } catch (_: Throwable) { null }

    /** First grading company token found, case-insensitive, with no letter either side (digits may abut
     *  it, since OCR often merges "PSA 10" into "PSA10"); BECKETT normalises to BGS. Same rule as iOS. */
    private fun detectCompany(text: String): String? {
        if (text.isEmpty()) return null
        for (tok in COMPANY_TOKENS) {
            if (Regex("(?<![A-Z])${Regex.escape(tok)}(?![A-Z])", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
                return if (tok == "BECKETT") "BGS" else tok
            }
        }
        return null
    }

    /** Grade number via the waterfall, normalised ("10","9.5","9"); "" when nothing readable. */
    private fun detectGrade(text: String): String {
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

    /** Top [fraction] of the frame where the label sits; null on any failure (caller falls back to full
     *  frame). Always a new bitmap (never [src]) so the caller can recycle it. */
    private fun cropTop(src: Bitmap, fraction: Float): Bitmap? = try {
        val h = (src.height * fraction).toInt().coerceIn(1, src.height)
        if (h >= src.height) null else Bitmap.createBitmap(src, 0, 0, src.width, h)
    } catch (_: Throwable) { null }
}
