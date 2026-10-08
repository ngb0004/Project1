import * as Clipboard from 'expo-clipboard';
import { captureRef } from 'react-native-view-shot';
import type { View } from 'react-native';
import type { DiveServices } from '@sia/dive-ui';
import { config } from './config';

const FILE_NAME = 'dive-result.png';

async function capturePng(view: View | null): Promise<string | null> {
  if (!view) return null;
  try {
    return await captureRef(view, { format: 'png', quality: 1, result: 'data-uri' });
  } catch {
    return null;
  }
}

function pngFile(dataUri: string): File {
  const bytes = atob(dataUri.slice(dataUri.indexOf(',') + 1));
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new File([buf], FILE_NAME, { type: 'image/png' });
}

function download(dataUri: string) {
  const a = document.createElement('a');
  a.href = dataUri;
  a.download = FILE_NAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Web: the Web Share API when the browser has it (with the card image when it
 * can share files); otherwise copy the link and offer the PNG as a download.
 */
export const diveServices: DiveServices = {
  openUrl: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  copy: (text) => Clipboard.setStringAsync(text).then(() => undefined),
  async share({ card, text, view }) {
    const png = await capturePng(view);
    if (typeof navigator.share === 'function') {
      const data: ShareData = { title: card.headline, text: `${card.headline} ${card.tagline}`, url: card.url };
      const file = png ? pngFile(png) : null;
      if (file && navigator.canShare?.({ files: [file] })) data.files = [file];
      try {
        await navigator.share(data);
        return { status: 'shared' };
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return { status: 'cancelled' };
        // NotAllowedError and friends: fall back to copying the link.
      }
    }
    await Clipboard.setStringAsync(text);
    return { status: 'copied', download: png ? () => download(png) : undefined };
  },
};

export function shareBaseUrl(): string {
  return config.shareBaseUrl ?? window.location.origin;
}
