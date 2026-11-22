package app.omw.omwnative

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/**
 * Durable upload jobs: one JSON file per entry under noBackupFilesDir/omw-uploads/<entryId>.json,
 * written atomically (temp file, fsync, rename). A job holds what JS enqueued (entryId, entry,
 * files, mode), the transfer state (`transfer`: upload slots, offsets, flags) and the last
 * reported `status`, so the uploader resumes after process death or a reboot without JS.
 *
 * Every operation runs under one process-wide lock and an exclusive file lock on `.lock` in the
 * same directory, so the JS bridge, the uploader thread and a second process of the app (the
 * instrumented tests run the job service in its own process) never lose each other's writes
 * ([update] reads, changes and writes under both). Plain java.io only: the JVM unit tests use it
 * with a temp directory.
 */
class UploadJobStore(private val dir: File) {
  constructor(context: Context) : this(File(context.noBackupFilesDir, DIR_NAME))

  init {
    dir.mkdirs()
  }

  /** A store of the same kind in a sibling directory (the withdrawals live next to the jobs). */
  fun sibling(name: String): UploadJobStore = UploadJobStore(File(dir.absoluteFile.parentFile, name))

  private fun fileFor(entryId: String): File {
    require(ULID.matches(entryId)) { "entryId must be a ULID" }
    return File(dir, "$entryId.json")
  }

  private inline fun <T> locked(block: () -> T): T = synchronized(LOCK) {
    dir.mkdirs()
    RandomAccessFile(File(dir, LOCK_FILE), "rw").use { raf ->
      raf.channel.lock().use { block() }
    }
  }

  fun put(job: JSONObject) = locked { write(fileFor(job.getString("entryId")), job) }

  fun get(entryId: String): JSONObject? = locked { read(fileFor(entryId)) }

  /** All jobs, oldest entry first (ULIDs sort by time). Damaged files are skipped. */
  fun all(): List<JSONObject> = locked {
    dir.listFiles { file -> file.name.endsWith(".json") && ULID.matches(file.name.removeSuffix(".json")) }
      ?.sortedBy { it.name }
      ?.mapNotNull { read(it) }
      ?: emptyList()
  }

  /**
   * Reads the current job, lets [change] modify it and writes it back, all under the lock.
   * Returns the written job, or null when the job does not exist (e.g. cancelled meanwhile).
   */
  fun update(entryId: String, change: (JSONObject) -> Unit): JSONObject? = updateIf(entryId) { change(it); true }

  /**
   * Like [update], but writes only when [change] returns true (statuses are re-evaluated before
   * every request; unchanged ones must not cost an fsync each time).
   */
  fun updateIf(entryId: String, change: (JSONObject) -> Boolean): JSONObject? = locked {
    val file = fileFor(entryId)
    val job = read(file) ?: return@locked null
    if (change(job)) write(file, job)
    job
  }

  fun remove(entryId: String): Boolean = locked {
    val file = fileFor(entryId)
    val existed = file.exists()
    file.delete()
    existed
  }

  private fun read(file: File): JSONObject? {
    if (!file.exists()) return null
    return try {
      JSONObject(file.readText(Charsets.UTF_8))
    } catch (_: Exception) {
      null
    }
  }

  private fun write(file: File, job: JSONObject) {
    val tmp = File(dir, "${file.name}.tmp")
    FileOutputStream(tmp).use { out ->
      out.write(job.toString().toByteArray(Charsets.UTF_8))
      out.fd.sync()
    }
    if (!tmp.renameTo(file)) {
      tmp.delete()
      throw java.io.IOException("Could not write ${file.name}")
    }
  }

  companion object {
    const val DIR_NAME = "omw-uploads"
    private const val LOCK_FILE = ".lock"
    val ULID = Regex("^[0-7][0-9A-HJKMNP-TV-Z]{25}$")
    private val LOCK = Any()
  }
}
