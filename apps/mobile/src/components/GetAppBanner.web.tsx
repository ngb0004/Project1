import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, space, type } from '@sia/dive-ui';
import { config } from '@/lib/config';

const DISMISSED_KEY = 'dive.getAppBanner.dismissed';

type Store = { label: string; url: string };

/** The store links that fit this device: the one for its platform, or every one there is on a computer. */
function storesFor(userAgent: string): Store[] {
  const ios = config.iosAppUrl ? { label: 'App Store', url: config.iosAppUrl } : null;
  const android = config.androidAppUrl ? { label: 'Google Play', url: config.androidAppUrl } : null;
  // iPadOS reports itself as a Mac; the touch check tells them apart.
  const isIos = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1);
  if (isIos) return ios ? [ios] : [];
  if (/Android/.test(userAgent)) return android ? [android] : [];
  return [ios, android].filter((s): s is Store => s !== null);
}

/**
 * A slim "Get the app" bar for people who open a shared link in a browser. It
 * stays hidden until a store link is configured, and once closed it stays closed
 * on this browser. Decided after the first render, so the server-rendered HTML
 * and the first client render match.
 */
export function GetAppBanner() {
  const [stores, setStores] = useState<Store[]>([]);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      // Storage blocked (private mode, an embedded preview): just show the banner.
    }
    if (!dismissed) setStores(storesFor(navigator.userAgent));
  }, []);

  if (stores.length === 0) return null;

  const close = () => {
    setStores([]);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Not remembered; it is closed for this visit.
    }
  };

  return (
    <View style={styles.bar} testID="get-app-banner" role="region" aria-label="Get the app">
      <Text style={[type.small, styles.text]}>Dive is better in the app.</Text>
      {stores.map((s) => (
        <Pressable key={s.label} onPress={() => void Linking.openURL(s.url)} role="link" style={styles.link}>
          <Text style={styles.linkText}>Get it on {s.label}</Text>
        </Pressable>
      ))}
      <Pressable onPress={close} role="button" aria-label="Close" style={styles.close} testID="get-app-close">
        <Text style={styles.closeText}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    backgroundColor: colors.ink,
  },
  text: { color: colors.paper, flexShrink: 1 },
  link: { paddingVertical: 4, paddingHorizontal: space.sm, borderWidth: 1, borderColor: colors.paper },
  linkText: { fontFamily: fonts.sans, fontSize: 14, color: colors.paper },
  close: { marginLeft: 'auto', paddingHorizontal: space.sm, minHeight: 32, justifyContent: 'center' },
  closeText: { fontSize: 22, lineHeight: 24, color: colors.paper },
});
