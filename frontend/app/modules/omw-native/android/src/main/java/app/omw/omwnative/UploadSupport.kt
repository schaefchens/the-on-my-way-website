package app.omw.omwnative

import android.content.Context
import androidx.core.content.edit
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Time for the uploader. Tests replace it with a fake that only moves when told to. */
interface Clock {
  /** Wall clock in ms (persisted budgets and backoffs, ISO timestamps). */
  fun nowMs(): Long

  /** Monotonic ms (chunk timings). */
  fun elapsedMs(): Long
}

object WallClock : Clock {
  override fun nowMs(): Long = System.currentTimeMillis()

  override fun elapsedMs(): Long = TimeUnit.NANOSECONDS.toMillis(System.nanoTime())
}

/**
 * Cooperative stop for one uploader run: the system stopped the job (constraints, timeout) or
 * the worker was cancelled. Waits use it so a stop ends them at once.
 */
interface StopSignal {
  val stopped: Boolean

  /** Waits up to [ms]; returns false when stopped (before or during the wait). */
  fun sleep(ms: Long): Boolean

  /** Ends the current (or next) wait early without stopping: something changed, look again. */
  fun wake() {}
}

class RealStopSignal : StopSignal {
  private val lock = ReentrantLock()
  private val changed = lock.newCondition()
  private val onStop = mutableListOf<() -> Unit>()

  @Volatile
  override var stopped = false
    private set

  private var woken = false

  fun stop() {
    val callbacks = lock.withLock {
      if (stopped) return
      stopped = true
      changed.signalAll()
      onStop.toList()
    }
    callbacks.forEach { runCatching(it) }
  }

  /** Runs [callback] when stopped (at once when already stopped). */
  fun onStop(callback: () -> Unit) {
    val now = lock.withLock {
      if (!stopped) onStop += callback
      stopped
    }
    if (now) callback()
  }

  override fun wake() = lock.withLock {
    woken = true
    changed.signalAll()
  }

  override fun sleep(ms: Long): Boolean = lock.withLock {
    var left = TimeUnit.MILLISECONDS.toNanos(ms.coerceAtLeast(0))
    while (!stopped && !woken && left > 0) left = changed.awaitNanos(left)
    woken = false
    !stopped
  }
}

/** Small string store for the uploader's process-independent state (budget, backoff, config). */
interface KeyValueStore {
  fun get(key: String): String?

  fun put(key: String, value: String?)
}

class MemoryKeyValueStore : KeyValueStore {
  private val map = HashMap<String, String>()

  @Synchronized
  override fun get(key: String): String? = map[key]

  @Synchronized
  override fun put(key: String, value: String?) {
    if (value == null) map.remove(key) else map[key] = value
  }
}

/** SharedPreferences-backed store. `commit` makes the request budget survive a crash right after a request. */
class PrefsKeyValueStore(context: Context, name: String) : KeyValueStore {
  private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)

  override fun get(key: String): String? = prefs.getString(key, null)

  override fun put(key: String, value: String?) {
    prefs.edit(commit = true) { if (value == null) remove(key) else putString(key, value) }
  }
}
