#!/usr/bin/env bash
# Builds a signed RELEASE of the traveler app (frontend/app, R8 on): an Android App Bundle for
# Google Play's internal testing track (Play App Signing), or an APK for the emulator test run.
#
#   scripts/app/release.sh --create-upload-key                          # once: the upload key
#   scripts/app/release.sh --aab --api-base-url https://<api host>      # the bundle for Play
#   scripts/app/release.sh --apk --api-base-url http://127.0.0.1:8080   # emulator e2e build
#   scripts/app/release.sh --verify <file.aab|file.apk>                  # signer + 16 KB checks
#
# Options:
#   --api-base-url URL  the API the app pairs with and uploads to (or OMW_API_BASE_URL). Must be
#                       https://, except http://127.0.0.1 / localhost for the emulator build
#                       (adb reverse). It is built in; pairing links never change it.
#   --abis LIST         ABIs to build (default: AAB arm64-v8a,armeabi-v7a; APK arm64-v8a)
#   --version-code N    default: minutes since 2026-01-01 UTC (always increasing; Play needs that)
#   --out DIR           artifact + report folder (default: <checkout>/.cache/app-release)
#   --keep-android      keep the generated frontend/app/android (~1.5 GB) for a quicker rebuild
# Environment: OMW_ANDROID_PACKAGE (applicationId, default app.omw.traveler; it can never change
# after the first Play upload), OMW_UPLOAD_KEY_DIR (default <checkout>/.secrets).
#
# The upload key: OMW_UPLOAD_KEY_DIR/omw-upload.p12 (PKCS12, RSA 4096, valid ~27 years) and
# omw-upload.properties (its password; both mode 600, git-ignored). Nothing here prints a password;
# Gradle reads the properties file itself (OMW_UPLOAD_KEYSTORE_PROPERTIES). The public upload
# certificate is exported as omw-upload-cert.pem (Play Console: App integrity, only needed when
# asked for it; with Play App Signing, Google keeps the app signing key and this key only uploads).
# Back up the .p12 and the .properties file together, e.g. in the password manager: a lost upload
# key can be reset through Play support, but that takes days.
#
# Output: <out>/omw-traveler-<versionName>-<versionCode>[-<kind>].{aab,apk} and a .json report
# (size, ABIs, 16 KB page-size check, signer). Needs >= 5 GB free disk; never contacts any host
# except Gradle's and npm's package mirrors.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$HERE/env.sh"
APP="$OMW_ROOT/frontend/app"
KEY_DIR="${OMW_UPLOAD_KEY_DIR:-$OMW_ROOT/.secrets}"
KEYSTORE="$KEY_DIR/omw-upload.p12"
KEYPROPS="$KEY_DIR/omw-upload.properties"
CERT="$KEY_DIR/omw-upload-cert.pem"
ALIAS=omw-upload

KIND=""
ABIS=""
OUT="$OMW_ROOT/.cache/app-release"
KEEP=0
CREATE_KEY=0
VERIFY=""
VERSION_CODE="${OMW_VERSION_CODE:-}"
API_BASE="${OMW_API_BASE_URL:-}"

log() { printf '[release] %s\n' "$*" >&2; }
die() { printf '[release] %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --aab) KIND=aab; shift ;;
    --apk) KIND=apk; shift ;;
    --api-base-url) API_BASE="$2"; shift 2 ;;
    --abis) ABIS="$2"; shift 2 ;;
    --version-code) VERSION_CODE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --keep-android) KEEP=1; shift ;;
    --create-upload-key) CREATE_KEY=1; shift ;;
    --verify) VERIFY="$2"; shift 2 ;;
    -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

# ---- checks -----------------------------------------------------------------------------------

# verify_signer FILE: the AAB/APK verifies and its signer is the upload key (APK: also zipalign
# with 16 KiB pages for uncompressed native libraries). Prints no fingerprint.
verify_signer() {
  local file="$1" want got bt
  want="$(keytool -printcert -file "$CERT" 2>/dev/null | awk '/SHA256:/ {print $2; exit}')"
  if [[ "$file" == *.aab ]]; then
    # Not -strict: Android upload keys are self-signed and untimestamped, which -strict rejects.
    jarsigner -verify "$file" 2>/dev/null | grep -x 'jar verified.' >/dev/null || die "jarsigner could not verify $file"
    got="$(keytool -printcert -jarfile "$file" 2>/dev/null | awk '/SHA256:/ {print $2; exit}')"
  else
    bt="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
    "$bt/apksigner" verify "$file" >/dev/null || die "apksigner could not verify $file"
    got="$("$bt/apksigner" verify --print-certs "$file" 2>/dev/null | awk -F': ' '/certificate SHA-256 digest/ {print toupper($NF); exit}' | sed 's/../&:/g; s/:$//')"
    "$bt/zipalign" -c -P 16 4 "$file" >/dev/null || die "zipalign -P 16 check failed for $file"
  fi
  [[ -n "$want" && "$got" == "$want" ]] || die "$file is not signed with the upload key in $KEY_DIR"
  log "signed with the upload key: yes"
}

if [[ -n "$VERIFY" ]]; then
  verify_signer "$VERIFY"
  python3 -I "$HERE/check-artifact.py" "$VERIFY"
  exit $?
fi

# ---- the upload key ---------------------------------------------------------------------------

create_upload_key() {
  if [[ -e "$KEYSTORE" || -e "$KEYPROPS" ]]; then
    die "an upload key already exists in $KEY_DIR: not overwriting it"
  fi
  mkdir -p "$KEY_DIR"
  chmod 700 "$KEY_DIR"
  local pass
  pass="$(openssl rand -base64 33 | tr -d '\n/+=' | cut -c1-40)"
  [[ ${#pass} -ge 32 ]] || die "could not generate a password"
  (
    umask 077
    # PKCS12 keeps one password for the store and the key.
    OMW_KS_PASS="$pass" keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" \
      -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=On My Way upload key" \
      -storepass:env OMW_KS_PASS -keypass:env OMW_KS_PASS >/dev/null 2>&1
    printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=%s\nkeyPassword=%s\n' "$KEYSTORE" "$pass" "$ALIAS" "$pass" >"$KEYPROPS"
    OMW_KS_PASS="$pass" keytool -exportcert -rfc -keystore "$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" \
      -storepass:env OMW_KS_PASS -file "$CERT" >/dev/null 2>&1
  )
  chmod 600 "$KEYSTORE" "$KEYPROPS" "$CERT"
  log "upload key created: $KEYSTORE (+ omw-upload.properties, omw-upload-cert.pem; mode 600, never printed)"
}

if [[ "$CREATE_KEY" == 1 ]]; then
  create_upload_key
  [[ -z "$KIND" ]] && exit 0
fi
[[ -n "$KIND" ]] || die "choose --aab or --apk (see --help)"
[[ -f "$KEYSTORE" && -f "$KEYPROPS" ]] || die "no upload key in $KEY_DIR: run scripts/app/release.sh --create-upload-key first"
for f in "$KEYSTORE" "$KEYPROPS"; do
  [[ "$(stat -f '%Lp' "$f" 2>/dev/null || stat -c '%a' "$f")" == 600 ]] || die "$f must be mode 600"
done

# ---- inputs -----------------------------------------------------------------------------------

[[ -n "$API_BASE" ]] || die "--api-base-url is required: the API's public https:// URL (for an emulator build http://127.0.0.1:8080)"
API_BASE="${API_BASE%/}"
LABEL=""
if [[ "$API_BASE" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]]; then
  [[ "$KIND" == apk ]] || die "a Play bundle must use an https:// API, not $API_BASE"
  LABEL="-emulator"
elif [[ ! "$API_BASE" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/.*)?$ ]]; then
  die "the API base must be https:// (got $API_BASE)"
fi
API_HOST="$(printf '%s' "$API_BASE" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
if [[ "$API_HOST" == *.invalid || "$API_HOST" == *.example || "$API_HOST" == example.* ]]; then
  LABEL="-placeholder-api"
  log "WARNING: $API_HOST is a placeholder: this build can't pair or upload. Not for Play."
fi
if [[ -z "$ABIS" ]]; then
  if [[ "$KIND" == aab ]]; then ABIS="arm64-v8a,armeabi-v7a"; else ABIS="arm64-v8a"; fi
fi
if [[ -z "$VERSION_CODE" ]]; then
  VERSION_CODE=$(( ($(date -u +%s) - $(date -u -j -f '%Y-%m-%dT%H:%M:%S' '2026-01-01T00:00:00' +%s 2>/dev/null || date -u -d '2026-01-01T00:00:00' +%s)) / 60 ))
fi
[[ "$VERSION_CODE" =~ ^[0-9]+$ && "$VERSION_CODE" -ge 1 && "$VERSION_CODE" -le 2100000000 ]] || die "bad version code $VERSION_CODE"
SHA="$(git -C "$OMW_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
DIRTY=""
[[ -n "$(git -C "$OMW_ROOT" status --porcelain -- frontend/app packages/contracts 2>/dev/null)" ]] && DIRTY="-dirty"
VERSION_NAME="0.5.0-$(date -u +%Y%m%d)-$SHA$DIRTY"

free_gb="$(df -g / | awk 'NR==2 {print $4}')"
((free_gb >= 5)) || die "only ${free_gb} GB free on /: a release build needs at least 5 GB"

export OMW_API_BASE_URL="$API_BASE" OMW_VERSION_CODE="$VERSION_CODE" OMW_VERSION_NAME="$VERSION_NAME"
export OMW_UPLOAD_KEYSTORE_PROPERTIES="$KEYPROPS"
export NODE_ENV=production CI=1
export ORG_GRADLE_PROJECT_reactNativeArchitectures="$ABIS"

log "building a release $KIND: versionName $VERSION_NAME, versionCode $VERSION_CODE, ABIs $ABIS, API $API_BASE, package ${OMW_ANDROID_PACKAGE:-app.omw.traveler}"
START=$SECONDS
cd "$APP"
# A clean prebuild: release artifacts come from freshly generated native sources.
npx expo prebuild --platform android --no-install --clean >&2
cd android
if [[ "$KIND" == aab ]]; then
  ./gradlew --console=plain :app:bundleRelease >&2
  SRC="app/build/outputs/bundle/release/app-release.aab"
else
  ./gradlew --console=plain :app:assembleRelease >&2
  SRC="app/build/outputs/apk/release/app-release.apk"
fi
[[ -f "$SRC" ]] || die "no $SRC: was the build signed? (OMW_UPLOAD_KEYSTORE_PROPERTIES)"
BUILD_SECONDS=$((SECONDS - START))

mkdir -p "$OUT"
NAME="omw-traveler-$VERSION_NAME-$VERSION_CODE$LABEL.$KIND"
cp "$SRC" "$OUT/$NAME"
REPORT="$OUT/${NAME%.*}.json"

# ---- checks: signer = the upload key, 16 KB pages, permissions, size ---------------------------

verify_signer "$OUT/$NAME"

set +e
python3 -I "$HERE/check-artifact.py" "$OUT/$NAME" --json "$REPORT.tmp" >&2
check=$?
set -e
python3 -I - "$REPORT.tmp" "$REPORT" "$VERSION_NAME" "$VERSION_CODE" "$ABIS" "$API_HOST" "$BUILD_SECONDS" <<'PY'
import json, sys
src, dst, vname, vcode, abis, host, secs = sys.argv[1:8]
r = json.load(open(src))
r.update({"versionName": vname, "versionCode": int(vcode), "abisBuilt": abis.split(","), "apiHost": host,
          "signedWithUploadKey": True, "r8": True, "buildSeconds": int(secs)})
json.dump(r, open(dst, "w"), indent=2)
open(dst, "a").write("\n")
PY
rm -f "$REPORT.tmp"

cd "$OMW_ROOT"
if [[ "$KEEP" == 0 ]]; then
  rm -rf "$APP/android"
  log "removed frontend/app/android (use --keep-android to keep it)"
fi
log "done in $((SECONDS - START)) s: $OUT/$NAME ($(du -h "$OUT/$NAME" | cut -f1)); report ${REPORT#"$OMW_ROOT"/}"
[[ "$check" == 0 ]] || die "the artifact check failed (see above)"
echo "$OUT/$NAME"
