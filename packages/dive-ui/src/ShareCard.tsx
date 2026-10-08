import type { Ref } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ShareCardData } from '@sia/dive-engine';
import { Distribution } from './charts';
import { testIds } from './testIds';
import { colors, fonts, space, type } from './theme';

export const SHARE_CARD_WIDTH = 340;
export const SHARE_CARD_HEIGHT = 425;

const EMPTY_HISTOGRAM = Array.from({ length: 10 }, () => 0);

/**
 * The personal shift card. A fixed-size, self-contained view (plain Views, no
 * SVG) so the host app can capture it to a PNG on every platform.
 */
export function ShareCard({ card, ref }: { card: ShareCardData; ref?: Ref<View> }) {
  return (
    <View
      ref={ref}
      collapsable={false}
      style={styles.card}
      testID={testIds.shareCard}
      accessible
      accessibilityLabel={`${card.headline} ${card.tagline} ${card.url}`}
    >
      <Text style={styles.title} numberOfLines={2}>
        {card.title}
      </Text>
      <Text style={styles.headline}>{card.headline.replace(/\.\s+/g, '.\n')}</Text>
      <View style={styles.chart}>
        <Text style={[type.caps, styles.chartLabel]}>Where everyone ended up</Text>
        <Distribution
          histogram={card.crowdAfter ?? EMPTY_HISTOGRAM}
          before={card.before}
          after={card.after}
          height={44}
        />
        <View style={styles.axis}>
          <Text style={styles.axisText} numberOfLines={1}>
            {card.leftLabel}
          </Text>
          <Text style={[styles.axisText, styles.axisRight]} numberOfLines={1}>
            {card.rightLabel}
          </Text>
        </View>
      </View>
      <View style={styles.footer}>
        <Text style={styles.tagline}>{card.tagline}</Text>
        <Text style={styles.url} numberOfLines={1}>
          {card.url}
        </Text>
        {card.seeded ? <Text style={styles.seeded}>Crowd includes seeded estimates.</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: SHARE_CARD_WIDTH,
    height: SHARE_CARD_HEIGHT,
    backgroundColor: colors.paperRaised,
    borderWidth: 1,
    borderColor: colors.rule,
    padding: space.lg,
    justifyContent: 'space-between',
    alignSelf: 'center',
  },
  title: { fontFamily: fonts.serif, fontSize: 15, lineHeight: 20, color: colors.muted },
  headline: { fontFamily: fonts.serif, fontSize: 32, lineHeight: 39, color: colors.ink },
  chart: { gap: space.xs },
  chartLabel: { fontSize: 10, marginBottom: space.xs },
  axis: { flexDirection: 'row', justifyContent: 'space-between', gap: space.sm },
  axisText: { fontFamily: fonts.sans, fontSize: 11, color: colors.muted, flexShrink: 1 },
  axisRight: { textAlign: 'right' },
  footer: { gap: 4 },
  tagline: { fontFamily: fonts.serif, fontSize: 20, lineHeight: 26, fontStyle: 'italic', color: colors.accent },
  url: { fontFamily: fonts.sans, fontSize: 12, color: colors.ink },
  seeded: { fontFamily: fonts.sans, fontSize: 10, color: colors.muted },
});
