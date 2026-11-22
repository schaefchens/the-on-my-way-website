# Sourced by instrument.sh and reboot-check.sh (not run directly). Needs adb and ANDROID_SERIAL.
#
# omw_require_wifi [seconds]: switches Wi-Fi and mobile data on and waits until the emulator has a
# VALIDATED Wi-Fi network, so a broken emulator network fails fast with a hint instead of making
# every uploader test time out. Android only validates a network when the host's internet works.
# After a host network outage the emulator's Wi-Fi (served by netsimd) may also stay "connected"
# without an IP address (DHCP lost) until both the emulator and netsimd are restarted; a reboot of
# the guest alone does not help.
omw_require_wifi() {
  local timeout="${1:-60}" deadline agents
  adb shell svc data enable >/dev/null 2>&1 || true
  adb shell svc wifi enable >/dev/null 2>&1 || true
  deadline=$((SECONDS + timeout))
  while :; do
    # No `grep -q` in a pipe: it ends early, and pipefail would turn the match into a failure.
    agents="$(adb shell dumpsys connectivity 2>/dev/null | grep -E 'NetworkAgentInfo\{' || true)"
    if grep -E 'WIFI.*IS_VALIDATED' <<<"$agents" >/dev/null; then
      return 0
    fi
    if ((SECONDS >= deadline)); then
      echo "omw_require_wifi: no validated Wi-Fi on the emulator after ${timeout} s" \
        "($(adb shell cmd wifi status 2>/dev/null | grep -m1 -E 'connected' | tr -d '\r' || true))." >&2
      echo "  Check the host's internet connection. If Wi-Fi is connected but has no IP address" \
        "(netsimd lost DHCP): scripts/app/with-emulator.sh --stop, end the lingering netsimd" \
        "process (pkill -x netsimd, only while no emulator runs), then run again." >&2
      return 1
    fi
    sleep 2
  done
}
