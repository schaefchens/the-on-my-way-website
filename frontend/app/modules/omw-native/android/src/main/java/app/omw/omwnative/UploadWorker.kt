package app.omw.omwnative

import android.content.Context
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * The uploader on API 29–33, for follow-ups scheduled while the app is not visible on 34+, and
 * the backup behind every UIDT job (see UploadScheduler.backupDelayMs). A plain worker with the
 * network constraint of the A4 rules: it uploads for about 9 minutes (inside WorkManager's
 * 10-minute execution limit) and then enqueues the next run. It never promotes itself to a
 * foreground service: Android 12+ throws ForegroundServiceStartNotAllowedException for that from
 * the background.
 */
class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  private val signal = RealStopSignal()

  override fun doWork(): Result {
    runs++
    val engine = UploadRuntime.engine(applicationContext)
    val outcome = try {
      engine.run(signal, deadlineMs = System.currentTimeMillis() + RUN_MS)
    } catch (e: Exception) {
      Log.e(TAG, "upload run failed", e)
      return Result.retry()
    }
    Log.i(TAG, "worker run ended: $outcome")
    if (outcome == RunOutcome.Stopped) return Result.retry() // WorkManager reschedules it when the constraints hold again
    try {
      when (outcome) {
        RunOutcome.Busy -> UploadScheduler.rearmBackup(applicationContext) // a UIDT run is active: stay its backup
        is RunOutcome.RetryAt ->
          UploadScheduler.schedule(applicationContext, delayMs = (outcome.atMs - System.currentTimeMillis()).coerceAtLeast(1_000), fromWorker = true)
        else -> UploadScheduler.schedule(applicationContext, fromWorker = true)
      }
    } catch (e: Exception) {
      Log.e(TAG, "follow-up not scheduled (the next app open reschedules)", e)
    }
    return Result.success()
  }

  override fun onStopped() {
    signal.stop()
  }

  init {
    signal.onStop { UploadEngine.abortAll() }
  }

  companion object {
    private const val TAG = "OmwUploader"
    private const val RUN_MS = 9 * 60_000L

    /** Worker runs in this process (tests tell the WorkManager path from the UIDT path with it). */
    @Volatile
    var runs = 0
      private set
  }
}
