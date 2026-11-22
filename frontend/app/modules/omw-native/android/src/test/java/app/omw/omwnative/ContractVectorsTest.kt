package app.omw.omwnative

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The Kotlin mirrors against the contract's shared vectors (fixtures/vectors/app-chunks.json). */
class ContractVectorsTest {
  private val vectors: JSONObject by lazy {
    val dir = System.getProperty("omw.fixtures") ?: error("omw.fixtures is not set (see omw-native.gradle)")
    JSONObject(File(dir, "vectors/app-chunks.json").readText())
  }

  @Test
  fun nextChunkBytesMatchesEveryVector() {
    val next = vectors.getJSONArray("next")
    assertTrue(next.length() >= 8)
    for (i in 0 until next.length()) {
      val v = next.getJSONObject(i)
      val outcome = v.getJSONObject("outcome")
      val bounds = v.optJSONObject("bounds")
      val actual = ChunkSizer.next(
        current = v.getLong("current"),
        ok = outcome.getBoolean("ok"),
        bytes = outcome.optLong("bytes"),
        ms = outcome.optLong("ms"),
        minBytes = bounds?.getLong("minBytes") ?: ChunkSizer.MIN_BYTES,
        maxBytes = bounds?.getLong("maxBytes") ?: ChunkSizer.MAX_BYTES,
      )
      assertEquals(v.getString("name"), v.getLong("expected"), actual)
    }
  }

  @Test
  fun uploadChecksumHeaderMatchesTheContract() {
    val inputs = mapOf("sha256 of the empty string" to "", "sha256 of \"abc\"" to "abc")
    val checksum = vectors.getJSONArray("checksum")
    for (i in 0 until checksum.length()) {
      val v = checksum.getJSONObject(i)
      val input = inputs.getValue(v.getString("name"))
      assertEquals(v.getString("header"), TusClient.checksumHeader(input.toByteArray()))
    }
  }
}
