package app.omw.omwnative

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/** The wire format of each request (APP_TUS of @omw/contracts/app). */
class TusClientTest {
  private val clock = FakeClock()
  private lateinit var server: MockWebServer
  private lateinit var client: TusClient
  private val kv = MemoryKeyValueStore()
  private val stop = FakeStop(clock)

  @Before
  fun setUp() {
    server = MockWebServer().apply { start() }
    client = TusClient(TusClient.httpClient(), server.url("/base/"), FakeTusServer.TEST_TOKEN, RequestBudget(clock, kv), clock, kv)
  }

  @After
  fun tearDown() = server.shutdown()

  @Test
  fun createSendsTheContractEnvelope() {
    server.enqueue(MockResponse().setResponseCode(201).setBody("""{"entryId":"x","uploads":[]}"""))
    val entry = JSONObject().put("entryId", TestJobs.ulid(1))
    val r = client.createEntry(entry, "2026-11-20T10:00:00.000Z", stop)
    assertEquals(201, r.status)
    val req = server.takeRequest()
    assertEquals("POST", req.method)
    assertEquals("/base/api/v1/app/entries", req.path)
    assertEquals("Bearer ${FakeTusServer.TEST_TOKEN}", req.getHeader("Authorization"))
    assertEquals("application/json; charset=utf-8", req.getHeader("Content-Type"))
    val body = JSONObject(req.body.readUtf8())
    assertEquals(1, body.getInt("contractVersion"))
    assertEquals("2026-11-20T10:00:00.000Z", body.getString("clientNow"))
    assertEquals(TestJobs.ulid(1), body.getJSONObject("entry").getString("entryId"))
  }

  @Test
  fun patchCarriesTheTusHeaders() {
    server.enqueue(MockResponse().setResponseCode(204).setHeader("Upload-Offset", "1003"))
    val data = ByteArray(10) { it.toByte() }
    val r = client.patch("u_abcdefghijklmnop", 1000, data, 3, TusClient.checksumHeader(data, 3), stop)
    assertEquals(204, r.status)
    assertEquals(1003L, r.uploadOffset)
    val req = server.takeRequest()
    assertEquals("PATCH", req.method)
    assertEquals("/base/api/v1/app/uploads/u_abcdefghijklmnop", req.path)
    assertEquals("1.0.0", req.getHeader("Tus-Resumable"))
    assertEquals("application/offset+octet-stream", req.getHeader("Content-Type"))
    assertEquals("1000", req.getHeader("Upload-Offset"))
    assertEquals("3", req.getHeader("Content-Length"))
    assertEquals(TusClient.checksumHeader(byteArrayOf(0, 1, 2)), req.getHeader("Upload-Checksum"))
    assertEquals(3L, req.bodySize)
  }

  @Test
  fun errorsCarryCodeOffsetAndRetryAfter() {
    server.enqueue(
      MockResponse().setResponseCode(503).setHeader("Retry-After", "42")
        .setBody("""{"error":{"code":"transfer_busy","message":"busy"}}"""),
    )
    val r = client.commit(TestJobs.ulid(1), listOf("media", "preview"), stop)
    assertEquals(503, r.status)
    assertEquals("transfer_busy", r.errorCode)
    assertEquals(42_000L, r.retryAfterMs)
    assertNull(r.uploadOffset)
    val req = server.takeRequest()
    assertEquals("/base/api/v1/app/entries/${TestJobs.ulid(1)}/commit", req.path)
    assertEquals("""{"roles":["media","preview"]}""", req.body.readUtf8())
    server.enqueue(MockResponse().setResponseCode(409).setHeader("Upload-Offset", "65536"))
    val head = client.head("u_abcdefghijklmnop", stop)
    assertEquals(65_536L, head.uploadOffset)
    assertEquals("HEAD", server.takeRequest().method)
  }

  @Test
  fun aHostWithoutPatchGetsPostWithMethodOverrideFromThenOn() {
    server.enqueue(MockResponse().setResponseCode(405))
    server.enqueue(MockResponse().setResponseCode(204).setHeader("Upload-Offset", "3"))
    server.enqueue(MockResponse().setResponseCode(200).setHeader("Upload-Offset", "3"))
    val data = byteArrayOf(1, 2, 3)
    assertEquals(204, client.patch("u_abcdefghijklmnop", 0, data, 3, TusClient.checksumHeader(data), stop).status)
    assertEquals("PATCH", server.takeRequest().method)
    val overridden = server.takeRequest()
    assertEquals("POST", overridden.method)
    assertEquals("PATCH", overridden.getHeader("X-HTTP-Method-Override"))
    assertEquals("0", overridden.getHeader("Upload-Offset"))
    assertEquals(3L, overridden.bodySize)
    assertEquals(200, client.head("u_abcdefghijklmnop", stop).status)
    val head = server.takeRequest()
    assertEquals("POST", head.method)
    assertEquals("HEAD", head.getHeader("X-HTTP-Method-Override"))
  }

  @Test
  fun aStoppedRunSendsNothing() {
    val stopped = FakeStop(clock).apply { stopped = true }
    assertEquals(ApiResult.STOPPED, client.commit(TestJobs.ulid(1), listOf("media"), stopped).status)
    assertEquals(0, server.requestCount)
  }
}
