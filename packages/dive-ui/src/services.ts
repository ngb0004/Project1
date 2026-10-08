import type { View } from 'react-native';
import type { ShareCardData } from '@sia/dive-engine';

/**
 * Platform services the host app injects. dive-ui renders on iOS, Android and
 * the web (the Expo app and the admin preview), so it never opens links, shares
 * or touches the clipboard itself.
 */

export interface ShareRequest {
  card: ShareCardData;
  /** Ready-to-paste text: headline, tagline and the deep link. */
  text: string;
  /** The rendered share card, for capturing to an image. Null if it is not mounted. */
  view: View | null;
}

export type ShareOutcome =
  | { status: 'shared' }
  | { status: 'cancelled' }
  /** The link was copied instead (no share sheet); `download` saves the card image when offered. */
  | { status: 'copied'; download?: () => void }
  | { status: 'failed'; message: string };

export interface DiveServices {
  openUrl(url: string): void | Promise<void>;
  share(request: ShareRequest): Promise<ShareOutcome | void>;
  copy?(text: string): Promise<void>;
}
