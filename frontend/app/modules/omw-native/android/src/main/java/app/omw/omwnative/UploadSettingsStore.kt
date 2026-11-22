package app.omw.omwnative

import android.content.Context
import androidx.core.content.edit

/**
 * The A4 upload settings, persisted natively so the uploader can decide without JS.
 * Defaults (owner decision Q6 c): automatic, Wi-Fi only for everything, roaming off.
 */
data class UploadSettings(
  val mode: String = "auto",
  val wifiOnly: Boolean = true,
  val photosOnMobileData: Boolean = false,
  val roaming: Boolean = false,
  /** MCC+MNC of SIMs she allowed while roaming ("Allow on this SIM"). */
  val roamingAllowedSims: List<String> = emptyList(),
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "mode" to mode,
    "wifiOnly" to wifiOnly,
    "photosOnMobileData" to photosOnMobileData,
    "roaming" to roaming,
    "roamingAllowedSims" to roamingAllowedSims,
  )
}

class UploadSettingsStore(context: Context) {
  private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun read(): UploadSettings = UploadSettings(
    mode = prefs.getString("mode", null)?.takeIf { it in MODES } ?: "auto",
    wifiOnly = prefs.getBoolean("wifiOnly", true),
    photosOnMobileData = prefs.getBoolean("photosOnMobileData", false),
    roaming = prefs.getBoolean("roaming", false),
    roamingAllowedSims = prefs.getStringSet("roamingAllowedSims", emptySet())!!.filter(::isSimOperator).sorted(),
  )

  /** Applies the keys present in [patch]; unknown keys and wrong types are rejected. */
  fun update(patch: Map<String, Any?>): UploadSettings {
    for (key in patch.keys) require(key in KEYS) { "Unknown upload setting: $key" }
    prefs.edit(commit = true) {
      patch["mode"]?.let {
        require(it is String && it in MODES) { "mode must be auto or manual" }
        putString("mode", it)
      }
      for (key in listOf("wifiOnly", "photosOnMobileData", "roaming")) {
        patch[key]?.let {
          require(it is Boolean) { "$key must be a boolean" }
          putBoolean(key, it)
        }
      }
      patch["roamingAllowedSims"]?.let { value ->
        val sims = (value as? List<*>)?.map { it as? String } ?: throw IllegalArgumentException("roamingAllowedSims must be a list")
        require(sims.all { it != null && isSimOperator(it) }) { "roamingAllowedSims must be MCC+MNC codes" }
        putStringSet("roamingAllowedSims", sims.filterNotNull().toSet())
      }
    }
    return read()
  }

  companion object {
    const val PREFS = "omw.upload-settings"
    val MODES = setOf("auto", "manual")
    val KEYS = setOf("mode", "wifiOnly", "photosOnMobileData", "roaming", "roamingAllowedSims")
    fun isSimOperator(value: String) = Regex("^[0-9]{5,6}$").matches(value)
  }
}
