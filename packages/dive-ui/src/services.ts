import type { View } from 'react-native';
import type { ShareCardData } from '@sia/dive-engine';

/**
 * Platform services the host app injects. dive-ui renders on iOS, Android and
 * the web (the Expo app and the admin preview), so it never opens links, shares,
 * touches the clipboard or stores anything itself.
 */

export interface ShareRequest {
  card: ShareCardData;
  /** Ready-to-paste text: headline, tagline and the deep link (when there is one). */
  text: string;
  /** The rendered share card, for capturing to an image. Null if it is not mounted. */
  view: View | null;
}

export type ShareOutcome =
  | { status: 'shared' }
  | { status: 'cancelled' }
  /** The share sheet opened, but the platform cannot tell a share from a cancel. */
  | { status: 'opened' }
  /** The link was copied instead (no share sheet); `download` saves the card image when offered. */
  | { status: 'copied'; download?: () => void }
  /** Nothing could be shared or copied: the screen shows the link to copy by hand. */
  | { status: 'manual'; download?: () => void }
  | { status: 'failed'; message: string };

/** Which version of a case this device is part-way through, by slug. */
export interface DiveProgressStore {
  get(slug: string): Promise<number | null>;
  /** Null once the dive is finished (or there is nothing to resume). */
  set(slug: string, version: number | null): Promise<void>;
}

export interface DiveServices {
  openUrl(url: string): void | Promise<void>;
  /** Shares the card with its text and link, and the card image where the platform can send both at once. */
  share(request: ShareRequest): Promise<ShareOutcome | void>;
  /** Shares the card image on its own, for platforms whose `share` can only carry the text and link. */
  shareImage?(request: ShareRequest): Promise<ShareOutcome | void>;
  /** Resolves false when nothing reached the clipboard. */
  copy?(text: string): Promise<boolean>;
  /**
   * Remembers the version of an unfinished dive, so a revision published
   * mid-dive does not quietly start the reader over on the new version.
   */
  progress?: DiveProgressStore;
}
