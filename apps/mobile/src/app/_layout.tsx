import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '@sia/dive-ui';
import { BackendProvider } from '@/lib/backend';

export default function RootLayout() {
  return (
    <BackendProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, title: 'Dive', contentStyle: { backgroundColor: colors.paper } }} />
    </BackendProvider>
  );
}
