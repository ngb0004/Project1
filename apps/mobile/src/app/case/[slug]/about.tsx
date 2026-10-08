import { useLocalSearchParams, useRouter } from 'expo-router';
import { TransparencyPage } from '@sia/dive-ui';
import { BackendNotice, Screen } from '@/components/Screen';
import { useBackend } from '@/lib/backend';
import { diveServices } from '@/lib/services';

export default function AboutCaseScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const backend = useBackend();
  const router = useRouter();

  return (
    <Screen>
      {backend.status !== 'ready' ? (
        <BackendNotice backend={backend} />
      ) : (
        <TransparencyPage
          api={backend.api}
          slug={slug}
          openUrl={(url) => void diveServices.openUrl(url)}
          onBack={() =>
            router.canGoBack() ? router.back() : router.replace({ pathname: '/case/[slug]', params: { slug } })
          }
        />
      )}
    </Screen>
  );
}
