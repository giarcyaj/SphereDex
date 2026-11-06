package app.spheredex

import android.content.Context
import org.json.JSONObject

/**
 * Keeps the last snapshot the web app handed us for the home-screen widget. The widget cannot run the
 * web page, so everything it shows (already formatted by the app) lives here as one JSON string.
 * Prices are never written when the app is in price hiding mode: the web side leaves "value" out.
 */
object WidgetStore {
    private const val STORE = "spheredex_widget"
    private const val KEY = "snapshot"
    private const val DAY_MS = 86_400_000L

    /** The only pages a widget row may open. Anything else falls back to Home. */
    private val PAGES = setOf("releases", "collection", "portfolio")

    fun save(ctx: Context, json: String) {
        // Refuse anything that is not an object, or that is oversized, rather than store junk.
        if (json.length > 8_000) return
        try { JSONObject(json) } catch (_: Exception) { return }
        ctx.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().putString(KEY, json).apply()
    }

    fun load(ctx: Context): JSONObject? = try {
        ctx.getSharedPreferences(STORE, Context.MODE_PRIVATE).getString(KEY, null)?.let { JSONObject(it) }
    } catch (_: Exception) { null }

    /** Whole local days from today to the release, so the countdown keeps moving between app opens. */
    fun daysUntil(targetMs: Long, nowMs: Long, offsetMs: Long): Int {
        val today = Math.floorDiv(nowMs + offsetMs, DAY_MS)
        val target = Math.floorDiv(targetMs + offsetMs, DAY_MS)
        return (target - today).toInt()
    }

    fun countdownText(days: Int): String = when {
        days < 0 -> "Out now"
        days == 0 -> "Today"
        days == 1 -> "Tomorrow"
        else -> "In $days days"
    }

    fun safePage(go: String?): String = if (go != null && go in PAGES) go else "home"
}
