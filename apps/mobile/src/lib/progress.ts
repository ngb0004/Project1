import * as SecureStore from 'expo-secure-store';
import type { DiveProgressStore } from '@sia/dive-ui';

// SecureStore keys allow letters, digits, ".", "-" and "_", which covers every slug.
const key = (slug: string) => `dive.progress.${slug}`;

/** The case version this install is part-way through, by slug (next to the device id). */
export const progressStore: DiveProgressStore = {
  async get(slug) {
    try {
      const v = Number(await SecureStore.getItemAsync(key(slug)));
      return Number.isInteger(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  },
  async set(slug, version) {
    try {
      if (version === null) await SecureStore.deleteItemAsync(key(slug));
      else await SecureStore.setItemAsync(key(slug), String(version));
    } catch {
      // Storage unavailable: a reopened dive falls back to the live version.
    }
  },
};
