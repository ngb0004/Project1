import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The review screen's preview plays the dive with the same React Native
 * components the app uses (@sia/dive-ui), rendered through react-native-web.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    '@sia/case-schema',
    '@sia/case-store',
    '@sia/dive-engine',
    '@sia/dive-ui',
    'react-native-web',
    'react-native-svg',
  ],
  turbopack: {
    // The pnpm workspace root, so workspace packages and hoisted node_modules resolve.
    root: path.join(__dirname, '../..'),
    resolveAlias: {
      'react-native': 'react-native-web',
    },
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
  },
};

export default nextConfig;
