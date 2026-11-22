package app.omw.omwnative

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.HandlerThread
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

private const val UPLOAD_PROGRESS = "onUploadProgress"
private const val UPLOAD_STATE = "onUploadStateChange"

/**
 * Uploader for JS (API.md): configure, settings, enqueue/cancel/withdraw/uploadNow/status and the two
 * events. The work itself happens natively (UploadEngine run by the UIDT job or the WorkManager
 * worker, see UploadScheduler), with or without JS. Opening the app (this module's creation)
 * reconciles the queue and reschedules: the guaranteed resume path after a force-stop. While it
 * lives, a change of the default network re-evaluates the waiting jobs' statuses
 * (UploadScheduler.onNetworkChanged), so the queue shows the reason for the network she is on.
 */
class OmwUploaderModule : Module() {
  private var unsubscribe: (() -> Unit)? = null
  internal var networkCallback: ConnectivityManager.NetworkCallback? = null
  internal var networkThread: HandlerThread? = null
  internal var lastNetwork: NetworkSnapshot? = null

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OmwUploader")

    Events(UPLOAD_PROGRESS, UPLOAD_STATE)

    OnCreate {
      unsubscribe = UploadEvents.add(
        object : UploadListener {
          override fun onState(status: JSONObject) = sendEvent(UPLOAD_STATE, jsonToMap(status))

          override fun onProgress(entryId: String, role: String, sentBytes: Long, totalBytes: Long) = sendEvent(
            UPLOAD_PROGRESS,
            mapOf("entryId" to entryId, "role" to role, "sentBytes" to sentBytes.toDouble(), "totalBytes" to totalBytes.toDouble()),
          )
        },
      )
      reconcileInBackground()
      watchNetwork()
    }

    // Every return to the app: reschedule (a UIDT needs the app visible; after a force-stop this
    // is the only way back) and let a waiting run look again.
    OnActivityEntersForeground { reconcileInBackground() }

    OnDestroy {
      unsubscribe?.invoke()
      unsubscribe = null
      unwatchNetwork()
    }

    AsyncFunction("configure") { config: Map<String, Any?> ->
      val base = config["apiBaseUrl"] as? String ?: throw IllegalArgumentException("apiBaseUrl is required")
      UploaderConfig.setBaseUrl(context, base)
      UploadScheduler.schedule(context)
    }

    AsyncFunction("getSettings") { -> UploadSettingsStore(context).read().toMap() }

    AsyncFunction("setSettings") { patch: Map<String, Any?> ->
      val settings = UploadSettingsStore(context).update(patch)
      UploadScheduler.schedule(context) // a new rule may free (or hold) waiting jobs
      settings.toMap()
    }

    AsyncFunction("enqueue") { job: Map<String, Any?> ->
      val status = UploadRuntime.queue(context).enqueue(JSONObject(job), UploadSettingsStore(context).read())
      sendEvent(UPLOAD_STATE, jsonToMap(status))
      UploadScheduler.schedule(context)
    }

    AsyncFunction("cancel") { entryId: String ->
      val status = UploadRuntime.queue(context).cancel(entryId) ?: return@AsyncFunction false
      UploadEngine.abortIfActive(entryId)
      sendEvent(UPLOAD_STATE, jsonToMap(status))
      UploadScheduler.schedule(context)
      true
    }

    // Undo / Remove: forgets the job and owes the API a DELETE, durably (sent first, paced, retried).
    AsyncFunction("withdraw") { entryId: String ->
      val result = UploadRuntime.queue(context).withdraw(entryId)
      UploadEngine.abortIfActive(entryId)
      result.cancelled?.let { sendEvent(UPLOAD_STATE, jsonToMap(it)) }
      UploadScheduler.schedule(context)
      result.deleteOwed
    }

    AsyncFunction("uploadNow") { options: Map<String, Any?> ->
      val count = UploadRuntime.queue(context).uploadNow(options["entryId"] as? String, options["allowMetered"] == true)
      if (count > 0) {
        UploadRuntime.throttle(context).resetForUser() // her tap skips our own backoff, never a Retry-After
        UploadScheduler.schedule(context)
      }
      count
    }

    AsyncFunction("status") { entryId: String? ->
      UploadRuntime.queue(context).statuses(entryId).map { jsonToMap(it) }
    }
  }
}

/**
 * Default-network callback on its own thread. Only a change of the facts the A4 rules read
 * (connected, validated, unmetered, roaming, data SIM) re-evaluates, 1 s after the last change
 * (Android reports a switch from Wi-Fi to mobile data as several callbacks).
 */
private fun OmwUploaderModule.watchNetwork() {
  val ctx = appContext.reactContext?.applicationContext ?: return
  val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return
  val thread = HandlerThread("omw-upload-network").also { it.start() }
  val handler = Handler(thread.looper)
  val refresh = Runnable { UploadScheduler.onNetworkChanged(ctx) }
  fun changed(caps: NetworkCapabilities?) {
    val now = NetworkProbe.read(ctx, caps).copy(transport = "", simOperatorName = null)
    if (now == lastNetwork) return
    lastNetwork = now
    handler.removeCallbacks(refresh)
    handler.postDelayed(refresh, 1_000)
  }
  val cb = object : ConnectivityManager.NetworkCallback() {
    override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = changed(caps)

    override fun onLost(network: Network) = changed(null)
  }
  runCatching { cm.registerDefaultNetworkCallback(cb, handler) }.onSuccess {
    networkCallback = cb
    networkThread = thread
  }.onFailure { thread.quitSafely() }
}

private fun OmwUploaderModule.unwatchNetwork() {
  val cb = networkCallback ?: return
  networkCallback = null
  runCatching {
    appContext.reactContext?.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb)
  }
  networkThread?.quitSafely()
  networkThread = null
}

private fun OmwUploaderModule.reconcileInBackground() {
  val ctx = appContext.reactContext?.applicationContext ?: return
  thread(name = "omw-upload-reconcile") { runCatching { UploadScheduler.reconcile(ctx) } }
}

internal fun jsonToMap(json: JSONObject): Map<String, Any?> =
  json.keys().asSequence().associateWith { key -> unwrap(json.get(key)) }

private fun unwrap(value: Any?): Any? = when (value) {
  JSONObject.NULL -> null
  is JSONObject -> jsonToMap(value)
  is JSONArray -> (0 until value.length()).map { unwrap(value.get(it)) }
  is Long -> value.toDouble()
  is Int -> value.toDouble()
  else -> value
}
