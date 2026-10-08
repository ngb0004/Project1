import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import { Platform, Share, type View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import type { DiveServices } from '@sia/dive-ui';
import { config } from './config';
import { progressStore } from './progress';

async function capturePng(view: View | null): Promise<string | null> {
  if (!view) return null;
  try {
    return await captureRef(view, { format: 'png', quality: 1, result: 'tmpfile' });
  } catch {
    return null;
  }
}

/**
 * Native sharing. iOS sends the card image and the text with its link in one
 * share sheet. Android's share sheet carries text or a file, not both (React
 * Native's Share takes text only; expo-sharing takes a file only), so Share
 * sends the text with its tappable link and "Share the image" sends the card.
 * Android resolves as soon as the sheet opens, and expo-sharing resolves on any
 * dismissal, so neither can report whether anything was sent.
 */
export const diveServices: DiveServices = {
  openUrl: (url) => Linking.openURL(url).then(() => undefined),
  copy: (text) => Clipboard.setStringAsync(text),
  progress: progressStore,
  async share({ card, text, view }) {
    const image = Platform.OS === 'ios' ? await capturePng(view) : null;
    const result = await Share.share(image ? { message: text, url: image } : { message: text, title: card.headline }, {
      dialogTitle: card.headline,
      subject: card.headline,
    });
    if (Platform.OS !== 'ios') return { status: 'opened' };
    return result.action === Share.dismissedAction ? { status: 'cancelled' } : { status: 'shared' };
  },
  shareImage:
    Platform.OS === 'android'
      ? async ({ card, view }) => {
          const uri = await capturePng(view);
          if (!uri || !(await Sharing.isAvailableAsync())) {
            return { status: 'failed', message: "Couldn't prepare the image. Share the link instead." };
          }
          await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: card.headline });
          return { status: 'opened' };
        }
      : undefined,
};

let warned = false;

/**
 * Share links point at the public web app (an http(s) origin). Without one a
 * native build shares no link at all: a dive:// link opens nothing for
 * recipients without the app, and messengers do not make it tappable.
 */
export function shareBaseUrl(): string | null {
  if (config.shareBaseUrl && /^https?:\/\//i.test(config.shareBaseUrl)) return config.shareBaseUrl;
  if (__DEV__ && !warned) {
    warned = true;
    console.warn('EXPO_PUBLIC_SHARE_BASE_URL is not set to an http(s) origin, so share cards carry no link. See .env.example.');
  }
  return null;
}
