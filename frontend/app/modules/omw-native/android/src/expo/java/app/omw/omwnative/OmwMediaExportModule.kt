package app.omw.omwnative

import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val EXPORT_PROGRESS = "onExportProgress"

/**
 * MediaExport.exportVideo/exportPhoto/cancel with onExportProgress {jobId, progress} (API.md).
 * Video: Media3 Transformer 1.9.1 in the export foreground service (VideoExporter,
 * MediaExportService); photo: PhotoExporter. Errors reject with the codes of MediaExportException
 * (ERR_INVALID_REQUEST, ERR_INVALID_SOURCE, ERR_INVALID_OUTPUT, ERR_UNSUPPORTED_SOURCE,
 * ERR_INVALID_TRIM, ERR_EXPORT_FAILED, ERR_CANCELLED, ERR_NOT_IMPLEMENTED for the v0.6 overlay).
 */
class OmwMediaExportModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OmwMediaExport")

    Events(EXPORT_PROGRESS)

    AsyncFunction("exportVideo") { request: Map<String, Any?>, promise: Promise ->
      val req = try {
        videoRequest(request)
      } catch (e: MediaExportException) {
        promise.reject(e.code, e.message, e)
        return@AsyncFunction
      }
      MediaExportRunner.exportVideo(
        context,
        req,
        onProgress = { p -> sendEvent(EXPORT_PROGRESS, mapOf("jobId" to req.jobId, "progress" to p.toDouble())) },
      ) { result -> settle(promise, result) }
    }

    AsyncFunction("exportPhoto") { request: Map<String, Any?>, promise: Promise ->
      val req = try {
        photoRequest(request)
      } catch (e: MediaExportException) {
        promise.reject(e.code, e.message, e)
        return@AsyncFunction
      }
      MediaExportRunner.exportPhoto(context, req) { result ->
        if (result.isSuccess) sendEvent(EXPORT_PROGRESS, mapOf("jobId" to req.jobId, "progress" to 1.0))
        settle(promise, result)
      }
    }

    AsyncFunction("cancel") { jobId: String -> MediaExportRunner.cancel(jobId) }
  }

  private fun settle(promise: Promise, result: Result<MediaExportResult>) {
    result.fold(
      onSuccess = { promise.resolve(it.toMap()) },
      onFailure = { e ->
        val code = (e as? MediaExportException)?.code ?: "ERR_EXPORT_FAILED"
        promise.reject(code, e.message ?: code, e)
      },
    )
  }

  private fun videoRequest(m: Map<String, Any?>): VideoExportRequest {
    if (m["overlayPngUri"] != null) throw MediaExportException("ERR_NOT_IMPLEMENTED", "overlayPngUri comes with v0.6")
    return VideoExportRequest(
      jobId = jobId(m),
      source = MediaFiles.sourceUri(string(m, "sourceUri")),
      output = MediaFiles.outputFile(context, string(m, "outputUri")),
      trimStartMs = number(m, "trimStartMs")?.toLong(),
      trimEndMs = number(m, "trimEndMs")?.toLong(),
      mute = m["mute"] == true,
      maxLongSide = (number(m, "maxLongSide")?.toInt() ?: MediaFiles.VIDEO_MAX_LONG_SIDE).coerceIn(2, MediaFiles.VIDEO_MAX_LONG_SIDE),
      maxFps = (number(m, "maxFps")?.toInt() ?: 30).coerceIn(1, 30),
    )
  }

  private fun photoRequest(m: Map<String, Any?>): PhotoExportRequest = PhotoExportRequest(
    jobId = jobId(m),
    source = MediaFiles.sourceUri(string(m, "sourceUri")),
    output = MediaFiles.outputFile(context, string(m, "outputUri")),
    maxLongSide = (number(m, "maxLongSide")?.toInt() ?: MediaFiles.PHOTO_MAX_LONG_SIDE).coerceIn(1, MediaFiles.PHOTO_MAX_LONG_SIDE),
    maxShortSide = (number(m, "maxShortSide")?.toInt() ?: MediaFiles.PHOTO_MAX_SHORT_SIDE).coerceIn(1, MediaFiles.PHOTO_MAX_SHORT_SIDE),
    quality = ((number(m, "quality") ?: 0.9) * 100).toInt().coerceIn(1, 100),
  )

  private fun jobId(m: Map<String, Any?>): String {
    val id = string(m, "jobId")
    if (id.length > 100) throw MediaExportException("ERR_INVALID_REQUEST", "jobId is too long")
    return id
  }

  private fun string(m: Map<String, Any?>, key: String): String =
    (m[key] as? String)?.takeIf { it.isNotEmpty() } ?: throw MediaExportException("ERR_INVALID_REQUEST", "$key is required")

  private fun number(m: Map<String, Any?>, key: String): Double? = when (val v = m[key]) {
    null -> null
    is Number -> v.toDouble().takeIf { it.isFinite() } ?: throw MediaExportException("ERR_INVALID_REQUEST", "$key must be finite")
    else -> throw MediaExportException("ERR_INVALID_REQUEST", "$key must be a number")
  }
}
