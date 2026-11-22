package app.omw.omwnative

import android.app.job.JobScheduler
import android.net.NetworkCapabilities
import android.os.SystemClock
import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.ListenableWorker
import androidx.work.testing.TestWorkerBuilder
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.Executors

/**
 * The uploader on the emulator, against the contract's fake API (MockWebServer inside the test):
 * - the UIDT job (API 34+) killed mid-upload resumes from the server's offset by itself;
 * - Wi-Fi only: nothing is sent on mobile data, the job runs when Wi-Fi comes back, also when
 *   Wi-Fi goes away mid-upload (Wi-Fi and mobile data are switched with `svc wifi|data`);
 * - the WorkManager path (API 29–33) uploads too;
 * - the token vault works without JS.
 * The uploader's JobService runs in its own process here (androidTest manifest), so the test and
 * the fake API survive the kill. The radios are always switched back on.
 */
@RunWith(AndroidJUnit4::class)
class UploaderInstrumentedTest {
  private val context = Device.context
  private lateinit var server: MockWebServer
  private lateinit var fake: FakeTusServer
  private lateinit var outbox: File

  @Before
  fun setUp() {
    Device.restoreNetworks()
    Device.resetUploader()
    fake = FakeTusServer()
    server = MockWebServer().apply {
      dispatcher = fake
      start()
    }
    TokenVault(context).set(FakeTusServer.TEST_TOKEN)
    UploaderConfig.setBaseUrl(context, server.url("/").toString())
    outbox = File(context.filesDir, "outbox-test").apply {
      deleteRecursively()
      mkdirs()
    }
  }

  @After
  fun tearDown() {
    Device.restoreNetworks()
    Device.resetUploader()
    TokenVault(context).clear()
    server.shutdown()
    outbox.deleteRecursively()
  }

  private fun enqueue(n: Int, kind: String, roles: Map<String, Int>): JSONObject {
    val job = TestJobs.job(outbox, n, kind, roles)
    UploadRuntime.queue(context).enqueue(job, UploadSettingsStore(context).read())
    return job
  }

  private fun status(n: Int): JSONObject = UploadJobStore(context).get(TestJobs.ulid(n))!!.getJSONObject("status")

  private fun localBytes(n: Int, role: String) = File(outbox, "${TestJobs.ulid(n)}-$role.bin").readBytes()

  private fun serverDone(n: Int, role: String = "media") =
    fake.uploads.values.any { it.entryId == TestJobs.ulid(n) && it.role == role && it.committed }

  @Test
  fun aKilledUidtUploadResumesFromTheServersOffsetByItself() {
    fake.patchDelayMs = 700 // a slow link, so the kill lands mid-upload
    fake.chunkMax = 1024 * 1024L // no growing chunks: ~10 paced PATCHes for 10 MiB
    // JobScheduler reschedules the killed UIDT; the WorkManager backup takes over if it doesn't
    // start it again (in the app it runs 15 minutes after the UIDT was scheduled).
    UploadScheduler.backupDelayMs = 30_000
    val size = 10 * 1024 * 1024
    enqueue(1, "video", mapOf("media" to size))
    ActivityScenario.launch(TestHostActivity::class.java).use {
      UploadScheduler.schedule(context)
      assertNotNull("a UIDT job is scheduled", context.getSystemService(JobScheduler::class.java).getPendingJob(UploadScheduler.UIDT_JOB_ID)?.takeIf { it.isUserInitiated })
    }
    Device.waitFor("2 chunks on the server", 60_000) { fake.log.count { it.method == "PATCH" && it.status == 204 } >= 2 }
    val beforeKill = fake.log.size
    val offsetAtKill = fake.uploads.values.single().offset
    assertTrue("the uploader runs in its own process", Device.killUploadProcess())
    val killedAt = SystemClock.elapsedRealtime()
    Log.i(TAG, "killed the uploader at offset $offsetAtKill of $size")

    val workerRuns = UploadWorker.runs
    Device.waitFor("the upload to resume and finish", 240_000, 500) { serverDone(1) }
    val by = if (UploadWorker.runs > workerRuns) "the WorkManager backup" else "the restarted UIDT job"
    Log.i(TAG, "finished ${(SystemClock.elapsedRealtime() - killedAt) / 1000}s after the kill, by $by")
    val after = fake.log.drop(beforeKill).filter { it.method == "PATCH" || it.method == "HEAD" }
    val firstPatch = after.first { it.method == "PATCH" }
    assertTrue("resumed at ${firstPatch.offset}, not from 0", firstPatch.offset!! >= offsetAtKill && firstPatch.offset!! > 0)
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
    Device.waitFor("the job file to say uploaded", 10_000) { status(1).getString("state") == "uploaded" }
  }

  @Test
  fun wifiOnlySendsNothingOnMobileDataAndGoesOnWifi() {
    Device.wifi(false)
    Device.waitForNetwork("mobile data") { it.connected && !it.unmetered && it.transport == "cellular" }
    enqueue(1, "video", mapOf("media" to 2 * 1024 * 1024))
    ActivityScenario.launch(TestHostActivity::class.java).use { UploadScheduler.schedule(context) }

    assertEquals("waiting", status(1).getString("state"))
    assertEquals("wifi_only", status(1).getString("blockedBy"))
    val job = context.getSystemService(JobScheduler::class.java).getPendingJob(UploadScheduler.UIDT_JOB_ID)
    assertNotNull(job)
    assertTrue("waits for an unmetered network", job!!.requiredNetwork!!.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
    SystemClock.sleep(8_000)
    assertEquals("nothing sent on mobile data", 0, fake.log.size)

    val wifiAt = System.currentTimeMillis()
    Device.wifi(true)
    Device.waitFor("the upload on Wi-Fi", 120_000, 500) { serverDone(1) }
    assertTrue(fake.log.all { it.atMs >= wifiAt })
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
  }

  @Test
  fun losingWifiMidUploadPausesOnMobileDataAndResumesFromTheOffsetOnWifi() {
    fake.patchDelayMs = 700
    // The server's chunk bound keeps every PATCH at 512 KiB (~16 paced requests for 8 MiB):
    // switching Wi-Fi off takes a few seconds, and growing chunks would finish the file first.
    fake.chunkMax = 512 * 1024L
    // Who resumes: the kept UIDT job, or WorkManager (in the app the follow-up enqueued beside it;
    // here the UIDT runs in its own process without WorkManager, so the backup stands in for it).
    UploadScheduler.backupDelayMs = 20_000
    val size = 8 * 1024 * 1024
    enqueue(1, "video", mapOf("media" to size))
    ActivityScenario.launch(TestHostActivity::class.java).use { UploadScheduler.schedule(context) }
    Device.waitFor("2 chunks on Wi-Fi", 60_000) { fake.log.count { it.method == "PATCH" && it.status == 204 } >= 2 }

    Device.wifi(false) // she walks out of the café
    Device.waitForNetwork("mobile data") { it.connected && !it.unmetered }
    SystemClock.sleep(4_000) // a PATCH that was already on its way may still land
    val quietFrom = fake.log.size
    val offset = fake.uploads.values.single().offset
    SystemClock.sleep(10_000)
    assertEquals("nothing is sent on mobile data", quietFrom, fake.log.size)
    assertTrue("stopped midway at $offset", offset in 1 until size)
    val job = context.getSystemService(JobScheduler::class.java).getPendingJob(UploadScheduler.UIDT_JOB_ID)
    assertNotNull("the UIDT job keeps waiting for Wi-Fi", job)
    assertTrue(job!!.isUserInitiated)
    // The app's bridge calls this on every change of the default network (OmwUploaderModule):
    // the status follows the network she is on now, not the gap between Wi-Fi and mobile data.
    UploadScheduler.onNetworkChanged(context)
    assertEquals("wifi_only", status(1).getString("blockedBy"))
    assertEquals("still nothing sent", quietFrom, fake.log.size)

    Device.wifi(true) // nothing here schedules it again
    val workerRuns = UploadWorker.runs
    Device.waitFor("the rest on Wi-Fi", 240_000, 500) { serverDone(1) }
    Log.i(TAG, "resumed on Wi-Fi by ${if (UploadWorker.runs > workerRuns) "WorkManager" else "the kept UIDT job"}")
    val firstPatch = fake.log.drop(quietFrom).first { it.method == "PATCH" }
    assertTrue("resumed at ${firstPatch.offset}, not from 0", firstPatch.offset!! >= offset)
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
  }

  @Test
  fun photosMayUseMobileDataWhileVideosAndOriginalsWaitForWifi() {
    UploadSettingsStore(context).update(mapOf("photosOnMobileData" to true))
    Device.wifi(false)
    Device.waitForNetwork("mobile data") { it.connected && it.validated && !it.unmetered }
    enqueue(1, "photo", mapOf("media" to 300_000, "original" to 600_000))
    enqueue(2, "video", mapOf("media" to 300_000))
    ActivityScenario.launch(TestHostActivity::class.java).use { UploadScheduler.schedule(context) }
    Device.waitFor("the photo on mobile data", 60_000, 500) { serverDone(1) }
    SystemClock.sleep(3_000)
    assertTrue("the original waited", !serverDone(1, "original"))
    assertTrue("the video waited", fake.uploads.values.none { it.entryId == TestJobs.ulid(2) && it.offset > 0 })
    val original = fake.uploads.values.single { it.role == "original" }.id
    assertTrue(fake.log.none { it.path.endsWith(original) })

    // Back on Wi-Fi with the app open: the rest goes.
    Device.wifi(true)
    Device.waitForNetwork("Wi-Fi") { it.unmetered && it.validated }
    ActivityScenario.launch(TestHostActivity::class.java).use { UploadScheduler.schedule(context) }
    Device.waitFor("the original and the video on Wi-Fi", 120_000, 500) { serverDone(1, "original") && serverDone(2) }
    assertArrayEquals(localBytes(1, "original"), fake.bytesOf("original"))
  }

  @Test
  fun noNetworkAtAllWaitsAsNoNetwork() {
    Device.wifi(false)
    Device.data(false)
    Device.waitForNetwork("no network") { !it.connected }
    UploadSettingsStore(context).update(mapOf("wifiOnly" to false))
    enqueue(1, "photo", mapOf("media" to 10_000))
    ActivityScenario.launch(TestHostActivity::class.java).use { UploadScheduler.schedule(context) }
    assertEquals("no_network", status(1).getString("blockedBy"))
    SystemClock.sleep(3_000)
    assertEquals(0, fake.log.size)
    Device.data(true)
    Device.waitFor("the upload on mobile data", 120_000, 500) { serverDone(1) }
  }

  @Test
  fun theWorkManagerPathUploadsToo() {
    // API 29–33 (and background follow-ups on 34+) use a plain WorkManager worker.
    enqueue(1, "photo", mapOf("media" to 1_500_000, "preview" to 50_000))
    UploadScheduler.forceWorkManager = true
    UploadScheduler.schedule(context)
    assertNull(context.getSystemService(JobScheduler::class.java).getPendingJob(UploadScheduler.UIDT_JOB_ID))
    Device.waitFor("the WorkManager upload", 120_000, 500) { serverDone(1) && serverDone(1, "preview") }
    assertArrayEquals(localBytes(1, "media"), fake.bytesOf("media"))
  }

  @Test
  fun theWorkerReportsSuccessAndLeavesNothingBehind() {
    enqueue(1, "voice", mapOf("media" to 200_000))
    val worker = TestWorkerBuilder.from(context, UploadWorker::class.java, Executors.newSingleThreadExecutor()).build()
    assertTrue(worker.doWork() is ListenableWorker.Result.Success)
    assertTrue(serverDone(1))
    assertEquals("uploaded", status(1).getString("state"))
  }

  @Test
  fun theTokenVaultIsEncryptedAndReadableWithoutJs() {
    val vault = TokenVault(context)
    val token = "omw_" + "A".repeat(20) + "b".repeat(23)
    vault.set(token)
    assertEquals(token, TokenVault(context).get())
    val file = File(context.noBackupFilesDir, "omw-token.vault")
    assertTrue(file.exists())
    assertTrue("sealed, not plain", !String(file.readBytes(), Charsets.ISO_8859_1).contains("AAAAAAAAAAbbbb"))
    file.writeBytes(file.readBytes().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() })
    assertNull("a damaged file reads as not paired", vault.get())
    vault.clear()
    assertNull(vault.get())
  }

  companion object {
    private const val TAG = "OmwUploaderTest"
  }
}
