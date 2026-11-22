package app.omw.omwnative

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * MediaExport on the emulator: a GPS-tagged input must lose its location (and every other
 * metadata entry) while trim, mute, frame cap, size limits and orientation work (app-plan §6.2
 * done-when 7).
 */
@RunWith(AndroidJUnit4::class)
class MediaExportInstrumentedTest {
  private val context = Device.context
  private lateinit var dir: File

  @Before
  fun setUp() {
    dir = File(context.filesDir, "outbox-test").apply {
      deleteRecursively()
      mkdirs()
    }
  }

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  private fun extract(file: File): List<MediaFormat> {
    val e = MediaExtractor()
    try {
      e.setDataSource(file.path)
      return (0 until e.trackCount).map { e.getTrackFormat(it) }
    } finally {
      e.release()
    }
  }

  private fun meta(file: File, key: Int): String? {
    val r = MediaMetadataRetriever()
    try {
      r.setDataSource(file.path)
      return r.extractMetadata(key)
    } finally {
      r.release()
    }
  }

  @Test
  fun aGpsTaggedPortraitVideoLosesItsLocationKeepsItsOrientationAndIsCappedTo30fps() {
    val input = File(dir, "camera.mp4")
    TestMedia.writeVideo(input, 320, 240, fps = 60, seconds = 3.0, rotation = 90, location = 48.8584f to 2.2945f)
    assertNotNull("the input really carries a location", meta(input, MediaMetadataRetriever.METADATA_KEY_LOCATION))
    assertTrue(TestMedia.contains(input, byteArrayOf(0xA9.toByte(), 'x'.code.toByte(), 'y'.code.toByte(), 'z'.code.toByte())))

    val output = File(dir, "media.mp4")
    val progress = mutableListOf<Float>()
    val result = VideoExporter(context).export(
      VideoExportRequest("v1", Uri.fromFile(input), output, trimStartMs = 500, trimEndMs = 2500, mute = false, maxLongSide = 1920, maxFps = 30),
    ) { progress += it }

    assertNull("no location", meta(output, MediaMetadataRetriever.METADATA_KEY_LOCATION))
    assertFalse("no ©xyz box", TestMedia.contains(output, byteArrayOf(0xA9.toByte(), 'x'.code.toByte(), 'y'.code.toByte(), 'z'.code.toByte())))
    assertFalse("no XMP", TestMedia.contains(output, "xmpmeta".toByteArray()))
    assertFalse("no loci box", TestMedia.contains(output, "loci".toByteArray()))
    // Orientation survives: the picture is still portrait.
    assertEquals(240, result.width)
    assertEquals(320, result.height)
    val rotation = meta(output, MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toInt() ?: 0
    val w = meta(output, MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)!!.toInt()
    val h = meta(output, MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)!!.toInt()
    assertEquals("display height", 320, if (rotation % 180 == 0) h else w)
    // Trimmed to 2 s, re-encoded at ≤ 30 fps, H.264 + AAC.
    assertTrue("duration ${result.durationMs}", result.durationMs!! in 1850..2150)
    val frames = meta(output, MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)!!.toInt()
    assertTrue("frames $frames for 2 s", frames in 50..64)
    val mimes = extract(output).map { it.getString(MediaFormat.KEY_MIME) }
    assertEquals(listOf(MediaFormat.MIMETYPE_VIDEO_AVC, MediaFormat.MIMETYPE_AUDIO_AAC), mimes.sortedBy { if (it!!.startsWith("video")) 0 else 1 })
    // The result describes the file.
    assertEquals(output.length(), result.bytes)
    assertEquals(MediaFiles.sha256Hex(output), result.sha256Hex)
    assertEquals("video/mp4", result.mimetype)
    assertTrue(progress.isNotEmpty() && progress.last() == 1f)
    assertFalse("no temp file left", File(dir, ".media.mp4.tmp").exists())
  }

  @Test
  fun muteRemovesTheAudioTrack() {
    val input = File(dir, "camera.mp4")
    TestMedia.writeVideo(input, 320, 240, fps = 30, seconds = 1.5, location = 10.77f to 106.70f)
    val output = File(dir, "muted.mp4")
    VideoExporter(context).export(VideoExportRequest("v2", Uri.fromFile(input), output, null, null, mute = true, maxLongSide = 1920, maxFps = 30))
    assertEquals(listOf(MediaFormat.MIMETYPE_VIDEO_AVC), extract(output).map { it.getString(MediaFormat.KEY_MIME) })
    assertNull(meta(output, MediaMetadataRetriever.METADATA_KEY_LOCATION))
  }

  @Test
  fun longVideosAreCutTo60SecondsAndBigOnesScaledTo1920() {
    val input = File(dir, "long.mp4")
    TestMedia.writeVideo(input, 176, 144, fps = 5, seconds = 63.0, audio = false)
    val output = File(dir, "cut.mp4")
    val result = VideoExporter(context).export(VideoExportRequest("v3", Uri.fromFile(input), output, null, null, mute = false, maxLongSide = 160, maxFps = 30))
    assertTrue("duration ${result.durationMs}", result.durationMs!! in 59_000..60_300)
    assertTrue("long side ${result.width}", maxOf(result.width, result.height) <= 160)
  }

  @Test
  fun anEmptyTrimIsRefused() {
    val input = File(dir, "camera.mp4")
    TestMedia.writeVideo(input, 176, 144, fps = 30, seconds = 1.0, audio = false)
    val e = runCatching {
      VideoExporter(context).export(VideoExportRequest("v4", Uri.fromFile(input), File(dir, "x.mp4"), 900, 900, false, 1920, 30))
    }.exceptionOrNull()
    assertEquals("ERR_INVALID_TRIM", (e as MediaExportException).code)
  }

  @Test
  fun exportsThroughTheForegroundServiceRunner() {
    ActivityScenario.launch(TestHostActivity::class.java).use {
      val input = File(dir, "camera.mp4")
      TestMedia.writeVideo(input, 320, 240, fps = 30, seconds = 1.0, location = 1f to 2f)
      val done = CountDownLatch(1)
      var outcome: Result<MediaExportResult>? = null
      MediaExportRunner.exportVideo(
        context,
        VideoExportRequest("v5", Uri.fromFile(input), File(dir, "fgs.mp4"), null, null, false, 1920, 30),
        onProgress = {},
      ) {
        outcome = it
        done.countDown()
      }
      assertTrue(done.await(120, TimeUnit.SECONDS))
      val result = outcome!!.getOrThrow()
      assertNull(meta(result.output, MediaMetadataRetriever.METADATA_KEY_LOCATION))
      Device.waitFor("the export service to stop", 10_000) { MediaExportRunner.idle }
    }
  }

  @Test
  fun aGpsTaggedPhotoLosesAllMetadataAndGetsItsOrientationBakedIn() {
    // A 3600×2700 camera JPEG stored sideways (EXIF orientation 6 = rotate 90° clockwise), with GPS,
    // camera model and capture date. A red block marks the stored top-left corner.
    val input = File(dir, "camera.jpg")
    val bitmap = Bitmap.createBitmap(3600, 2700, Bitmap.Config.ARGB_8888)
    Canvas(bitmap).apply {
      drawColor(Color.BLUE)
      drawRect(0f, 0f, 900f, 675f, Paint().apply { color = Color.RED })
    }
    input.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }
    bitmap.recycle()
    ExifInterface(input.path).apply {
      setLatLong(16.0544, 108.2022)
      setAttribute(ExifInterface.TAG_MAKE, "Phone")
      setAttribute(ExifInterface.TAG_MODEL, "Model X")
      setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, "2026:11:19 07:12:00")
      setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
      saveAttributes()
    }
    assertNotNull("the input really has GPS", ExifInterface(input.path).latLong)

    val output = File(dir, "media.jpg")
    val result = PhotoExporter.export(context, PhotoExportRequest("p1", Uri.fromFile(input), output, 2880, 1600, 90))

    // Display size 2700×3600 fitted into 1600 (short) × 2880 (long): 1600×2133.
    assertEquals(1600, result.width)
    assertEquals(2133, result.height)
    val exif = ExifInterface(output.path)
    assertNull("no GPS", exif.latLong)
    assertNull(exif.getAttribute(ExifInterface.TAG_GPS_LATITUDE))
    assertNull(exif.getAttribute(ExifInterface.TAG_MAKE))
    assertNull(exif.getAttribute(ExifInterface.TAG_MODEL))
    assertNull(exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL))
    assertTrue(exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, 0) in setOf(0, ExifInterface.ORIENTATION_NORMAL))
    assertFalse("no EXIF segment at all", TestMedia.contains(output, "Exif\u0000\u0000".toByteArray()))
    assertFalse("no XMP", TestMedia.contains(output, "http://ns.adobe.com/xap".toByteArray()))
    // The stored top-left is now the displayed top-right.
    val decoded = BitmapFactory.decodeFile(output.path)
    assertEquals(1600, decoded.width)
    assertEquals(2133, decoded.height)
    assertTrue("red at top-right", isRed(decoded.getPixel(1500, 100)))
    assertTrue("blue at top-left", isBlue(decoded.getPixel(100, 100)))
    assertTrue("blue at bottom-right", isBlue(decoded.getPixel(1500, 2000)))
    assertEquals(MediaFiles.sha256Hex(output), result.sha256Hex)
    assertEquals(output.length(), result.bytes)
  }

  @Test
  fun smallPhotosAreNotUpscaled() {
    val input = File(dir, "small.png")
    val bitmap = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.TRANSPARENT) }
    input.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    val output = File(dir, "small.jpg")
    val result = PhotoExporter.export(context, PhotoExportRequest("p2", Uri.fromFile(input), output, 2880, 1600, 90))
    assertEquals(640, result.width)
    assertEquals(480, result.height)
    // Transparency becomes white, not black.
    assertTrue(Color.red(BitmapFactory.decodeFile(output.path).getPixel(10, 10)) > 240)
  }

  @Test
  fun outputsOutsideTheAppAreRefused() {
    val e = runCatching { MediaFiles.outputFile(context, "file:///sdcard/Download/x.jpg") }.exceptionOrNull()
    assertEquals("ERR_INVALID_OUTPUT", (e as MediaExportException).code)
    val sneaky = runCatching { MediaFiles.outputFile(context, "file://${context.filesDir.path}/../../x.jpg") }.exceptionOrNull()
    assertEquals("ERR_INVALID_OUTPUT", (sneaky as MediaExportException).code)
  }

  private fun isRed(c: Int) = Color.red(c) > 200 && Color.blue(c) < 60

  private fun isBlue(c: Int) = Color.blue(c) > 200 && Color.red(c) < 60
}
