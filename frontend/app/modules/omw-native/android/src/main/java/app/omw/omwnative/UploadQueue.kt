package app.omw.omwnative

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI

/**
 * The job operations behind the JS API (enqueue, cancel, withdraw, uploadNow, status), without
 * Android types so the JVM tests use them as the bridge does. Scheduling is the caller's business.
 *
 * Withdrawals (Undo, Remove) live in their own store next to the jobs ([withdrawals], one record
 * per entryId: requestedAt, delete = a DELETE /app/entries/{id} is owed, doneAt once the API
 * answered). The engine sends owed ones before any upload. A record also refuses a later enqueue
 * of the same id, so an enqueue that races her Undo can never upload the undone moment.
 */
class UploadQueue(
  private val store: UploadJobStore,
  private val clock: Clock,
  private val withdrawals: UploadJobStore = store.sibling(WITHDRAWALS_DIR),
) {
  /**
   * Validates and stores a job (API.md "UploadJob"); returns its status. Idempotent per entryId:
   * the same entry again keeps the job as it is (transfer state and status; only a changed `mode`
   * is applied while it still waits), except a job that failed for good, which starts again
   * ("Try again", [restart]); a changed entry starts over (the API then answers entry_conflict
   * when it already had the old one, so the app sends a changed moment under a new id).
   * Refused for an id that was withdrawn.
   */
  fun enqueue(input: JSONObject, settings: UploadSettings): JSONObject = synchronized(LOCK) { enqueueLocked(input, settings) }

  private fun enqueueLocked(input: JSONObject, settings: UploadSettings): JSONObject {
    val entryId = input.optString("entryId")
    require(UploadJobStore.ULID.matches(entryId)) { "entryId must be a ULID" }
    check(withdrawals.get(entryId) == null) { "entry $entryId was withdrawn; a moment shared again gets a new id" }
    // JS `undefined` may arrive as null; AppEntry has no nullable field, so null means "absent".
    val entry = (input.optJSONObject("entry") ?: throw IllegalArgumentException("entry is required")).let { withoutNulls(it) as JSONObject }
    require(entry.optString("entryId") == entryId) { "entry.entryId must equal entryId" }
    val mode = input.optString("mode").takeIf { it.isNotEmpty() && it != "null" }
    require(mode == null || mode == "auto" || mode == "manual") { "mode must be auto or manual" }
    // The same entry again (e.g. the outbox replays its effects at app start): keep the job, even
    // when its files are already gone after the upload.
    val old = store.get(entryId)?.let(::UploadJob)
    if (old != null && canonical(old.enqueuedEntry) == canonical(entry) && old.status != null) {
      return if (old.failed) restart(old, mode, settings) else keep(old, mode, settings)
    }
    val files = input.optJSONArray("files") ?: JSONArray()
    val local = HashMap<String, String>()
    for (i in 0 until files.length()) {
      val f = files.getJSONObject(i)
      val role = f.optString("role")
      require(role in UploadJob.ROLE_ORDER) { "files[$i].role is invalid" }
      require(local.put(role, f.optString("uri")) == null) { "files[$i].role is duplicated" }
      require(f.optString("uri").startsWith("file://")) { "files[$i].uri must be a file:// URI" }
    }
    val declared = entry.optJSONArray("files") ?: JSONArray()
    val declaredRoles = HashSet<String>()
    for (i in 0 until declared.length()) {
      val d = declared.getJSONObject(i)
      val role = d.optString("role")
      require(role in UploadJob.ROLE_ORDER && declaredRoles.add(role)) { "entry.files[$i].role is invalid or duplicated" }
      val bytes = d.optLong("bytes", -1)
      require(bytes > 0) { "entry.files[$i].bytes must be positive" }
      val uri = local[role] ?: throw IllegalArgumentException("no local file for role $role")
      val file = runCatching { File(URI(uri)) }.getOrNull() ?: throw IllegalArgumentException("files: bad URI for $role")
      require(file.isFile) { "the $role file does not exist" }
      require(file.length() == bytes) { "the $role file has ${file.length()} bytes, the entry declares $bytes" }
    }
    require(local.keys.all { it in declaredRoles }) { "files has a role that entry.files does not declare" }

    val job = JSONObject()
      .put("entryId", entryId)
      .put("entry", entry)
      .put("files", files)
      .put("mode", mode ?: JSONObject.NULL)
    val status = initialStatus(UploadJob(job), (mode ?: settings.mode) == "manual")
    job.put("status", status)
    store.put(job)
    return status
  }

  /** The status of a job that waits for its first (or next) run. */
  private fun initialStatus(view: UploadJob, manual: Boolean): JSONObject {
    val primary = view.primaryRoles
    val original = if (view.hasOriginal) {
      JSONObject().put("state", if (view.originalFailed) "failed" else "queued").put("blockedBy", JSONObject.NULL)
        .put("sentBytes", view.sentBytes(listOf(UploadRules.ROLE_ORIGINAL)))
        .put("totalBytes", view.declaredBytes(UploadRules.ROLE_ORIGINAL))
        .put("error", view.transfer.optJSONObject("originalError") ?: JSONObject.NULL)
    } else {
      null
    }
    return UploadJob.status(
      view.entryId,
      if (manual) "waiting" else "queued",
      view.sentBytes(primary),
      view.totalBytes(primary),
      if (manual) "manual" else null,
      null,
      clock.nowMs(),
      original,
    )
  }

  /**
   * "Try again" on a job that failed for good: the failure and its counters are cleared so the
   * engine takes the job up again. When the API has no usable entry for it any more (not_found,
   * gone, rejected) or would not take it under this id (forbidden, entry_conflict, a protocol
   * error), the entry is created again from scratch; otherwise (e.g. three sha256 mismatches) the
   * engine asks for the offsets first. The app sends moments the API refuses under this id with a
   * new id instead (API.md "Try again"); this keeps an enqueue of the same entry from ever being
   * a silent no-op.
   */
  private fun restart(old: UploadJob, mode: String?, settings: UploadSettings): JSONObject {
    val code = old.status?.optJSONObject("error")?.optString("code")
    val written = store.update(old.entryId) { json ->
      json.put("mode", mode ?: JSONObject.NULL)
      val job = UploadJob(json)
      val t = job.transfer
      t.remove("failed")
      t.put("shaMismatches", 0).put("notFound", 0)
      if (code in RECREATE_CODES) {
        t.put("created", false)
        t.remove("slots")
      } else {
        val slots = t.optJSONObject("slots")
        slots?.keys()?.forEach { role -> slots.optJSONObject(role)?.takeIf { !it.optBoolean("committed") }?.put("inFlight", true) }
      }
      json.put("status", initialStatus(job, (mode ?: settings.mode) == "manual" && !job.manualReleased))
    }
    return written?.optJSONObject("status") ?: old.status!!
  }

  /** The same entry again: keep the job; a new `mode` only changes a job that has not started. */
  private fun keep(old: UploadJob, mode: String?, settings: UploadSettings): JSONObject {
    val status = old.status!!
    if (mode == old.mode || old.failed || old.done) return status
    val written = store.update(old.entryId) { json ->
      json.put("mode", mode ?: JSONObject.NULL)
      val manual = (mode ?: settings.mode) == "manual" && !UploadJob(json).manualReleased
      val s = json.optJSONObject("status") ?: return@update
      val state = s.optString("state")
      if (manual && (state == "queued" || state == "waiting")) {
        s.put("state", "waiting").put("blockedBy", "manual").put("updatedAt", UploadJob.isoNow(clock.nowMs()))
      } else if (!manual && state == "waiting" && s.optString("blockedBy") == "manual") {
        s.put("state", "queued").put("blockedBy", JSONObject.NULL).put("updatedAt", UploadJob.isoNow(clock.nowMs()))
      }
    }
    return written?.optJSONObject("status") ?: status
  }

  /** Forgets the job; returns its "cancelled" status, or null when it was unknown. */
  fun cancel(entryId: String): JSONObject? = synchronized(LOCK) {
    if (!UploadJobStore.ULID.matches(entryId)) return null
    val job = store.get(entryId)?.let(::UploadJob) ?: return null
    store.remove(entryId)
    cancelled(job)
  }

  private fun cancelled(job: UploadJob): JSONObject {
    val primary = job.primaryRoles
    return UploadJob.status(job.entryId, "cancelled", job.sentBytes(primary), job.totalBytes(primary), null, null, clock.nowMs(), null)
  }

  /**
   * She took a shared moment back (Undo, or Remove of one that needs her): the job is forgotten
   * and the withdrawal is recorded durably. A DELETE /app/entries/{entryId} is owed unless the
   * job provably never reached the API (no create was ever sent); when there is no job at all
   * (never enqueued, or pruned long after its upload) it is owed too: the API answers 404 when it
   * has nothing. Idempotent: the same id again changes nothing.
   */
  fun withdraw(entryId: String): Withdrawal = synchronized(LOCK) {
    require(UploadJobStore.ULID.matches(entryId)) { "entryId must be a ULID" }
    withdrawals.get(entryId)?.let { return Withdrawal(it.optBoolean("delete") && !it.has("doneAt"), null) }
    val job = store.get(entryId)?.let(::UploadJob)
    val owed = job == null || job.createSent
    val now = clock.nowMs()
    val record = JSONObject().put("entryId", entryId).put("requestedAt", now).put("delete", owed)
    if (!owed) record.put("doneAt", now)
    withdrawals.put(record)
    if (job != null) store.remove(entryId)
    Withdrawal(owed, job?.let(::cancelled))
  }

  /** What [withdraw] did: whether a DELETE is owed, and the cancelled status of the job it removed. */
  data class Withdrawal(val deleteOwed: Boolean, val cancelled: JSONObject?)

  /** Withdrawals whose DELETE is still owed (the engine sends them first). */
  fun pendingWithdrawals(): List<String> =
    withdrawals.all().filter { it.optBoolean("delete") && !it.has("doneAt") }.map { it.getString("entryId") }

  /**
   * "Upload now": lifts the manual block of one job or of every unfinished job; with
   * [allowMetered] ("Upload anyway" on mobile data) those entries may also use mobile data
   * (never their originals). Returns how many jobs it affected.
   */
  fun uploadNow(entryId: String?, allowMetered: Boolean): Int {
    var count = 0
    for (json in store.all()) {
      val job = UploadJob(json)
      if (entryId != null && job.entryId != entryId) continue
      if (job.failed || job.done) continue
      store.update(job.entryId) { j ->
        val t = UploadJob(j).transfer
        t.put("manualReleased", true)
        if (allowMetered) t.put("allowMetered", true)
      } ?: continue
      count++
    }
    return count
  }

  fun statuses(entryId: String?): List<JSONObject> =
    store.all().filter { entryId == null || it.optString("entryId") == entryId }.mapNotNull { it.optJSONObject("status") }

  /**
   * Removes jobs finished more than [maxAgeMs] ago (their status is in the server's hands then),
   * and withdrawals answered that long ago (a racing enqueue comes within seconds, not days).
   */
  fun prune(maxAgeMs: Long = PRUNE_AFTER_MS): Int = synchronized(LOCK) {
    val now = clock.nowMs()
    var removed = 0
    for (json in store.all()) {
      val doneAt = json.optJSONObject("transfer")?.optLong("doneAt", 0) ?: 0
      if (doneAt > 0 && now - doneAt > maxAgeMs && store.remove(json.getString("entryId"))) removed++
    }
    for (json in withdrawals.all()) {
      val doneAt = json.optLong("doneAt", 0)
      if (doneAt > 0 && now - doneAt > maxAgeMs && withdrawals.remove(json.getString("entryId"))) removed++
    }
    removed
  }

  companion object {
    const val PRUNE_AFTER_MS = 7L * 24 * 3600 * 1000
    const val WITHDRAWALS_DIR = "omw-withdrawals"

    /** Errors after which "Try again" creates the entry again instead of continuing its slots. */
    val RECREATE_CODES = setOf("not_found", "gone", "rejected", "forbidden", "entry_conflict", "protocol")

    /** enqueue, cancel and withdraw of the bridge run on several threads: one at a time. */
    private val LOCK = Any()

    /** A copy of [value] without null members (JSONObject.NULL), recursively. */
    fun withoutNulls(value: Any?): Any? = when (value) {
      is JSONObject -> JSONObject().also { out ->
        for (k in value.keys()) {
          val v = value.opt(k)
          if (v != null && v != JSONObject.NULL) out.put(k, withoutNulls(v))
        }
      }
      is JSONArray -> JSONArray().also { out ->
        for (i in 0 until value.length()) out.put(withoutNulls(value.opt(i)) ?: JSONObject.NULL)
      }
      else -> value
    }

    /** Key-sorted JSON (Android's org.json has no similar()). */
    fun canonical(value: Any?): String = when (value) {
      null, JSONObject.NULL -> "null"
      is JSONObject -> value.keys().asSequence().sorted().joinToString(",", "{", "}") { k -> JSONObject.quote(k) + ":" + canonical(value.opt(k)) }
      is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.opt(it)) }
      is String -> JSONObject.quote(value)
      is Number -> if (value.toDouble() == value.toLong().toDouble()) value.toLong().toString() else value.toString()
      else -> value.toString()
    }
  }
}
