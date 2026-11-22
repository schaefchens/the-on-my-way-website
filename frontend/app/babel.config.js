// babel-preset-expo adds the Reanimated/worklets plugin by itself; Lingui's macros compile here.
module.exports = (api) => {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['@lingui/babel-plugin-lingui-macro'],
  };
};
