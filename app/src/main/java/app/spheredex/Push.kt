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
                if (t.isSuccessful) t.result?.let { registerToken(it) }
                else Log.w(TAG, "token fetch failed", t.exception)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "FCM unavailable", e)
        }
    }

    /** POST { token, platform } to the backend on a background thread. Best-effort; failures are logged. */
    fun registerToken(token: String) {
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
                val body = JSONObject().put("token", token).put("platform", "android").toString()
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                conn.inputStream.use { it.readBytes() }   // drain so the connection can be reused
            } catch (e: Exception) {
                Log.w(TAG, "register failed", e)
            } finally {
                conn?.disconnect()
            }
        }.start()
    }
}
