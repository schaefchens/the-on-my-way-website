package app.omw.omwnative

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager

/**
 * The network facts the A4 upload rules need (owner decision A4, app-plan §4 "Network state"):
 * unmetered counts as Wi-Fi (a phone hotspot or a metered Wi-Fi counts as mobile data), roaming
 * from NET_CAPABILITY_NOT_ROAMING, validated from NET_CAPABILITY_VALIDATED (captive portals), and
 * the data SIM's MCC+MNC for the per-SIM roaming answer. No permission beyond ACCESS_NETWORK_STATE.
 */
data class NetworkSnapshot(
  val connected: Boolean,
  val validated: Boolean,
  val unmetered: Boolean,
  val roaming: Boolean,
  val transport: String,
  val simOperator: String?,
  val simOperatorName: String?,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "connected" to connected,
    "validated" to validated,
    "unmetered" to unmetered,
    "roaming" to roaming,
    "transport" to transport,
    "simOperator" to simOperator,
    "simOperatorName" to simOperatorName,
  )
}

object NetworkProbe {
  fun read(context: Context, capabilities: NetworkCapabilities? = null): NetworkSnapshot {
    val cm = context.getSystemService(ConnectivityManager::class.java)
    val caps = capabilities ?: cm?.activeNetwork?.let { cm.getNetworkCapabilities(it) }
    val (operator, operatorName) = dataSim(context)
    if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
      return NetworkSnapshot(false, false, false, false, "none", operator, operatorName)
    }
    val transport = when {
      caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
      else -> "other"
    }
    return NetworkSnapshot(
      connected = true,
      validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
      unmetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) ||
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_TEMPORARILY_NOT_METERED),
      roaming = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING),
      transport = transport,
      simOperator = operator,
      simOperatorName = operatorName,
    )
  }

  /** MCC+MNC and carrier name of the default data subscription (no permission needed). */
  private fun dataSim(context: Context): Pair<String?, String?> {
    return try {
      val tm = context.getSystemService(TelephonyManager::class.java) ?: return null to null
      val subId = SubscriptionManager.getDefaultDataSubscriptionId()
      val dataTm = if (subId != SubscriptionManager.INVALID_SUBSCRIPTION_ID) tm.createForSubscriptionId(subId) else tm
      dataTm.simOperator?.takeIf { it.isNotEmpty() } to dataTm.simOperatorName?.takeIf { it.isNotEmpty() }
    } catch (_: SecurityException) {
      null to null
    }
  }
}
