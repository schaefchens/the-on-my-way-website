/**
 * Metro for the pnpm monorepo (isolated node-linker, the repo default).
 * - expo/metro-config sets watchFolders and node_modules paths for workspaces by itself.
 * - @omw/contracts is consumed from source: the "@omw/source" export condition, plus a fallback
 *   from the sources' "./x.js" specifiers (NodeNext style) to the "./x.ts" files.
 * - .po catalogs compile on import (@lingui/metro-transformer).
 * - The cache lives in the checkout's .cache/metro (OMW_METRO_CACHE overrides it).
 */
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const packagesDir = path.join(workspaceRoot, 'packages') + path.sep;

const config = getDefaultConfig(projectRoot);

config.resolver.unstable_conditionNames = [
  '@omw/source',
  ...(config.resolver.unstable_conditionNames ?? ['require', 'import', 'react-native']),
];
config.resolver.sourceExts = [...config.resolver.sourceExts, 'po'];

const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstreamResolve ?? context.resolveRequest;
  if (moduleName.startsWith('.') && moduleName.endsWith('.js') && context.originModulePath.startsWith(packagesDir)) {
    try {
      return resolve(context, `${moduleName.slice(0, -3)}.ts`, platform);
    } catch {
      // Not a TS source: resolve the specifier as written.
    }
  }
  return resolve(context, moduleName, platform);
};

config.transformer.babelTransformerPath = require.resolve('@lingui/metro-transformer/expo');

// metro-cache comes with expo's Metro; resolve it from there (pnpm keeps it out of our node_modules).
const metroCache = require(
  require.resolve('@expo/metro/metro-cache', { paths: [require.resolve('expo/package.json')] }),
);
config.cacheStores = [
  new metroCache.FileStore({ root: process.env.OMW_METRO_CACHE ?? path.join(workspaceRoot, '.cache', 'metro') }),
];

module.exports = config;
