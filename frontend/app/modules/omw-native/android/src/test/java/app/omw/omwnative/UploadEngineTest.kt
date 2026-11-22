package app.omw.omwnative

import app.omw.omwnative.FakeEnv.Companion.HOTSPOT
import app.omw.omwnative.FakeEnv.Companion.MOBILE
import app.omw.omwnative.FakeEnv.Companion.PORTAL
import app.omw.omwnative.FakeEnv.Companion.ROAMING
import app.omw.omwnative.FakeEnv.Companion.WIFI
import app.omw.omwnative.UploadPacingTest.Companion.assertWithinBudget
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/**
 * The uploader engine against the contract's fake API on MockWebServer (time is simulated with a
 * FakeClock, so budgets, backoffs and link speeds are exact and the tests are fast).
 */
class UploadEngineTest {
  @get:Rule
  val tmp = TemporaryFolder()

  private val clock = FakeClock()
  private lateinit var fake: FakeTusServer
  private lateinit var server: MockWebServer
  private lateinit var env: FakeEnv
  private lateinit var store: UploadJobStore
  private lateinit var files: File
  private val kv = MemoryKeyValueStore()
  private val listener = RecordingListener()

  @Before
  fun setUp() {
    fake = FakeTusServer(clock)
    server = MockWebServer().apply {
      dispatcher = fake
      start()
    }
    env = FakeEnv(clock, base = server.url("/"))
    store = UploadJobStore(tmp.newFolder("jobs"))
    files = tmp.newFolder("outbox")
  }

  @After
  fun tearDown() {
    server.shutdown()
  }

  /** A fresh engine, as a new process would build it (budget and throttle read from [kv]). */
  private fun engine(inlineWaitMaxMs: Long = 60_000) =
    UploadEngine(store, env, RequestBudget(clock, kv), UploadThrottle(clock, kv, Random(3)), kv, listener, inlineWaitMaxMs = inlineWaitMaxMs)

  private fun enqueue(n: Int, kind: String, roles: Map<String, Int>, mode: String? = null): JSONObject {
    val job = TestJobs.job(files, n, kind, roles, mode)
    UploadQueue(store, clock).enqueue(job, env.uploadSettings)
    return job
  }

  private fun localBytes(n: Int, role: String) = File(files, "${TestJobs.ulid(n)}-$role.bin").readBytes()

  private fun status(n: Int) = store.get(TestJobs.ulid(n))!!.getJSONObject("status")

  private fun patches() = fake.log.filter { it.method == "PATCH" }

  @Test
  fun uploadsMediaAndPreviewFirstThenTheOriginalWithItsOwnCommit() {
    enqueue(1, "video", mapOf("media" to 3_000_000, "preview" to 100_000, "original" to 5_000_000))
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
    assertArrayEquals(localBytes(1, "preview"), fake.bytesOf("preview"))
    assertArrayEquals(localBytes(1, "original"), fake.bytesOf("original"))
    val commits = fake.log.withIndex().filter { it.value.path.endsWith("/commit") }.map { it.index }
    assertEquals(2, commits.size)
    val originalId = fake.uploads.values.single { it.role == "original" }.id
    val originalRequests = fake.log.withIndex().filter { it.value.path.endsWith(originalId) }.map { it.index }
    assertTrue("the original goes after the first commit", originalRequests.isNotEmpty() && originalRequests.all { it > commits[0] && it < commits[1] })
    assertEquals(0, fake.count("HEAD")) // never before a chunk
    val s = status(1)
    assertEquals("uploaded", s.getString("state"))
    assertEquals(3_100_000L, s.getLong("sentBytes"))
    assertEquals("uploaded", s.getJSONObject("original").getString("state"))
    assertTrue(UploadJob(store.get(TestJobs.ulid(1))!!).done)
    // JS saw queued/uploading → uploaded, and per-chunk progress for every role.
    assertTrue(listener.states.any { it.getString("state") == "uploading" })
    assertEquals("uploaded", listener.states.last().getString("state"))
    assertEquals(setOf("media", "preview", "original"), listener.progress.map { it.second }.toSet())
    assertWithinBudget(fake.log.map { it.atMs })
  }

  @Test
  fun chunksGrowOnAFastLinkUpTo8MiB() {
    fake.bytesPerSecond = 20L * 1024 * 1024
    enqueue(1, "video", mapOf("media" to 40 * 1024 * 1024))
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    val sizes = patches().map { it.length }
    assertEquals(listOf(1L, 2L, 4L, 8L, 8L).map { it * 1024 * 1024 }, sizes.take(5))
    assertTrue(sizes.all { it <= 8 * 1024 * 1024 })
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
  }

  @Test
  fun chunksShrinkTo256KiBOnA64kbitLinkThatDrops() {
    fake.bytesPerSecond = 8_000 // 64 kbit/s
    var patchNo = 0
    fake.fault = { _, method ->
      // Drop every 4th PATCH mid-body (the link "drops every 1 MB").
      if (method == "PATCH" && ++patchNo % 4 == 0) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) else null
    }
    enqueue(1, "photo", mapOf("media" to 2_500_000))
    assertEquals(RunOutcome.Done, engine(inlineWaitMaxMs = 30 * 60_000).run(FakeStop(clock)))
    val sizes = patches().filter { it.status == 204 }.map { it.length }
    assertEquals(1024L * 1024, sizes.first())
    assertTrue("falls to 256 KiB", sizes.drop(1).all { it <= 256 * 1024 })
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
    assertWithinBudget(fake.log.map { it.atMs })
  }

  @Test
  fun neverMoreThanTenRequestsInTenSecondsAcrossManyJobs() {
    for (n in 1..12) enqueue(n, "photo", mapOf("media" to 20_000, "preview" to 5_000))
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals(12 * 4, fake.log.size) // create, 2 PATCHes, commit
    assertWithinBudget(fake.log.map { it.atMs })
    val times = fake.log.map { it.atMs }
    for (i in 1 until times.size) assertTrue(times[i] - times[i - 1] >= 200)
  }

  @Test
  fun resumesFromTheServersOffsetAfterProcessDeathMidChunk() {
    enqueue(1, "video", mapOf("media" to 12 * 1024 * 1024))
    var patchNo = 0
    val dying = FakeStop(clock)
    fake.fault = { _, method ->
      // The server appends the 3rd chunk, but the process dies before it reads the answer.
      if (method == "PATCH" && ++patchNo == 3) {
        fake.dropNextPatchAnswer = true
        dying.stopped = true
      }
      null
    }
    assertEquals(RunOutcome.Stopped, engine().run(dying))
    val job = UploadJob(store.get(TestJobs.ulid(1))!!)
    assertTrue("the unanswered chunk is marked", job.slot("media")!!.getBoolean("inFlight"))
    val serverOffset = fake.uploads.values.single().offset
    assertTrue(serverOffset > job.slot("media")!!.getLong("offset"))

    // Second "process": asks once (HEAD), then continues from the server's offset, not from 0.
    val before = fake.log.size
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    val after = fake.log.drop(before)
    assertEquals("HEAD", after.first().method)
    assertEquals(1, after.count { it.method == "HEAD" })
    assertEquals(serverOffset, after.first { it.method == "PATCH" }.offset)
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
    assertEquals("no byte sent twice", 12L * 1024 * 1024, patches().filter { it.status == 204 }.sumOf { it.length })
  }

  @Test
  fun aCutBodyIsResentAfterAHeadAndTheChunkHalves() {
    enqueue(1, "photo", mapOf("media" to 3 * 1024 * 1024))
    var patchNo = 0
    fake.fault = { _, method ->
      // Cut the body of the 2nd PATCH halfway (the policy applies to the next request read).
      if (method == "PATCH" && ++patchNo == 1) fake.nextPolicy = MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_DURING_REQUEST_BODY)
      null
    }
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals(1, fake.count("HEAD"))
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
  }

  @Test
  fun offsetMismatchContinuesFromTheServersOffsetWithoutBackoff() {
    enqueue(1, "photo", mapOf("media" to 1_500_000))
    var first = true
    fake.fault = { _, method ->
      if (method == "PATCH" && first) {
        first = false
        FakeTusServer.error(409, "offset_mismatch").setHeader("Upload-Offset", 524_288)
      } else {
        null
      }
    }
    val stop = FakeStop(clock)
    assertEquals(RunOutcome.Done, engine().run(stop))
    // The client went to 524288, the real server said 0, then the upload ran normally.
    assertEquals(listOf(0L, 524_288L, 0L), patches().take(3).map { it.offset })
    assertEquals(0, UploadThrottle(clock, kv).attempt)
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
  }

  @Test
  fun checksumMismatchResendsTheChunkAfterABackoff() {
    enqueue(1, "photo", mapOf("media" to 700_000))
    var first = true
    fake.fault = { _, method ->
      if (method == "PATCH" && first) {
        first = false
        FakeTusServer.error(460, "checksum_mismatch").setHeader("Upload-Offset", 0)
      } else {
        null
      }
    }
    val stop = FakeStop(clock)
    assertEquals(RunOutcome.Done, engine().run(stop))
    val p = patches()
    assertEquals(0L, p[1].offset)
    assertTrue("backoff waited", p[1].atMs - p[0].atMs >= Backoff.BASE_MS / 2)
    assertTrue("halved", p[1].length < p[0].length)
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
  }

  @Test
  fun retryAfterOn503And507PausesEveryJob() {
    enqueue(1, "photo", mapOf("media" to 10_000))
    enqueue(2, "photo", mapOf("media" to 10_000))
    val answers = ArrayDeque(listOf(FakeTusServer.error(503, "transfer_busy").setHeader("Retry-After", "120"), FakeTusServer.error(507, "inbox_full").setHeader("Retry-After", "300")))
    fake.fault = { _, _ -> answers.removeFirstOrNull() }
    val statesSeen = mutableListOf<String>()
    val l = object : UploadListener {
      override fun onState(status: JSONObject) {
        if (!status.isNull("blockedBy")) statesSeen += status.getString("blockedBy")
      }
    }
    val e = UploadEngine(store, env, RequestBudget(clock, kv), UploadThrottle(clock, kv, Random(3)), kv, l, inlineWaitMaxMs = 10 * 60_000)
    assertEquals(RunOutcome.Done, e.run(FakeStop(clock)))
    val t = fake.log.map { it.atMs }
    assertTrue(t[1] - t[0] >= 120_000)
    assertTrue(t[2] - t[1] >= 300_000)
    assertTrue(statesSeen.containsAll(listOf("server_busy", "inbox_full")))
    assertEquals("uploaded", status(1).getString("state"))
    assertEquals("uploaded", status(2).getString("state"))
  }

  @Test
  fun aLongRetryAfterEndsTheRunWithARetryTime() {
    enqueue(1, "photo", mapOf("media" to 10_000))
    var once = true
    fake.fault = { _, _ ->
      if (once) {
        once = false
        FakeTusServer.error(429, "rate_limited").setHeader("Retry-After", "3600")
      } else {
        null
      }
    }
    val start = clock.nowMs()
    val outcome = engine().run(FakeStop(clock))
    assertTrue(outcome is RunOutcome.RetryAt)
    assertTrue((outcome as RunOutcome.RetryAt).atMs >= start + 3_600_000)
    assertEquals("backoff", status(1).getString("blockedBy"))
    assertEquals(1, fake.log.size)
  }

  @Test
  fun unreachableApiWaitsAsNoNetworkWithGrowingBackoff() {
    enqueue(1, "photo", mapOf("media" to 10_000))
    fake.fault = { _, _ -> MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) }
    val stop = FakeStop(clock, stopAfterSleeps = 40)
    val outcome = engine(inlineWaitMaxMs = Long.MAX_VALUE).run(stop)
    val t = fake.log.map { it.atMs }
    assertTrue("${t.size} requests, $outcome, ${server.requestCount}, sleeps ${stop.sleeps}, ${status(1)}", t.size in 5..40)
    val gaps = t.zipWithNext { a, b -> b - a }
    for (i in 2 until t.size) assertTrue("never faster than half the step: $gaps", t[i] - t[i - 1] >= minOf(Backoff.MAX_MS, Backoff.BASE_MS shl (i - 1)) / 2)
    assertEquals("no_network", status(1).getString("blockedBy"))
  }

  @Test
  fun revokedTokenStopsEverythingUntilANewTokenIsSet() {
    enqueue(1, "photo", mapOf("media" to 10_000))
    enqueue(2, "photo", mapOf("media" to 10_000))
    fake.token = "omw_" + "n".repeat(43)
    assertEquals(RunOutcome.Unauthorized, engine().run(FakeStop(clock)))
    assertEquals(1, fake.log.size)
    for (n in 1..2) {
      assertEquals("failed", status(n).getString("state"))
      assertEquals("unauthorized", status(n).getString("blockedBy"))
      assertTrue(status(n).getJSONObject("error").getBoolean("permanent"))
    }
    // The same token is never tried again.
    assertEquals(RunOutcome.Unauthorized, engine().run(FakeStop(clock)))
    assertEquals(1, fake.log.size)
    // After pairing again, the jobs go on by themselves.
    env.tokenValue = fake.token
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals("uploaded", status(2).getString("state"))
  }

  @Test
  fun notPairedOrNotConfiguredSendsNothing() {
    enqueue(1, "photo", mapOf("media" to 10_000))
    env.tokenValue = null
    assertEquals(RunOutcome.Unauthorized, engine().run(FakeStop(clock)))
    assertEquals("not_paired", status(1).getJSONObject("error").getString("code"))
    env.tokenValue = FakeTusServer.TEST_TOKEN
    env.base = null
    assertEquals(RunOutcome.Unauthorized, engine().run(FakeStop(clock)))
    assertEquals("not_configured", status(1).getJSONObject("error").getString("code"))
    assertEquals(0, fake.log.size)
  }

  @Test
  fun wifiOnlyWaitsOnMobileDataAndHotspots() {
    enqueue(1, "video", mapOf("media" to 10_000))
    for (net in listOf(MOBILE, HOTSPOT)) {
      env.net = net
      assertEquals(RunOutcome.WaitNetwork, engine().run(FakeStop(clock)))
      assertEquals("waiting", status(1).getString("state"))
      assertEquals("wifi_only", status(1).getString("blockedBy"))
      assertEquals(setOf(NetNeed.UNMETERED), engine().evaluate().runNeeds)
    }
    assertEquals(0, fake.log.size)
    env.net = WIFI
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals("uploaded", status(1).getString("state"))
  }

  @Test
  fun photosOnMobileDataSendTheArtifactAndKeepTheOriginalForWifi() {
    env.uploadSettings = UploadSettings(photosOnMobileData = true)
    env.net = MOBILE
    enqueue(1, "photo", mapOf("media" to 50_000, "preview" to 5_000, "original" to 80_000))
    enqueue(2, "video", mapOf("media" to 50_000))
    assertEquals(RunOutcome.WaitNetwork, engine().run(FakeStop(clock)))
    val photo = status(1)
    assertEquals("uploaded", photo.getString("state"))
    assertEquals("waiting", photo.getJSONObject("original").getString("state"))
    assertEquals("wifi_only", photo.getJSONObject("original").getString("blockedBy"))
    assertEquals("wifi_only", status(2).getString("blockedBy"))
    assertTrue(fake.log.none { it.path.contains(fake.uploads.values.first { u -> u.role == "original" }.id) })
    env.net = WIFI
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals("uploaded", status(1).getJSONObject("original").getString("state"))
    assertEquals("uploaded", status(2).getString("state"))
  }

  @Test
  fun uploadNowWithUploadAnywayUsesMobileDataButNeverForTheOriginal() {
    env.net = MOBILE
    enqueue(1, "video", mapOf("media" to 50_000, "original" to 50_000))
    assertEquals(RunOutcome.WaitNetwork, engine().run(FakeStop(clock)))
    assertEquals(1, UploadQueue(store, clock).uploadNow(TestJobs.ulid(1), allowMetered = true))
    assertEquals(RunOutcome.WaitNetwork, engine().run(FakeStop(clock)))
    assertEquals("uploaded", status(1).getString("state"))
    assertEquals("wifi_only", status(1).getJSONObject("original").getString("blockedBy"))
  }

  @Test
  fun roamingWaitsUntilThisSimIsAllowed() {
    env.uploadSettings = UploadSettings(wifiOnly = false)
    env.net = ROAMING
    enqueue(1, "photo", mapOf("media" to 10_000))
    assertEquals(RunOutcome.WaitNetwork, engine().run(FakeStop(clock)))
    assertEquals("roaming", status(1).getString("blockedBy"))
    assertEquals(setOf(NetNeed.NOT_ROAMING), engine().evaluate().runNeeds)
    env.uploadSettings = env.uploadSettings.copy(roamingAllowedSims = listOf("45204"))
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
  }

  @Test
  fun aCaptivePortalGetsNoRequestAndEndsWithARetryTime() {
    env.net = PORTAL
    enqueue(1, "photo", mapOf("media" to 10_000))
    val stop = FakeStop(clock)
    val outcome = engine().run(stop)
    assertTrue(outcome is RunOutcome.RetryAt)
    assertEquals("not_validated", status(1).getString("blockedBy"))
    assertEquals(0, fake.log.size)
  }

  @Test
  fun manualModeWaitsForUploadNow() {
    env.uploadSettings = UploadSettings(mode = "manual")
    enqueue(1, "photo", mapOf("media" to 10_000))
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals("manual", status(1).getString("blockedBy"))
    assertTrue(engine().evaluate().runNeeds.isEmpty()) // nothing to schedule
    UploadQueue(store, clock).uploadNow(null, allowMetered = false)
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals("uploaded", status(1).getString("state"))
  }

  @Test
  fun hostsThatRefusePatchGetTheMethodOverride() {
    fake.blockNativePatchHead = true
    enqueue(1, "photo", mapOf("media" to 1_500_000))
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals(1, fake.log.count { it.status == 405 })
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
    assertEquals("1", kv.get("tus.methodOverride"))
  }

  @Test
  fun aTextStatusIsOneCreate() {
    enqueue(1, "text", emptyMap())
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals(1, fake.log.size)
    assertEquals("uploaded", status(1).getString("state"))
  }

  @Test
  fun aDamagedFileFailsPermanentlyAfterThreeShaMismatches() {
    enqueue(1, "photo", mapOf("media" to 300_000))
    // Same size, other bytes: every chunk checksum fits, the whole-file sha256 never does.
    File(files, "${TestJobs.ulid(1)}-media.bin").writeBytes(Random(99).nextBytes(300_000))
    assertEquals(RunOutcome.Done, engine(inlineWaitMaxMs = Long.MAX_VALUE).run(FakeStop(clock)))
    assertEquals(3, fake.log.count { it.path.endsWith("/commit") })
    val s = status(1)
    assertEquals("failed", s.getString("state"))
    assertEquals("sha256_mismatch", s.getJSONObject("error").getString("code"))
  }

  @Test
  fun aMissingFileOrAConflictNeedsHer() {
    enqueue(1, "photo", mapOf("media" to 10_000))
    enqueue(2, "photo", mapOf("media" to 10_000))
    File(files, "${TestJobs.ulid(1)}-media.bin").delete()
    fake.fault = { req, _ -> if (req.body.clone().readUtf8().contains(TestJobs.ulid(2))) FakeTusServer.error(409, "entry_conflict") else null }
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals("file_missing", status(1).getJSONObject("error").getString("code"))
    assertEquals("entry_conflict", status(2).getJSONObject("error").getString("code"))
    assertFalse(engine().evaluate().runNeeds.isNotEmpty())
  }

  @Test
  fun anExpiredSlotIsCreatedAgain() {
    enqueue(1, "photo", mapOf("media" to 600_000))
    val patchNo = AtomicInteger()
    fake.fault = { _, method -> if (method == "PATCH" && patchNo.incrementAndGet() == 1) FakeTusServer.error(404, "not_found") else null }
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals(2, fake.log.count { it.path.endsWith("/app/entries") })
    assertEquals("uploaded", status(1).getString("state"))
  }

  @Test
  fun aSystemStopEndsTheRunAtOnceAndTheNextRunContinues() {
    fake.bytesPerSecond = 1_000_000
    enqueue(1, "video", mapOf("media" to 5 * 1024 * 1024))
    val stop = FakeStop(clock)
    var patchNo = 0
    fake.fault = { _, method ->
      if (method == "PATCH" && ++patchNo == 2) stop.stopped = true
      null
    }
    assertEquals(RunOutcome.Stopped, engine().run(stop))
    val sent = fake.uploads.values.single().offset
    assertTrue(sent > 0)
    fake.fault = null
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
  }

  @Test
  fun anOriginalTooLargeForTheInboxStaysOnThePhoneAndTheMomentGoesOn() {
    // AppHints.fileMaxBytes: the create answers 413 while the entry declares the original.
    fake.fault = { req, method ->
      val body = if (method == "POST" && req.path!!.endsWith("/app/entries")) req.body.clone().readUtf8() else ""
      if (body.contains("\"original\"")) FakeTusServer.error(413, "upload_too_large", JSONObject().put("role", "original").put("maxBytes", 500_000)) else null
    }
    val job = enqueue(1, "video", mapOf("media" to 400_000, "preview" to 20_000, "original" to 900_000))
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals(2, fake.log.count { it.path.endsWith("/app/entries") })
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
    assertTrue("nothing of the original was sent", fake.uploads.values.none { it.role == "original" })
    val s = status(1)
    assertEquals("uploaded", s.getString("state"))
    val original = s.getJSONObject("original")
    assertEquals("failed", original.getString("state"))
    assertEquals(900_000L, original.getLong("totalBytes"))
    assertEquals("upload_too_large", original.getJSONObject("error").getString("code"))
    assertTrue(original.getJSONObject("error").getBoolean("permanent"))
    // The outbox enqueues the same entry again (app start): the job stays as it is.
    UploadQueue(store, clock).enqueue(JSONObject(job.toString()), env.uploadSettings)
    assertEquals("uploaded", status(1).getString("state"))
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals(2, fake.log.count { it.path.endsWith("/app/entries") })
  }

  @Test
  fun aMediaFileTooLargeForTheInboxNeedsHer() {
    fake.fault = { req, method ->
      if (method == "POST" && req.path!!.endsWith("/app/entries")) FakeTusServer.error(413, "upload_too_large", JSONObject().put("role", "media")) else null
    }
    enqueue(1, "video", mapOf("media" to 400_000, "original" to 900_000))
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals(1, fake.log.count { it.path.endsWith("/app/entries") })
    val s = status(1)
    assertEquals("failed", s.getString("state"))
    assertEquals("upload_too_large", s.getJSONObject("error").getString("code"))
    assertEquals(2, UploadJob(store.get(TestJobs.ulid(1))!!).declaredRoles.size) // the entry is untouched
  }

  @Test
  fun aFinishedQueueIsNotRewrittenOnEveryLook() {
    enqueue(1, "photo", mapOf("media" to 10_000))
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    val file = File(tmp.root, "jobs/${TestJobs.ulid(1)}.json")
    assertTrue(file.setLastModified(1_000_000L))
    val events = listener.states.size
    repeat(3) { engine().evaluate() }
    assertEquals(1_000_000L, file.lastModified())
    assertEquals(events, listener.states.size)
  }

  @Test
  fun aNudgeEndsTheWaitOfTheActiveRun() {
    // Real time here: a run behind a captive portal polls every 5 s. When something changes (a new
    // job, "Upload now", a new token, new settings), UploadScheduler nudges the run, which looks
    // again at once instead of after its wait.
    val realEnv = FakeEnv(WallClock, net = PORTAL, base = server.url("/"))
    enqueue(1, "photo", mapOf("media" to 10_000))
    val engine = UploadEngine(store, realEnv, RequestBudget(WallClock, MemoryKeyValueStore()), UploadThrottle(WallClock, MemoryKeyValueStore(), Random(3)), MemoryKeyValueStore(), listener)
    val outcome = java.util.concurrent.atomic.AtomicReference<RunOutcome>()
    val stop = RealStopSignal()
    val t = Thread { outcome.set(engine.run(stop)) }.apply { start() }
    try {
      assertTrue(waitUntil(5_000) { UploadEngine.isRunning && status(1).optString("blockedBy") == "not_validated" })
      Thread.sleep(300) // the run is inside its 5 s poll now
      realEnv.net = WIFI
      val nudgedAt = System.nanoTime()
      UploadEngine.nudge()
      t.join(10_000)
      assertEquals(RunOutcome.Done, outcome.get())
      assertTrue("looked again at once", System.nanoTime() - nudgedAt < 2_500_000_000L)
      assertEquals("uploaded", status(1).getString("state"))
    } finally {
      stop.stop()
      t.join(5_000)
    }
  }

  @Test
  fun aWakeEndsOneWaitWithoutStopping() {
    val signal = RealStopSignal()
    val started = System.nanoTime()
    val waker = Thread {
      Thread.sleep(100)
      signal.wake()
    }.apply { start() }
    assertTrue(signal.sleep(10_000))
    assertTrue("woke early", System.nanoTime() - started < 5_000_000_000L)
    assertFalse(signal.stopped)
    waker.join()
    signal.wake() // a wake between two waits ends the next one at once
    assertTrue(signal.sleep(10_000))
    signal.stop()
    assertFalse(signal.sleep(10))
  }

  private fun waitUntil(ms: Long, condition: () -> Boolean): Boolean {
    val deadline = System.currentTimeMillis() + ms
    while (System.currentTimeMillis() < deadline) {
      if (condition()) return true
      Thread.sleep(10)
    }
    return condition()
  }

  @Test
  fun aSecondRunInTheSameProcessIsBusy() {
    enqueue(1, "photo", mapOf("media" to 10_000))
    val inner = mutableListOf<RunOutcome>()
    fake.fault = { _, _ ->
      if (inner.isEmpty()) inner += engine().run(FakeStop(clock))
      null
    }
    assertEquals(RunOutcome.Done, engine().run(FakeStop(clock)))
    assertEquals(listOf<RunOutcome>(RunOutcome.Busy), inner)
  }
}
