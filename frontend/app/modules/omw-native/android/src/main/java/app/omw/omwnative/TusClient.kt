package app.omw.omwnative

import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.TimeUnit

/** One answer of the API (or why there was none). */
data class ApiResult(
  /** HTTP status; [UNREACHABLE] = no answer (network error), [STOPPED] = the run was stopped. */
  val status: Int,
  val body: JSONObject? = null,
  /** ApiError.error.code */
  val errorCode: String? = null,
  val errorMessage: String? = null,
  /** ApiError.error.details, e.g. {role, maxBytes} of a 413 on create. */
  val errorDetails: JSONObject? = null,
  val retryAfterMs: Long? = null,
  /** tus Upload-Offset (PATCH 204, HEAD 200, 409, 460). */
  val uploadOffset: Long? = null,
  val ioError: IOException? = null,
  /** Time of the HTTP exchange itself (without the wait for the request budget). */
  val durationMs: Long = 0,
) {
  val ok: Boolean get() = status in 200..299

  companion object {
    const val UNREACHABLE = 0
    const val STOPPED = -1
  }
}

/**
 * The app routes of the API (prefix /api/v1) with the tus 1.0 subset of @omw/contracts/app
 * (APP_TUS): entry create, HEAD/PATCH on upload slots, commit. Every request first takes a slot
 * of the [RequestBudget]. Hosts that refuse PATCH/HEAD (405/501) get POST + X-HTTP-Method-Override,
 * remembered in [state]. The token only ever goes into the Authorization header; nothing here logs.
 */
class TusClient(
  private val http: OkHttpClient,
  private val baseUrl: HttpUrl,
  private val token: String,
  private val budget: RequestBudget,
  private val clock: Clock,
  private val state: KeyValueStore,
) {
  @Volatile
  private var current: Call? = null

  /** Cancels the request in flight (the run was stopped). */
  fun abort() {
    current?.cancel()
  }

  fun createEntry(entry: JSONObject, clientNow: String, stop: StopSignal): ApiResult {
    val body = JSONObject()
      .put("contractVersion", CONTRACT_VERSION)
      .put("clientNow", clientNow)
      .put("entry", entry)
    return send(stop, request("app/entries").post(oneShot(body.toString().toRequestBody(JSON))))
  }

  fun head(uploadId: String, stop: StopSignal): ApiResult = tus(stop, "HEAD", uploadId, null, emptyMap())

  /** Sends [length] bytes of [data] at [offset]; [checksum] is the "sha256 <base64>" header value. */
  fun patch(uploadId: String, offset: Long, data: ByteArray, length: Int, checksum: String, stop: StopSignal): ApiResult =
    tus(
      stop,
      "PATCH",
      uploadId,
      oneShot(data.toRequestBody(TUS_CONTENT_TYPE, 0, length)),
      mapOf(H_OFFSET to offset.toString(), H_CHECKSUM to checksum),
    )

  fun commit(entryId: String, roles: List<String>, stop: StopSignal): ApiResult {
    val body = JSONObject().put("roles", JSONArray(roles))
    return send(stop, request("app/entries/$entryId/commit").post(oneShot(body.toString().toRequestBody(JSON))))
  }

  /** DELETE /app/entries/{entryId}: withdraw (204; 404 when the API never had it). */
  fun withdrawEntry(entryId: String, stop: StopSignal): ApiResult {
    require(ENTRY_ID.matches(entryId)) { "Unexpected entry id" }
    return withOverride(stop, "DELETE", null) { request("app/entries/$entryId") }
  }

  private fun tus(stop: StopSignal, method: String, uploadId: String, body: RequestBody?, headers: Map<String, String>): ApiResult {
    require(UPLOAD_ID.matches(uploadId)) { "Unexpected upload id" }
    return withOverride(stop, method, body) {
      request("app/uploads/$uploadId").header(H_RESUMABLE, TUS_VERSION).apply { headers.forEach { (k, v) -> header(k, v) } }
    }
  }

  /** [method] as is, or as POST + X-HTTP-Method-Override on hosts that refuse it (405/501, remembered). */
  private fun withOverride(stop: StopSignal, method: String, body: RequestBody?, base: () -> Request.Builder): ApiResult {
    fun build(override: Boolean): Request.Builder = if (override) {
      base().header(H_OVERRIDE, method).post(body ?: oneShot(ByteArray(0).toRequestBody(null)))
    } else {
      base().method(method, body)
    }
    if (state.get(KEY_OVERRIDE) == "1") return send(stop, build(true))
    val first = send(stop, build(false))
    if (first.status != 405 && first.status != 501) return first
    state.put(KEY_OVERRIDE, "1")
    return send(stop, build(true))
  }

  private fun request(path: String): Request.Builder {
    val url = baseUrl.newBuilder().addPathSegments("api/v1/$path").build()
    return Request.Builder()
      .url(url)
      .header("Authorization", "Bearer $token")
      .header("Accept", "application/json")
      .header("User-Agent", USER_AGENT)
  }

  private fun send(stop: StopSignal, builder: Request.Builder): ApiResult {
    if (!budget.acquire(stop)) return ApiResult(ApiResult.STOPPED)
    val call = http.newCall(builder.build())
    current = call
    if (stop.stopped) call.cancel()
    val started = clock.elapsedMs()
    return try {
      call.execute().use { parse(it) }.copy(durationMs = clock.elapsedMs() - started)
    } catch (e: IOException) {
      if (stop.stopped) ApiResult(ApiResult.STOPPED, ioError = e) else ApiResult(ApiResult.UNREACHABLE, ioError = e)
    } finally {
      current = null
    }
  }

  private fun parse(response: Response): ApiResult {
    val text = response.body?.let { body ->
      val source = body.source()
      source.request(MAX_BODY)
      source.buffer.readUtf8(minOf(source.buffer.size, MAX_BODY))
    }
    val json = text?.takeIf { it.isNotBlank() }?.let { runCatching { JSONObject(it) }.getOrNull() }
    val error = json?.optJSONObject("error")
    return ApiResult(
      status = response.code,
      body = json,
      errorCode = error?.optString("code")?.takeIf { it.isNotEmpty() },
      errorMessage = error?.optString("message")?.takeIf { it.isNotEmpty() },
      errorDetails = error?.optJSONObject("details"),
      retryAfterMs = Backoff.parseRetryAfter(response.header("Retry-After"), clock.nowMs()),
      uploadOffset = response.header(H_OFFSET)?.trim()?.toLongOrNull()?.takeIf { it >= 0 },
    )
  }

  companion object {
    const val CONTRACT_VERSION = 1
    const val TUS_VERSION = "1.0.0"
    const val H_RESUMABLE = "Tus-Resumable"
    const val H_OFFSET = "Upload-Offset"
    const val H_LENGTH = "Upload-Length"
    const val H_CHECKSUM = "Upload-Checksum"
    const val H_OVERRIDE = "X-HTTP-Method-Override"
    const val USER_AGENT = "OnMyWay-Android"
    private const val KEY_OVERRIDE = "tus.methodOverride"
    private const val MAX_BODY = 256L * 1024
    val JSON = "application/json; charset=utf-8".toMediaType()
    val TUS_CONTENT_TYPE = "application/offset+octet-stream".toMediaType()
    val UPLOAD_ID = Regex("^u_[A-Za-z0-9_-]{16,64}$")
    val ENTRY_ID = UploadJobStore.ULID

    /** A body OkHttp must not send twice (no silent retry once the request started). */
    fun oneShot(body: RequestBody): RequestBody = object : RequestBody() {
      override fun contentType() = body.contentType()

      override fun contentLength() = body.contentLength()

      override fun isOneShot() = true

      override fun writeTo(sink: okio.BufferedSink) = body.writeTo(sink)
    }

    /** "sha256 <base64>" for the Upload-Checksum header (formatUploadChecksum in the contract). */
    fun checksumHeader(data: ByteArray, length: Int = data.size): String {
      val digest = MessageDigest.getInstance("SHA-256").apply { update(data, 0, length) }.digest()
      return "sha256 " + Base64.getEncoder().encodeToString(digest)
    }

    fun httpClient(): OkHttpClient = OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .writeTimeout(60, TimeUnit.SECONDS)
      .readTimeout(60, TimeUnit.SECONDS)
      .callTimeout(150, TimeUnit.SECONDS)
      // Lets OkHttp fall back to another address of the host when a connect fails (dual-stack
      // hosts); bodies are one-shot, so a request that started sending is never silently resent:
      // every retry goes through the budget and the backoff.
      .retryOnConnectionFailure(true)
      .followRedirects(false)
      .build()
  }
}
