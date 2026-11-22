package app.omw.omwnative

import android.view.HapticFeedbackConstants
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class HapticMapTest {
  @Test
  fun everyNameResolvesOnEveryLevel() {
    for (sdk in 29..37) for (name in HapticMap.NAMES) assertNotNull("$name @ $sdk", HapticMap.resolve(name, sdk))
  }

  @Test
  fun newConstantsOnApi34() {
    assertEquals(HapticFeedbackConstants.SEGMENT_TICK, HapticMap.resolve("SEGMENT_TICK", 34))
    assertEquals(HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE, HapticMap.resolve("GESTURE_THRESHOLD_ACTIVATE", 34))
    assertEquals(HapticFeedbackConstants.TOGGLE_ON, HapticMap.resolve("TOGGLE_ON", 36))
  }

  @Test
  fun olderLevelsFallBack() {
    assertEquals(HapticFeedbackConstants.CLOCK_TICK, HapticMap.resolve("SEGMENT_TICK", 33))
    assertEquals(HapticFeedbackConstants.CONTEXT_CLICK, HapticMap.resolve("CONFIRM", 29))
    assertEquals(HapticFeedbackConstants.CONFIRM, HapticMap.resolve("CONFIRM", 30))
    assertEquals(HapticFeedbackConstants.LONG_PRESS, HapticMap.resolve("DRAG_START", 33))
  }

  @Test
  fun unknownNames() {
    assertNull(HapticMap.resolve("VIBRATE", 36))
    assertNull(HapticMap.resolve("", 36))
  }
}
