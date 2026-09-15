package app.spheredex

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

// ---------------------------------------------------------------------------
// Tunables (top-level so they are trivial to adjust).
// ---------------------------------------------------------------------------

/**
 * dHash sampling grid. The image is scaled to (HASH_WIDTH+1) x HASH_HEIGHT grayscale and each
 * pixel is compared with its right neighbour, yielding HASH_WIDTH*HASH_HEIGHT bits. 8x8 => 64 bits,
 * which packs into a single Long. dHash is robust to brightness/contrast/JPEG noise, so a phone
 * photo of a card still lands close to the clean bundled render.
 */
const val HASH_WIDTH = 8
const val HASH_HEIGHT = 8
const val HASH_BITS = HASH_WIDTH * HASH_HEIGHT               // 64

/** Best Hamming distance (0..HASH_BITS) above which [CardImageMatcher.match] returns null. Lower = stricter.
 *  A phone photo (lighting, perspective, glare) lands further from the clean render than a screenshot would,
 *  so this is looser than a pixel-exact match. On-device tuning knob. */
const val REJECT_DISTANCE = 16

/** Hamming distance mapped to 0f confidence; distance 0 maps to 1f, linear in between (then clamped). */
const val CONFIDENCE_ZERO_DISTANCE = 32f

/** Smallest image edge (px) kept when down-sampling a reference decode: plenty to feed the tiny grid. */
private const val DECODE_MIN_EDGE = 32

/** Bumped whenever the hash algorithm or cache layout changes, to invalidate stale cache files. */
private const val FORMAT_VERSION = 2

/** Asset folder of bundled card art (assets/img/EBP01-001.jpg), mirrored from docs/app/img by tools/rebuild.py. */
private const val IMG_DIR = "img"
private const val CACHE_FILE = "card_phash.cache"

/** Image file extensions BitmapFactory decodes; anything else in [IMG_DIR] is ignored. */
private val IMG_EXTENSIONS = setOf("jpg", "jpeg", "png", "webp")

/** Keeps only file base names shaped like a real card number (e.g. EBP01-001, EBP01-001OSR, EPR-001, ESOUL-000),
 *  so the box, banner and logo art in the same folder is skipped. */
private val KEY_SHAPE = Regex("^[A-Z0-9]{1,10}-[0-9]{3}[A-Z0-9]{0,8}$")

/**
 * On-device full-card recognition by perceptual hash (dHash) of the bundled card art. No ML Kit,
 * no third-party deps: builds a `cardNumber -> 64-bit hash` table from the card image files in
 * assets/img once, caches it in filesDir, then matches a query crop by Hamming distance.
 */
object CardImageMatcher {

    /** True once the hash table is loaded/built and [match] can return results. Read-only to callers. */
    @Volatile
    var isReady: Boolean = false
        private set

    /** Number of reference cards indexed (0 until ready). For the on-camera diagnostic readout. */
    @Volatile
    var count: Int = 0
        private set

    /** Nearest reference key + Hamming distance from the LAST [match] call, even when it was rejected.
     *  Purely diagnostic (surfaced on the scanner during tuning); not synchronized. */
    @Volatile
    var lastBestKey: String? = null
        private set
    @Volatile
    var lastBestDistance: Int = -1
        private set

    // Built once on a background thread, then only read; published via the @Volatile reference.
    @Volatile
    private var hashes: Map<String, Long>? = null

    private val started = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor()

    /** Idempotent. Kicks off a one-time background load (or build) of the hash table. */
    fun prepare(context: Context) {
        if (isReady || !started.compareAndSet(false, true)) return
        val app = context.applicationContext
        executor.execute {
            try {
                val file = File(app.filesDir, CACHE_FILE)
                val names = cardImageNames(app)                         // card art files in assets/img
                val signature = artSignature(app, names.size)           // part of the cache key
                var map = if (signature != null) loadCache(file, signature) else null
                if (map == null) {
                    map = build(app, names)
                    if (map != null && signature != null) persist(file, signature, map)
                }
                if (map != null) {
                    hashes = map
                    count = map.size
                    isReady = true
                } else {
                    started.set(false)                                  // asset unreadable: allow a later retry
                }
            } catch (_: Throwable) {
                started.set(false)
            }
        }
    }

    /**
     * Matches an upright crop of the card region. CPU-only and quick (one hash + a table scan);
     * the caller is expected to invoke it off the UI thread. Returns (cardNumber, confidence 0f..1f)
     * for the nearest reference within [maxDistance], or null. [lastBestKey]/[lastBestDistance] are
     * always updated with the nearest reference (even when rejected) for the diagnostic readout.
     * Pass [maxDistance] = Int.MAX_VALUE to force-accept the nearest match (used by tap-to-scan).
     */
    fun match(bitmap: Bitmap, maxDistance: Int = REJECT_DISTANCE): Pair<String, Float>? {
        val map = hashes ?: return null
        val q = perceptualHash(bitmap) ?: return null
        var bestKey: String? = null
        var bestDist = Int.MAX_VALUE
        for ((key, h) in map) {
            val d = (q xor h).countOneBits()
            if (d < bestDist) { bestDist = d; bestKey = key }
        }
        val key = bestKey ?: return null
        lastBestKey = key
        lastBestDistance = bestDist
        if (bestDist > maxDistance) return null
        val confidence = (1f - bestDist / CONFIDENCE_ZERO_DISTANCE).coerceIn(0f, 1f)
        return key to confidence
    }

    // ---- build / cache ----

    /** Decodes and hashes each card image asset, one small sampled bitmap at a time. Null if none could be read. */
    private fun build(context: Context, names: List<String>): Map<String, Long>? {
        val out = HashMap<String, Long>(names.size * 2)
        for (name in names) {
            val bmp = decodeSampled(context, "$IMG_DIR/$name") ?: continue
            val hash = perceptualHash(bmp)
            bmp.recycle()
            if (hash != null) out[name.substringBeforeLast('.')] = hash
        }
        return if (out.isEmpty()) null else out
    }

    /** Sorted file names in assets/img whose base name is card-number shaped. Empty if the folder is missing. */
    private fun cardImageNames(context: Context): List<String> {
        val all = try { context.assets.list(IMG_DIR) } catch (_: Throwable) { null }
        if (all == null) return emptyList()
        return all.filter { name ->
            val dot = name.lastIndexOf('.')
            dot > 0 && name.substring(dot + 1).lowercase() in IMG_EXTENSIONS &&
                KEY_SHAPE.matches(name.substring(0, dot))
        }.sorted()
    }

    /**
     * Cheap cache key that changes whenever the bundled art can have changed, without opening any image:
     * a release bumps versionCode, any install or update (even a same-version dev build) moves
     * lastUpdateTime, and the image count catches a changed folder. Null if the package info is unavailable.
     */
    private fun artSignature(context: Context, imageCount: Int): String? {
        return try {
            @Suppress("DEPRECATION")
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            "v" + PackageInfoCompat.getLongVersionCode(info) + "-u" + info.lastUpdateTime + "-n" + imageCount
        } catch (_: Throwable) {
            null
        }
    }

    /** Loads the cached table if the header (format, art signature, bit count) still matches; else null. */
    private fun loadCache(file: File, signature: String): Map<String, Long>? {
        if (!file.exists()) return null
        return try {
            val lines = file.readLines()
            if (lines.isEmpty()) return null
            val h = lines[0].split('\t')
            if (h.size < 4 || h[0] != "SDPHASH") return null
            if (h[1].toInt() != FORMAT_VERSION) return null
            if (h[2] != signature) return null
            if (h[3].toInt() != HASH_BITS) return null
            val map = HashMap<String, Long>(lines.size)
            for (i in 1 until lines.size) {
                val p = lines[i].split('\t')
                if (p.size == 2) p[1].toLongOrNull()?.let { map[p[0]] = it }
            }
            if (map.isEmpty()) null else map
        } catch (_: Throwable) {
            null
        }
    }

    /** Writes the table with a self-describing header. Best-effort: failure just means a rebuild next launch. */
    private fun persist(file: File, signature: String, map: Map<String, Long>) {
        try {
            val sb = StringBuilder(map.size * 24 + 64)
            sb.append("SDPHASH\t").append(FORMAT_VERSION).append('\t')
                .append(signature).append('\t').append(HASH_BITS).append('\t').append(map.size).append('\n')
            for ((k, v) in map) sb.append(k).append('\t').append(v).append('\n')
            file.writeText(sb.toString())
        } catch (_: Throwable) {
            // ignore
        }
    }

    // ---- hashing ----

    /** 64-bit difference hash (dHash) of a bitmap, or null on any failure. */
    private fun perceptualHash(src: Bitmap): Long? {
        return try {
            val w = HASH_WIDTH + 1
            val h = HASH_HEIGHT
            val small = Bitmap.createScaledBitmap(src, w, h, true)      // bilinear downscale to grayscale grid
            val px = IntArray(w * h)
            small.getPixels(px, 0, w, 0, 0, w, h)
            if (small !== src) small.recycle()                          // never recycle the caller's bitmap
            var hash = 0L
            var bit = 0
            for (y in 0 until h) {
                val row = y * w
                var prev = luma(px[row])
                for (x in 1 until w) {
                    val cur = luma(px[row + x])
                    if (prev > cur) hash = hash or (1L shl bit)
                    prev = cur
                    bit++
                }
            }
            hash
        } catch (_: Throwable) {
            null
        }
    }

    /** Fast integer luminance from an ARGB pixel. */
    private fun luma(c: Int): Int {
        val r = (c ushr 16) and 0xFF
        val g = (c ushr 8) and 0xFF
        val b = c and 0xFF
        return (r * 77 + g * 151 + b * 28) ushr 8
    }

    /** Decodes a card image asset down-sampled to a small edge (cheaper, lower memory) for hashing: a
     *  bounds-only pass reads the header, then a fresh stream decodes at the chosen sample size. */
    private fun decodeSampled(context: Context, path: String): Bitmap? {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            context.assets.open(path).use { BitmapFactory.decodeStream(it, null, bounds) }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            val opts = BitmapFactory.Options().apply {
                inSampleSize = sampleFor(bounds.outWidth, bounds.outHeight)
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
            context.assets.open(path).use { BitmapFactory.decodeStream(it, null, opts) }
        } catch (_: Throwable) {
            null
        }
    }

    /** Largest power-of-two sample that keeps the shorter edge >= [DECODE_MIN_EDGE]. */
    private fun sampleFor(w: Int, h: Int): Int {
        if (w <= 0 || h <= 0) return 1
        val minDim = minOf(w, h)
        var s = 1
        while (minDim / (s * 2) >= DECODE_MIN_EDGE) s *= 2
        return s
    }
}