import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Body, Button, Headline, Page, space } from '@sia/dive-ui';
import { Screen } from '@/components/Screen';

export default function NotFound() {
  const router = useRouter();
  return (
    <Screen>
      <Page>
        <View style={{ gap: space.md }}>
          <Headline>Nothing here.</Headline>
          <Body>This link doesn't point to a dive.</Body>
          <Button label="Go to the live dive" variant="secondary" onPress={() => router.replace('/')} />
        </View>
      </Page>
    </Screen>
  );
}
