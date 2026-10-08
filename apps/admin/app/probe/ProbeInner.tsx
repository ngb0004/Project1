'use client';
import { JourneyChart } from '@sia/dive-ui';
import { View, Text } from 'react-native';
const h = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
export default function ProbeInner() {
  return (
    <View style={{ width: 300, height: 300 }}>
      <Text>probe</Text>
      <JourneyChart path={[10, 40, 80]} beforeHistogram={h} afterHistogram={h} leftLabel="L" rightLabel="R" accessibilityLabel="x" />
    </View>
  );
}
