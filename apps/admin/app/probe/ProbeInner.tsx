'use client';
import { Distribution } from '@sia/dive-ui';
import { View, Text } from 'react-native';
export default function ProbeInner() {
  return (
    <View style={{ width: 300, height: 300 }}>
      <Text>probe</Text>
      <Distribution beforeHistogram={[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]} afterHistogram={[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]} />
    </View>
  );
}
