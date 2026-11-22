/**
 * The release-relevant rules of app.config.ts: the API base is https (only the phone's own
 * loopback may be cleartext, for the emulator build), cleartext traffic is allowed only then,
 * the permissions Play flags stay blocked, and release builds are signed with the upload key named
 * by OMW_UPLOAD_KEYSTORE_PROPERTIES (never the debug key).
 */
import type { ExpoConfig } from 'expo/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = (cfg: Record<string, unknown>) => Promise<{ modResults: { contents: string } }>;
type ManifestMod = (cfg: Record<string, unknown>) => Promise<{
  modResults: { manifest: { $: Record<string, string>; application: { 'meta-data'?: unknown[] }[] } };
}>;
type GradleMod = (
  cfg: Record<string, unknown>,
) => Promise<{ modResults: { type: string; key?: string; value?: string }[] }>;

async function loadConfig(env: Record<string, string | undefined>): Promise<ExpoConfig> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, undefined as unknown as string);
    else vi.stubEnv(k, v);
  }
  return (await import('../app.config.ts')).default as ExpoConfig;
}

function buildProperties(cfg: ExpoConfig): Record<string, unknown> {
  const entry = cfg.plugins?.find((p) => Array.isArray(p) && p[0] === 'expo-build-properties');
  return (entry as [string, { android: Record<string, unknown> }])[1].android;
}

describe('app.config.ts', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the local API through adb reverse, with cleartext only for it', async () => {
    const cfg = await loadConfig({ OMW_API_BASE_URL: undefined });
    expect(cfg.extra?.apiBaseUrl).toBe('http://127.0.0.1:8080');
    expect(buildProperties(cfg).usesCleartextTraffic).toBe(true);
  });

  it('uses an https API without any cleartext traffic, with R8 and resource shrinking', async () => {
    const cfg = await loadConfig({ OMW_API_BASE_URL: 'https://api.example.org' });
    expect(cfg.extra?.apiBaseUrl).toBe('https://api.example.org');
    const props = buildProperties(cfg);
    expect(props.usesCleartextTraffic).toBe(false);
    expect(props.enableMinifyInReleaseBuilds).toBe(true);
    expect(props.enableShrinkResourcesInReleaseBuilds).toBe(true);
  });

  it('refuses a cleartext API anywhere but the loopback', async () => {
    await expect(loadConfig({ OMW_API_BASE_URL: 'http://10.0.2.2:8080' })).rejects.toThrow(/https/);
    await expect(loadConfig({ OMW_API_BASE_URL: 'http://api.example.org' })).rejects.toThrow(/https/);
    await expect(loadConfig({ OMW_API_BASE_URL: 'ftp://127.0.0.1' })).rejects.toThrow(/https/);
  });

  it('keeps the permissions Play flags blocked', async () => {
    const cfg = await loadConfig({});
    const blocked = cfg.android?.blockedPermissions ?? [];
    for (const p of [
      'android.permission.VIBRATE',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.READ_MEDIA_IMAGES',
    ]) {
      expect(blocked).toContain(p);
    }
    expect(cfg.android?.allowBackup).toBe(false);
  });

  it('signs release builds with the upload key from the properties file, read by Gradle', async () => {
    const cfg = await loadConfig({});
    const mods = (cfg as { mods?: { android?: { appBuildGradle?: Mod } } }).mods;
    const mod = mods?.android?.appBuildGradle;
    expect(mod).toBeTypeOf('function');
    const run = (contents: string) =>
      (mod as Mod)({
        ...cfg,
        modResults: { contents, language: 'groovy', path: 'android/app/build.gradle' },
        modRequest: {
          platform: 'android',
          modName: 'appBuildGradle',
          projectRoot: '/x',
          platformProjectRoot: '/x/android',
          introspect: false,
        },
      });
    const once = (await run('android {}\n')).modResults.contents;
    expect(once).toContain("System.getenv('OMW_UPLOAD_KEYSTORE_PROPERTIES')");
    expect(once).toContain('android.buildTypes.release.signingConfig android.signingConfigs.omwUpload');
    expect(once).toContain('android.buildTypes.release.signingConfig null');
    expect(once).not.toMatch(/storePassword\s+'/); // no literal password, ever
    const twice = (await run(once)).modResults.contents;
    expect(twice).toBe(once); // idempotent across prebuilds
  });

  it('leaves out expo-camera’s ML Kit document scanner (and keeps the barcode scanner off)', async () => {
    const cfg = await loadConfig({});
    const mods = (cfg as { mods?: { android?: { gradleProperties?: GradleMod } } }).mods;
    const mod = mods?.android?.gradleProperties;
    expect(mod).toBeTypeOf('function');
    const props = (
      await (mod as GradleMod)({
        ...cfg,
        modResults: [{ type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx2048m' }],
        modRequest: {
          platform: 'android',
          modName: 'gradleProperties',
          projectRoot: '/x',
          platformProjectRoot: '/x/android',
          introspect: false,
        },
      })
    ).modResults;
    expect(props).toContainEqual({ type: 'property', key: 'expo.camera.document-scanner-enabled', value: 'false' });
    const camera = cfg.plugins?.find((p) => Array.isArray(p) && p[0] === 'expo-camera') as [
      string,
      Record<string, unknown>,
    ];
    expect(camera[1].barcodeScannerEnabled).toBe(false);
    // The switches reach Gradle only when expo-camera is built from source (not its Maven artifact).
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      expo?: { autolinking?: { android?: { buildFromSource?: string[] } } };
    };
    expect(pkg.expo?.autolinking?.android?.buildFromSource).toContain('expo-camera');
    // …and Play services is not asked to download ML Kit's barcode module at install.
    const manifestMod = (cfg as { mods?: { android?: { manifest?: ManifestMod } } }).mods?.android?.manifest;
    expect(manifestMod).toBeTypeOf('function');
    const manifest = {
      manifest: {
        $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
        application: [{ $: { 'android:name': '.MainApplication' } }],
      },
    };
    const out = await (manifestMod as ManifestMod)({
      ...cfg,
      modResults: manifest,
      modRequest: {
        platform: 'android',
        modName: 'manifest',
        projectRoot: '/x',
        platformProjectRoot: '/x/android',
        introspect: false,
      },
    });
    expect(out.modResults.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
    expect(out.modResults.manifest.application[0]?.['meta-data']).toContainEqual({
      $: { 'android:name': 'com.google.mlkit.vision.DEPENDENCIES', 'tools:node': 'remove' },
    });
  });
});
