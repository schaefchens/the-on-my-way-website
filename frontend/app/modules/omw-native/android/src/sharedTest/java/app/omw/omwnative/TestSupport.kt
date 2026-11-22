package app.omw.omwnative

import okhttp3.HttpUrl
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

/** A clock that only moves when told to (and when FakeStop "sleeps"). */
class FakeClock(start: Long = 1_800_000_000_000L) : Clock {
  private val now = AtomicLong(start)

  override fun nowMs(): Long = now.get()

  override fun elapsedMs(): Long = now.get()

  fun advance(ms: Long) {
    now.addAndGet(ms)
  }
}

/** Sleeping advances the fake clock instantly; [stopAfterSleeps] simulates a system stop. */
class FakeStop(private val clock: FakeClock, private val stopAfterSleeps: Int = Int.MAX_VALUE) : StopSignal {
  @Volatile override var stopped = false
  var sleeps = 0
  var sleptMs = 0L

  override fun sleep(ms: Long): Boolean {
    if (stopped) return false
    sleeps++
    sleptMs += ms
    clock.advance(ms.coerceAtLeast(1))
    if (sleeps >= stopAfterSleeps) stopped = true
    return !stopped
  }
}

class FakeEnv(
  override val clock: Clock,
  @Volatile var net: NetworkSnapshot = WIFI,
  var uploadSettings: UploadSettings = UploadSettings(),
  var tokenValue: String? = FakeTusServer.TEST_TOKEN,
  var base: HttpUrl? = null,
) : UploadEnvironment {
  override fun network() = net

  override fun settings() = uploadSettings

  override fun token() = tokenValue

  override fun baseUrl() = base

  companion object {
    val WIFI = NetworkSnapshot(true, true, true, false, "wifi", "26201", "Telekom")
    val MOBILE = NetworkSnapshot(true, true, false, false, "cellular", "26201", "Telekom")
    val HOTSPOT = NetworkSnapshot(true, true, false, false, "wifi", "26201", "Telekom")
    val ROAMING = NetworkSnapshot(true, true, false, true, "cellular", "45204", "Viettel")
    val PORTAL = NetworkSnapshot(true, false, true, false, "wifi", null, null)
    val OFFLINE = NetworkSnapshot(false, false, false, false, "none", null, null)
  }
}

/** Collects engine events. */
class RecordingListener : UploadListener {
  val states = mutableListOf<JSONObject>()
  val progress = mutableListOf<Triple<String, String, Long>>()

  @Synchronized
  override fun onState(status: JSONObject) {
    states += status
  }

  @Synchronized
  override fun onProgress(entryId: String, role: String, sentBytes: Long, totalBytes: Long) {
    progress += Triple(entryId, role, sentBytes)
  }
}

object TestJobs {
  /** A valid ULID for test number [n]. */
  fun ulid(n: Int): String = "01JD" + n.toString().padStart(22, '0')

  fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  /**
   * Writes the files and returns the UploadJob JSON JS would enqueue (AppEntry + local files).
   * [roles]: role → size in bytes.
   */
  fun job(dir: File, n: Int, kind: String, roles: Map<String, Int>, mode: String? = null, seed: Int = n): JSONObject {
    val entryId = ulid(n)
    val random = Random(seed)
    val declared = JSONArray()
    val files = JSONArray()
    for ((role, size) in roles) {
      val bytes = random.nextBytes(size)
      val file = File(dir, "$entryId-$role.bin").apply { writeBytes(bytes) }
      val mimetype = when {
        role == "preview" -> "image/jpeg"
        kind == "photo" -> "image/jpeg"
        kind == "voice" -> "audio/mp4"
        else -> "video/mp4"
      }
      declared.put(JSONObject().put("role", role).put("mimetype", mimetype).put("bytes", size).put("sha256Hex", sha256Hex(bytes)))
      files.put(JSONObject().put("role", role).put("uri", file.toURI().toString().replace("file:/", "file:///")))
    }
    val entry = JSONObject()
      .put("schema", 1)
      .put("entryId", entryId)
      .put("source", "app")
      .put("kind", kind)
      .put("occurredAt", "2026-11-20T10:00:00.000Z")
      .put("tz", "Asia/Ho_Chi_Minh")
      .put("files", declared)
      .put("client", JSONObject().put("app", "test").put("platform", "android"))
    when (kind) {
      "text" -> entry.put("text", JSONObject().put("body", "Hallo").put("bgArgb", 0xff7a5cfaL).put("textArgb", 0xffffffffL).put("font", "SYSTEM"))
      "photo" -> entry.put("media", JSONObject().put("width", 1600).put("height", 1200))
      "video" -> entry.put("media", JSONObject().put("width", 1920).put("height", 1080).put("seconds", 12.5))
      "voice" -> entry.put("media", JSONObject().put("seconds", 8))
    }
    return JSONObject().put("entryId", entryId).put("entry", entry).put("files", files).apply { if (mode != null) put("mode", mode) }
  }
}
