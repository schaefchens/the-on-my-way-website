/** Stand-in for `expo-constants` in Vitest: the build's app config, as app.config.ts makes it. */
const Constants = {
  expoConfig: { version: '0.5.0', extra: { apiBaseUrl: 'http://127.0.0.1:8080/', versionName: 'test' } },
};
export default Constants;
