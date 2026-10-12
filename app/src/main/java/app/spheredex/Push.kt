package app.spheredex

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Push-notification plumbing shared by MainActivity and SphereMessagingService.
 *
 * Everything here is a safe no-op until app/google-services.json is added and Firebase initialises,
 * so the app ships and runs identically before push is configured. The channel is created and the
 * runtime permission requested regardless (harmless), but no token is fetched or sent while Firebase
 * has no default app.
 */
object Push {
    // Must match the backend's android.notification.channel_id in src/push.ts.
    const val CHANNEL_ID = "spheredex"
    private const val BACKEND = "https://spheredex-backend.craigjayedit.workers.dev"
    private const val TAG = "SpherePush"
    private const val PREFS_STORE = "spheredex_push"
    private const val PREFS_KEY = "prefs"
    // Which categories the device wants. Default: everything on until the user changes it in Settings.
    private const val DEFAULT_PREFS = "{\"releases\":true,\"news\":true,\"newSets\":true}"

    /** The device's current notification prefs as a JSON string (set by the web Settings UI). */
    fun currentPrefs(ctx: Context): String =
        ctx.getSharedPreferences(PREFS_STORE, Context.MODE_PRIVATE).getString(PREFS_KEY, DEFAULT_PREFS) ?: DEFAULT_PREFS

    /** Store new prefs (JSON from the web bridge) and re-register the token so the backend sees them. */
    fun applyPrefs(ctx: Context, prefsJson: String) {
        try { JSONObject(prefsJson) } catch (_: Exception) { return }   // ignore malformed input
        ctx.getSharedPreferences(PREFS_STORE, Context.MODE_PRIVATE).edit().putString(PREFS_KEY, prefsJson).apply()
        fetchAndRegister(ctx)
    }

    /** Create the notification channel (idempotent). Required on Android O+. */
    fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID, "New sets & alerts", NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = "New Palworld set releases, news, and price movement alerts." }
            ctx.getSystemService(NotificationManager::class.java)?.createNotificationChannel(ch)
        }
    }

    /** True only once Firebase has a default app (i.e. google-services.json shipped in this build). */
    private fun firebaseReady(ctx: Context): Boolean =
        try { FirebaseApp.getApps(ctx).isNotEmpty() } catch (_: Throwable) { false }

    /** Last time the resume path re-registered, so returning to the app does not re-post constantly. */
    private var lastResumeRegister = 0L

    /**
     * Re-send this device's prefs when the app comes back to the foreground, at most every 15 minutes.
     * A change made while the phone had no signal is otherwise stuck on the server until the next COLD
     * start, which on a phone that keeps the process alive can be days: the server would keep alerting
     * on the market the user had left, or on a product they had unfollowed. The web layer re-sends on
     * its own wake too, but that depends on the WebView reporting visibility, which older WebViews do
     * not do reliably, so this path does not rely on it.
     */
    fun refreshOnResume(ctx: Context) {
        val now = System.currentTimeMillis()
        if (now - lastResumeRegister < 15 * 60 * 1000L) return
        lastResumeRegister = now
        fetchAndRegister(ctx)
    }

    /** Fetch this device's FCM token and register it with the backend. Safe to call every launch. */
    fun fetchAndRegister(ctx: Context) {
        if (!firebaseReady(ctx)) return
        try {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
                if (t.isSuccessful) t.result?.let { registerToken(ctx, it) }
                else Log.w(TAG, "token fetch failed", t.exception)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "FCM unavailable", e)
        }
    }

    /**
     * POST { token, platform, prefs } to the backend on a background thread.
     *
     * This is the ONLY way the server learns which market this device is in and which products it
     * follows, and it used to be sent once and forgotten: the response was never read, so a 500 looked
     * exactly like success, and a dropped request left the server alerting on the market the user had
     * just left. Now the status is checked and a failure is retried a couple of times with a widening
     * gap. The endpoint overwrites rather than appends, so a repeat is free and a duplicate is harmless.
     * If all three attempts fail the next foreground re-sends it (the web layer calls setPrefs on wake).
     */
    fun registerToken(ctx: Context, token: String) {
        // The application context, not the activity, so a retry thread never keeps an activity alive.
        val app = ctx.applicationContext
        Thread {
            var sent = false
            for (attempt in 0 until 3) {
                if (attempt > 0) {
                    try { Thread.sleep(2000L * attempt) } catch (_: InterruptedException) { break }
                }
                // Read the prefs on every attempt. Captured once, an older chain's retry could land after a
                // newer change and put the old follow list or market back on the server.
                if (postRegistration(token, currentPrefs(app))) { sent = true; break }
            }
            if (!sent) Log.w(TAG, "register gave up after 3 attempts")
        }.start()
    }

    /** One attempt. True only when the backend actually accepted it. */
    private fun postRegistration(token: String, prefs: String): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("$BACKEND/api/push/register").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 10000
                readTimeout = 10000
                setRequestProperty("Content-Type", "application/json")
            }
            val body = JSONObject().put("token", token).put("platform", "android")
            try { body.put("prefs", JSONObject(prefs)) } catch (_: Exception) { /* send without prefs */ }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            // Drain whichever stream the status gives us, so the connection can be reused either way.
            try { (if (code in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes() } } catch (_: Exception) {}
            if (code !in 200..299) Log.w(TAG, "register rejected: HTTP $code")
            code in 200..299
        } catch (e: Exception) {
            Log.w(TAG, "register attempt failed", e)
            false
        } finally {
            conn?.disconnect()
        }
    }
}
