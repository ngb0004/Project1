import { useMemo, useState, type ReactNode, type Ref } from 'react';
import { Platform, StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent, type TextStyle } from 'react-native';
import type { ShareCardData } from '@sia/dive-engine';
import { Distribution } from './charts';
import { testIds } from './testIds';
import { MAX_WIDTH, colors, fonts, space, type } from './theme';

export const SHARE_CARD_WIDTH = 340;
export const SHARE_CARD_HEIGHT = 425;

/** Card text ignores the system font size: the card is a picture with a fixed layout (its label carries the text). */
function CardText({
  style,
  lines,
  children,
}: {
  style: TextStyle | TextStyle[];
  lines?: number;
  children: ReactNode;
}) {
  return (
    <Text style={style} numberOfLines={lines} allowFontScaling={false}>
      {children}
    </Text>
  );
}

/**
 * The personal shift card. A self-contained view (plain Views, no SVG) so the
 * host app can capture it to a PNG on every platform. It keeps the proportions
 * of SHARE_CARD_WIDTH x SHARE_CARD_HEIGHT and scales down, every size with it,
 * when the column is narrower than that.
 */
export function ShareCard({ card, ref }: { card: ShareCardData; ref?: Ref<View> }) {
  const window = useWindowDimensions();
  // The reading column's width until the card's own slot is measured.
  const [slot, setSlot] = useState(() => Math.min(window.width, MAX_WIDTH) - space.lg * 2);
  const scale = Math.min(1, Math.max(slot, 1) / SHARE_CARD_WIDTH);
  const styles = useMemo(() => cardStyles(scale), [scale]);

  return (
    <View style={fixed.slot} onLayout={(e: LayoutChangeEvent) => setSlot(e.nativeEvent.layout.width)}>
      <View
        ref={ref}
        collapsable={false}
        style={styles.card}
        testID={testIds.shareCard}
        accessible
        accessibilityLabel={[card.headline, card.tagline, card.url].filter(Boolean).join(' ')}
      >
        <CardText style={styles.title} lines={2}>
          {card.title}
        </CardText>
        <CardText style={styles.headline}>{card.headline.replace(/\.\s+/g, '.\n')}</CardText>
        {card.crowdAfter ? (
          <View style={styles.chart}>
            <CardText style={[type.caps, styles.chartLabel]}>Where everyone ended up</CardText>
            <Distribution histogram={card.crowdAfter} before={card.before} after={card.after} height={44 * scale} />
            <View style={styles.axis}>
              <CardText style={styles.axisText} lines={1}>
                {card.leftLabel}
              </CardText>
              <CardText style={[styles.axisText, styles.axisRight]} lines={1}>
                {card.rightLabel}
              </CardText>
            </View>
          </View>
        ) : null}
        <View style={styles.footer}>
          <CardText style={styles.tagline}>{card.tagline}</CardText>
          {card.url ? <CardText style={styles.url}>{card.url}</CardText> : null}
          {card.seeded ? <CardText style={styles.seeded}>Crowd includes seeded estimates.</CardText> : null}
        </View>
      </View>
    </View>
  );
}

const fixed = StyleSheet.create({
  slot: { alignSelf: 'stretch', alignItems: 'center' },
});

function cardStyles(s: number) {
  const px = (n: number) => Math.round(n * s * 10) / 10;
  return StyleSheet.create({
    card: {
      width: px(SHARE_CARD_WIDTH),
      height: px(SHARE_CARD_HEIGHT),
      backgroundColor: colors.paperRaised,
      borderWidth: 1,
      borderColor: colors.rule,
      padding: px(space.lg),
      justifyContent: 'space-between',
    },
    title: { fontFamily: fonts.serif, fontSize: px(15), lineHeight: px(20), color: colors.muted },
    headline: { fontFamily: fonts.serif, fontSize: px(32), lineHeight: px(39), color: colors.ink },
    chart: { gap: px(space.xs) },
    chartLabel: { fontSize: px(10), lineHeight: px(14), marginBottom: px(space.xs) },
    axis: { flexDirection: 'row', justifyContent: 'space-between', gap: px(space.sm) },
    axisText: { fontFamily: fonts.sans, fontSize: px(11), lineHeight: px(15), color: colors.muted, flexShrink: 1 },
    axisRight: { textAlign: 'right' },
    footer: { gap: px(4) },
    tagline: { fontFamily: fonts.serif, fontSize: px(20), lineHeight: px(26), fontStyle: 'italic', color: colors.accent },
    // A long slug wraps rather than being cut off: the link has to be readable from the image.
    url: {
      fontFamily: fonts.sans,
      fontSize: px(12),
      lineHeight: px(16),
      color: colors.ink,
      ...(Platform.OS === 'web' ? ({ wordBreak: 'break-all' } as object) : null),
    },
    seeded: { fontFamily: fonts.sans, fontSize: px(10), lineHeight: px(13), color: colors.muted },
  });
}
