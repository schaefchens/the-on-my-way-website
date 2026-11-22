package app.omw.omwnative

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorSpace
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.HandlerThread
import androidx.exifinterface.media.ExifInterface
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.Metadata
import androidx.media3.common.MimeTypes
import androidx.media3.container.Mp4OrientationData
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.InAppMp4Muxer
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** A failed export; [code] is what JS sees as error.code. */
class MediaExportException(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause)

data class VideoExportRequest(
  val jobId: String,
  val source: Uri,
  val output: File,
  val trimStartMs: Long?,
  val trimEndMs: Long?,
  val mute: Boolean,
  val maxLongSide: Int,
  val maxFps: Int,
)

data class PhotoExportRequest(
  val jobId: String,
  val source: Uri,
  val output: File,
  val maxLongSide: Int,
  val maxShortSide: Int,
  /** JPEG quality 0..100 */
  val quality: Int,
)

/** ExportResult of API.md. */
data class MediaExportResult(
  val jobId: String,
  val output: File,
  val mimetype: String,
  val bytes: Long,
  val sha256Hex: String,
  val width: Int,
  val height: Int,
  val durationMs: Long?,
) {
  fun toMap(): Map<String, Any?> = buildMap {
    put("jobId", jobId)
    put("uri", Uri.fromFile(output).toString())
    put("mimetype", mimetype)
    put("bytes", bytes.toDouble())
    put("sha256Hex", sha256Hex)
    put("width", width)
    put("height", height)
    if (durationMs != null) put("durationMs", durationMs.toDouble())
  }
}

object MediaFiles {
  /** APP_LIMITS of @omw/contracts/app. */
  const val VIDEO_MAX_MS = 60_000L
  const val VIDEO_MAX_LONG_SIDE = 1920
  const val PHOTO_MAX_LONG_SIDE = 2880
  const val PHOTO_MAX_SHORT_SIDE = 1600

  fun sha256Hex(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(256 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }

  /** The output must be a file:// URI inside the app's own storage. */
  fun outputFile(context: Context, uri: String): File {
    val parsed = Uri.parse(uri)
    if (parsed.scheme != "file" || parsed.path == null) throw MediaExportException("ERR_INVALID_OUTPUT", "outputUri must be a file:// URI")
    val file = File(parsed.path!!).canonicalFile
    val roots = listOfNotNull(context.filesDir, context.noBackupFilesDir, context.cacheDir).map { it.canonicalFile }
    if (roots.none { file.path.startsWith(it.path + File.separator) }) {
      throw MediaExportException("ERR_INVALID_OUTPUT", "outputUri must be inside the app's storage")
    }
    file.parentFile?.mkdirs()
    return file
  }

  fun sourceUri(uri: String): Uri {
    val parsed = Uri.parse(uri)
    if (parsed.scheme != "content" && parsed.scheme != "file") throw MediaExportException("ERR_INVALID_SOURCE", "sourceUri must be content:// or file://")
    return parsed
  }

  /** Moves a finished temp file into place (same directory, so the rename is atomic). */
  fun commit(tmp: File, target: File) {
    FileOutputStream(tmp, true).use { it.fd.sync() }
    if (!tmp.renameTo(target)) {
      tmp.delete()
      throw MediaExportException("ERR_EXPORT_FAILED", "could not write ${target.name}")
    }
  }
}

/**
 * Photo export (app-plan §6.2 "photo export"): decode pre-scaled, bake the EXIF orientation into
 * the pixels, fit inside 2880 × 1600 (long × short side), convert to sRGB and write a JPEG
 * (q 90 by default) with NO metadata at all: Bitmap.compress writes no EXIF, no XMP, no GPS, and
 * the new bitmap carries no Ultra HDR gain map. Transparent pixels become white.
 */
object PhotoExporter {
  fun export(context: Context, req: PhotoExportRequest, cancelled: () -> Boolean = { false }): MediaExportResult {
    val resolver = context.contentResolver
    fun <T> withFd(block: (java.io.FileDescriptor) -> T): T =
      (resolver.openFileDescriptor(req.source, "r") ?: throw MediaExportException("ERR_INVALID_SOURCE", "cannot open the photo")).use { block(it.fileDescriptor) }

    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    withFd { BitmapFactory.decodeFileDescriptor(it, null, bounds) }
    val srcW = bounds.outWidth
    val srcH = bounds.outHeight
    if (srcW <= 0 || srcH <= 0) throw MediaExportException("ERR_UNSUPPORTED_SOURCE", "not a decodable image")
    val orientation = try {
      withFd { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
    } catch (_: Exception) {
      ExifInterface.ORIENTATION_NORMAL
    }
    val transposed = orientation in TRANSPOSING
    val dispW = if (transposed) srcH else srcW
    val dispH = if (transposed) srcW else srcH
    val (outW, outH) = fit(dispW, dispH, req.maxLongSide, req.maxShortSide)

    // Largest power-of-two sample size that keeps at least the output size.
    val needW = if (transposed) outH else outW
    val needH = if (transposed) outW else outH
    var sample = 1
    while (srcW / (sample * 2) >= needW && srcH / (sample * 2) >= needH) sample *= 2
    val opts = BitmapFactory.Options().apply {
      inSampleSize = sample
      inPreferredConfig = Bitmap.Config.ARGB_8888
      inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
    }
    if (cancelled()) throw MediaExportException("ERR_CANCELLED", "cancelled")
    val decoded = withFd { BitmapFactory.decodeFileDescriptor(it, null, opts) }
      ?: throw MediaExportException("ERR_UNSUPPORTED_SOURCE", "the image could not be decoded")
    val out = try {
      Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888).also { target ->
        val canvas = Canvas(target)
        canvas.drawColor(Color.WHITE)
        canvas.drawBitmap(decoded, orientationMatrix(orientation, decoded.width, decoded.height, outW, outH), Paint(Paint.FILTER_BITMAP_FLAG))
      }
    } finally {
      decoded.recycle()
    }
    val tmp = File(req.output.parentFile, ".${req.output.name}.tmp")
    try {
      FileOutputStream(tmp).use { stream ->
        if (!out.compress(Bitmap.CompressFormat.JPEG, req.quality.coerceIn(1, 100), stream)) {
          throw MediaExportException("ERR_EXPORT_FAILED", "JPEG encoding failed")
        }
      }
      MediaFiles.commit(tmp, req.output)
    } catch (e: IOException) {
      tmp.delete()
      throw MediaExportException("ERR_EXPORT_FAILED", "could not write the photo", e)
    } finally {
      out.recycle()
    }
    return MediaExportResult(req.jobId, req.output, "image/jpeg", req.output.length(), MediaFiles.sha256Hex(req.output), outW, outH, null)
  }

  /** The output size: inside long × short, never upscaled, at least 1 px. */
  fun fit(w: Int, h: Int, maxLong: Int, maxShort: Int): Pair<Int, Int> {
    val long = max(w, h).toDouble()
    val short = min(w, h).toDouble()
    val scale = min(1.0, min(maxLong / long, maxShort / short))
    return max(1, (w * scale).roundToInt()) to max(1, (h * scale).roundToInt())
  }

  /** Bakes the EXIF orientation and scales [w]×[h] onto [outW]×[outH]. */
  fun orientationMatrix(orientation: Int, w: Int, h: Int, outW: Int, outH: Int): Matrix {
    val m = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.setScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> {
        m.setRotate(90f)
        m.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> {
        m.setRotate(-90f)
        m.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(-90f)
    }
    val r = RectF(0f, 0f, w.toFloat(), h.toFloat())
    m.mapRect(r)
    m.postTranslate(-r.left, -r.top)
    m.postScale(outW / r.width(), outH / r.height())
    return m
  }

  private val TRANSPOSING = setOf(
    ExifInterface.ORIENTATION_TRANSPOSE,
    ExifInterface.ORIENTATION_ROTATE_90,
    ExifInterface.ORIENTATION_TRANSVERSE,
    ExifInterface.ORIENTATION_ROTATE_270,
  )
}

/**
 * Video export with Media3 Transformer 1.9.1 (app-plan §4 "Video export"): trim by
 * ClippingConfiguration (re-encoded, never an edit list), at most 60 s, optional mute, H.264 +
 * AAC in MP4, SDR (HDR is tone-mapped with OpenGL, MediaCodec as the fallback), long side ≤ 1920,
 * ≤ 30 fps (FrameDropEffect), and an InAppMp4Muxer whose MetadataProvider drops every metadata
 * entry of the input (©xyz location, XMP, capture dates, mdta keys). The muxer writes the
 * orientation itself, from the video format, so the picture stays upright.
 */
class VideoExporter(private val context: Context) {
  data class Probe(val width: Int, val height: Int, val rotation: Int, val durationMs: Long, val fps: Float, val hdr: Boolean, val hasAudio: Boolean)

  @Volatile
  private var cancelRequested = false

  @Volatile
  private var cancelAction: (() -> Unit)? = null

  fun cancel() {
    cancelRequested = true
    cancelAction?.invoke()
  }

  fun export(req: VideoExportRequest, onProgress: (Float) -> Unit = {}): MediaExportResult {
    val probe = probe(context, req.source)
    val start = (req.trimStartMs ?: 0L).coerceAtLeast(0)
    var end = min(req.trimEndMs ?: probe.durationMs, probe.durationMs)
    end = min(end, start + MediaFiles.VIDEO_MAX_MS)
    if (end <= start) throw MediaExportException("ERR_INVALID_TRIM", "the trim range is empty")

    val tmp = File(req.output.parentFile, ".${req.output.name}.tmp")
    tmp.delete()
    val first = runCatching { transform(req, probe, start, end, tmp, Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL, onProgress) }
    val failure = first.exceptionOrNull()
    if (failure != null) {
      if (cancelRequested || !probe.hdr || android.os.Build.VERSION.SDK_INT < 31) {
        tmp.delete()
        throw failure.asExportException()
      }
      // Some GPUs lack the OpenGL HDR path; the decoder's own tone mapping is the fallback.
      tmp.delete()
      runCatching { transform(req, probe, start, end, tmp, Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_MEDIACODEC, onProgress) }
        .exceptionOrNull()?.let {
          tmp.delete()
          throw it.asExportException()
        }
    }
    MediaFiles.commit(tmp, req.output)
    val out = probe(context, Uri.fromFile(req.output))
    val rotated = out.rotation == 90 || out.rotation == 270
    return MediaExportResult(
      req.jobId,
      req.output,
      "video/mp4",
      req.output.length(),
      MediaFiles.sha256Hex(req.output),
      if (rotated) out.height else out.width,
      if (rotated) out.width else out.height,
      out.durationMs,
    )
  }

  private fun Throwable.asExportException(): MediaExportException = when {
    this is MediaExportException -> this
    cancelRequested -> MediaExportException("ERR_CANCELLED", "cancelled")
    this is ExportException -> MediaExportException("ERR_EXPORT_FAILED", "export failed: ${errorCodeName}", this)
    else -> MediaExportException("ERR_EXPORT_FAILED", "export failed: ${javaClass.simpleName}", this)
  }

  private fun transform(
    req: VideoExportRequest,
    probe: Probe,
    startMs: Long,
    endMs: Long,
    tmp: File,
    hdrMode: Int,
    onProgress: (Float) -> Unit,
  ) {
    if (cancelRequested) throw MediaExportException("ERR_CANCELLED", "cancelled")
    val clipping = MediaItem.ClippingConfiguration.Builder().setStartPositionMs(startMs).setEndPositionMs(endMs).build()
    val item = MediaItem.Builder().setUri(req.source).setClippingConfiguration(clipping).build()

    val effects = mutableListOf<Effect>()
    if (probe.fps > req.maxFps + 0.5f) effects += FrameDropEffect.createDefaultFrameDropEffect(req.maxFps.toFloat())
    val long = max(probe.width, probe.height)
    val short = min(probe.width, probe.height)
    var outLong = long
    var outShort = short
    if (long > req.maxLongSide) {
      outShort = evenFloor(short * req.maxLongSide / long)
      outLong = req.maxLongSide
      effects += Presentation.createForShortSide(outShort)
    }
    val edited = EditedMediaItem.Builder(item)
      .setRemoveAudio(req.mute)
      .setEffects(Effects(emptyList(), effects))
      .build()
    val sequence = if (req.mute || !probe.hasAudio) {
      EditedMediaItemSequence.withVideoFrom(listOf(edited))
    } else {
      EditedMediaItemSequence.withAudioAndVideoFrom(listOf(edited))
    }
    val composition = Composition.Builder(sequence)
      .setHdrMode(hdrMode)
      .build()
    // A requested bitrate also makes Transformer re-encode every input (no pass-through of the
    // camera's own stream): ~0.1 bit per pixel and frame, 1.5–8 Mbit/s (1080p30 ≈ 6 Mbit/s).
    val fps = min(if (probe.fps > 0) probe.fps else 30f, req.maxFps.toFloat())
    val bitrate = (outLong.toDouble() * outShort * fps * 0.1).toInt().coerceIn(1_500_000, 8_000_000)
    val encoders = DefaultEncoderFactory.Builder(context)
      .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(bitrate).build())
      .setEnableFallback(true)
      .build()

    val thread = HandlerThread("omw-export").apply { start() }
    val handler = Handler(thread.looper)
    val done = CountDownLatch(1)
    var error: Throwable? = null
    var transformer: Transformer? = null
    val holder = ProgressHolder()
    val poll = object : Runnable {
      override fun run() {
        val t = transformer ?: return
        if (t.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) onProgress(holder.progress / 100f)
        if (done.count > 0) handler.postDelayed(this, PROGRESS_INTERVAL_MS)
      }
    }
    handler.post {
      try {
        val t = Transformer.Builder(context)
          .setLooper(thread.looper)
          .setVideoMimeType(MimeTypes.VIDEO_H264)
          .setAudioMimeType(MimeTypes.AUDIO_AAC)
          .setEncoderFactory(encoders)
          .setMuxerFactory(InAppMp4Muxer.Factory(STRIP_METADATA))
          .addListener(object : Transformer.Listener {
            override fun onCompleted(composition: Composition, exportResult: androidx.media3.transformer.ExportResult) {
              done.countDown()
            }

            override fun onError(composition: Composition, exportResult: androidx.media3.transformer.ExportResult, exportException: ExportException) {
              error = exportException
              done.countDown()
            }
          })
          .build()
        transformer = t
        cancelAction = {
          handler.post {
            t.cancel()
            error = MediaExportException("ERR_CANCELLED", "cancelled")
            done.countDown()
          }
        }
        t.start(composition, tmp.path)
        handler.postDelayed(poll, PROGRESS_INTERVAL_MS)
      } catch (e: Exception) {
        error = e
        done.countDown()
      }
    }
    try {
      if (!done.await(TIMEOUT_MINUTES, TimeUnit.MINUTES)) {
        handler.post { transformer?.cancel() }
        error = MediaExportException("ERR_EXPORT_FAILED", "export timed out")
      }
    } finally {
      cancelAction = null
      handler.post { thread.quitSafely() }
    }
    error?.let { throw it }
    onProgress(1f)
  }

  companion object {
    private const val PROGRESS_INTERVAL_MS = 250L
    private const val TIMEOUT_MINUTES = 20L

    /** Keeps nothing of the input's metadata (orientation is written by the muxer itself). */
    val STRIP_METADATA = InAppMp4Muxer.MetadataProvider { entries: MutableSet<Metadata.Entry> ->
      entries.retainAll { it is Mp4OrientationData }
    }

    private fun evenFloor(n: Int) = max(2, n - n % 2)

    fun probe(context: Context, uri: Uri): Probe {
      val extractor = MediaExtractor()
      try {
        extractor.setDataSource(context, uri, null)
        var video: MediaFormat? = null
        var audio = false
        for (i in 0 until extractor.trackCount) {
          val f = extractor.getTrackFormat(i)
          val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
          if (mime.startsWith("video/") && video == null) video = f
          if (mime.startsWith("audio/")) audio = true
        }
        val v = video ?: throw MediaExportException("ERR_UNSUPPORTED_SOURCE", "no video track")
        val transfer = if (v.containsKey(MediaFormat.KEY_COLOR_TRANSFER)) v.getInteger(MediaFormat.KEY_COLOR_TRANSFER) else 0
        val hdr = transfer == MediaFormat.COLOR_TRANSFER_ST2084 || transfer == MediaFormat.COLOR_TRANSFER_HLG
        val retriever = MediaMetadataRetriever()
        try {
          retriever.setDataSource(context, uri)
          fun meta(key: Int) = retriever.extractMetadata(key)?.toLongOrNull()
          val width = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toInt() ?: v.getInteger(MediaFormat.KEY_WIDTH)
          val height = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toInt() ?: v.getInteger(MediaFormat.KEY_HEIGHT)
          val rotation = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toInt() ?: 0
          val durationMs = meta(MediaMetadataRetriever.METADATA_KEY_DURATION)
            ?: if (v.containsKey(MediaFormat.KEY_DURATION)) v.getLong(MediaFormat.KEY_DURATION) / 1000 else 0
          val frames = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)
          val declared = if (v.containsKey(MediaFormat.KEY_FRAME_RATE)) runCatching { v.getInteger(MediaFormat.KEY_FRAME_RATE).toFloat() }.getOrElse { v.getFloat(MediaFormat.KEY_FRAME_RATE) } else 0f
          val counted = if (frames != null && durationMs > 0) frames * 1000f / durationMs else 0f
          return Probe(width, height, rotation, durationMs, max(declared, counted), hdr, audio)
        } finally {
          retriever.release()
        }
      } catch (e: MediaExportException) {
        throw e
      } catch (e: Exception) {
        throw MediaExportException("ERR_UNSUPPORTED_SOURCE", "cannot read the video: ${e.javaClass.simpleName}", e)
      } finally {
        extractor.release()
      }
    }
  }
}
