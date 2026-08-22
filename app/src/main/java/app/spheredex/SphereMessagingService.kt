package app.spheredex

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives Firebase Cloud Messaging pushes.
 *
 * - onNewToken: the device's token rotated; re-register it with the backend.
 * - onMessageReceived: fires for every message while the app is FOREGROUNDED (and for data-only
 *   messages in the background too), so we build and post the notification ourselves. When the app
 *   is backgrounded and the message carries a notification payload, the system draws it instead,
 *   using the default_notification_* meta-data in the manifest.
 *
 * Dormant until google-services.json is present - FCM never delivers to an unconfigured app.
 */
class SphereMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Push.registerToken(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val title = message.notification?.title ?: message.data["title"] ?: "SphereDex"
        val body = message.notification?.body ?: message.data["body"] ?: ""
        val url = message.data["url"]
        Push.ensureChannel(this)

        // Tap -> MainActivity, carrying an optional deep-link route in the "url" extra.
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (!url.isNullOrEmpty()) putExtra("url", url)
        }
        val pi = PendingIntent.getActivity(
            this,
            (url ?: title).hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val n = NotificationCompat.Builder(this, Push.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_spheredex)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pi)
            .build()

        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(System.currentTimeMillis().toInt(), n)
    }
}
