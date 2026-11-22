package app.omw.omwnative

import app.omw.omwnative.FakeEnv.Companion.HOTSPOT
import app.omw.omwnative.FakeEnv.Companion.MOBILE
import app.omw.omwnative.FakeEnv.Companion.OFFLINE
import app.omw.omwnative.FakeEnv.Companion.PORTAL
import app.omw.omwnative.FakeEnv.Companion.ROAMING
import app.omw.omwnative.FakeEnv.Companion.WIFI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Owner decisions A4 / Q6 c / Q2 c as rules. */
class UploadRulesTest {
  private val defaults = UploadSettings() // auto, Wi-Fi only, roaming off

  private fun block(kind: String, role: String, net: NetworkSnapshot, s: UploadSettings = defaults, allowMetered: Boolean = false) =
    UploadRules.block(kind, role, net, s, allowMetered)

  @Test
  fun defaultsAreWifiOnlyForEverything() {
    for (kind in listOf("photo", "video", "text", "voice")) {
      assertNull(block(kind, "media", WIFI))
      assertEquals("wifi_only", block(kind, "media", MOBILE))
    }
  }

  @Test
  fun aHotspotOrMeteredWifiCountsAsMobileData() {
    assertEquals("wifi_only", block("photo", "media", HOTSPOT))
  }

  @Test
  fun noNetworkAndCaptivePortalsNeverGetARequest() {
    assertEquals("no_network", block("photo", "media", OFFLINE))
    assertEquals("not_validated", block("photo", "media", PORTAL))
    assertEquals("not_validated", block("photo", "media", PORTAL, defaults.copy(wifiOnly = false)))
  }

  @Test
  fun photosTextAndVoiceMayUseMobileDataWhenAllowedButVideosWait() {
    val s = defaults.copy(photosOnMobileData = true)
    assertNull(block("photo", "media", MOBILE, s))
    assertNull(block("photo", "preview", MOBILE, s))
    assertNull(block("text", "media", MOBILE, s))
    assertNull(block("voice", "media", MOBILE, s))
    assertEquals("wifi_only", block("video", "media", MOBILE, s))
  }

  @Test
  fun originalsOnlyEverGoOverUnmeteredNetworks() {
    val open = defaults.copy(wifiOnly = false, roaming = true)
    assertEquals("wifi_only", block("photo", "original", MOBILE, open, allowMetered = true))
    assertEquals("wifi_only", block("video", "original", HOTSPOT, open, allowMetered = true))
    assertNull(block("video", "original", WIFI, open))
  }

  @Test
  fun uploadAnywayLiftsWifiOnlyForThatEntry() {
    assertNull(block("video", "media", MOBILE, allowMetered = true))
  }

  @Test
  fun roamingWaitsUnlessAllowedGloballyOrForThisSim() {
    val mobileOk = defaults.copy(wifiOnly = false)
    assertEquals("roaming", block("photo", "media", ROAMING, mobileOk))
    assertEquals("roaming", block("photo", "media", ROAMING, defaults, allowMetered = true))
    assertNull(block("photo", "media", ROAMING, mobileOk.copy(roaming = true)))
    assertNull(block("photo", "media", ROAMING, mobileOk.copy(roamingAllowedSims = listOf("45204"))))
    assertEquals("roaming", block("photo", "media", ROAMING, mobileOk.copy(roamingAllowedSims = listOf("26201"))))
    // Wi-Fi abroad is never "roaming".
    assertNull(block("video", "original", WIFI.copy(simOperator = "45204")))
  }

  @Test
  fun needsAreTheWeakestNetworkThatLetsTheStepRun() {
    assertEquals(NetNeed.UNMETERED, UploadRules.need("video", "media", defaults, false, "26201"))
    assertEquals(NetNeed.UNMETERED, UploadRules.need("photo", "original", defaults.copy(wifiOnly = false), true, "26201"))
    assertEquals(NetNeed.NOT_ROAMING, UploadRules.need("photo", "media", defaults.copy(wifiOnly = false), false, "26201"))
    assertEquals(NetNeed.ANY, UploadRules.need("photo", "media", defaults.copy(wifiOnly = false, roaming = true), false, null))
    assertEquals(NetNeed.ANY, UploadRules.need("photo", "media", defaults.copy(wifiOnly = false, roamingAllowedSims = listOf("45204")), false, "45204"))
    assertEquals(NetNeed.ANY, UploadRules.weakest(listOf(NetNeed.UNMETERED, NetNeed.ANY, NetNeed.NOT_ROAMING)))
    assertNull(UploadRules.weakest(emptyList()))
  }
}
