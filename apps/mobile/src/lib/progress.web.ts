import type { DiveProgressStore } from '@sia/dive-ui';

const key = (slug: string) => `dive.progress.${slug}`;

/** The case version this browser profile is part-way through, by slug (next to the device id). */
export const progressStore: DiveProgressStore = {
  async get(slug) {
    try {
      const v = Number(window.localStorage.getItem(key(slug)));
      return Number.isInteger(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  },
  async set(slug, version) {
    try {
      if (version === null) window.localStorage.removeItem(key(slug));
      else window.localStorage.setItem(key(slug), String(version));
    } catch {
      // Storage blocked: a reopened dive falls back to the live version.
    }
  },
};
