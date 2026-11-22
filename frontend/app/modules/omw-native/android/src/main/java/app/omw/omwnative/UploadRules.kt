package app.omw.omwnative

/** The weakest network a step can use; the scheduler turns it into the job's network constraint. */
enum class NetNeed { ANY, NOT_ROAMING, UNMETERED }

/**
 * Owner decisions A4 and Q6 c as pure rules (no Android types, unit-tested on the JVM):
 * - "Wi-Fi" means NOT_METERED: a phone hotspot or a metered Wi-Fi counts as mobile data.
 * - wifiOnly (default on) keeps every upload off mobile data, except photos, text and voice when
 *   photosOnMobileData is on, and except an entry she sent with "Upload now" → "Upload anyway".
 * - Originals (Q2 c) only ever go over unmetered networks, whatever the settings.
 * - On mobile data while roaming, uploads wait unless "also while roaming" is on or she allowed
 *   this SIM (MCC+MNC); this applies even after "Upload anyway" (roaming costs are a separate
 *   question the app asks once per SIM).
 * - A network without NET_CAPABILITY_VALIDATED (captive portal) never gets a request.
 */
object UploadRules {
  /** Kinds that may use mobile data with photosOnMobileData ("photos, text and voice"). */
  val LIGHT_KINDS = setOf("photo", "text", "voice")

  fun mayUseMetered(kind: String, role: String, settings: UploadSettings, allowMetered: Boolean): Boolean =
    role != ROLE_ORIGINAL &&
      (!settings.wifiOnly || allowMetered || (settings.photosOnMobileData && kind in LIGHT_KINDS))

  fun roamingAllowed(settings: UploadSettings, simOperator: String?): Boolean =
    settings.roaming || (simOperator != null && simOperator in settings.roamingAllowedSims)

  /** Why a request for [role] of a [kind] entry may not go out on [net] now, or null when it may. */
  fun block(kind: String, role: String, net: NetworkSnapshot, settings: UploadSettings, allowMetered: Boolean): String? {
    if (!net.connected) return "no_network"
    if (!net.validated) return "not_validated"
    if (net.unmetered) return null
    if (!mayUseMetered(kind, role, settings, allowMetered)) return "wifi_only"
    if (net.roaming && !roamingAllowed(settings, net.simOperator)) return "roaming"
    return null
  }

  /** The weakest network that would let this step run. */
  fun need(kind: String, role: String, settings: UploadSettings, allowMetered: Boolean, simOperator: String?): NetNeed = when {
    !mayUseMetered(kind, role, settings, allowMetered) -> NetNeed.UNMETERED
    !roamingAllowed(settings, simOperator) -> NetNeed.NOT_ROAMING
    else -> NetNeed.ANY
  }

  /** The weakest of several needs (the job constraint must let every runnable step run). */
  fun weakest(needs: Collection<NetNeed>): NetNeed? = needs.minByOrNull { it.ordinal }

  const val ROLE_MEDIA = "media"
  const val ROLE_PREVIEW = "preview"
  const val ROLE_ORIGINAL = "original"
}
