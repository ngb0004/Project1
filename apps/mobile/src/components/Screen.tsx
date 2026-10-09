import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Headline, Kicker, MAX_WIDTH, Small, colors, space } from '@sia/dive-ui';
import type { Backend } from '@/lib/backend';
import { GetAppBanner } from './GetAppBanner';

/** Full-screen paper background inside the safe area. */
export function Screen({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
      <GetAppBanner />
      {children}
    </SafeAreaView>
  );
}

export function Loading() {
  return (
    <View style={styles.centered}>
      <ActivityIndicator color={colors.ink} accessibilityLabel="Loading" />
    </View>
  );
}

/** What to show while the data source is not ready: loading, a configuration notice, or an error. */
export function BackendNotice({ backend }: { backend: Exclude<Backend, { status: 'ready' }> }) {
  if (backend.status === 'loading') return <Loading />;
  return (
    <View style={styles.centered}>
      <View style={styles.notice} testID="config-notice">
        {backend.status === 'unconfigured' ? (
          <>
            <Kicker>Not configured</Kicker>
            <Headline>No data source is set up.</Headline>
            <Body>
              Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to play published dives, or
              EXPO_PUBLIC_DEMO_CASES_URL to play demo cases in memory. Then restart the app.
            </Body>
          </>
        ) : (
          <>
            <Kicker>Something went wrong</Kicker>
            <Headline>Couldn't load the dives.</Headline>
            <Small>{backend.message}</Small>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
    backgroundColor: colors.paper,
  },
  notice: { maxWidth: MAX_WIDTH, gap: space.md },
});
