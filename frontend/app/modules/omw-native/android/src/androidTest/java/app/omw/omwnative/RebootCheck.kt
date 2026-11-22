package app.omw.omwnative

import android.app.job.JobScheduler
import android.net.NetworkCapabilities
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The two halves of the reboot check (android/harness/reboot-check.sh runs them with a real
 * `adb reboot` in between; a normal test run skips them):
 * 1. [a_prepare]: a video job waits for Wi-Fi (mobile data only, Wi-Fi off) as a persisted UIDT job.
 * 2. after the reboot, [b_resume]: the job is still scheduled; when Wi-Fi comes back, JobScheduler
 *    runs it by itself (nothing here schedules it again) and the upload completes.
 */
@RunWith(AndroidJUnit4::class)
class RebootCheck {
  private val context = Device.context
  private val outbox = File(context.filesDir, "outbox-reboot")

  @Before
  fun onlyInTheRebootRun() {
    assumeTrue("only in android/harness/reboot-check.sh", InstrumentationRegistry.getArguments().getString("omwReboot") == "1")
  }

  @Test
  fun a_prepare() {
    Device.restoreNetworks()
    Device.resetUploader()
    TokenVault(context).set(FakeTusServer.TEST_TOKEN)
    UploaderConfig.setBaseUrl(context, "http://127.0.0.1:$PORT/")
    outbox.deleteRecursively()
    outbox.mkdirs()
    UploadRuntime.queue(context).enqueue(TestJobs.job(outbox, 1, "video", mapOf("media" to 3 * 1024 * 1024)), UploadSettingsStore(context).read())

    Device.wifi(false)
    Device.waitForNetwork("mobile data") { it.connected && !it.unmetered }
    ActivityScenario.launch(TestHostActivity::class.java).use { UploadScheduler.schedule(context) }

    val job = context.getSystemService(JobScheduler::class.java).getPendingJob(UploadScheduler.UIDT_JOB_ID)
    assertNotNull("a UIDT job waits", job)
    assertTrue(job!!.isUserInitiated)
    assertTrue("persisted", job.isPersisted)
    assertTrue(job.requiredNetwork!!.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
    assertEquals("wifi_only", status().getString("blockedBy"))
  }

  @Test
  fun b_resume() {
    val js = context.getSystemService(JobScheduler::class.java)
    val job = js.getPendingJob(UploadScheduler.UIDT_JOB_ID)
    assertNotNull("the UIDT job survived the reboot", job)
    assertTrue(job!!.isUserInitiated)
    assertEquals("waiting", status().getString("state"))

    val fake = FakeTusServer()
    val server = MockWebServer().apply {
      dispatcher = fake
      start(PORT)
    }
    try {
      Device.wifi(true)
      Device.waitFor("the upload after the reboot", 240_000, 500) {
        fake.uploads.values.any { it.role == "media" && it.committed }
      }
      assertArrayEquals(File(outbox, "${TestJobs.ulid(1)}-media.bin").readBytes(), fake.bytesOf("media"))
      Device.waitFor("the job file to say uploaded", 10_000) { status().getString("state") == "uploaded" }
    } finally {
      server.shutdown()
      Device.restoreNetworks()
      Device.resetUploader()
      TokenVault(context).clear()
      outbox.deleteRecursively()
    }
  }

  private fun status() = UploadJobStore(context).get(TestJobs.ulid(1))!!.getJSONObject("status")

  companion object {
    const val PORT = 18_765
  }
}
