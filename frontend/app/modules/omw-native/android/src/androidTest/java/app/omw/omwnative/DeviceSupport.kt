package app.omw.omwnative

import android.app.ActivityManager
import android.app.job.JobScheduler
import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Process
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.PI
import kotlin.math.sin

/** Helpers for the instrumented tests (emulator). */
object Device {
  val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

  /** Runs a shell command as the shell user (svc wifi/data, dumpsys, …) and returns its output. */
  fun shell(command: String): String {
    val pfd = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
    return android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd).use { it.readBytes().toString(Charsets.UTF_8) }
  }

  fun waitFor(what: String, timeoutMs: Long, pollMs: Long = 250, condition: () -> Boolean) {
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (!condition()) {
      if (SystemClock.elapsedRealtime() > deadline) throw AssertionError("timed out after ${timeoutMs}ms waiting for: $what")
      Thread.sleep(pollMs)
    }
  }

  fun uploadProcessPid(): Int? {
    val am = context.getSystemService(ActivityManager::class.java)
    return am.runningAppProcesses?.firstOrNull { it.processName == "${context.packageName}:upload" }?.pid
  }

  /** Kills the uploader's process like the system's low-memory killer would (no force-stop). */
  fun killUploadProcess(): Boolean {
    val pid = uploadProcessPid() ?: return false
    Process.killProcess(pid)
    waitFor("the upload process to die", 10_000) { uploadProcessPid() != pid }
    return true
  }

  /** A clean uploader: no jobs, no scheduled work, no stored state, no running :upload process. */
  fun resetUploader() {
    UploadScheduler.forceWorkManager = false
    UploadScheduler.backupDelayMs = 15 * 60_000L
    context.getSystemService(JobScheduler::class.java).cancel(UploadScheduler.UIDT_JOB_ID)
    runCatching { androidx.work.WorkManager.getInstance(context).cancelAllWork().result.get() }
    killUploadProcess()
    File(context.noBackupFilesDir, UploadJobStore.DIR_NAME).deleteRecursively()
    for (prefs in listOf(UploadRuntime.STATE_PREFS, "omw.upload-settings", "omw.upload-config")) {
      context.getSharedPreferences(prefs, Context.MODE_PRIVATE).edit().clear().commit()
    }
  }

  fun wifi(on: Boolean) = shell("svc wifi ${if (on) "enable" else "disable"}")

  fun data(on: Boolean) = shell("svc data ${if (on) "enable" else "disable"}")

  fun waitForNetwork(what: String, timeoutMs: Long = 90_000, condition: (NetworkSnapshot) -> Boolean) =
    waitFor("network: $what (now ${NetworkProbe.read(context)})", timeoutMs, 500) { condition(NetworkProbe.read(context)) }

  /** Both radios on and a validated Wi-Fi, as the emulator boots. */
  fun restoreNetworks() {
    data(true)
    wifi(true)
    runCatching { waitForNetwork("validated Wi-Fi", 60_000) { it.transport == "wifi" && it.validated } }
  }
}

/**
 * Phone-like test media made on the device: an MP4 as a camera app writes it with MediaMuxer
 * (H.264 + AAC, a rotation, and the GPS position as ©xyz via setLocation).
 */
object TestMedia {
  fun writeVideo(
    file: File,
    width: Int,
    height: Int,
    fps: Int,
    seconds: Double,
    rotation: Int = 0,
    location: Pair<Float, Float>? = null,
    audio: Boolean = true,
  ) {
    val frames = (seconds * fps).toInt()
    val video = encodeVideo(width, height, fps, frames)
    val sound = if (audio) encodeAudio(seconds) else null
    val muxer = MediaMuxer(file.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    try {
      muxer.setOrientationHint(rotation)
      location?.let { (lat, lon) -> muxer.setLocation(lat, lon) }
      val vTrack = muxer.addTrack(video.first)
      val aTrack = sound?.let { muxer.addTrack(it.first) }
      muxer.start()
      for ((data, info) in video.second) muxer.writeSampleData(vTrack, data, info)
      if (aTrack != null) for ((data, info) in sound.second) muxer.writeSampleData(aTrack, data, info)
      muxer.stop()
    } finally {
      muxer.release()
    }
  }

  private fun encodeVideo(w: Int, h: Int, fps: Int, frames: Int): Pair<MediaFormat, List<Pair<ByteBuffer, MediaCodec.BufferInfo>>> {
    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
      setInteger(MediaFormat.KEY_BIT_RATE, 1_000_000)
      setInteger(MediaFormat.KEY_FRAME_RATE, fps)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }
    val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    codec.start()
    var frame = 0
    return drain(codec) { index ->
      if (frame >= frames) {
        codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        true
      } else {
        val image = codec.getInputImage(index)!!
        val y = image.planes[0]
        val row = ByteArray(w) { x -> ((x + frame * 4) and 0xff).toByte() }
        for (r in 0 until h) {
          if (y.pixelStride == 1) {
            y.buffer.position(r * y.rowStride)
            y.buffer.put(row)
          } else {
            for (x in 0 until w) y.buffer.put(r * y.rowStride + x * y.pixelStride, row[x])
          }
        }
        for (p in 1..2) {
          val plane = image.planes[p]
          for (r in 0 until h / 2) for (x in 0 until w / 2) plane.buffer.put(r * plane.rowStride + x * plane.pixelStride, 128.toByte())
        }
        codec.queueInputBuffer(index, 0, w * h * 3 / 2, frame * 1_000_000L / fps, 0)
        frame++
        false
      }
    }
  }

  private fun encodeAudio(seconds: Double): Pair<MediaFormat, List<Pair<ByteBuffer, MediaCodec.BufferInfo>>> {
    val rate = 44_100
    val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, 1).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE, 64_000)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384)
    }
    val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    codec.start()
    val total = (seconds * rate).toLong()
    var written = 0L
    return drain(codec) { index ->
      if (written >= total) {
        codec.queueInputBuffer(index, 0, 0, written * 1_000_000 / rate, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        true
      } else {
        val buf = codec.getInputBuffer(index)!!
        buf.clear()
        val samples = minOf((buf.capacity() / 2).toLong(), total - written, 4096).toInt()
        for (i in 0 until samples) {
          val v = (sin(2 * PI * 440 * (written + i) / rate) * 8000).toInt().toShort()
          buf.put((v.toInt() and 0xff).toByte())
          buf.put((v.toInt() shr 8 and 0xff).toByte())
        }
        codec.queueInputBuffer(index, 0, samples * 2, written * 1_000_000 / rate, 0)
        written += samples
        false
      }
    }
  }

  /** Feeds [fill] (returns true after queueing end of stream) and collects the encoded samples. */
  private fun drain(codec: MediaCodec, fill: (Int) -> Boolean): Pair<MediaFormat, List<Pair<ByteBuffer, MediaCodec.BufferInfo>>> {
    val out = mutableListOf<Pair<ByteBuffer, MediaCodec.BufferInfo>>()
    var format: MediaFormat? = null
    var inputDone = false
    val info = MediaCodec.BufferInfo()
    try {
      while (true) {
        if (!inputDone) {
          val index = codec.dequeueInputBuffer(10_000)
          if (index >= 0) inputDone = fill(index)
        }
        val o = codec.dequeueOutputBuffer(info, 10_000)
        when {
          o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> format = codec.outputFormat
          o >= 0 -> {
            val data = codec.getOutputBuffer(o)!!
            if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
              val copy = ByteBuffer.allocateDirect(info.size)
              data.position(info.offset)
              data.limit(info.offset + info.size)
              copy.put(data)
              copy.flip()
              out += copy to MediaCodec.BufferInfo().apply { set(0, info.size, info.presentationTimeUs, info.flags) }
            }
            codec.releaseOutputBuffer(o, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
          }
        }
      }
    } finally {
      codec.stop()
      codec.release()
    }
    return (format ?: error("the encoder reported no format")) to out
  }

  /** True when [needle] occurs in the file's bytes. */
  fun contains(file: File, needle: ByteArray): Boolean {
    val bytes = file.readBytes()
    outer@ for (i in 0..bytes.size - needle.size) {
      for (j in needle.indices) if (bytes[i + j] != needle[j]) continue@outer
      return true
    }
    return false
  }
}
