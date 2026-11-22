package app.omw.omwnative

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Runs exports one at a time and keeps the process in a foreground service while a video export
 * runs, so it survives the screen turning off or her switching apps (app-plan §4 "Export in the
 * background"). The service is started at Share, while the app is visible (the only moment
 * Android allows it); if Android refuses, the export still runs, just without that protection.
 */
object MediaExportRunner {
  private const val TAG = "OmwExport"
  private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "omw-media-export") }
  private val running = ConcurrentHashMap<String, VideoExporter>()
  private val cancelled = ConcurrentHashMap.newKeySet<String>()
  private val pending = AtomicInteger()

  @Volatile
  private var service: MediaExportService? = null

  @Volatile
  private var lastPercent = -1

  val idle: Boolean get() = pending.get() == 0

  /** Starts a video export; [onDone] gets the result or the failure on the export thread. */
  fun exportVideo(context: Context, req: VideoExportRequest, onProgress: (Float) -> Unit, onDone: (Result<MediaExportResult>) -> Unit) {
    val app = context.applicationContext
    pending.incrementAndGet()
    startService(app)
    executor.execute {
      val result = runCatching {
        if (cancelled.remove(req.jobId)) throw MediaExportException("ERR_CANCELLED", "cancelled")
        val exporter = VideoExporter(app)
        running[req.jobId] = exporter
        var lastAt = 0L
        try {
          exporter.export(req) { p ->
            val now = SystemClock.elapsedRealtime()
            if (now - lastAt >= 250 || p >= 1f) {
              lastAt = now
              onProgress(p)
              notifyProgress(app, (p * 100).toInt())
            }
          }
        } finally {
          running.remove(req.jobId)
        }
      }
      finish()
      onDone(result)
    }
  }

  /** Photos are fast: no foreground service, same queue (so a photo never races a video's memory). */
  fun exportPhoto(context: Context, req: PhotoExportRequest, onDone: (Result<MediaExportResult>) -> Unit) {
    val app = context.applicationContext
    pending.incrementAndGet()
    executor.execute {
      val result = runCatching {
        if (cancelled.remove(req.jobId)) throw MediaExportException("ERR_CANCELLED", "cancelled")
        PhotoExporter.export(app, req) { req.jobId in cancelled }
      }
      cancelled.remove(req.jobId)
      finish()
      onDone(result)
    }
  }

  /** Cancels a queued or running export; false when the job is unknown or already finished. */
  fun cancel(jobId: String): Boolean {
    running[jobId]?.let {
      it.cancel()
      return true
    }
    if (pending.get() == 0) return false
    cancelled += jobId
    return true
  }

  fun cancelAll() {
    running.values.forEach { it.cancel() }
  }

  internal fun attach(s: MediaExportService) {
    service = s
    if (idle) s.stopNow()
  }

  internal fun detach(s: MediaExportService) {
    if (service === s) service = null
  }

  private fun finish() {
    if (pending.decrementAndGet() == 0) {
      lastPercent = -1
      service?.stopNow()
    }
  }

  private fun startService(context: Context) {
    try {
      context.startForegroundService(Intent(context, MediaExportService::class.java))
    } catch (e: RuntimeException) {
      // ForegroundServiceStartNotAllowedException (not visible) or a missing declaration.
      Log.w(TAG, "export runs without a foreground service: ${e.javaClass.simpleName}")
    }
  }

  private fun notifyProgress(context: Context, percent: Int) {
    if (percent == lastPercent || service == null) return
    lastPercent = percent
    context.getSystemService(NotificationManager::class.java)
      ?.notify(OmwNotifications.ID_EXPORT, OmwNotifications.export(context, percent))
  }
}

/** The export foreground service: mediaProcessing on API 35+, dataSync on 29–34. */
class MediaExportService : Service() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val type = if (Build.VERSION.SDK_INT >= 35) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING
    } else {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
    }
    try {
      startForeground(OmwNotifications.ID_EXPORT, OmwNotifications.export(this, null), type)
    } catch (e: RuntimeException) {
      Log.w("OmwExport", "startForeground refused: ${e.javaClass.simpleName}")
      stopSelf()
      return START_NOT_STICKY
    }
    MediaExportRunner.attach(this)
    return START_NOT_STICKY
  }

  /** API 35+: the type's time limit is reached; stop now (the export is cancelled, JS may retry). */
  override fun onTimeout(startId: Int, fgsType: Int) {
    MediaExportRunner.cancelAll()
    stopNow()
  }

  fun stopNow() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    MediaExportRunner.detach(this)
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
