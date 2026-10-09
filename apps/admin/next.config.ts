import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The review screen's preview plays the dive with the same React Native
 * components the app uses (@sia/dive-ui), rendered through react-native-web.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The console is never framed (no clickjacking of publish, archive or reject),
  // never sniffed, and never leaks its URLs to the source sites it links to.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
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
