package app.omw.omwnative

import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

private const val KIB = 1024L
private const val MIB = 1024L * KIB

/**
 * Adaptive chunk size, the Kotlin mirror of nextChunkBytes() in @omw/contracts/app (vectors in
 * fixtures/vectors/app-chunks.json): after a success aim for [TARGET_SECONDS] at the measured
 * throughput but at most double; after any failure halve. Always inside the server's bounds and
 * a multiple of 64 KiB.
 */
object ChunkSizer {
  const val MIN_BYTES = 256 * KIB
  const val MAX_BYTES = 8 * MIB
  const val START_BYTES = 1 * MIB
  const val TARGET_SECONDS = 15.0
  private const val STEP = 64 * KIB

  fun next(current: Long, ok: Boolean, bytes: Long = 0, ms: Long = 0, minBytes: Long = MIN_BYTES, maxBytes: Long = MAX_BYTES): Long {
    fun clamp(n: Double) = min(maxBytes.toDouble(), max(minBytes.toDouble(), n))
    val next = if (!ok) {
      current / 2.0
    } else {
      val perSecond = if (ms > 0) bytes * 1000.0 / ms else Double.POSITIVE_INFINITY
      min(current * 2.0, perSecond * TARGET_SECONDS)
    }
    return clamp(floor(clamp(next) / STEP) * STEP).toLong()
  }

  /** A stored or announced size brought inside the bounds (for a server with tighter limits). */
  fun within(current: Long, minBytes: Long, maxBytes: Long): Long = min(maxBytes, max(minBytes, current))
}

/**
 * Exponential backoff (APP_REQUEST_BUDGET: 2 s base, 15 min cap) with "equal jitter": half of the
 * exponential step is fixed, half random. Unlike full jitter it never retries much faster than
 * the step, so a failing host is never hammered (the API host blocks IPs after bursts of requests).
 * There is one client per host, so de-synchronising many clients (full jitter's purpose) does not
 * apply. A longer Retry-After always wins.
 */
object Backoff {
  const val BASE_MS = 2_000L
  const val MAX_MS = 15 * 60 * 1000L

  fun delayMs(attempt: Int, random: Random, retryAfterMs: Long? = null): Long {
    val cap = if (attempt >= 20) MAX_MS else min(MAX_MS, BASE_MS shl attempt.coerceAtLeast(0))
    val half = cap / 2
    val jittered = half + random.nextLong(0, half + 1)
    return max(jittered, retryAfterMs ?: 0L)
  }

  /** Retry-After as delta-seconds or an HTTP date, in ms from [nowMs]; null when absent or invalid. */
  fun parseRetryAfter(value: String?, nowMs: Long): Long? {
    val v = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    v.toLongOrNull()?.let { return if (it >= 0) min(it, 24 * 3600L) * 1000 else null }
    return try {
      val at = ZonedDateTime.parse(v, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()
      (at - nowMs).coerceIn(0, 24 * 3600 * 1000L)
    } catch (_: Exception) {
      null
    }
  }
}

/**
 * APP_REQUEST_BUDGET: at most [maxRequests] requests per [windowMs] across every job and run, plus
 * a small gap between two requests so a burst never happens. The send times are persisted, so a
 * crash loop or a fresh process cannot burst either. [acquire] blocks until the next request may
 * go (or the run is stopped).
 */
class RequestBudget(
  private val clock: Clock,
  private val store: KeyValueStore,
  val maxRequests: Int = 10,
  val windowMs: Long = 10_000,
  val minGapMs: Long = 200,
) {
  private val times = ArrayDeque<Long>()

  init {
    store.get(KEY)?.split(',')?.mapNotNull { it.toLongOrNull() }?.sorted()?.forEach { times.addLast(it) }
  }

  /** Waits for a slot and takes it. Returns false when [stop] ended the wait. */
  @Synchronized
  fun acquire(stop: StopSignal): Boolean {
    while (true) {
      if (stop.stopped) return false
      val now = clock.nowMs()
      // Forget sends outside the window, and "future" sends after the wall clock went back.
      times.removeAll { it <= now - windowMs || it > now + windowMs }
      val waitWindow = if (times.size >= maxRequests) times.first() + windowMs - now else 0L
      val waitGap = times.lastOrNull()?.let { it + minGapMs - now } ?: 0L
      val wait = max(waitWindow, waitGap)
      if (wait <= 0) {
        times.addLast(now)
        store.put(KEY, times.joinToString(","))
        return true
      }
      if (!stop.sleep(wait)) return false
    }
  }

  companion object {
    private const val KEY = "budget.sentAt"
  }
}

/**
 * The host-wide wait after errors. Requests go one at a time, so one shared backoff protects the
 * host better than per-job timers: any error pauses every job. Our own exponential wait and the
 * server's Retry-After are kept apart, because "Upload now" may skip the first but never the second.
 *
 * Deadlines are wall-clock times (they must survive a new process and a reboot), stored with the
 * time they were set, and forgotten once seen over. When the wall clock went back (she changed it
 * while travelling, or network time corrected it), a running deadline is rebased to its own length
 * from now, so a jump never stretches a wait; and no deadline lies further ahead than its cap ([Backoff.MAX_MS] for ours, 24 h for the
 * server's, as [Backoff.parseRetryAfter] caps it).
 */
class UploadThrottle(private val clock: Clock, private val store: KeyValueStore, private val random: Random = Random.Default) {
  var attempt: Int = store.get("throttle.attempt")?.toIntOrNull() ?: 0
    private set
  private var ownUntil: Long = store.get("throttle.ownUntil")?.toLongOrNull() ?: 0
  private var serverUntil: Long = store.get("throttle.serverUntil")?.toLongOrNull() ?: 0
  private var ownSetAt: Long = store.get("throttle.ownSetAt")?.toLongOrNull() ?: 0
  private var serverSetAt: Long = store.get("throttle.serverSetAt")?.toLongOrNull() ?: 0

  /** Why the host is paused: "backoff", "no_network", "server_busy" or "inbox_full". */
  var reason: String = store.get("throttle.reason") ?: "backoff"
    private set

  @Synchronized
  fun blockedUntil(): Long {
    sanitize()
    return max(ownUntil, serverUntil)
  }

  @Synchronized
  fun isBlocked(): Boolean = blockedUntil() > clock.nowMs()

  @Synchronized
  fun success() {
    if (attempt == 0 && ownUntil == 0L) return
    attempt = 0
    ownUntil = 0
    persist()
  }

  /** Records a failed request; returns the wait in ms. */
  @Synchronized
  fun failure(reason: String, retryAfterMs: Long? = null): Long {
    sanitize()
    val now = clock.nowMs()
    val delay = Backoff.delayMs(attempt, random, retryAfterMs)
    attempt = min(attempt + 1, 30)
    ownUntil = now + min(delay, Backoff.MAX_MS)
    ownSetAt = now
    if (retryAfterMs != null && now + retryAfterMs > serverUntil) {
      serverUntil = now + min(retryAfterMs, MAX_SERVER_MS)
      serverSetAt = now
    }
    this.reason = reason
    persist()
    return delay
  }

  /** "Upload now": drop our own wait (never the server's Retry-After). */
  @Synchronized
  fun resetForUser() {
    attempt = 0
    ownUntil = 0
    persist()
  }

  /** Rebases deadlines after the wall clock went back and caps them (see the class comment). */
  private fun sanitize() {
    val now = clock.nowMs()
    var changed = false
    fun fix(until: Long, setAt: Long, cap: Long): Pair<Long, Long>? {
      if (until <= 0) return null
      if (until <= now) {
        changed = true
        return 0L to 0L // over: forgotten, so a later jump back can not bring it back
      }
      if (now < setAt) {
        changed = true
        return (now + (until - setAt).coerceIn(0, cap)) to now
      }
      if (until - now > cap) {
        changed = true
        return (now + cap) to now
      }
      return null
    }
    fix(ownUntil, ownSetAt, Backoff.MAX_MS)?.let { (u, at) -> ownUntil = u; ownSetAt = at }
    fix(serverUntil, serverSetAt, MAX_SERVER_MS)?.let { (u, at) -> serverUntil = u; serverSetAt = at }
    if (changed) persist()
  }

  private fun persist() {
    store.put("throttle.attempt", attempt.toString())
    store.put("throttle.ownUntil", ownUntil.toString())
    store.put("throttle.serverUntil", serverUntil.toString())
    store.put("throttle.ownSetAt", ownSetAt.toString())
    store.put("throttle.serverSetAt", serverSetAt.toString())
    store.put("throttle.reason", reason)
  }

  companion object {
    /** The longest server wait we honour (Retry-After is capped to this when parsed). */
    const val MAX_SERVER_MS = 24 * 3600 * 1000L
  }
}
