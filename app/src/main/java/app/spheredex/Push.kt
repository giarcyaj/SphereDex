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

    /** POST { token, platform, prefs } to the backend on a background thread. Best-effort; logged on failure. */
    fun registerToken(ctx: Context, token: String) {
        val prefs = currentPrefs(ctx)
        Thread {
            var conn: HttpURLConnection? = null
            try {
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
                conn.inputStream.use { it.readBytes() }   // drain so the connection can be reused
            } catch (e: Exception) {
                Log.w(TAG, "register failed", e)
            } finally {
                conn?.disconnect()
            }
        }.start()
    }
}
