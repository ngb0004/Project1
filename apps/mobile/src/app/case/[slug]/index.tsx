import { useLocalSearchParams, useRouter } from 'expo-router';
import { DiveFlow } from '@sia/dive-ui';
import { BackendNotice, Loading, Screen } from '@/components/Screen';
import { useBackend } from '@/lib/backend';
import { diveServices, shareBaseUrl } from '@/lib/services';
import { useDeviceId } from '@/lib/useDeviceId';

/** The deep-link target: /case/<slug>, optionally ?v=<version> for a specific published version. */
export default function CaseScreen() {
  const { slug, v } = useLocalSearchParams<{ slug: string; v?: string }>();
  const backend = useBackend();
  const deviceId = useDeviceId();
  const router = useRouter();
  const version = v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;

  return (
    <Screen>
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
        />
      )}
    </Screen>
  );
}
