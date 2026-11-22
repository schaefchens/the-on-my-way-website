package app.omw.omwnative

import app.omw.omwnative.UploadRules.ROLE_MEDIA
import app.omw.omwnative.UploadRules.ROLE_ORIGINAL
import app.omw.omwnative.UploadRules.ROLE_PREVIEW
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.time.Instant

/**
 * Typed access to one job file (UploadJobStore). Layout:
 *
 *   entryId, entry (AppEntry), files [{role, uri}], mode? ("auto" | "manual")
 *   status    the last reported UploadStatus (see API.md)
 *   transfer  createSent (a create went out at least once: the API may have the entry, even when
 *             its answer was lost), created, slots {role: {uploadId, bytes, offset, committed, inFlight}}, chunkMin,
 *             chunkMax, manualReleased, allowMetered, failed, originalFailed, originalError,
 *             originalDropped + originalBytes (the API refused the original as too large at
 *             create: the entry went on without it), shaMismatches, notFound, doneAt
 *   enqueued  the entry exactly as JS enqueued it (set when [entry] was changed natively, i.e.
 *             after dropping the original), so a re-enqueue of the same entry is recognised
 *
 * "inFlight" is set before a PATCH and cleared by its answer: a job found with it set after a
 * crash asks the server for the offset (HEAD) once, instead of before every chunk.
 */
class UploadJob(val json: JSONObject) {
  val entryId: String get() = json.getString("entryId")
  val entry: JSONObject get() = json.getJSONObject("entry")
  val kind: String get() = entry.optString("kind")
  val mode: String? get() = json.optString("mode").takeIf { it == "auto" || it == "manual" }

  val transfer: JSONObject
    get() = json.optJSONObject("transfer") ?: JSONObject().also { json.put("transfer", it) }

  val status: JSONObject? get() = json.optJSONObject("status")

  /** Roles declared in entry.files, in upload order (media, preview, original). */
  val declaredRoles: List<String>
    get() {
      val files = entry.optJSONArray("files") ?: JSONArray()
      val roles = (0 until files.length()).map { files.getJSONObject(it).optString("role") }.toSet()
      return ROLE_ORDER.filter { it in roles }
    }

  val primaryRoles: List<String> get() = declaredRoles.filter { it != ROLE_ORIGINAL }

  /** True when the entry has (or had, see originalDropped) a private original. */
  val hasOriginal: Boolean get() = ROLE_ORIGINAL in declaredRoles || originalDropped

  /** The API refused the original at create (413): the entry was created without it. */
  val originalDropped: Boolean get() = transfer.optBoolean("originalDropped")

  /** The entry as JS enqueued it (differs from [entry] only after the original was dropped). */
  val enqueuedEntry: JSONObject get() = json.optJSONObject("enqueued") ?: entry

  fun declaredBytes(role: String): Long {
    if (role == ROLE_ORIGINAL && originalDropped) return transfer.optLong("originalBytes")
    val files = entry.optJSONArray("files") ?: return 0
    for (i in 0 until files.length()) {
      val f = files.getJSONObject(i)
      if (f.optString("role") == role) return f.optLong("bytes", 0)
    }
    return 0
  }

  fun localFile(role: String): File? {
    val files = json.optJSONArray("files") ?: return null
    for (i in 0 until files.length()) {
      val f = files.getJSONObject(i)
      if (f.optString("role") == role) return runCatching { File(URI(f.getString("uri"))) }.getOrNull()
    }
    return null
  }

  val created: Boolean get() = transfer.optBoolean("created")
  val createSent: Boolean get() = transfer.optBoolean("createSent") || created
  val failed: Boolean get() = transfer.optBoolean("failed")
  val originalFailed: Boolean get() = transfer.optBoolean("originalFailed")
  val manualReleased: Boolean get() = transfer.optBoolean("manualReleased")
  val allowMetered: Boolean get() = transfer.optBoolean("allowMetered")

  fun slot(role: String): JSONObject? = transfer.optJSONObject("slots")?.optJSONObject(role)

  fun committed(role: String): Boolean = slot(role)?.optBoolean("committed") == true

  val primaryDone: Boolean get() = created && primaryRoles.all { committed(it) }
  val originalDone: Boolean get() = !hasOriginal || committed(ROLE_ORIGINAL) || originalFailed
  val done: Boolean get() = primaryDone && originalDone

  /** Bytes the server holds of [roles] (committed or offset). */
  fun sentBytes(roles: List<String>): Long = roles.sumOf { role ->
    val s = slot(role) ?: return@sumOf 0L
    if (s.optBoolean("committed")) s.optLong("bytes") else s.optLong("offset")
  }

  fun totalBytes(roles: List<String>): Long = roles.sumOf { declaredBytes(it) }

  /** Bytes still to send (for setEstimatedNetworkBytes and the notification). */
  fun pendingBytes(includeOriginal: Boolean): Long {
    val roles = if (includeOriginal) declaredRoles else primaryRoles
    return (totalBytes(roles) - sentBytes(roles)).coerceAtLeast(0)
  }

  companion object {
    val ROLE_ORDER = listOf(ROLE_MEDIA, ROLE_PREVIEW, ROLE_ORIGINAL)

    fun isoNow(nowMs: Long): String = Instant.ofEpochMilli(nowMs).toString()

    fun error(code: String, message: String, permanent: Boolean): JSONObject =
      JSONObject().put("code", code).put("message", message).put("permanent", permanent)

    /** The UploadStatus JSON of API.md. */
    fun status(
      entryId: String,
      state: String,
      sentBytes: Long,
      totalBytes: Long,
      blockedBy: String?,
      error: JSONObject?,
      nowMs: Long,
      original: JSONObject?,
    ): JSONObject = JSONObject()
      .put("entryId", entryId)
      .put("state", state)
      .put("sentBytes", sentBytes)
      .put("totalBytes", totalBytes)
      .put("blockedBy", blockedBy ?: JSONObject.NULL)
      .put("error", error ?: JSONObject.NULL)
      .put("updatedAt", isoNow(nowMs))
      .put("original", original ?: JSONObject.NULL)

    /** Same status apart from updatedAt (decides whether to persist). */
    fun sameStatus(a: JSONObject?, b: JSONObject): Boolean = a != null && signature(a, true) == signature(b, true)

    /** Same state, block and error (decides whether to emit onUploadStateChange). */
    fun sameState(a: JSONObject?, b: JSONObject): Boolean = a != null && signature(a, false) == signature(b, false)

    private fun signature(s: JSONObject, bytes: Boolean): String {
      fun err(o: JSONObject?) = o?.let { "${it.optString("code")}|${it.optBoolean("permanent")}" } ?: "-"
      val o = s.optJSONObject("original")
      val orig = o?.let {
        val b = if (bytes) "${it.optLong("sentBytes")}|${it.optLong("totalBytes")}" else ""
        "${it.optString("state")}|${it.opt("blockedBy")}|$b|${err(it.optJSONObject("error"))}"
      } ?: "-"
      return listOf(
        s.optString("state"),
        "${s.opt("blockedBy")}",
        if (bytes) "${s.optLong("sentBytes")}|${s.optLong("totalBytes")}" else "",
        err(s.optJSONObject("error")),
        orig,
      ).joinToString(";")
    }
  }
}
