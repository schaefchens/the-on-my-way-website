package app.omw.omwnative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build

/**
 * The two silent notifications Android requires (ux.md §3.15): the UIDT upload progress
 * ("Uploads" channel; ProgressStyle with one segment per moment on Android 16) and the export
 * foreground service ("Preparing"). Low importance: no sound, no vibration, no heads-up. A tap
 * opens the app. Nothing is shown when everything is done (no "Live ✓" notification).
 * Without POST_NOTIFICATIONS (asked by the app at the first upload) they stay invisible and the
 * work runs anyway.
 */
object OmwNotifications {
  const val CHANNEL_UPLOADS = "omw.uploads"
  const val CHANNEL_EXPORT = "omw.export"
  const val ID_UPLOAD = 0x0A11
  const val ID_EXPORT = 0x0A12

  fun ensureChannels(context: Context) {
    val nm = context.getSystemService(NotificationManager::class.java) ?: return
    fun channel(id: String, name: Int, description: Int) = NotificationChannel(id, context.getString(name), NotificationManager.IMPORTANCE_LOW).apply {
      this.description = context.getString(description)
      setSound(null, null)
      enableVibration(false)
      setShowBadge(false)
    }
    nm.createNotificationChannels(
      listOf(
        channel(CHANNEL_UPLOADS, R.string.omw_channel_uploads, R.string.omw_channel_uploads_description),
        channel(CHANNEL_EXPORT, R.string.omw_channel_export, R.string.omw_channel_export_description),
      ),
    )
  }

  /**
   * Upload progress: [segments] are the sizes of the unfinished moments (bytes), [sent] the bytes
   * already sent of them. No segments = waiting for a connection.
   */
  fun upload(context: Context, segments: List<Long>, sent: Long): Notification {
    ensureChannels(context)
    val total = segments.sum().coerceAtLeast(1)
    val percent = ((sent * 100) / total).toInt().coerceIn(0, 100)
    val text = if (segments.isEmpty()) {
      context.getString(R.string.omw_upload_waiting)
    } else {
      context.resources.getQuantityString(R.plurals.omw_uploading, segments.size, segments.size, percent)
    }
    val b = base(context, CHANNEL_UPLOADS, R.drawable.omw_ic_upload).setContentText(text)
    if (segments.isNotEmpty()) {
      if (Build.VERSION.SDK_INT >= 36) {
        // One segment per moment, in 64 KiB units (Segment lengths are ints).
        val unit = 64 * 1024L
        val lengths = segments.map { (it / unit).coerceIn(1, Int.MAX_VALUE.toLong() / 64).toInt() }
        val progress = ((sent.toDouble() / total) * lengths.sum()).toInt()
        b.setStyle(
          Notification.ProgressStyle()
            .setStyledByProgress(false)
            .setProgressSegments(lengths.map { Notification.ProgressStyle.Segment(it) })
            .setProgress(progress.coerceIn(0, lengths.sum())),
        )
      } else {
        b.setProgress(100, percent, false)
      }
    }
    return b.build()
  }

  /** Export progress (null = unknown yet). */
  fun export(context: Context, percent: Int?, photo: Boolean = false): Notification {
    ensureChannels(context)
    val text = if (photo) context.getString(R.string.omw_exporting_photo) else context.getString(R.string.omw_exporting, percent ?: 0)
    return base(context, CHANNEL_EXPORT, R.drawable.omw_ic_export)
      .setContentText(text)
      .setProgress(100, percent ?: 0, percent == null)
      .build()
  }

  private fun base(context: Context, channel: String, icon: Int): Notification.Builder =
    Notification.Builder(context, channel)
      .setSmallIcon(icon)
      .setContentTitle(context.getString(R.string.omw_app_name))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
      .apply { contentIntent(context)?.let(::setContentIntent) }

  private fun contentIntent(context: Context): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }
}
