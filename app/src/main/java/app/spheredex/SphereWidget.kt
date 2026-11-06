package app.spheredex

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import java.util.TimeZone

/** Home-screen widget: next release, closest set goal, and collection value. Reads WidgetStore only. */
class SphereWidget : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) mgr.updateAppWidget(id, build(ctx))
    }

    companion object {
        /** Redraw every placed widget, e.g. after the app saved a fresh snapshot. */
        fun refresh(ctx: Context) {
            val mgr = AppWidgetManager.getInstance(ctx)
            val ids = mgr.getAppWidgetIds(ComponentName(ctx, SphereWidget::class.java))
            if (ids.isNotEmpty()) for (id in ids) mgr.updateAppWidget(id, build(ctx))
        }

        private fun open(ctx: Context, code: Int, go: String?): PendingIntent {
            val i = Intent(ctx, MainActivity::class.java)
                .putExtra("url", WidgetStore.safePage(go))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        private fun build(ctx: Context): RemoteViews {
            val v = RemoteViews(ctx.packageName, R.layout.widget_sphere)
            val snap = WidgetStore.load(ctx)
            v.setOnClickPendingIntent(R.id.widgetRoot, open(ctx, 0, "home"))

            val rel = snap?.optJSONObject("release")
            if (rel != null) {
                val now = System.currentTimeMillis()
                val days = WidgetStore.daysUntil(rel.optLong("target"), now, TimeZone.getDefault().getOffset(now).toLong())
                v.setViewVisibility(R.id.rowRelease, View.VISIBLE)
                v.setTextViewText(R.id.relTitle, rel.optString("title"))
                v.setTextViewText(R.id.relWhen, WidgetStore.countdownText(days) + " · " + rel.optString("date"))
                v.setOnClickPendingIntent(R.id.rowRelease, open(ctx, 1, rel.optString("go")))
            } else v.setViewVisibility(R.id.rowRelease, View.GONE)

            val set = snap?.optJSONObject("set")
            if (set != null) {
                v.setViewVisibility(R.id.rowSet, View.VISIBLE)
                v.setTextViewText(R.id.setName, set.optString("name"))
                v.setTextViewText(R.id.setCount, "${set.optInt("owned")} of ${set.optInt("total")} cards · ${set.optInt("pct")}%")
                v.setProgressBar(R.id.setBar, 100, set.optInt("pct").coerceIn(0, 100), false)
                v.setOnClickPendingIntent(R.id.rowSet, open(ctx, 2, set.optString("go")))
            } else v.setViewVisibility(R.id.rowSet, View.GONE)

            // With price hiding on the app sends no value at all, so the row stays gone.
            val value = snap?.optJSONObject("value")
            if (value != null && !snap.optBoolean("hidePrices")) {
                v.setViewVisibility(R.id.rowValue, View.VISIBLE)
                v.setTextViewText(R.id.valText, value.optString("text"))
                val move = value.optString("move")
                v.setTextViewText(R.id.valMove, if (move.isEmpty()) "" else "$move today")
                v.setOnClickPendingIntent(R.id.rowValue, open(ctx, 3, value.optString("go")))
            } else v.setViewVisibility(R.id.rowValue, View.GONE)

            v.setViewVisibility(R.id.widgetEmpty, if (snap == null) View.VISIBLE else View.GONE)
            return v
        }
    }
}
