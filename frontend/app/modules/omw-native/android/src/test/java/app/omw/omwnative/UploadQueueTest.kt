package app.omw.omwnative

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** enqueue / cancel / uploadNow / status / prune, and the API-base validation. */
class UploadQueueTest {
  @get:Rule
  val tmp = TemporaryFolder()

  private val clock = FakeClock()
  private val store by lazy { UploadJobStore(tmp.newFolder("jobs")) }
  private val queue by lazy { UploadQueue(store, clock) }
  private val files by lazy { tmp.newFolder("outbox") }

  @Test
  fun enqueueValidatesTheJob() {
    val good = TestJobs.job(files, 1, "photo", mapOf("media" to 1000, "preview" to 200))
    fun bad(change: (JSONObject) -> Unit) = assertThrows(IllegalArgumentException::class.java) {
      queue.enqueue(JSONObject(good.toString()).also(change), UploadSettings())
    }
    bad { it.put("entryId", "not-a-ulid") }
    bad { it.getJSONObject("entry").put("entryId", TestJobs.ulid(2)) }
    bad { it.getJSONArray("files").getJSONObject(0).put("uri", "content://media/1") }
    bad { it.getJSONArray("files").remove(1) } // preview declared, no local file
    bad { it.getJSONObject("entry").getJSONArray("files").getJSONObject(0).put("bytes", 999) } // size differs
    bad { it.put("mode", "sometimes") }
    val status = queue.enqueue(good, UploadSettings())
    assertEquals("queued", status.getString("state"))
    assertEquals(1200L, status.getLong("totalBytes"))
    assertEquals(JSONObject.NULL, status.get("original"))
  }

  @Test
  fun manualModeWaitsForUploadNow() {
    val job = TestJobs.job(files, 1, "photo", mapOf("media" to 1000))
    assertEquals("manual", queue.enqueue(job, UploadSettings(mode = "manual")).getString("blockedBy"))
    // A per-entry "auto" from the publish sheet wins over the setting.
    val auto = TestJobs.job(files, 2, "photo", mapOf("media" to 1000), mode = "auto")
    assertEquals("queued", queue.enqueue(auto, UploadSettings(mode = "manual")).getString("state"))
    assertEquals(2, queue.uploadNow(null, allowMetered = false))
    assertTrue(UploadJob(store.get(TestJobs.ulid(1))!!).manualReleased)
    assertFalse(UploadJob(store.get(TestJobs.ulid(1))!!).allowMetered)
    assertEquals(1, queue.uploadNow(TestJobs.ulid(1), allowMetered = true))
    assertTrue(UploadJob(store.get(TestJobs.ulid(1))!!).allowMetered)
    assertFalse(UploadJob(store.get(TestJobs.ulid(2))!!).allowMetered)
  }

  @Test
  fun reEnqueueKeepsTheTransferStateOfTheSameEntryOnly() {
    val job = TestJobs.job(files, 1, "video", mapOf("media" to 1000))
    queue.enqueue(job, UploadSettings())
    store.update(TestJobs.ulid(1)) { UploadJob(it).transfer.put("created", true) }
    queue.enqueue(JSONObject(job.toString()), UploadSettings())
    assertTrue(UploadJob(store.get(TestJobs.ulid(1))!!).created)
    val changed = JSONObject(job.toString()).apply { getJSONObject("entry").put("caption", "new") }
    queue.enqueue(changed, UploadSettings())
    assertFalse(UploadJob(store.get(TestJobs.ulid(1))!!).created)
  }

  @Test
  fun reEnqueueOfAnUploadedEntryKeepsItsStatusEvenWhenTheFilesAreGone() {
    val job = TestJobs.job(files, 1, "photo", mapOf("media" to 1000))
    queue.enqueue(job, UploadSettings())
    val done = UploadJob.status(TestJobs.ulid(1), "uploaded", 1000, 1000, null, null, clock.nowMs(), null)
    store.update(TestJobs.ulid(1)) { json ->
      UploadJob(json).transfer.put("created", true)
        .put("slots", JSONObject().put("media", JSONObject().put("uploadId", "u_0123456789abcdef").put("bytes", 1000).put("offset", 1000).put("committed", true)))
      json.put("status", done)
    }
    files.listFiles()!!.forEach { it.delete() } // the outbox deleted the artifact after the upload
    val again = queue.enqueue(JSONObject(job.toString()).put("mode", "manual"), UploadSettings())
    assertEquals("uploaded", again.getString("state"))
    assertTrue(UploadJob(store.get(TestJobs.ulid(1))!!).done)
  }

  @Test
  fun aNewModeOnlyChangesAJobThatHasNotStarted() {
    val job = TestJobs.job(files, 1, "photo", mapOf("media" to 1000))
    assertEquals("queued", queue.enqueue(job, UploadSettings()).getString("state"))
    val manual = queue.enqueue(JSONObject(job.toString()).put("mode", "manual"), UploadSettings())
    assertEquals("waiting", manual.getString("state"))
    assertEquals("manual", manual.getString("blockedBy"))
    val auto = queue.enqueue(JSONObject(job.toString()).put("mode", "auto"), UploadSettings())
    assertEquals("queued", auto.getString("state"))
    assertEquals(JSONObject.NULL, auto.get("blockedBy"))
  }

  @Test
  fun nullMembersFromJsMeanAbsent() {
    val job = TestJobs.job(files, 1, "photo", mapOf("media" to 1000))
    job.getJSONObject("entry").put("caption", JSONObject.NULL).put("visibility", JSONObject.NULL)
      .getJSONObject("media").put("accessibilityLabel", JSONObject.NULL)
    queue.enqueue(job, UploadSettings())
    val entry = UploadJob(store.get(TestJobs.ulid(1))!!).entry
    assertFalse(entry.has("caption"))
    assertFalse(entry.has("visibility"))
    assertFalse(entry.getJSONObject("media").has("accessibilityLabel"))
    assertEquals(1600, entry.getJSONObject("media").getInt("width"))
    assertEquals(1, entry.getJSONArray("files").length())
  }

  @Test
  fun unchangedJobsAreNotRewritten() {
    queue.enqueue(TestJobs.job(files, 1, "photo", mapOf("media" to 1000)), UploadSettings())
    val file = tmp.root.resolve("jobs/${TestJobs.ulid(1)}.json")
    assertTrue(file.setLastModified(1_000_000L))
    store.updateIf(TestJobs.ulid(1)) { false }
    assertEquals(1_000_000L, file.lastModified())
    store.updateIf(TestJobs.ulid(1)) { it.put("x", 1); true }
    assertTrue(file.lastModified() > 1_000_000L)
    assertNull(store.updateIf(TestJobs.ulid(9)) { true })
  }

  @Test
  fun cancelForgetsTheJob() {
    queue.enqueue(TestJobs.job(files, 1, "photo", mapOf("media" to 1000)), UploadSettings())
    assertEquals("cancelled", queue.cancel(TestJobs.ulid(1))!!.getString("state"))
    assertNull(store.get(TestJobs.ulid(1)))
    assertNull(queue.cancel(TestJobs.ulid(1)))
    assertTrue(queue.statuses(null).isEmpty())
  }

  @Test
  fun pruneRemovesOnlyJobsFinishedAWeekAgo() {
    queue.enqueue(TestJobs.job(files, 1, "photo", mapOf("media" to 1000)), UploadSettings())
    queue.enqueue(TestJobs.job(files, 2, "photo", mapOf("media" to 1000)), UploadSettings())
    store.update(TestJobs.ulid(1)) { UploadJob(it).transfer.put("doneAt", clock.nowMs()) }
    clock.advance(UploadQueue.PRUNE_AFTER_MS + 1)
    assertEquals(1, queue.prune())
    assertNull(store.get(TestJobs.ulid(1)))
    assertNotNull(store.get(TestJobs.ulid(2)))
  }

  @Test
  fun storeSkipsDamagedFilesAndWritesAtomically() {
    queue.enqueue(TestJobs.job(files, 1, "photo", mapOf("media" to 1000)), UploadSettings())
    val dir = tmp.root.resolve("jobs")
    dir.resolve("${TestJobs.ulid(2)}.json").writeText("{broken")
    dir.resolve("${TestJobs.ulid(3)}.json.tmp").writeText("{}")
    assertEquals(listOf(TestJobs.ulid(1)), store.all().map { it.getString("entryId") })
  }

  @Test
  fun apiBaseMustBeHttpsOrTheLocalApi() {
    val allow = { _: String -> true }
    assertEquals("https://api.example.org/", UploaderConfig.parse("https://api.example.org", allow).toString())
    assertEquals("https://example.org/omw/", UploaderConfig.parse("https://example.org/omw/", allow).toString())
    assertEquals("http://127.0.0.1:8080/", UploaderConfig.parse("http://127.0.0.1:8080", allow).toString())
    for (bad in listOf("http://api.example.org", "ftp://x", "https://u:p@example.org", "https://example.org/?a=1", "nonsense")) {
      assertThrows(bad, IllegalArgumentException::class.java) { UploaderConfig.parse(bad, allow) }
    }
    assertThrows(IllegalArgumentException::class.java) { UploaderConfig.parse("http://127.0.0.1:8080", { false }) }
  }

  @Test
  fun apiBaseFallsBackToTheBuildsEmbeddedAppConfig() {
    val allow = { _: String -> true }
    val config = """{"name":"On My Way","extra":{"apiBaseUrl":"https://api.example.org","versionName":"dev"}}"""
    assertEquals("https://api.example.org/", UploaderConfig.fromAppConfig(config, allow).toString())
    assertEquals("http://127.0.0.1:8080/", UploaderConfig.fromAppConfig("""{"extra":{"apiBaseUrl":"http://127.0.0.1:8080"}}""", allow).toString())
    // Absent, invalid or not allowed: no API base (nothing is sent).
    assertNull(UploaderConfig.fromAppConfig("""{"extra":{}}""", allow))
    assertNull(UploaderConfig.fromAppConfig("""{"extra":{"apiBaseUrl":"http://evil.example.org"}}""", allow))
    assertNull(UploaderConfig.fromAppConfig("""{"extra":{"apiBaseUrl":"http://127.0.0.1:8080"}}""") { false })
    assertNull(UploaderConfig.fromAppConfig("not json", allow))
  }
}
