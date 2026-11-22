package app.omw.omwnative

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class UnknownHapticException(name: String) : CodedException("Unknown haptic constant: $name")

/**
 * haptic(constant): View.performHapticFeedback on the current window, so the system "Touch
 * feedback" switch applies and no VIBRATE permission is needed. Resolves false when nothing ran
 * (no activity, or the system declined).
 */
class OmwHapticsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OmwHaptics")

    AsyncFunction("perform") { name: String ->
      val constant = HapticMap.resolve(name) ?: throw UnknownHapticException(name)
      val view = appContext.currentActivity?.window?.decorView ?: return@AsyncFunction false
      view.performHapticFeedback(constant)
    }.runOnQueue(Queues.MAIN)
  }
}
