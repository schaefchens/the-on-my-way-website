/**
 * Expo config of the traveler app (Android first). `android/` is generated from this file by
 * `expo prebuild` (CNG) and never committed.
 *
 * Build-time environment (all optional):
 * - OMW_API_BASE_URL: the API the app pairs with and uploads to. Pairing links never set it (a
 *   link from a stranger must not redirect her uploads). Default: the local PHP API through
 *   `adb reverse tcp:8080 tcp:8080`, so development never reaches the live hosts.
 * - OMW_ANDROID_PACKAGE: the applicationId. Decide it before the first Play upload (it can never
 *   change afterwards); the default is deliberately neutral.
 * - OMW_VERSION_CODE / OMW_VERSION_NAME: set by the release build script (scripts/app/release.sh).
 *
 * Release builds (scripts/app/release.sh): R8 + resource shrinking, signed with the upload key whose
 * properties file OMW_UPLOAD_KEYSTORE_PROPERTIES names at Gradle time (never written into
 * android/). Without it a release build stays unsigned, never debug-signed. Cleartext HTTP is
 * allowed only when the API base is the phone's own loopback (the emulator test build reaches the
 * local API through `adb reverse`); every other base must be https.
 */
import type { ExpoConfig } from 'expo/config';
import {
  AndroidConfig,
  type ConfigPlugin,
  withAndroidManifest,
  withAppBuildGradle,
  withGradleProperties,
} from 'expo/config-plugins';

const apiBaseUrl = process.env.OMW_API_BASE_URL ?? 'http://127.0.0.1:8080';
const loopbackHttp = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(apiBaseUrl);
if (!loopbackHttp && !/^https:\/\/[^/\s]+/.test(apiBaseUrl)) {
  throw new Error(`OMW_API_BASE_URL must be https:// (or http://127.0.0.1 for the emulator), got ${apiBaseUrl}`);
}

const SIGNING_MARK = '// omw: release signing (app.config.ts withReleaseSigning)';

/**
 * Signs `release` with the upload key from the properties file named by
 * OMW_UPLOAD_KEYSTORE_PROPERTIES (storeFile, storePassword, keyAlias, keyPassword), read when Gradle
 * runs, so no path or password ever lands in the generated android/ folder. Without it the
 * release build type has no signing config (an unsigned artifact), instead of the template's
 * debug key.
 */
const withReleaseSigning: ConfigPlugin = (cfg) =>
  withAppBuildGradle(cfg, (mod) => {
    if (!mod.modResults.contents.includes(SIGNING_MARK)) {
      mod.modResults.contents += `
${SIGNING_MARK}
def omwUploadProps = System.getenv('OMW_UPLOAD_KEYSTORE_PROPERTIES')
if (omwUploadProps) {
    def p = new Properties()
    file(omwUploadProps).withInputStream { p.load(it) }
    android.signingConfigs.create('omwUpload') {
        storeFile file(p.getProperty('storeFile'))
        storePassword p.getProperty('storePassword')
        keyAlias p.getProperty('keyAlias')
        keyPassword p.getProperty('keyPassword')
    }
    android.buildTypes.release.signingConfig android.signingConfigs.omwUpload
} else {
    android.buildTypes.release.signingConfig null
}
`;
    }
    return mod;
  });

/**
 * expo-camera links ML Kit's document scanner (Play services, its own activities) unless the
 * Gradle property says no; v0.5 never scans documents. The barcode scanner is off through the
 * camera plugin's own option (until the QR pairing). Both switches only work because expo-camera
 * is built from source (package.json `expo.autolinking.android.buildFromSource`): its precompiled
 * Maven artifact always brings both scanners.
 */
const DOCUMENT_SCANNER_PROPERTY = 'expo.camera.document-scanner-enabled';
const withoutDocumentScanner: ConfigPlugin = (cfg) =>
  withGradleProperties(cfg, (mod) => {
    mod.modResults = AndroidConfig.BuildProperties.updateAndroidBuildProperty(
      mod.modResults,
      DOCUMENT_SCANNER_PROPERTY,
      'false',
    );
    return mod;
  });

/**
 * expo-camera's own manifest asks Play services to download ML Kit's barcode UI module at install
 * (`com.google.mlkit.vision.DEPENDENCIES` = barcode_ui). Without the scanners linked that download
 * is pointless: the merged manifest drops the entry.
 */
const MLKIT_DEPENDENCIES = 'com.google.mlkit.vision.DEPENDENCIES';
const withoutMlKitDownload: ConfigPlugin = (cfg) =>
  withAndroidManifest(cfg, (mod) => {
    const manifest = mod.modResults.manifest;
    manifest.$['xmlns:tools'] ??= 'http://schemas.android.com/tools';
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    app['meta-data'] ??= [];
    if (!app['meta-data'].some((m) => m.$['android:name'] === MLKIT_DEPENDENCIES)) {
      app['meta-data'].push({
        $: { 'android:name': MLKIT_DEPENDENCIES, 'tools:node': 'remove' } as { 'android:name': string },
      });
    }
    return mod;
  });

const fontFamilies = [
  { fontFamily: 'Fraunces', weights: [600] },
  { fontFamily: 'Nunito', weights: [400, 700, 800] },
  { fontFamily: 'PlaypenSans', weights: [400, 500], file: 'playpen_sans' },
  { fontFamily: 'Calistoga', weights: [400] },
  { fontFamily: 'CourierPrime', weights: [700], file: 'courier_prime' },
  { fontFamily: 'Exo2', weights: [800] },
] as const;

const config: ExpoConfig = {
  name: 'On My Way',
  slug: 'on-my-way',
  scheme: 'omw',
  // Android versionName (Play shows it); the build's date + git SHA is extra.versionName.
  version: '0.5.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  // dawn bg; the dusk bg is applied at runtime (src/theme).
  backgroundColor: '#fff8f6',
  platforms: ['android'],
  android: {
    package: process.env.OMW_ANDROID_PACKAGE ?? 'de.schaefchens.onmyway',
    versionCode: Number(process.env.OMW_VERSION_CODE ?? 1),
    allowBackup: false,
    permissions: [],
    blockedPermissions: [
      'android.permission.VIBRATE',
      // The system Photo Picker needs no media permission (Play policy); location never.
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      'android.permission.ACCESS_MEDIA_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      // The template's "display over other apps" (dev overlay); a sensitive permission on Play.
      'android.permission.SYSTEM_ALERT_WINDOW',
    ],
  },
  plugins: [
    'expo-router',
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 29,
          targetSdkVersion: 36,
          compileSdkVersion: 37,
          // R8 (code shrinking + obfuscation) and resource shrinking for release builds.
          enableMinifyInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
          // Only the emulator test build (API on the phone's loopback via adb reverse).
          usesCleartextTraffic: loopbackHttp,
        },
      },
    ],
    [
      'expo-font',
      {
        android: {
          fonts: fontFamilies.map(({ fontFamily, weights, ...rest }) => {
            const file = 'file' in rest ? rest.file : fontFamily.toLowerCase();
            return {
              fontFamily,
              fontDefinitions: weights.map((weight) => ({ path: `./assets/fonts/${file}_${weight}.ttf`, weight })),
            };
          }),
        },
      },
    ],
    ['expo-localization', { supportedLocales: { android: ['en', 'de'] } }],
    ['expo-splash-screen', { backgroundColor: '#fff8f6', dark: { backgroundColor: '#1b1322' } }],
    // App UI (v0.5): camera (photo + video with sound; no barcode scanner until the QR pairing),
    // voice notes (no background playback service), the system Photo Picker, the app lock.
    ['expo-camera', { recordAudioAndroid: true, barcodeScannerEnabled: false }],
    ['expo-audio', { recordAudioAndroid: true, enableBackgroundPlayback: false, enableBackgroundRecording: false }],
    // (No options: `microphonePermission: false` would block RECORD_AUDIO for the camera and voice too.)
    'expo-image-picker',
    'expo-local-authentication',
    ['expo-video', { supportsBackgroundPlayback: false, supportsPictureInPicture: false }],
    'expo-sqlite',
  ],
  extra: {
    apiBaseUrl,
    versionName: process.env.OMW_VERSION_NAME ?? 'dev',
  },
};

export default withReleaseSigning(withoutMlKitDownload(withoutDocumentScanner(config)));
