package app.omw.omwnative

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * The app routes of the API as @omw/contracts/app specifies them (entries, tus subset, commit),
 * in memory, for MockWebServer: used by the JVM tests and by the instrumented tests on the
 * emulator. Every request is logged with the time of [clock] (a FakeClock in JVM tests, so
 * "10 requests per 10 s" can be checked exactly). Faults are injected with [fault] (answer
 * instead of the real handler) and [nextPolicy] (socket policy of the next request, e.g. a
 * disconnect in the middle of a PATCH body).
 *
 * Ownership as the real API (AppInbox): an entry and its slots belong to the phone that created
 * it. [token] is this phone's token; setting it is pairing the same install again (the old token
 * stops working, the entries stay this phone's, as the API's adoption by installId does). Other
 * phones ([addOtherPhone]) get 403 on this phone's slots and entries, and 409 entry_conflict on a
 * create of an id this phone has. An id keeps its first content forever, also once withdrawn.
 */
class FakeTusServer(
  private val clock: Clock = WallClock,
  @Volatile var token: String = TEST_TOKEN,
) : Dispatcher() {
  class Upload(val id: String, val entryId: String, val role: String, val bytes: Long, val sha256Hex: String) {
    val data = ByteArrayOutputStream()
    @Volatile var committed = false
    val offset: Long get() = synchronized(data) { data.size().toLong() }
  }

  class Entry(val entryId: String, val entry: JSONObject, val uploads: List<Upload>, val owner: String) {
    @Volatile var state = "receiving"
  }

  data class Logged(val method: String, val path: String, val atMs: Long, val status: Int, val offset: Long?, val length: Long)

  val entries = ConcurrentHashMap<String, Entry>()
  val uploads = ConcurrentHashMap<String, Upload>()
  val log = CopyOnWriteArrayList<Logged>()
  private val ids = AtomicInteger()

  @Volatile var chunkMin = 256 * 1024L
  @Volatile var chunkMax = 8 * 1024 * 1024L

  /** Simulated link speed for FakeClock tests: each PATCH body advances the clock by its transfer time. */
  @Volatile var bytesPerSecond = 0L

  /** Real delay per PATCH (instrumented tests: makes an upload slow enough to kill it midway). */
  @Volatile var patchDelayMs = 0L

  /** Answer instead of the real handler (null = handle normally). */
  @Volatile var fault: ((RecordedRequest, String) -> MockResponse?)? = null

  /** Socket policy for the next request (consumed by it). */
  @Volatile var nextPolicy: MockResponse? = null

  /** The next PATCH is appended, but its answer is lost (the phone dies before reading it). */
  @Volatile var dropNextPatchAnswer = false

  /** The next create is stored, but its answer is lost. */
  @Volatile var dropNextCreateAnswer = false

  /** Only answer to these methods natively (a host that blocks PATCH/HEAD → 405). */
  @Volatile var blockNativePatchHead = false

  override fun peek(): MockResponse = nextPolicy ?: super.peek()

  override fun dispatch(request: RecordedRequest): MockResponse {
    nextPolicy = null
    val at = clock.nowMs()
    val override = request.getHeader("X-HTTP-Method-Override")
    val method = if (request.method == "POST" && override != null) override else request.method ?: "GET"
    val path = request.requestUrl?.encodedPath ?: ""
    val response = handle(request, method, path, override != null)
    val offset = request.getHeader("Upload-Offset")?.toLongOrNull()
    log += Logged(method, path, at, response.status.split(' ').getOrNull(1)?.toIntOrNull() ?: 0, offset, request.bodySize)
    return response
  }

  /** Tokens of other phones (token -> phone name). */
  private val others = ConcurrentHashMap<String, String>()

  /** Connects another phone (another install): it may not touch this phone's entries. */
  fun addOtherPhone(token: String, name: String = "other") {
    others[token] = name
  }

  /** Requests of one kind, e.g. count("PATCH"). */
  fun count(method: String): Int = log.count { it.method == method }

  fun bytesOf(role: String): ByteArray? = uploads.values.firstOrNull { it.role == role }?.data?.toByteArray()

  private fun handle(request: RecordedRequest, method: String, path: String, overridden: Boolean): MockResponse {
    val bearer = request.getHeader("Authorization")?.removePrefix("Bearer ")
    val phone = when (bearer) {
      token -> ME
      null -> null
      else -> others[bearer]
    } ?: return error(401, "unauthorized")
    fault?.invoke(request, method)?.let { return it }
    if (blockNativePatchHead && !overridden && (method == "PATCH" || method == "HEAD")) return MockResponse().setResponseCode(405)
    val entries = Regex("^/api/v1/app/entries$")
    val one = Regex("^/api/v1/app/entries/([0-9A-Z]{26})$")
    val commit = Regex("^/api/v1/app/entries/([0-9A-Z]{26})/commit$")
    val upload = Regex("^/api/v1/app/uploads/(u_[A-Za-z0-9_-]+)$")
    return when {
      method == "POST" && entries.matches(path) -> create(request, phone)
      method == "DELETE" && one.matches(path) -> withdraw(one.find(path)!!.groupValues[1], phone)
      method == "POST" && commit.matches(path) -> commit(request, commit.find(path)!!.groupValues[1], phone)
      method == "HEAD" && upload.matches(path) -> head(upload.find(path)!!.groupValues[1], phone)
      method == "PATCH" && upload.matches(path) -> patch(request, upload.find(path)!!.groupValues[1], phone)
      else -> error(404, "not_found")
    }
  }

  /** 403 for another phone's entry, 410 once withdrawn, null when [phone] may use the slot. */
  private fun refuse(e: Entry?, phone: String): MockResponse? = when {
    e == null -> null
    e.owner != phone -> error(403, "forbidden")
    e.state == "withdrawn" -> error(410, "gone")
    else -> null
  }

  private fun withdraw(entryId: String, phone: String): MockResponse {
    val e = entries[entryId] ?: return error(404, "not_found")
    if (e.owner != phone) return error(403, "forbidden")
    e.state = "withdrawn" // its slots answer 410 from now on; the id keeps its content
    return MockResponse().setResponseCode(204)
  }

  private fun create(request: RecordedRequest, phone: String): MockResponse {
    val body = JSONObject(request.body.readUtf8())
    if (body.optInt("contractVersion") != 1 || !body.has("clientNow")) return error(422, "validation_failed")
    val entry = body.getJSONObject("entry")
    val entryId = entry.getString("entryId")
    val existing = entries[entryId]
    if (existing != null) {
      if (existing.owner != phone || UploadQueue.canonical(existing.entry) != UploadQueue.canonical(entry)) return error(409, "entry_conflict")
      return json(200, state(existing))
    }
    val files = entry.optJSONArray("files") ?: JSONArray()
    val list = (0 until files.length()).map { i ->
      val f = files.getJSONObject(i)
      Upload("u_test${ids.incrementAndGet().toString().padStart(16, '0')}", entryId, f.getString("role"), f.getLong("bytes"), f.getString("sha256Hex"))
    }
    list.forEach { uploads[it.id] = it }
    val e = Entry(entryId, entry, list, phone)
    if (list.isEmpty()) e.state = "uploaded"
    entries[entryId] = e
    if (dropNextCreateAnswer) {
      dropNextCreateAnswer = false
      return json(201, state(e)).setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
    }
    return json(201, state(e))
  }

  private fun head(id: String, phone: String): MockResponse {
    val u = uploads[id] ?: return error(404, "not_found")
    refuse(entries[u.entryId], phone)?.let { return it }
    return MockResponse().setResponseCode(200)
      .setHeader("Tus-Resumable", "1.0.0")
      .setHeader("Upload-Offset", u.offset)
      .setHeader("Upload-Length", u.bytes)
      .setHeader("Cache-Control", "no-store")
  }

  private fun patch(request: RecordedRequest, id: String, phone: String): MockResponse {
    val u = uploads[id] ?: return error(404, "not_found")
    refuse(entries[u.entryId], phone)?.let { return it }
    if (request.getHeader("Tus-Resumable") != "1.0.0") return error(412, "validation_failed")
    if (request.getHeader("Content-Type")?.startsWith("application/offset+octet-stream") != true) return error(415, "unsupported_media_type")
    val bytes = request.body.readByteArray()
    val declared = request.getHeader("Content-Length")?.toLongOrNull()
    if (declared != null && declared != bytes.size.toLong()) return error(400, "validation_failed") // a cut body is never appended
    if (bytesPerSecond > 0 && clock is FakeClock) clock.advance(bytes.size * 1000L / bytesPerSecond)
    if (patchDelayMs > 0) Thread.sleep(patchDelayMs)
    synchronized(u.data) {
      val offset = request.getHeader("Upload-Offset")?.toLongOrNull() ?: return error(400, "validation_failed")
      if (offset != u.offset) return error(409, "offset_mismatch").setHeader("Upload-Offset", u.offset)
      if (bytes.size > chunkMax || offset + bytes.size > u.bytes) return error(413, "upload_too_large")
      val checksum = request.getHeader("Upload-Checksum") ?: ""
      val digest = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes))
      if (checksum != "sha256 $digest") return error(460, "checksum_mismatch").setHeader("Upload-Offset", u.offset)
      u.data.write(bytes)
      val ok = MockResponse().setResponseCode(204).setHeader("Tus-Resumable", "1.0.0").setHeader("Upload-Offset", u.offset)
      if (dropNextPatchAnswer) {
        dropNextPatchAnswer = false
        return ok.setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
      }
      return ok
    }
  }

  private fun commit(request: RecordedRequest, entryId: String, phone: String): MockResponse {
    val e = entries[entryId] ?: return error(404, "not_found")
    refuse(e, phone)?.let { return it }
    val roles = JSONObject(request.body.readUtf8()).getJSONArray("roles")
    for (i in 0 until roles.length()) {
      val u = e.uploads.firstOrNull { it.role == roles.getString(i) } ?: return error(422, "validation_failed")
      if (u.committed) continue
      if (u.offset != u.bytes) return error(409, "incomplete")
      val hex = MessageDigest.getInstance("SHA-256").digest(u.data.toByteArray()).joinToString("") { "%02x".format(it) }
      if (hex != u.sha256Hex) {
        synchronized(u.data) { u.data.reset() }
        return error(422, "sha256_mismatch")
      }
      u.committed = true
    }
    if (e.uploads.filter { it.role != "original" }.all { it.committed }) e.state = "uploaded"
    return json(200, state(e))
  }

  fun state(e: Entry): JSONObject = JSONObject()
    .put("entryId", e.entryId)
    .put("sourceKey", "app:${e.entryId}")
    .put("state", e.state)
    .put("occurredAt", e.entry.optString("occurredAt"))
    .put("receivedAt", UploadJob.isoNow(clock.nowMs()))
    .put("heldBack", false)
    .put(
      "uploads",
      JSONArray(
        e.uploads.map {
          JSONObject().put("uploadId", it.id).put("role", it.role).put("bytes", it.bytes).put("offset", it.offset).put("committed", it.committed)
        },
      ),
    )
    .put("chunk", JSONObject().put("minBytes", chunkMin).put("maxBytes", chunkMax))
    .put("backendLastSeenAt", JSONObject.NULL)
    .put("publish", JSONObject.NULL)

  companion object {
    const val TEST_TOKEN = "omw_TESTtokenTESTtokenTESTtokenTESTtokenTESTtok"
    private const val ME = "this phone"

    fun error(status: Int, code: String, details: JSONObject? = null): MockResponse =
      MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json")
        .setBody(JSONObject().put("error", JSONObject().put("code", code).put("message", code).apply { if (details != null) put("details", details) }).toString())

    fun json(status: Int, body: JSONObject): MockResponse =
      MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body.toString())
  }
}
