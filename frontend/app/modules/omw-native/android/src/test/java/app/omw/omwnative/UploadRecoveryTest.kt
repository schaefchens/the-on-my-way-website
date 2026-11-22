package app.omw.omwnative

import app.omw.omwnative.FakeEnv.Companion.MOBILE
import app.omw.omwnative.FakeEnv.Companion.ROAMING
import app.omw.omwnative.FakeEnv.Companion.WIFI
import app.omw.omwnative.UploadPacingTest.Companion.assertWithinBudget
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/**
 * The paths that bring a moment home after something went wrong (review R1–R5): "Try again" after
 * each permanent error, pairing the same phone again with uploads open, Undo + Share again,
 * durable withdrawals, and the order of media before originals. Against FakeTusServer, which
 * binds entries to the phone that created them like the real API.
 */
class UploadRecoveryTest {
  @get:Rule
  val tmp = TemporaryFolder()

  private val clock = FakeClock()
  private lateinit var fake: FakeTusServer
  private lateinit var server: MockWebServer
  private lateinit var env: FakeEnv
  private lateinit var store: UploadJobStore
  private lateinit var queue: UploadQueue
  private lateinit var files: File
  private val kv = MemoryKeyValueStore()

  @Before
  fun setUp() {
    fake = FakeTusServer(clock)
    server = MockWebServer().apply {
      dispatcher = fake
      start()
    }
    env = FakeEnv(clock, base = server.url("/"))
    store = UploadJobStore(tmp.newFolder("jobs"))
    queue = UploadQueue(store, clock)
    files = tmp.newFolder("outbox")
  }

  @After
  fun tearDown() {
    server.shutdown()
  }

  private fun engine() =
    UploadEngine(store, env, RequestBudget(clock, kv), UploadThrottle(clock, kv, Random(5)), kv, RecordingListener(), inlineWaitMaxMs = Long.MAX_VALUE)

  private fun status(n: Int) = store.get(TestJobs.ulid(n))!!.getJSONObject("status")

  private fun localBytes(n: Int, role: String) = File(files, "${TestJobs.ulid(n)}-$role.bin").readBytes()

  private fun isCreate(r: FakeTusServer.Logged) = r.method == "POST" && r.path.endsWith("/app/entries")

  /** A fault that answers [answer] to the first request [matches] accepts, then gets out of the way. */
  private fun once(answer: MockResponse, matches: (RecordedRequest, String) -> Boolean): (RecordedRequest, String) -> MockResponse? {
    val used = AtomicInteger()
    return { req, method -> if (matches(req, method) && used.getAndIncrement() == 0) answer else null }
  }

  // ---- R1: "Try again" -----------------------------------------------------------------------

  @Test
  fun tryAgainAfterEachPermanentUploadErrorSendsTheJobAgain() {
    val commitNo = AtomicInteger()
    val cases: List<Pair<String, (RecordedRequest, String) -> MockResponse?>> = listOf(
      "forbidden" to once(FakeTusServer.error(403, "forbidden")) { _, m -> m == "PATCH" },
      "gone" to once(FakeTusServer.error(410, "gone")) { _, m -> m == "PATCH" },
      "unsupported_media_type" to once(FakeTusServer.error(415, "unsupported_media_type")) { _, m -> m == "PATCH" },
      "entry_conflict" to once(FakeTusServer.error(409, "entry_conflict")) { r, m -> m == "POST" && r.path!!.endsWith("/entries") },
      "validation_failed" to once(FakeTusServer.error(422, "validation_failed")) { r, m -> m == "POST" && r.path!!.endsWith("/entries") },
      "protocol" to once(FakeTusServer.json(201, JSONObject().put("state", "receiving"))) { r, m -> m == "POST" && r.path!!.endsWith("/entries") },
      // Three damaged arrivals in a row (the server resets the file each time).
      "sha256_mismatch" to { r, _ ->
        if (r.path!!.endsWith("/commit") && commitNo.incrementAndGet() <= 3) FakeTusServer.error(422, "sha256_mismatch") else null
      },
    )
    for ((n, case) in cases.withIndex()) {
      val (code, fault) = case
      val id = n + 1
      val job = TestJobs.job(files, id, "photo", mapOf("media" to 300_000, "preview" to 20_000))
      queue.enqueue(job, env.uploadSettings)
      fake.fault = fault
      assertEquals(code, RunOutcome.Done, engine().run(FakeStop(clock)))
      val failed = status(id)
      assertEquals(code, "failed", failed.getString("state"))
      assertEquals(code, failed.getJSONObject("error").getString("code"))
      assertTrue(code, failed.getJSONObject("error").getBoolean("permanent"))

      // She taps "Try again": the app enqueues the same entry again, which restarts the job.
      val before = fake.log.size
      val again = queue.enqueue(job, env.uploadSettings)
      assertEquals(code, "queued", again.getString("state"))
      assertTrue(code, again.isNull("error"))
      assertEquals(code, RunOutcome.Done, engine().run(FakeStop(clock)))
      assertTrue("$code: requests after Try again", fake.log.size > before)
      assertEquals(code, "uploaded", status(id).getString("state"))
      val entry = fake.entries.getValue(TestJobs.ulid(id))
      val media = entry.uploads.single { it.role == "media" }
      assertArrayEquals(code, localBytes(id, "media"), media.data.toByteArray())
    }
    assertWithinBudget(fake.log.map { it.atMs })
  }

  // ---- R3: pairing again ----------------------------------------------------------------------

  @Test
  fun pairingTheSamePhoneAgainContinuesOpenUploadsFromTheirOffsets() {
    fake.bytesPerSecond = 1_000_000
    queue.enqueue(TestJobs.job(files, 1, "video", mapOf("media" to 6 * 1024 * 1024, "original" to 2 * 1024 * 1024)), env.uploadSettings)
    val stop = FakeStop(clock)
    var patchNo = 0
    fake.fault = { _, method ->
      if (method == "PATCH" && ++patchNo == 2) stop.stopped = true
      null
    }
    assertEquals(RunOutcome.Stopped, engine().run(stop))
    fake.fault = null
    val media = fake.uploads.values.single { it.role == "media" }
    val sentBefore = media.offset
    assertTrue(sentBefore in 1 until media.bytes)

    // The owner disconnects the phone (a false alarm) and connects it again: a new token, the
    // same install (the API hands this phone's entries to the new token).
    val oldToken = fake.token
    fake.token = "omw_" + "B".repeat(43)
    assertEquals(RunOutcome.Unauthorized, engine().run(FakeStop(clock)))
    assertEquals("unauthorized", status(1).getString("blockedBy"))
    env.tokenValue = fake.token
    val mark = fake.log.size
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))

    val after = fake.log.drop(mark)
    assertFalse("no second create was needed", after.any(::isCreate))
    val firstPatch = after.first { it.method == "PATCH" }
    assertTrue(firstPatch.path.endsWith(media.id))
    assertEquals("continues at the offset, not at 0", sentBefore, firstPatch.offset)
    assertTrue(after.none { it.status in listOf(403, 409, 410) })
    assertEquals("uploaded", status(1).getString("state"))
    assertEquals("uploaded", status(1).getJSONObject("original").getString("state"))
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
    assertArrayEquals(localBytes(1, "original"), fake.bytesOf("original"))
    assertFalse(oldToken == fake.token)
  }

  @Test
  fun anotherPhoneCannotContinueThisPhonesUploads() {
    queue.enqueue(TestJobs.job(files, 1, "photo", mapOf("media" to 600_000)), env.uploadSettings)
    val stop = FakeStop(clock)
    fake.fault = { _, method ->
      if (method == "PATCH") stop.stopped = true
      null
    }
    engine().run(stop)
    fake.fault = null
    fake.addOtherPhone("omw_" + "S".repeat(43), "stolen phone")
    env.tokenValue = "omw_" + "S".repeat(43)
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals("failed", status(1).getString("state"))
    assertEquals("forbidden", status(1).getJSONObject("error").getString("code"))
    assertTrue(fake.log.any { it.status == 403 })
  }

  // ---- R2 + R4: Undo, Share again, durable withdrawals ---------------------------------------

  @Test
  fun undoThenShareAgainWithdrawsTheOldIdAndUploadsTheNewOne() {
    val first = TestJobs.job(files, 1, "text", emptyMap())
    queue.enqueue(first, env.uploadSettings)
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals("uploaded", fake.entries.getValue(TestJobs.ulid(1)).state)

    // Undo (8 s later): the job is gone, a DELETE is owed; the edited draft goes out under a new id.
    val undo = queue.withdraw(TestJobs.ulid(1))
    assertTrue(undo.deleteOwed)
    assertEquals("cancelled", undo.cancelled!!.getString("state"))
    val second = TestJobs.job(files, 2, "text", emptyMap())
    second.getJSONObject("entry").put("occurredAt", "2026-11-20T10:00:20.000Z").getJSONObject("text").put("body", "Hallo, Hội An!")
    queue.enqueue(second, env.uploadSettings)
    val mark = fake.log.size
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))

    val sent = fake.log.drop(mark)
    assertEquals(listOf("DELETE", "POST"), sent.map { it.method })
    assertTrue(sent[0].path.endsWith("/app/entries/${TestJobs.ulid(1)}"))
    assertEquals(204, sent[0].status)
    assertEquals(201, sent[1].status)
    assertEquals("withdrawn", fake.entries.getValue(TestJobs.ulid(1)).state)
    assertEquals("uploaded", fake.entries.getValue(TestJobs.ulid(2)).state)
    assertEquals("uploaded", status(2).getString("state"))
    assertTrue(queue.pendingWithdrawals().isEmpty())
    // The undone id can never be enqueued again (an enqueue racing the Undo is refused).
    assertThrows(IllegalStateException::class.java) { queue.enqueue(first, env.uploadSettings) }
    // A second Undo of the same id changes nothing.
    assertFalse(queue.withdraw(TestJobs.ulid(1)).deleteOwed)
  }

  @Test
  fun undoBeforeAnythingWentOutOwesNoRequest() {
    queue.enqueue(TestJobs.job(files, 1, "photo", mapOf("media" to 10_000), mode = "manual"), env.uploadSettings)
    val undo = queue.withdraw(TestJobs.ulid(1))
    assertFalse(undo.deleteOwed)
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals(0, fake.log.size)
    assertTrue(store.get(TestJobs.ulid(1)) == null)
  }

  @Test
  fun aLostCreateAnswerStillOwesTheWithdrawal() {
    queue.enqueue(TestJobs.job(files, 1, "text", emptyMap()), env.uploadSettings)
    // The create reaches the API, its answer never reaches the phone (then the system stops the run).
    fake.dropNextCreateAnswer = true
    assertEquals(RunOutcome.Stopped, engine().run(FakeStop(clock, stopAfterSleeps = 1)))
    assertEquals("uploaded", fake.entries.getValue(TestJobs.ulid(1)).state)
    assertFalse(UploadJob(store.get(TestJobs.ulid(1))!!).created)
    assertTrue(queue.withdraw(TestJobs.ulid(1)).deleteOwed)
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals("withdrawn", fake.entries.getValue(TestJobs.ulid(1)).state)
  }

  @Test
  fun withdrawalsGoFirstAndAreRetriedUntilTheApiAnswers() {
    queue.enqueue(TestJobs.job(files, 1, "photo", mapOf("media" to 300_000)), env.uploadSettings)
    queue.withdraw(TestJobs.ulid(7)) // no job here (pruned long ago, or never enqueued): asked anyway
    val deletes = AtomicInteger()
    fake.fault = { _, method ->
      if (method == "DELETE" && deletes.incrementAndGet() <= 2) FakeTusServer.error(503, "transfer_busy").setHeader("Retry-After", "20") else null
    }
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    val methods = fake.log.map { it.method }
    assertEquals(listOf("DELETE", "DELETE", "DELETE"), methods.take(3))
    assertEquals(404, fake.log[2].status) // the API never had it: done
    assertTrue(fake.log[1].atMs - fake.log[0].atMs >= 20_000)
    assertTrue(queue.pendingWithdrawals().isEmpty())
    assertEquals("uploaded", status(1).getString("state"))
  }

  @Test
  fun aWithdrawalIgnoresManualModeAndWifiOnlyButWaitsForRoamingAndAToken() {
    env.uploadSettings = UploadSettings(mode = "manual", wifiOnly = true)
    queue.withdraw(TestJobs.ulid(3))
    env.net = ROAMING
    assertEquals(RunOutcome.WaitNetwork, engine().run(FakeStop(clock)))
    env.tokenValue = null
    env.net = MOBILE
    assertEquals(RunOutcome.Unauthorized, engine().run(FakeStop(clock)))
    assertEquals(0, fake.log.size)
    env.tokenValue = FakeTusServer.TEST_TOKEN
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals(listOf("DELETE"), fake.log.map { it.method })
    env.net = WIFI
  }

  @Test
  fun oldWithdrawalsArePrunedAfterAWeek() {
    queue.withdraw(TestJobs.ulid(4))
    engine().run(FakeStop(clock))
    assertEquals(0, queue.prune())
    clock.advance(UploadQueue.PRUNE_AFTER_MS + 1)
    assertEquals(1, queue.prune())
    // After that, the id is unknown to the queue again.
    queue.enqueue(TestJobs.job(files, 4, "text", emptyMap()), env.uploadSettings)
  }

  // ---- R5: today's moments before yesterday's original -----------------------------------------

  @Test
  fun aNewerMomentGoesBeforeAnOlderOriginal() {
    fake.bytesPerSecond = 200L * 1024 // a slow hotel Wi-Fi
    queue.enqueue(TestJobs.job(files, 1, "video", mapOf("media" to 1_000_000, "original" to 6_000_000)), env.uploadSettings)
    val listener = RecordingListener()
    val first = UploadEngine(store, env, RequestBudget(clock, kv), UploadThrottle(clock, kv, Random(5)), kv, listener)
    // The first moment's media is home and its original has started, then she shares a photo.
    val stop = FakeStop(clock)
    fake.fault = { req, method ->
      if (method == "PATCH" && fake.uploads.values.any { it.role == "original" && it.id == req.path!!.substringAfterLast('/') && it.offset > 0 }) {
        stop.stopped = true
      }
      null
    }
    first.run(stop)
    fake.fault = null
    assertEquals("uploaded", status(1).getString("state"))
    queue.enqueue(TestJobs.job(files, 2, "photo", mapOf("media" to 300_000, "preview" to 30_000)), env.uploadSettings)
    val mark = fake.log.size
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))

    val after = fake.log.drop(mark)
    val originalId = fake.uploads.values.single { it.role == "original" }.id
    val secondCreate = after.indexOfFirst(::isCreate)
    val secondCommit = after.indexOfFirst { it.path.endsWith("${TestJobs.ulid(2)}/commit") }
    val firstOriginal = after.indexOfFirst { it.path.endsWith(originalId) }
    assertEquals("the new moment's create comes first", 0, secondCreate)
    assertTrue("its media is home before the original goes on", secondCommit in 0 until firstOriginal)
    assertEquals("uploaded", status(2).getString("state"))
    assertEquals("uploaded", status(1).getJSONObject("original").getString("state"))
    assertArrayEquals(localBytes(1, "original"), fake.bytesOf("original"))
  }

  @Test
  fun originalsWaitWhileAnyMomentsMediaCanGo() {
    queue.enqueue(TestJobs.job(files, 1, "photo", mapOf("media" to 50_000, "original" to 100_000)), env.uploadSettings)
    queue.enqueue(TestJobs.job(files, 2, "photo", mapOf("media" to 50_000, "original" to 100_000)), env.uploadSettings)
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    val commits = fake.log.withIndex().filter { it.value.path.endsWith("/commit") }
    // media of 1, media of 2, then the two originals.
    val roles = commits.map { c -> fake.log.take(c.index).lastOrNull { it.method == "PATCH" }?.path?.substringAfterLast('/') }
      .map { id -> fake.uploads.getValue(id!!).let { "${it.entryId.takeLast(1)}:${it.role}" } }
    assertEquals(listOf("1:media", "2:media", "1:original", "2:original"), roles)
  }
}
