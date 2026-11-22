package app.omw.omwnative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** The request budget (≤ 10 requests / 10 s), the backoff and Retry-After. */
class UploadPacingTest {
  @Test
  fun budgetAllowsTenRequestsPerTenSecondsAndSpacesThem() {
    val clock = FakeClock()
    val budget = RequestBudget(clock, MemoryKeyValueStore())
    val stop = FakeStop(clock)
    val sent = mutableListOf<Long>()
    repeat(35) {
      assertTrue(budget.acquire(stop))
      sent += clock.nowMs()
    }
    assertWithinBudget(sent)
    for (i in 1 until sent.size) assertTrue("gap", sent[i] - sent[i - 1] >= 200)
    // 35 requests need at least 3 full windows.
    assertTrue(sent.last() - sent.first() >= 30_000)
  }

  @Test
  fun budgetSurvivesANewProcess() {
    val clock = FakeClock()
    val kv = MemoryKeyValueStore()
    val first = RequestBudget(clock, kv)
    val stop = FakeStop(clock)
    val sent = mutableListOf<Long>()
    repeat(10) {
      first.acquire(stop)
      sent += clock.nowMs()
    }
    // "Crash" and restart: a fresh budget reads the persisted send times and must wait.
    val second = RequestBudget(clock, kv)
    repeat(5) {
      second.acquire(stop)
      sent += clock.nowMs()
    }
    assertWithinBudget(sent)
  }

  @Test
  fun budgetForgetsSendsWhenTheClockJumpsBack() {
    val clock = FakeClock()
    val kv = MemoryKeyValueStore()
    val budget = RequestBudget(clock, kv)
    val stop = FakeStop(clock)
    repeat(10) { budget.acquire(stop) }
    val restarted = RequestBudget(FakeClock(clock.nowMs() - 3_600_000), kv)
    val before = stop.sleeps
    assertTrue(restarted.acquire(stop))
    assertEquals(before, stop.sleeps)
  }

  @Test
  fun budgetWaitEndsWhenTheRunIsStopped() {
    val clock = FakeClock()
    val budget = RequestBudget(clock, MemoryKeyValueStore())
    val stop = FakeStop(clock, stopAfterSleeps = 1)
    repeat(10) { budget.acquire(FakeStop(clock)) }
    assertFalse(budget.acquire(stop))
  }

  @Test
  fun backoffGrowsWithEqualJitterAndCapsAt15Minutes() {
    val random = Random(7)
    for (attempt in 0..25) {
      val cap = minOf(Backoff.MAX_MS, Backoff.BASE_MS shl minOf(attempt, 20))
      repeat(50) {
        val d = Backoff.delayMs(attempt, random)
        assertTrue("attempt $attempt: $d", d >= cap / 2 && d <= cap)
      }
    }
    assertEquals(600_000L, Backoff.delayMs(0, random, retryAfterMs = 600_000))
  }

  @Test
  fun retryAfterAcceptsSecondsAndHttpDates() {
    val now = 1_800_000_000_000L
    assertEquals(120_000L, Backoff.parseRetryAfter("120", now))
    assertEquals(0L, Backoff.parseRetryAfter("0", now))
    assertEquals(30_000L, Backoff.parseRetryAfter(java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME.format(java.time.Instant.ofEpochMilli(now + 30_000).atZone(java.time.ZoneOffset.UTC)), now))
    assertNull(Backoff.parseRetryAfter("soon", now))
    assertNull(Backoff.parseRetryAfter(null, now))
    assertNull(Backoff.parseRetryAfter("-5", now))
  }

  @Test
  fun throttleKeepsTheServersRetryAfterThroughUploadNow() {
    val clock = FakeClock()
    val kv = MemoryKeyValueStore()
    val throttle = UploadThrottle(clock, kv, Random(1))
    throttle.failure("server_busy", retryAfterMs = 300_000)
    assertTrue(throttle.isBlocked())
    assertEquals("server_busy", throttle.reason)
    throttle.resetForUser()
    assertTrue("Retry-After stays", throttle.blockedUntil() >= clock.nowMs() + 300_000)
    // Persisted for the next process.
    assertEquals(throttle.blockedUntil(), UploadThrottle(clock, kv).blockedUntil())
    clock.advance(300_001)
    assertFalse(throttle.isBlocked())
    throttle.failure("no_network")
    throttle.failure("no_network")
    assertEquals(2, throttle.attempt)
    throttle.resetForUser()
    assertFalse(throttle.isBlocked())
    throttle.success()
    assertEquals(0, UploadThrottle(clock, kv).attempt)
  }

  @Test
  fun aWallClockThatWentBackNeverStretchesAWait() {
    val clock = FakeClock()
    val kv = MemoryKeyValueStore()
    val throttle = UploadThrottle(clock, kv, Random(1))
    throttle.failure("inbox_full", 900_000) // 507 with Retry-After: 900
    clock.advance(-24 * 3600 * 1000L) // she set the phone's clock back a day while travelling
    throttle.resetForUser() // "Upload now" (never skips the server's wait)
    assertTrue(throttle.isBlocked())
    assertTrue("at most the Retry-After itself", throttle.blockedUntil() - clock.nowMs() <= 900_000)
    // A new process reads the rebased deadline; the wait ends after the Retry-After.
    clock.advance(900_001)
    assertFalse(UploadThrottle(clock, kv, Random(1)).isBlocked())
    assertFalse(throttle.isBlocked())

    // Our own backoff too: a deadline is never further ahead than its cap.
    throttle.failure("backoff")
    clock.advance(-3 * 3600 * 1000L)
    assertTrue(throttle.blockedUntil() - clock.nowMs() <= Backoff.MAX_MS)
    throttle.resetForUser()
    assertFalse(throttle.isBlocked())
  }

  @Test
  fun aStoredDeadlineBeyondItsCapIsCut() {
    val clock = FakeClock()
    val kv = MemoryKeyValueStore()
    // Written by an older build (no set time) before the clock went back two days.
    kv.put("throttle.serverUntil", (clock.nowMs() + 2 * 24 * 3600 * 1000L).toString())
    val throttle = UploadThrottle(clock, kv, Random(1))
    assertTrue(throttle.blockedUntil() - clock.nowMs() <= UploadThrottle.MAX_SERVER_MS)
  }

  companion object {
    fun assertWithinBudget(times: List<Long>, max: Int = 10, windowMs: Long = 10_000) {
      val sorted = times.sorted()
      for (t in sorted) {
        val inWindow = sorted.count { it >= t && it < t + windowMs }
        assertTrue("$inWindow requests within ${windowMs}ms from $t", inWindow <= max)
      }
    }
  }
}
