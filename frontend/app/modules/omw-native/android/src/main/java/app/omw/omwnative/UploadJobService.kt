package app.omw.omwnative

import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Build
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * The UIDT job (API 34+, see UploadScheduler). Runs the engine on its own thread with the
 * required silent progress notification and transferred-bytes updates. When the system stops it
 * (network lost, constraints, quota), the request in flight is cancelled and the job asks to be
 * rescheduled; the next run resumes from the stored offsets.
 */
class UploadJobService : JobService() {
  @Volatile
  private var stop: RealStopSignal? = null

  /** She stopped the job in the Task Manager: no follow-up until she opens the app. */
  @Volatile
  private var stoppedByUser = false

  override fun onStartJob(params: JobParameters): Boolean {
    val signal = RealStopSignal()
    stop = signal
    val notifier = Notifier(params)
    notifier.update(force = true)
    thread(name = "omw-upload-uidt") {
      val engine = UploadRuntime.engine(this, listener = notifier, inlineWaitMaxMs = UIDT_INLINE_WAIT_MS)
      signal.onStop { UploadEngine.abortAll() }
      val outcome = try {
        engine.run(signal)
      } catch (e: Exception) {
        Log.e(TAG, "upload run failed", e)
        RunOutcome.RetryAt(System.currentTimeMillis() + 60_000)
      }
      Log.i(TAG, "UIDT run ended: $outcome")
      if (outcome == RunOutcome.Stopped || signal.stopped) {
        // onStopJob asked JobScheduler for the reschedule. It may not start the rescheduled UIDT
        // while the app is in the background, so WorkManager stands by as well; not when she
        // stopped it herself in the Task Manager (that waits until she opens the app).
        if (!stoppedByUser) followUpQuietly()
        return@thread
      }
      val need = if (outcome == RunOutcome.WaitNetwork) keepWaiting(params) else null
      if (need != null) {
        // The rest needs the network this job already waits for (e.g. Wi-Fi went away mid-upload):
        // keep this UIDT job (a new one can't be scheduled from the background), and put a
        // WorkManager follow-up with the same constraint beside it, because JobScheduler may not
        // start a rescheduled UIDT again while the app is in the background. Whichever starts
        // first uploads; the other finds the run busy.
        jobFinished(params, true)
        followUpQuietly(need)
        return@thread
      }
      jobFinished(params, false)
      try {
        when (outcome) {
          is RunOutcome.RetryAt -> UploadScheduler.schedule(this, delayMs = (outcome.atMs - System.currentTimeMillis()).coerceAtLeast(1_000))
          RunOutcome.Busy -> Unit
          else -> UploadScheduler.schedule(this) // e.g. the original now waits for Wi-Fi
        }
      } catch (e: Exception) {
        Log.e(TAG, "follow-up not scheduled (the next app open reschedules)", e)
      }
    }
    return true
  }

  /** A WorkManager run for [need] (default: what the queue needs now); never throws. */
  private fun followUpQuietly(need: NetNeed? = null) {
    try {
      (need ?: UploadScheduler.currentNeed(this))?.let { UploadScheduler.followUp(this, it) }
    } catch (e: Exception) {
      Log.w(TAG, "follow-up not enqueued: ${e.javaClass.simpleName}")
    }
  }

  /** The job's own network need when the queue still needs exactly that, else null. */
  private fun keepWaiting(params: JobParameters): NetNeed? = try {
    val mine = params.extras.getString(UploadScheduler.EXTRA_NEED)
    UploadScheduler.currentNeed(this)?.takeIf { it.name == mine }
  } catch (e: Exception) {
    null
  }

  override fun onStopJob(params: JobParameters): Boolean {
    val reason = if (Build.VERSION.SDK_INT >= 31) params.stopReason else -1
    Log.i(TAG, "UIDT stopped by the system (reason $reason)")
    stoppedByUser = reason == JobParameters.STOP_REASON_USER
    stop?.stop()
    return true
  }

  /** Forwards events to JS and keeps the UIDT notification and byte counters current (≤ 1/s). */
  private inner class Notifier(private val params: JobParameters) : UploadListener {
    private var lastAt = 0L
    private var transferred = 0L
    private val sentByEntry = HashMap<String, Long>()

    override fun onState(status: JSONObject) {
      UploadEvents.onState(status)
      update(force = false)
    }

    override fun onProgress(entryId: String, role: String, sentBytes: Long, totalBytes: Long) {
      UploadEvents.onProgress(entryId, role, sentBytes, totalBytes)
      val key = "$entryId/$role"
      val before = sentByEntry[key] ?: sentBytes
      if (sentBytes > before) transferred += sentBytes - before
      sentByEntry[key] = sentBytes
      update(force = false)
    }

    fun update(force: Boolean) {
      if (Build.VERSION.SDK_INT < 34) return
      val now = SystemClock.elapsedRealtime()
      if (!force && now - lastAt < 1_000) return
      lastAt = now
      try {
        val jobs = UploadRuntime.queue(this@UploadJobService).statuses(null)
          .filter { it.optString("state") in ACTIVE_STATES || it.optJSONObject("original")?.optString("state") in ACTIVE_STATES }
        val segments = jobs.map { it.optLong("totalBytes") + (it.optJSONObject("original")?.optLong("totalBytes") ?: 0) }
        val sent = jobs.sumOf { it.optLong("sentBytes") + (it.optJSONObject("original")?.optLong("sentBytes") ?: 0) }
        val waiting = jobs.all { it.optString("state") == "waiting" }
        val notification = OmwNotifications.upload(this@UploadJobService, if (waiting) emptyList() else segments, sent)
        setNotification(params, OmwNotifications.ID_UPLOAD, notification, JOB_END_NOTIFICATION_POLICY_REMOVE)
        updateTransferredNetworkBytes(params, 0, transferred)
      } catch (e: RuntimeException) {
        Log.w(TAG, "notification update failed: ${e.javaClass.simpleName}")
      }
    }
  }

  companion object {
    private const val TAG = "OmwUploader"
    private const val UIDT_INLINE_WAIT_MS = 10 * 60_000L
    private val ACTIVE_STATES = setOf("queued", "uploading", "committing", "waiting")
  }
}
