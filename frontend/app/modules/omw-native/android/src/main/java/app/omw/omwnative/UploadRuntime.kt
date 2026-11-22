package app.omw.omwnative

import android.content.Context
import android.security.NetworkSecurityPolicy
import androidx.core.content.edit
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Where the uploader sends to: the API base from the app build (`extra.apiBaseUrl`). JS may set
 * it through Uploader.configure (stored natively); without that, the uploader reads the same
 * value from the app config that expo-constants embeds in the APK (`assets/app.config`), so
 * background runs work without JS either way. Pairing links never set it. Only https, except
 * plain http to the phone itself (`adb reverse` in development) when the app's network security
 * config allows cleartext there.
 */
object UploaderConfig {
  private const val PREFS = "omw.upload-config"
  private const val EMBEDDED_CONFIG = "app.config"

  @Volatile
  private var embedded: Pair<Boolean, HttpUrl?> = false to null

  fun baseUrl(context: Context): HttpUrl? =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("apiBaseUrl", null)?.toHttpUrlOrNull()
      ?: embeddedBaseUrl(context)

  /** extra.apiBaseUrl of the embedded app config (read once per process), or null. */
  private fun embeddedBaseUrl(context: Context): HttpUrl? {
    val (read, url) = embedded
    if (read) return url
    val text = try {
      context.assets.open(EMBEDDED_CONFIG).use { it.readBytes().toString(Charsets.UTF_8) }
    } catch (_: java.io.IOException) {
      null
    }
    val parsed = text?.let { fromAppConfig(it) { host -> NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted(host) } }
    embedded = true to parsed
    return parsed
  }

  /** The API base in an Expo app config JSON (`extra.apiBaseUrl`), validated like [parse]; null when absent or invalid. */
  fun fromAppConfig(json: String, cleartextPermitted: (String) -> Boolean): HttpUrl? {
    val value = runCatching { JSONObject(json).optJSONObject("extra")?.optString("apiBaseUrl") }.getOrNull()
    if (value.isNullOrBlank()) return null
    return runCatching { parse(value, cleartextPermitted) }.getOrNull()
  }

  fun setBaseUrl(context: Context, value: String): HttpUrl {
    val url = parse(value) { host -> NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted(host) }
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit(commit = true) { putString("apiBaseUrl", url.toString()) }
    return url
  }

  /** Validates an API base ("https://api.example.org" or "http://127.0.0.1:8080"). */
  fun parse(value: String, cleartextPermitted: (String) -> Boolean): HttpUrl {
    val url = value.trim().toHttpUrlOrNull() ?: throw IllegalArgumentException("apiBaseUrl is not an http(s) URL")
    require(url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null) {
      "apiBaseUrl must not carry credentials, a query or a fragment"
    }
    if (!url.isHttps) {
      require(url.host in LOOPBACK) { "apiBaseUrl must use https (plain http only to the phone itself)" }
      require(cleartextPermitted(url.host)) { "cleartext to ${url.host} is not allowed by this build" }
    }
    val path = url.encodedPath.trimEnd('/')
    return url.newBuilder().encodedPath("$path/").build()
  }

  private val LOOPBACK = setOf("127.0.0.1", "localhost", "[::1]", "::1")
}

/** Fan-out of uploader events in this process (the JS bridge listens while the app runs). */
object UploadEvents : UploadListener {
  private val listeners = CopyOnWriteArrayList<UploadListener>()

  fun add(listener: UploadListener): () -> Unit {
    listeners += listener
    return { listeners -= listener }
  }

  override fun onState(status: JSONObject) = listeners.forEach { runCatching { it.onState(status) } }

  override fun onProgress(entryId: String, role: String, sentBytes: Long, totalBytes: Long) =
    listeners.forEach { runCatching { it.onProgress(entryId, role, sentBytes, totalBytes) } }
}

/** Builds engines with the real environment and the process-wide budget and throttle. */
object UploadRuntime {
  const val STATE_PREFS = "omw.upload-state"

  @Volatile
  private var shared: Triple<KeyValueStore, RequestBudget, UploadThrottle>? = null

  private fun shared(context: Context): Triple<KeyValueStore, RequestBudget, UploadThrottle> =
    shared ?: synchronized(this) {
      shared ?: run {
        val kv = PrefsKeyValueStore(context.applicationContext, STATE_PREFS)
        Triple(kv, RequestBudget(WallClock, kv), UploadThrottle(WallClock, kv))
      }.also { shared = it }
    }

  fun environment(context: Context): UploadEnvironment {
    val app = context.applicationContext
    return object : UploadEnvironment {
      override val clock: Clock = WallClock

      override fun network(): NetworkSnapshot = NetworkProbe.read(app)

      override fun settings(): UploadSettings = UploadSettingsStore(app).read()

      override fun token(): String? = TokenVault(app).get()

      override fun baseUrl(): HttpUrl? = UploaderConfig.baseUrl(app)
    }
  }

  fun throttle(context: Context): UploadThrottle = shared(context).third

  fun queue(context: Context): UploadQueue = UploadQueue(UploadJobStore(context), WallClock)

  fun engine(context: Context, listener: UploadListener = UploadEvents, inlineWaitMaxMs: Long = 60_000): UploadEngine {
    val (kv, budget, throttle) = shared(context)
    return UploadEngine(
      store = UploadJobStore(context),
      env = environment(context),
      budget = budget,
      throttle = throttle,
      state = kv,
      listener = listener,
      inlineWaitMaxMs = inlineWaitMaxMs,
    )
  }
}
