package app.omw.omwnative

import android.os.Build
import android.view.HapticFeedbackConstants

/**
 * Names of Android's own haptic feedback constants (app-plan §5.3) -> the constant to perform on
 * this API level. Constants newer than the device fall back to the nearest older one
 * (CLOCK_TICK, CONTEXT_CLICK, LONG_PRESS). Pure, so it is unit-tested on the JVM.
 */
object HapticMap {
  val NAMES: List<String> = listOf(
    "VIRTUAL_KEY",
    "LONG_PRESS",
    "KEYBOARD_TAP",
    "CLOCK_TICK",
    "CONTEXT_CLICK",
    "CONFIRM",
    "REJECT",
    "GESTURE_START",
    "GESTURE_END",
    "GESTURE_THRESHOLD_ACTIVATE",
    "GESTURE_THRESHOLD_DEACTIVATE",
    "SEGMENT_TICK",
    "SEGMENT_FREQUENT_TICK",
    "DRAG_START",
    "TOGGLE_ON",
    "TOGGLE_OFF",
  )

  /** The constant for [name] on [sdk], or null for an unknown name. */
  fun resolve(name: String, sdk: Int = Build.VERSION.SDK_INT): Int? {
    val r = Build.VERSION_CODES.R // 30
    val u = Build.VERSION_CODES.UPSIDE_DOWN_CAKE // 34
    return when (name) {
      "VIRTUAL_KEY" -> HapticFeedbackConstants.VIRTUAL_KEY
      "LONG_PRESS" -> HapticFeedbackConstants.LONG_PRESS
      "KEYBOARD_TAP" -> HapticFeedbackConstants.KEYBOARD_TAP
      "CLOCK_TICK" -> HapticFeedbackConstants.CLOCK_TICK
      "CONTEXT_CLICK" -> HapticFeedbackConstants.CONTEXT_CLICK
      "CONFIRM" -> if (sdk >= r) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.CONTEXT_CLICK
      "REJECT" -> if (sdk >= r) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
      "GESTURE_START" -> if (sdk >= r) HapticFeedbackConstants.GESTURE_START else HapticFeedbackConstants.CLOCK_TICK
      "GESTURE_END" -> if (sdk >= r) HapticFeedbackConstants.GESTURE_END else HapticFeedbackConstants.CLOCK_TICK
      "GESTURE_THRESHOLD_ACTIVATE" ->
        if (sdk >= u) HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE else HapticFeedbackConstants.CONTEXT_CLICK
      "GESTURE_THRESHOLD_DEACTIVATE" ->
        if (sdk >= u) HapticFeedbackConstants.GESTURE_THRESHOLD_DEACTIVATE else HapticFeedbackConstants.CLOCK_TICK
      "SEGMENT_TICK" -> if (sdk >= u) HapticFeedbackConstants.SEGMENT_TICK else HapticFeedbackConstants.CLOCK_TICK
      "SEGMENT_FREQUENT_TICK" ->
        if (sdk >= u) HapticFeedbackConstants.SEGMENT_FREQUENT_TICK else HapticFeedbackConstants.CLOCK_TICK
      "DRAG_START" -> if (sdk >= u) HapticFeedbackConstants.DRAG_START else HapticFeedbackConstants.LONG_PRESS
      "TOGGLE_ON" -> if (sdk >= u) HapticFeedbackConstants.TOGGLE_ON else HapticFeedbackConstants.CONTEXT_CLICK
      "TOGGLE_OFF" -> if (sdk >= u) HapticFeedbackConstants.TOGGLE_OFF else HapticFeedbackConstants.CLOCK_TICK
      else -> null
    }
  }
}
