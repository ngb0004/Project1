/**
 * Two projects: the native preset (React Native Testing Library) and a web
 * project that renders the same components through react-native-web in jsdom,
 * the way the Expo web build and the admin console preview do.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testTimeout: 20000,
  projects: [
    {
      displayName: 'native',
      preset: 'jest-expo',
      testMatch: ['<rootDir>/__tests__/**/*.test.ts?(x)'],
      testPathIgnorePatterns: ['/node_modules/', '\\.web\\.test\\.tsx?$'],
    },
    {
      displayName: 'web',
      preset: 'jest-expo/web',
      testMatch: ['<rootDir>/__tests__/**/*.web.test.ts?(x)'],
      // The web preset passes no Babel preset of its own when the app has no babel.config.js.
      transform: {
        '\\.[jt]sx?$': [
          'babel-jest',
          {
            presets: [require.resolve('expo/internal/babel-preset')],
            caller: { name: 'metro', bundler: 'metro', platform: 'web' },
          },
        ],
      },
    },
  ],
};
