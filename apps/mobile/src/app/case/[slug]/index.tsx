import { useState } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { DiveFlow } from '@sia/dive-ui';
import { BackendNotice, Loading, Screen } from '@/components/Screen';
import { useBackend } from '@/lib/backend';
import { diveServices, shareBaseUrl } from '@/lib/services';
import { useDeviceId } from '@/lib/useDeviceId';
import { useLeaveGuard } from '@/lib/useLeaveGuard';

/** The deep-link target: /case/<slug>, optionally ?v=<version> for a specific published version. */
export default function CaseScreen() {
  const { slug, v } = useLocalSearchParams<{ slug: string; v?: string }>();
  const backend = useBackend();
  const deviceId = useDeviceId();
  const router = useRouter();
  // Versions are positive 32-bit integers; anything else opens the live version.
  const version = v !== undefined && /^[1-9]\d{0,8}$/.test(v) ? Number(v) : undefined;
  // Mid-dive, the iOS back swipe would drop the reader out of the whole dive
  // (the in-app Back steps back one screen), and the web asks before leaving.
  const [inProgress, setInProgress] = useState(false);
  useLeaveGuard(inProgress);

  return (
    <Screen>
      <Stack.Screen options={{ gestureEnabled: !inProgress }} />
      {backend.status !== 'ready' ? (
        <BackendNotice backend={backend} />
      ) : !deviceId ? (
        <Loading />
      ) : (
        <DiveFlow
          api={backend.api}
          slug={slug}
          version={version}
          deviceId={deviceId}
          shareBaseUrl={shareBaseUrl()}
          services={diveServices}
          onExit={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          onOpenTransparency={() => router.push({ pathname: '/case/[slug]/about', params: { slug } })}
          onInProgressChange={setInProgress}
        />
      )}
    </Screen>
  );
}
