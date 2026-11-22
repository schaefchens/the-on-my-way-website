package app.omw.omwnative

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val NETWORK_CHANGE = "onNetworkChange"

/** Network.getState() and the onNetworkChange event (default network callback while observed). */
class OmwNetworkModule : Module() {
  private var callback: ConnectivityManager.NetworkCallback? = null

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OmwNetwork")

    Events(NETWORK_CHANGE)

    AsyncFunction("getState") { -> NetworkProbe.read(context).toMap() }

    OnStartObserving(NETWORK_CHANGE) {
      val cm = context.getSystemService(ConnectivityManager::class.java) ?: return@OnStartObserving
      val cb = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
          sendEvent(NETWORK_CHANGE, NetworkProbe.read(context, caps).toMap())
        }

        override fun onLost(network: Network) {
          sendEvent(NETWORK_CHANGE, NetworkProbe.read(context).toMap())
        }
      }
      cm.registerDefaultNetworkCallback(cb)
      callback = cb
    }

    OnStopObserving(NETWORK_CHANGE) { unregister() }

    OnDestroy { unregister() }
  }

  private fun unregister() {
    val cb = callback ?: return
    callback = null
    try {
      appContext.reactContext?.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb)
    } catch (_: IllegalArgumentException) {
      // Already unregistered.
    }
  }
}
