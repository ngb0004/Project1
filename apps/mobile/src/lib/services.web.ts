import { captureRef } from 'react-native-view-shot';
import type { View } from 'react-native';
import type { DiveServices } from '@sia/dive-ui';
import { config } from './config';
import { progressStore } from './progress';

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
 * Copies text, and says whether it worked. (expo-clipboard's web fallback
 * reports success even when execCommand('copy') copied nothing.)
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable: try the older route below.
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  Object.assign(field.style, { position: 'fixed', top: '0', left: '0', opacity: '0' });
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

/**
 * Web: the Web Share API when the browser has it (with the card image when it
 * can share files); otherwise copy the link and offer the PNG as a download, or
 * show the link to copy by hand when the clipboard refuses too.
 */
export const diveServices: DiveServices = {
  openUrl: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  copy: copyText,
  progress: progressStore,
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
    const downloadPng = png ? () => download(png) : undefined;
    return (await copyText(text)) ? { status: 'copied', download: downloadPng } : { status: 'manual', download: downloadPng };
  },
};

export function shareBaseUrl(): string {
  return config.shareBaseUrl ?? window.location.origin;
}
