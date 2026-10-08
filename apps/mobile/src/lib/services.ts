import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import { Share } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import type { DiveServices } from '@sia/dive-ui';
import { config } from './config';

/** Native: capture the share card to a PNG and open the system share sheet. */
export const diveServices: DiveServices = {
  openUrl: (url) => Linking.openURL(url).then(() => undefined),
  copy: (text) => Clipboard.setStringAsync(text).then(() => undefined),
  async share({ card, text, view }) {
    if (view && (await Sharing.isAvailableAsync())) {
      const uri = await captureRef(view, { format: 'png', quality: 1, result: 'tmpfile' });
      await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: card.headline });
      return { status: 'shared' };
    }
    const result = await Share.share({ message: text, url: card.url });
    return result.action === Share.dismissedAction ? { status: 'cancelled' } : { status: 'shared' };
  },
};

/** Share links point at the public web app when configured, otherwise at the app's own scheme. */
export function shareBaseUrl(): string {
  if (config.shareBaseUrl) return config.shareBaseUrl;
  const scheme = Constants.expoConfig?.scheme;
  return `${(Array.isArray(scheme) ? scheme[0] : scheme) ?? 'dive'}://`;
}
