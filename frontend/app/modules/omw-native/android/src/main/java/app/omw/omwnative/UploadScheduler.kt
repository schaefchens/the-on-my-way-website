package app.omw.omwnative

import android.app.ActivityManager
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.PersistableBundle
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * When the uploader runs (app-plan §6.2):
 * - API 34+: a user-initiated data transfer (UIDT) job, scheduled while the app is visible (Share,
 *   "Upload now", every app open). It is persisted (survives reboots), carries the network
 *   constraint of the A4 rules and a silent progress notification, and is exempt from standby
 *   quotas. A UIDT can only be scheduled while the app is visible, so a follow-up that a finished
 *   run schedules from the background (e.g. "now wait for Wi-Fi for the original") becomes a
 *   WorkManager job until the app opens again.
 * - API 29–33 (and those background follow-ups): a WorkManager worker with the same network
 *   constraint, ~9 minutes per run, re-enqueued; no foreground service (Android 12+ forbids
 *   starting one from the background).
 * - Every app open (the bridge's creation and every return to the foreground) calls [reconcile]:
 *   the guaranteed path after a force-stop. A force-stop (Settings › Force stop, or a swipe-away
 *   that some OEMs turn into one) removes every scheduled job and alarm of the app, and Android
 *   delivers nothing to a stopped app, so its uploads resume only when she opens the app again;
 *   they then continue from the stored offsets, not from 0. Process death (low memory) and a
 *   reboot need no app open: JobScheduler and WorkManager bring the run back by themselves.
 */
object UploadScheduler {
  /** JobScheduler id of the UIDT job (WorkManager uses its own id range). */
  const val UIDT_JOB_ID = 0x0A11_0001
  const val WORK_NAME = "omw-upload"

  /** JobInfo extra: the NetNeed the UIDT job was scheduled with (no secrets in extras). */
  const val EXTRA_NEED = "omw.need"
  private const val TAG = "OmwUploader"

  /** Test hook: always use WorkManager (the API 29–33 path) even on 34+. */
  @Volatile
  var forceWorkManager = false

  /**
   * The WorkManager backup behind every UIDT job: it runs this long after the UIDT was scheduled
   * (with the same network constraint) and only uploads when no run is active. JobScheduler
   * reschedules a UIDT whose process was killed, but may not start it again for a long time
   * (seen on the API 36 emulator); WorkManager does. While a long UIDT run is active, the backup
   * finds it busy and re-arms itself. Settable for tests.
   */
  @Volatile
  var backupDelayMs = 15 * 60_000L

  /**
   * The default network changed while the app is alive (the bridge listens): a waiting job's
   * "blockedBy" follows the network she is on now. Without it, a run stopped by losing Wi-Fi keeps
   * the reason it saw in the gap between networks ("no_network") while she is already on mobile
   * data, and the queue says "Waiting for network" instead of "Waiting for Wi-Fi". Only statuses:
   * an active run re-reads the queue (nudge); otherwise the queue is evaluated, nothing scheduled
   * (JobScheduler/WorkManager start the run from their network constraints).
   */
  fun onNetworkChanged(context: Context) {
    if (UploadEngine.isRunning) {
      UploadEngine.nudge()
      return
    }
    runCatching { UploadRuntime.engine(context).evaluate() }
  }

  /** App open: prune old finished jobs, then schedule. */
  fun reconcile(context: Context) {
    runCatching { UploadRuntime.queue(context).prune() }
    schedule(context)
  }

  /**
   * Re-evaluates the queue (statuses for the current network) and makes sure a run happens when
   * the rules allow one. [delayMs] postpones it (backoff); [fromWorker] chains after the calling
   * worker instead of replacing it.
   */
  fun schedule(context: Context, delayMs: Long = 0, fromWorker: Boolean = false) {
    if (UploadEngine.isRunning) {
      UploadEngine.nudge() // the active run re-reads the queue; end its current wait now
      return
    }
    val ev = UploadRuntime.engine(context).evaluate()
    val need = UploadRules.weakest(ev.runNeeds)
    if (need == null) {
      cancel(context)
      return
    }
    val delay = when {
      delayMs > 0 -> delayMs
      ev.next == null && ev.retryAt != null -> (ev.retryAt - System.currentTimeMillis()).coerceAtLeast(0)
      else -> 0
    }
    if (Build.VERSION.SDK_INT >= 34 && delay == 0L && !forceWorkManager && isVisible(context)) {
      if (scheduleUidt(context, need, ev.pendingBytes)) {
        enqueueWork(context, need, backupDelayMs, fromWorker = false) // the backup (see backupDelayMs)
        return
      }
    }
    enqueueWork(context, need, delay, fromWorker)
  }

  /** A WorkManager run as soon as [need] is met (beside a UIDT job that waits for the same network). */
  fun followUp(context: Context, need: NetNeed) = enqueueWork(context, need, 0, fromWorker = false)

  /** Re-arms the backup while another run is active (called by a worker that found it busy). */
  fun rearmBackup(context: Context) = enqueueWork(context, NetNeed.ANY, backupDelayMs, fromWorker = true)

  /** The weakest network the queue needs right now (null = nothing can run). */
  fun currentNeed(context: Context): NetNeed? = UploadRules.weakest(UploadRuntime.engine(context).evaluate().runNeeds)

  fun cancel(context: Context) {
    context.getSystemService(JobScheduler::class.java)?.cancel(UIDT_JOB_ID)
    workManager(context)?.cancelUniqueWork(WORK_NAME)
  }

  /** WorkManager, or null where it is not initialized (a secondary process); never throws. */
  private fun workManager(context: Context): WorkManager? = try {
    WorkManager.getInstance(context)
  } catch (e: IllegalStateException) {
    Log.w(TAG, "WorkManager unavailable in this process")
    null
  }

  /** The network a job needs, as a request (VPNs allowed; NOT_METERED = A4's "Wi-Fi"). */
  fun networkRequest(need: NetNeed): NetworkRequest = NetworkRequest.Builder()
    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
    .apply {
      when (need) {
        NetNeed.UNMETERED -> addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        NetNeed.NOT_ROAMING -> addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING)
        NetNeed.ANY -> Unit
      }
    }
    .build()

  private fun scheduleUidt(context: Context, need: NetNeed, pendingBytes: Long): Boolean {
    if (Build.VERSION.SDK_INT < 34) return false
    val js = context.getSystemService(JobScheduler::class.java) ?: return false
    val info = JobInfo.Builder(UIDT_JOB_ID, ComponentName(context, UploadJobService::class.java))
      .setUserInitiated(true)
      .setRequiredNetwork(networkRequest(need))
      .setEstimatedNetworkBytes(JobInfo.NETWORK_BYTES_UNKNOWN.toLong(), pendingBytes.coerceAtLeast(1))
      .setPersisted(true)
      .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
      .setExtras(PersistableBundle().apply { putString(EXTRA_NEED, need.name) })
      .build()
    return try {
      js.schedule(info) == JobScheduler.RESULT_SUCCESS
    } catch (e: RuntimeException) {
      // Not visible after all, or the system refused the UIDT: WorkManager takes over.
      Log.w(TAG, "UIDT not scheduled: ${e.javaClass.simpleName}")
      false
    }
  }

  private fun enqueueWork(context: Context, need: NetNeed, delayMs: Long, fromWorker: Boolean) {
    val type = when (need) {
      NetNeed.UNMETERED -> NetworkType.UNMETERED
      NetNeed.NOT_ROAMING -> NetworkType.NOT_ROAMING
      NetNeed.ANY -> NetworkType.CONNECTED
    }
    val request = OneTimeWorkRequest.Builder(UploadWorker::class.java)
      .setConstraints(Constraints.Builder().setRequiredNetworkRequest(networkRequest(need), type).build())
      .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .addTag(WORK_NAME)
      .build()
    val policy = if (fromWorker) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.REPLACE
    workManager(context)?.enqueueUniqueWork(WORK_NAME, policy, request)
  }

  /**
   * UIDT jobs may only be scheduled while the app is visible to her: an activity on screen
   * (FOREGROUND or VISIBLE). A process that only runs a job or a foreground service
   * (FOREGROUND_SERVICE, 125) is not visible, even though its importance number is lower.
   */
  private fun isVisible(context: Context): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
      info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
  }
}
