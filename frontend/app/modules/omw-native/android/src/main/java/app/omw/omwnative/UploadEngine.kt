package app.omw.omwnative

import app.omw.omwnative.UploadRules.ROLE_MEDIA
import app.omw.omwnative.UploadRules.ROLE_ORIGINAL
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/** What an uploader run reads from the world. Android supplies the real one, tests a fake. */
interface UploadEnvironment {
  val clock: Clock

  fun network(): NetworkSnapshot

  fun settings(): UploadSettings

  /** The app token (TokenVault), null when not paired. */
  fun token(): String?

  /** The API base (Uploader.configure), null when not configured. */
  fun baseUrl(): HttpUrl?
}

/** Events of a run (forwarded to JS while the app runs; the job files hold the truth anyway). */
interface UploadListener {
  fun onState(status: JSONObject) {}

  fun onProgress(entryId: String, role: String, sentBytes: Long, totalBytes: Long) {}
}

sealed class RunOutcome {
  /** Nothing left that could run: all uploaded, failed, or waiting for "Upload now". */
  object Done : RunOutcome()

  /** Work is left that needs another network (Wi-Fi, no roaming, any connection). */
  object WaitNetwork : RunOutcome()

  /** Work is left after a backoff, Retry-After or a captive portal: run again at [atMs]. */
  data class RetryAt(val atMs: Long) : RunOutcome()

  /** The system or a cancel stopped the run; the next run continues where this one stopped. */
  object Stopped : RunOutcome()

  /** The run's time budget is used up (WorkManager runs ~9 min); continue in a new run. */
  object Deadline : RunOutcome()

  /** No token, not configured, or the token was refused: nothing runs until a new token is set. */
  object Unauthorized : RunOutcome()

  /** Another run is active in this process; it picks up new work by itself. */
  object Busy : RunOutcome()

  override fun toString(): String = this::class.simpleName ?: "RunOutcome"
}

/**
 * The native uploader's engine (app-plan §6.2): for each job in the outbox, oldest first,
 * POST /app/entries → PATCH chunks (tus, sha256 per chunk, adaptive size) → POST …/commit for
 * media (+ preview), then the original the same way, separately and only on unmetered networks.
 *
 * Order of the work: withdrawals she asked for (DELETE /app/entries/{id}, Undo and Remove) come
 * first; then the media and previews of every moment, oldest first; an original's chunks only go
 * while no moment's media or preview can be sent (A5: the WhatsApp-sized version first, originals
 * later), so a large original never holds back today's moments.
 *
 * - One request at a time across all jobs; every request takes a [RequestBudget] slot (≤ 10 per
 *   10 s); any error pauses the whole host ([UploadThrottle]); HEAD only after a failure.
 * - All transfer state is written to the job file before and after each request, so a new
 *   process (after death, a reboot or a force-stop and the next app open) resumes from the offset.
 * - Before each request the A4 rules are checked against the current network ([UploadRules]).
 * - Pure JVM (OkHttp + org.json + java.io), so MockWebServer tests drive it directly.
 */
class UploadEngine(
  private val store: UploadJobStore,
  private val env: UploadEnvironment,
  private val budget: RequestBudget,
  private val throttle: UploadThrottle,
  private val state: KeyValueStore,
  private val listener: UploadListener = object : UploadListener {},
  private val http: OkHttpClient = TusClient.httpClient(),
  /** Backoffs up to this long are waited out inside the run instead of ending it. */
  private val inlineWaitMaxMs: Long = 60_000,
  /** How long a run keeps polling a network without NET_CAPABILITY_VALIDATED. */
  private val notValidatedWaitMs: Long = 60_000,
  /** Withdrawals she asked for (UploadQueue.withdraw); a store next to the jobs by default. */
  private val withdrawals: UploadJobStore = store.sibling(UploadQueue.WITHDRAWALS_DIR),
) {
  private val clock = env.clock
  private var buffer = ByteArray(0)

  enum class Action { CREATE, HEAD, PATCH, COMMIT, WITHDRAW }

  data class Step(val entryId: String, val action: Action, val roles: List<String>) {
    /** A step for the moment itself (media, preview or the create), not for its private original. */
    val primary: Boolean get() = action != Action.WITHDRAW && ROLE_ORIGINAL !in roles
  }

  private class Candidate(val job: UploadJob, val step: Step, val block: String?)

  /** The queue as the rules see it right now (also used by the scheduler, without running). */
  class Evaluation(
    val next: Step?,
    /** Needs of the jobs that wait for another network. */
    val needs: Set<NetNeed>,
    /** Needs of every job that could run (not manual, failed or unauthorized): the job constraint. */
    val runNeeds: Set<NetNeed>,
    val retryAt: Long?,
    val notValidated: Boolean,
    val unauthorized: Boolean,
    /** Bytes still to send by jobs that are not finished, failed or manual. */
    val pendingBytes: Long,
    /** Jobs that are not finished or failed (for the notification text). */
    val activeJobs: Int,
  ) {
    val weakestNeed: NetNeed? get() = UploadRules.weakest(needs)
  }

  fun run(stop: StopSignal, deadlineMs: Long = Long.MAX_VALUE): RunOutcome {
    if (!RUNNING.compareAndSet(false, true)) return RunOutcome.Busy
    activeStop = stop
    try {
      return loop(stop, deadlineMs)
    } finally {
      activeStop = null
      activeClient = null
      activeEntryId = null
      RUNNING.set(false)
    }
  }

  private fun loop(stop: StopSignal, deadlineMs: Long): RunOutcome {
    var client: TusClient? = null
    var clientKey: String? = null
    var notValidatedSince = 0L
    while (true) {
      if (stop.stopped) return RunOutcome.Stopped
      val now = clock.nowMs()
      if (now >= deadlineMs) return RunOutcome.Deadline
      val ev = evaluate(running = true)
      val step = ev.next
      if (step == null) {
        if (ev.retryAt != null) {
          val wait = ev.retryAt - now
          if (wait <= inlineWaitMaxMs && ev.retryAt < deadlineMs) {
            if (!stop.sleep(wait)) return RunOutcome.Stopped
            continue
          }
          return RunOutcome.RetryAt(ev.retryAt)
        }
        if (ev.notValidated) {
          if (notValidatedSince == 0L) notValidatedSince = now
          if (now - notValidatedSince < notValidatedWaitMs) {
            if (!stop.sleep(POLL_MS)) return RunOutcome.Stopped
            continue
          }
          return RunOutcome.RetryAt(now + NOT_VALIDATED_RETRY_MS)
        }
        if (ev.needs.isNotEmpty()) return RunOutcome.WaitNetwork
        if (ev.unauthorized) return RunOutcome.Unauthorized
        return RunOutcome.Done
      }
      notValidatedSince = 0L
      val token = env.token()
      val base = env.baseUrl()
      if (token == null || base == null) return RunOutcome.Unauthorized
      val key = "$base|${sha256Hex(token)}"
      if (client == null || key != clientKey) {
        client = TusClient(http, base, token, budget, clock, state)
        clientKey = key
      }
      activeClient = client
      activeEntryId = step.entryId
      val outcome = execute(step, client, stop, token)
      activeEntryId = null
      if (outcome != null) return outcome
    }
  }

  // ---- evaluation ---------------------------------------------------------------------------

  /**
   * Computes every job's status for the current network and settings, persists changed ones
   * (emitting onState for real changes) and picks the first step that may run now.
   * [running]: the picked job is reported as uploading/committing (a run is about to send it).
   */
  fun evaluate(running: Boolean = false): Evaluation {
    val net = env.network()
    val settings = env.settings()
    val auth = authProblem()
    val throttled = throttle.isBlocked()
    var next: Step? = null
    val needs = mutableSetOf<NetNeed>()
    val runNeeds = mutableSetOf<NetNeed>()
    var retryAt: Long? = null
    var notValidated = false
    var unauthorized = false
    var pendingBytes = 0L
    var activeJobs = 0
    // Withdrawals: her own tap, a request of a few hundred bytes. Never held for "Upload now" or
    // Wi-Fi only; roaming and the host's backoff still apply, like to a text status.
    for (w in withdrawals.all()) {
      if (!w.optBoolean("delete") || w.has("doneAt")) continue
      val ruleBlock = if (auth != null) null else UploadRules.block(WITHDRAW_KIND, ROLE_MEDIA, net, settings, allowMetered = true)
      val need = UploadRules.need(WITHDRAW_KIND, ROLE_MEDIA, settings, allowMetered = true, simOperator = net.simOperator)
      if (auth == null) runNeeds += need
      when {
        auth != null -> unauthorized = true
        ruleBlock == "not_validated" -> notValidated = true
        ruleBlock != null -> needs += need
        throttled -> retryAt = minOf(retryAt ?: Long.MAX_VALUE, throttle.blockedUntil())
        next == null -> next = Step(w.getString("entryId"), Action.WITHDRAW, emptyList())
      }
    }
    val candidates = mutableListOf<Candidate>()
    for (json in store.all()) {
      val job = UploadJob(json)
      if (job.failed) continue
      if (job.done) {
        writeStatus(job, null, null, null) // the final "uploaded" (once; unchanged statuses are not rewritten)
        continue
      }
      activeJobs++
      val step = nextStep(job) ?: continue
      val role = step.roles.first()
      val manual = (job.mode ?: settings.mode) == "manual" && !job.manualReleased
      val ruleBlock = if (manual || auth != null) null else UploadRules.block(job.kind, role, net, settings, job.allowMetered)
      val block = when {
        manual -> "manual"
        auth != null -> "unauthorized"
        ruleBlock != null -> ruleBlock
        throttled -> throttle.reason
        else -> null
      }
      if (block != "manual" && block != "unauthorized") {
        runNeeds += UploadRules.need(job.kind, role, settings, job.allowMetered, net.simOperator)
      }
      when {
        block == null -> Unit // a candidate for the next step (below)
        block == "manual" -> Unit
        block == "unauthorized" -> unauthorized = true
        ruleBlock == null -> retryAt = minOf(retryAt ?: Long.MAX_VALUE, throttle.blockedUntil()) // host backoff
        ruleBlock == "not_validated" -> notValidated = true
        else -> needs += UploadRules.need(job.kind, role, settings, job.allowMetered, net.simOperator)
      }
      if (block != "manual") pendingBytes += job.pendingBytes(includeOriginal = true)
      candidates += Candidate(job, step, block)
    }
    // The oldest moment's media or preview first; an original only when no moment's can go now.
    if (next == null) {
      next = candidates.firstOrNull { it.block == null && it.step.primary }?.step
        ?: candidates.firstOrNull { it.block == null }?.step
    }
    for (c in candidates) writeStatus(c.job, c.block, auth, if (running && next === c.step) c.step.action else null)
    return Evaluation(next, needs, runNeeds, retryAt, notValidated, unauthorized, pendingBytes, activeJobs)
  }

  /** The next request for [job], or null when it is finished or failed. */
  fun nextStep(job: UploadJob): Step? {
    if (job.failed || job.done) return null
    if (!job.created) return Step(job.entryId, Action.CREATE, listOf(job.primaryRoles.firstOrNull() ?: ROLE_MEDIA))
    val phase = if (!job.primaryDone) job.primaryRoles.filter { !job.committed(it) } else listOf(ROLE_ORIGINAL)
    for (role in phase) {
      val slot = job.slot(role) ?: return Step(job.entryId, Action.CREATE, listOf(role))
      if (slot.optBoolean("inFlight")) return Step(job.entryId, Action.HEAD, listOf(role))
      if (slot.optLong("offset") < slot.optLong("bytes")) return Step(job.entryId, Action.PATCH, listOf(role))
    }
    return Step(job.entryId, Action.COMMIT, phase)
  }

  /** null, or why no request may be sent: "not_configured", "not_paired", "token_revoked", "unauthorized". */
  private fun authProblem(): String? {
    if (env.baseUrl() == null) return "not_configured"
    val token = env.token() ?: return "not_paired"
    if (state.get(KEY_REJECTED_TOKEN) == sha256Hex(token)) return state.get(KEY_REJECTED_CODE) ?: "unauthorized"
    return null
  }

  private fun writeStatus(job: UploadJob, block: String?, auth: String?, active: Action?) {
    val now = clock.nowMs()
    val authError = if (block == "unauthorized") {
      UploadJob.error(auth ?: "unauthorized", AUTH_MESSAGES[auth] ?: "The API refused the app token.", permanent = true)
    } else {
      null
    }
    val primary = job.primaryRoles
    val (state, blockedBy, error) = when {
      job.primaryDone -> Triple("uploaded", null, null)
      active == Action.COMMIT -> Triple("committing", null, null)
      active != null -> Triple("uploading", null, null)
      block == "unauthorized" -> Triple("failed", "unauthorized", authError)
      block != null -> Triple("waiting", block, null)
      else -> Triple("queued", null, null)
    }
    val original = if (!job.hasOriginal) {
      null
    } else {
      val (oState, oBlock, oError) = when {
        job.committed(ROLE_ORIGINAL) -> Triple("uploaded", null, null)
        job.originalFailed -> Triple("failed", null, job.transfer.optJSONObject("originalError"))
        !job.primaryDone -> Triple("queued", null, null)
        active != null -> Triple("uploading", null, null)
        block == "unauthorized" -> Triple("failed", "unauthorized", authError)
        block != null -> Triple("waiting", block, null)
        else -> Triple("queued", null, null)
      }
      JSONObject()
        .put("state", oState)
        .put("blockedBy", oBlock ?: JSONObject.NULL)
        .put("sentBytes", job.sentBytes(listOf(ROLE_ORIGINAL)))
        .put("totalBytes", job.declaredBytes(ROLE_ORIGINAL))
        .put("error", oError ?: JSONObject.NULL)
    }
    val status = UploadJob.status(job.entryId, state, job.sentBytes(primary), job.totalBytes(primary), blockedBy, error, now, original)
    putStatus(job.entryId, status)
  }

  /** Persists [status] when it changed; emits onState when state, block or error changed. */
  private fun putStatus(entryId: String, status: JSONObject) {
    var emit = false
    store.updateIf(entryId) { json ->
      val old = json.optJSONObject("status")
      if (UploadJob.sameStatus(old, status)) return@updateIf false
      emit = !UploadJob.sameState(old, status)
      json.put("status", status)
      true
    }
    if (emit) listener.onState(status)
  }

  // ---- requests -------------------------------------------------------------------------------

  /** Runs one request. Returns an outcome to end the run, or null to go on. */
  private fun execute(step: Step, client: TusClient, stop: StopSignal, token: String): RunOutcome? {
    if (step.action == Action.WITHDRAW) return withdraw(step.entryId, client, stop, token)
    val job = store.get(step.entryId)?.let(::UploadJob) ?: return null // cancelled meanwhile
    return when (step.action) {
      Action.CREATE -> create(job, client, stop, token)
      Action.HEAD -> head(job, step.roles.first(), client, stop, token)
      Action.PATCH -> patch(job, step.roles.first(), client, stop, token)
      Action.COMMIT -> commit(job, step.roles, client, stop, token)
      Action.WITHDRAW -> null
    }
  }

  /**
   * DELETE /app/entries/{entryId} of a withdrawal. Done on 204, and on 404/410 (the API has
   * nothing, or nothing any more); other refusals (403: an entry of a phone this one is not)
   * end it too, since asking again cannot change them. No answer, 429 and 5xx wait like uploads.
   */
  private fun withdraw(entryId: String, client: TusClient, stop: StopSignal, token: String): RunOutcome? {
    val r = client.withdrawEntry(entryId, stop)
    if (r.ok || r.status == 404 || r.status == 410) {
      throttle.success()
      finishWithdrawal(entryId, r.status)
      return null
    }
    common(r, token)?.let { return it.outcome }
    if (r.status in 400..499) {
      finishWithdrawal(entryId, r.status)
      return null
    }
    return backoff("backoff", r)
  }

  private fun finishWithdrawal(entryId: String, status: Int) {
    withdrawals.update(entryId) { it.put("doneAt", clock.nowMs()).put("httpStatus", status) }
  }

  private fun create(job: UploadJob, client: TusClient, stop: StopSignal, token: String): RunOutcome? {
    // From here on the API may have the entry (even when the answer is lost): an Undo must withdraw it.
    if (!job.createSent) store.update(job.entryId) { UploadJob(it).transfer.put("createSent", true) } ?: return null
    val r = client.createEntry(job.entry, UploadJob.isoNow(clock.nowMs()), stop)
    if (r.ok) {
      val body = r.body ?: return protocolError(job, "create answered without a body")
      return applyEntryState(job, body)
    }
    common(r, token, job.entryId)?.let { return it.outcome }
    if (r.status == 413 && !job.created && ROLE_ORIGINAL in job.declaredRoles &&
      (r.errorDetails?.optString("role")?.takeIf { it.isNotEmpty() } ?: ROLE_ORIGINAL) == ROLE_ORIGINAL
    ) {
      return dropOriginal(job, r)
    }
    return when (r.status) {
      409, 413, 415, 422, 403 -> fail(job, r.errorCode ?: "http_${r.status}", r.errorMessage ?: "The API refused the entry.", phaseOf(job))
      else -> backoff("backoff", r)
    }
  }

  /**
   * 413 on create with an original declared: the API's inbox can't take a file that large
   * (AppHints.fileMaxBytes; nothing was stored). The moment itself must not wait for that, so the
   * entry goes on without its original, which stays on the phone ("failed", upload_too_large).
   * The entry as JS enqueued it is kept, so the same enqueue again is recognised.
   */
  private fun dropOriginal(job: UploadJob, r: ApiResult): RunOutcome? {
    val bytes = job.declaredBytes(ROLE_ORIGINAL)
    store.update(job.entryId) { json ->
      val j = UploadJob(json)
      if (!json.has("enqueued")) json.put("enqueued", JSONObject(j.entry.toString()))
      val files = j.entry.optJSONArray("files") ?: JSONArray()
      val kept = JSONArray()
      for (i in 0 until files.length()) files.optJSONObject(i)?.takeIf { it.optString("role") != ROLE_ORIGINAL }?.let(kept::put)
      j.entry.put("files", kept)
      val error = UploadJob.error(r.errorCode ?: "upload_too_large", r.errorMessage ?: "The original is too large for the API's inbox; it stays on the phone.", permanent = true)
      j.transfer.put("originalDropped", true).put("originalBytes", bytes).put("originalFailed", true).put("originalError", error)
    }
    return backoff("backoff", r)
  }

  /** Takes the slots of an AppEntryState (create and commit answers). */
  private fun applyEntryState(job: UploadJob, body: JSONObject): RunOutcome? {
    when (body.optString("state")) {
      "withdrawn" -> return fail(job, "gone", "The entry was withdrawn.", phaseOf(job))
      "rejected" -> return fail(job, "rejected", body.optString("rejectReason", "The home computer refused the entry."), phaseOf(job))
    }
    val uploads = body.optJSONArray("uploads") ?: JSONArray()
    val slots = JSONObject()
    for (i in 0 until uploads.length()) {
      val u = uploads.getJSONObject(i)
      val role = u.optString("role")
      if (role !in job.declaredRoles) continue
      if (u.optLong("bytes") != job.declaredBytes(role) || !TusClient.UPLOAD_ID.matches(u.optString("uploadId"))) {
        return protocolError(job, "slot for $role does not match the entry")
      }
      val old = job.slot(role)
      slots.put(
        role,
        JSONObject()
          .put("uploadId", u.getString("uploadId"))
          .put("bytes", u.getLong("bytes"))
          .put("offset", u.optLong("offset"))
          .put("committed", u.optBoolean("committed"))
          // Keep an unanswered PATCH marked: its slot is only trusted after a HEAD.
          .put("inFlight", old?.optString("uploadId") == u.getString("uploadId") && old.optBoolean("inFlight") && !u.optBoolean("committed")),
      )
    }
    if (job.declaredRoles.any { !slots.has(it) }) return protocolError(job, "missing upload slots")
    val chunk = body.optJSONObject("chunk")
    throttle.success()
    store.update(job.entryId) { json ->
      val t = UploadJob(json).transfer
      t.put("created", true).put("slots", slots).put("notFound", 0)
      if (chunk != null) t.put("chunkMin", chunk.optLong("minBytes")).put("chunkMax", chunk.optLong("maxBytes"))
      markDone(json)
    }
    return null
  }

  private fun head(job: UploadJob, role: String, client: TusClient, stop: StopSignal, token: String): RunOutcome? {
    val slot = job.slot(role) ?: return null
    val r = client.head(slot.getString("uploadId"), stop)
    if (r.ok && r.uploadOffset != null) {
      throttle.success()
      updateSlot(job.entryId, role) { it.put("offset", r.uploadOffset).put("inFlight", false) }
      return null
    }
    common(r, token, job.entryId)?.let { return it.outcome }
    return when (r.status) {
      404 -> slotLost(job)
      410 -> fail(job, "gone", "The entry was withdrawn.", phaseOf(job))
      403 -> fail(job, r.errorCode ?: "forbidden", r.errorMessage ?: "Not allowed.", phaseOf(job))
      else -> backoff("backoff", r)
    }
  }

  private fun patch(job: UploadJob, role: String, client: TusClient, stop: StopSignal, token: String): RunOutcome? {
    val slot = job.slot(role) ?: return null
    val file = job.localFile(role)
    val total = slot.getLong("bytes")
    if (file == null || !file.isFile) return fail(job, "file_missing", "The file of this moment is gone from the phone.", phaseOf(job))
    if (file.length() != total) return fail(job, "file_changed", "The file of this moment changed on the phone.", phaseOf(job))
    val offset = slot.getLong("offset")
    val min = job.transfer.optLong("chunkMin", ChunkSizer.MIN_BYTES).takeIf { it > 0 } ?: ChunkSizer.MIN_BYTES
    val max = job.transfer.optLong("chunkMax", ChunkSizer.MAX_BYTES).takeIf { it >= min } ?: ChunkSizer.MAX_BYTES
    val size = ChunkSizer.within(chunkBytes(), min, max)
    val length = minOf(size, total - offset).toInt()
    if (buffer.size < length) buffer = ByteArray(maxOf(length, ChunkSizer.START_BYTES.toInt()))
    try {
      RandomAccessFile(file, "r").use { raf ->
        raf.seek(offset)
        raf.readFully(buffer, 0, length)
      }
    } catch (e: java.io.IOException) {
      return fail(job, "file_unreadable", "The file of this moment can't be read.", phaseOf(job))
    }
    val checksum = TusClient.checksumHeader(buffer, length)
    updateSlot(job.entryId, role) { it.put("inFlight", true) }
    val r = client.patch(slot.getString("uploadId"), offset, buffer, length, checksum, stop)
    if (r.status == ApiResult.STOPPED) return RunOutcome.Stopped
    if (r.status == 204 || r.ok) {
      val newOffset = r.uploadOffset ?: (offset + length)
      setChunkBytes(ChunkSizer.next(size, ok = true, bytes = length.toLong(), ms = r.durationMs, minBytes = min, maxBytes = max))
      throttle.success()
      updateSlot(job.entryId, role) { it.put("offset", newOffset.coerceAtMost(total)).put("inFlight", false) }
      listener.onProgress(job.entryId, role, newOffset.coerceAtMost(total), total)
      return null
    }
    // The server answered, so nothing was half-appended (the contract appends whole chunks only).
    if (r.status != ApiResult.UNREACHABLE) updateSlot(job.entryId, role) { it.put("inFlight", false) }
    if (r.status == 409 && r.uploadOffset != null && r.uploadOffset != offset) {
      // Offset mismatch: continue from the server's offset, no backoff (the contract's exception).
      updateSlot(job.entryId, role) { it.put("offset", r.uploadOffset.coerceAtMost(total)) }
      return null
    }
    setChunkBytes(ChunkSizer.next(size, ok = false, minBytes = min, maxBytes = max))
    common(r, token, job.entryId)?.let { return it.outcome }
    return when (r.status) {
      404 -> slotLost(job)
      410 -> fail(job, "gone", "The entry was withdrawn.", phaseOf(job))
      403 -> fail(job, r.errorCode ?: "forbidden", r.errorMessage ?: "Not allowed.", phaseOf(job))
      415 -> fail(job, "unsupported_media_type", r.errorMessage ?: "The API refused the upload type.", phaseOf(job))
      413 -> {
        // Chunk above the server's limit: lower this entry's maximum, then retry after the backoff.
        val lowered = maxOf(min, (length / 2).toLong() / STEP * STEP)
        store.update(job.entryId) { UploadJob(it).transfer.put("chunkMax", lowered) }
        backoff("backoff", r)
      }
      409 -> {
        updateSlot(job.entryId, role) { it.put("inFlight", true) } // ask for the offset
        backoff("backoff", r)
      }
      else -> backoff("backoff", r) // 460 checksum mismatch, 4xx, …: resend the chunk later
    }
  }

  private fun commit(job: UploadJob, roles: List<String>, client: TusClient, stop: StopSignal, token: String): RunOutcome? {
    val r = client.commit(job.entryId, roles, stop)
    if (r.ok) {
      val body = r.body ?: return protocolError(job, "commit answered without a body")
      val uploads = body.optJSONArray("uploads") ?: JSONArray()
      val committed = (0 until uploads.length()).map { uploads.getJSONObject(it) }
        .filter { it.optBoolean("committed") }.map { it.optString("role") }.toSet()
      throttle.success()
      store.update(job.entryId) { json ->
        val j = UploadJob(json)
        for (role in roles) {
          val s = j.slot(role) ?: continue
          if (role in committed) s.put("committed", true).put("offset", s.optLong("bytes")) else s.put("inFlight", true)
        }
        markDone(json)
      }
      when (body.optString("state")) {
        "withdrawn" -> return fail(job, "gone", "The entry was withdrawn.", phaseOf(job))
        "rejected" -> return fail(job, "rejected", body.optString("rejectReason", "The home computer refused the entry."), phaseOf(job))
      }
      return null
    }
    common(r, token, job.entryId)?.let { return it.outcome }
    return when {
      r.status == 409 -> {
        // "incomplete": ask for the offsets, then upload the rest.
        roles.forEach { role -> updateSlot(job.entryId, role) { it.put("inFlight", true) } }
        backoff("backoff", r)
      }
      r.status == 422 && r.errorCode == "sha256_mismatch" -> {
        val count = job.transfer.optInt("shaMismatches") + 1
        store.update(job.entryId) { UploadJob(it).transfer.put("shaMismatches", count) }
        if (count >= MAX_SHA_MISMATCHES) {
          return fail(job, "sha256_mismatch", "The upload arrived damaged several times.", phaseOf(job))
        }
        // The server reset the slot to 0: ask for the offset and send it again.
        roles.forEach { role -> updateSlot(job.entryId, role) { it.put("inFlight", true) } }
        backoff("backoff", r)
      }
      r.status == 404 -> slotLost(job)
      r.status == 410 -> fail(job, "gone", "The entry was withdrawn.", phaseOf(job))
      r.status in setOf(403, 413, 415, 422) -> fail(job, r.errorCode ?: "http_${r.status}", r.errorMessage ?: "The API refused the upload.", phaseOf(job))
      else -> backoff("backoff", r)
    }
  }

  // ---- outcomes -------------------------------------------------------------------------------

  private class Handled(val outcome: RunOutcome?)

  /**
   * Answers every request type shares: stop, no answer, 401, 429, 503, 507, 5xx. [entryId]: a
   * request cut because its job was cancelled or withdrawn meanwhile is no network problem.
   */
  private fun common(r: ApiResult, token: String, entryId: String? = null): Handled? = when {
    r.status == ApiResult.STOPPED -> Handled(RunOutcome.Stopped)
    r.status == ApiResult.UNREACHABLE && entryId != null && store.get(entryId) == null -> Handled(null)
    r.status == ApiResult.UNREACHABLE -> Handled(backoff("no_network", r))
    r.status == 401 -> {
      state.put(KEY_REJECTED_TOKEN, sha256Hex(token))
      state.put(KEY_REJECTED_CODE, if (r.errorCode == "token_revoked") "token_revoked" else "unauthorized")
      evaluate()
      Handled(RunOutcome.Unauthorized)
    }
    r.status == 429 -> Handled(backoff("backoff", r))
    r.status == 503 -> Handled(backoff("server_busy", r))
    r.status == 507 -> Handled(backoff("inbox_full", r))
    r.status >= 500 -> Handled(backoff("backoff", r))
    else -> null
  }

  private fun backoff(reason: String, r: ApiResult): RunOutcome? {
    throttle.failure(reason, r.retryAfterMs)
    return null
  }

  private enum class Phase { PRIMARY, ORIGINAL }

  private fun phaseOf(job: UploadJob) = if (job.primaryDone) Phase.ORIGINAL else Phase.PRIMARY

  /** A permanent failure ("Needs you"). For the original, the entry itself stays uploaded. */
  private fun fail(job: UploadJob, code: String, message: String, phase: Phase): RunOutcome? {
    val now = clock.nowMs()
    val error = UploadJob.error(code, message, permanent = true)
    store.update(job.entryId) { json ->
      val j = UploadJob(json)
      if (phase == Phase.ORIGINAL) {
        j.transfer.put("originalFailed", true).put("originalError", error)
        markDone(json)
      } else {
        j.transfer.put("failed", true)
      }
    }
    if (phase == Phase.PRIMARY) {
      val fresh = store.get(job.entryId)?.let(::UploadJob) ?: return null
      val primary = fresh.primaryRoles
      val original = if (fresh.hasOriginal) {
        JSONObject().put("state", "failed").put("blockedBy", JSONObject.NULL)
          .put("sentBytes", fresh.sentBytes(listOf(ROLE_ORIGINAL))).put("totalBytes", fresh.declaredBytes(ROLE_ORIGINAL))
          .put("error", fresh.transfer.optJSONObject("originalError") ?: JSONObject.NULL)
      } else {
        null
      }
      putStatus(job.entryId, UploadJob.status(job.entryId, "failed", fresh.sentBytes(primary), fresh.totalBytes(primary), null, error, now, original))
    }
    return null
  }

  private fun protocolError(job: UploadJob, message: String): RunOutcome? =
    fail(job, "protocol", "Unexpected answer from the API: $message", phaseOf(job))

  /** 404 on a slot (expired after 72 h, or the API lost it): create the entry again (a replay). */
  private fun slotLost(job: UploadJob): RunOutcome? {
    val count = job.transfer.optInt("notFound") + 1
    if (count > MAX_NOT_FOUND) return fail(job, "not_found", "The API no longer knows this upload.", phaseOf(job))
    store.update(job.entryId) { json -> UploadJob(json).transfer.put("created", false).put("notFound", count) }
    throttle.failure("backoff")
    return null
  }

  private fun markDone(json: JSONObject) {
    val j = UploadJob(json)
    if (j.done && !j.transfer.has("doneAt")) j.transfer.put("doneAt", clock.nowMs())
  }

  private fun updateSlot(entryId: String, role: String, change: (JSONObject) -> Unit) {
    store.update(entryId) { json -> UploadJob(json).slot(role)?.let(change) }
  }

  private fun chunkBytes(): Long = state.get(KEY_CHUNK)?.toLongOrNull() ?: ChunkSizer.START_BYTES

  private fun setChunkBytes(value: Long) = state.put(KEY_CHUNK, value.toString())

  companion object {
    private val RUNNING = AtomicBoolean(false)

    @Volatile
    private var activeClient: TusClient? = null

    @Volatile
    private var activeEntryId: String? = null

    @Volatile
    private var activeStop: StopSignal? = null

    /** True while a run is active in this process (it re-reads the queue before every request). */
    val isRunning: Boolean get() = RUNNING.get()

    /**
     * Something changed (a new job, "Upload now", new settings or token): the active run ends its
     * current wait (backoff, budget, captive-portal poll) and looks at the queue again.
     */
    fun nudge() {
      activeStop?.wake()
    }

    /** Cancels the request in flight (the run was stopped by the system). */
    fun abortAll() {
      activeClient?.abort()
    }

    /** Cancels the request in flight when it belongs to [entryId] (the job was cancelled). */
    fun abortIfActive(entryId: String) {
      if (activeEntryId == entryId) activeClient?.abort()
    }

    const val KEY_CHUNK = "engine.chunkBytes"
    const val KEY_REJECTED_TOKEN = "auth.rejectedToken"
    const val KEY_REJECTED_CODE = "auth.rejectedCode"
    private const val STEP = 64 * 1024L

    /** A withdrawal follows the network rules of a text status (light, never an original). */
    private const val WITHDRAW_KIND = "text"
    private const val MAX_SHA_MISMATCHES = 3
    private const val MAX_NOT_FOUND = 3
    private const val POLL_MS = 5_000L
    private const val NOT_VALIDATED_RETRY_MS = 5 * 60_000L

    private val AUTH_MESSAGES = mapOf(
      "not_configured" to "The uploader has no API address yet (Uploader.configure).",
      "not_paired" to "The phone is not paired.",
      "token_revoked" to "The app token was revoked.",
      "unauthorized" to "The API refused the app token.",
    )

    fun sha256Hex(value: String): String =
      MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
  }
}
