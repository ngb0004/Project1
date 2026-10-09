import { Animated, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Polyline, Rect } from 'react-native-svg';
import { VOTE_LABEL, VOTE_ORDER, voteSplitText, type Histogram, type VoteKey, type VoteSplit } from '@sia/dive-engine';
import { useEntrance } from './motion';
import { testIds } from './testIds';
import { colors, space, type } from './theme';

/**
 * Reveal charts. These are the only places (with the reveal text around them)
 * that use the accent color and motion.
 */

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** How everyone who reached a fact voted on it, one row per answer, with the reader's own answer marked. */
export function VoteSplitBars({ votes, you }: { votes: VoteSplit; you: VoteKey | null }) {
  const progress = useEntrance({ delay: 180, nativeDriver: false });
  return (
    <View
      testID={testIds.crowdChart}
      accessible
      accessibilityLabel={`How everyone voted: ${voteSplitText(votes)}.${you ? ` You said ${VOTE_LABEL[you].toLowerCase()}.` : ''}`}
      style={styles.voteRows}
    >
      {VOTE_ORDER.map((k) => {
        const mine = k === you;
        return (
          <View key={k} style={styles.voteRow}>
            <Text style={[type.body, styles.voteLabel, mine && styles.mine]}>
              {VOTE_LABEL[k]}
              {mine ? <Text style={[type.caps, styles.youMark]}>  You</Text> : null}
            </Text>
            <View style={styles.voteTrack}>
              <Animated.View
                style={[
                  styles.voteBar,
                  { backgroundColor: mine ? colors.accent : colors.accentSoft },
                  { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', `${Math.max(1, votes[k] * 100)}%`] }) },
                ]}
              />
            </View>
            <Text style={[type.body, styles.votePct, mine && styles.mine]}>{pct(votes[k])}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** A small histogram of the crowd (ten 10-point bins) with optional markers for the reader. */
export function Distribution({
  histogram,
  before,
  after,
  height = 56,
}: {
  histogram: Histogram;
  before?: number;
  after?: number;
  height?: number;
}) {
  const max = Math.max(...histogram, 0.0001);
  return (
    <View>
      <View style={[styles.histogram, { height }]}>
        {histogram.map((share, i) => (
          <View key={i} style={styles.histogramSlot}>
            <View style={[styles.histogramBar, { height: Math.max(1, (share / max) * height) }]} />
          </View>
        ))}
      </View>
      <View style={styles.histogramAxis} />
      <View style={styles.markerRow}>
        {before !== undefined ? <View style={[styles.marker, styles.markerBefore, { left: `${before}%` }]} /> : null}
        {after !== undefined ? <View style={[styles.marker, styles.markerAfter, { left: `${after}%` }]} /> : null}
      </View>
    </View>
  );
}

const VB_W = 320;
const VB_H = 236;
const PAD_X = 12;
const PLOT_W = VB_W - PAD_X * 2;
const BAND = 48;
const TOP_BASE = 56;
const PATH_TOP = 70;
const PATH_BOTTOM = 166;
const BOTTOM_BASE = 180;

const xOf = (v: number) => PAD_X + (v / 100) * PLOT_W;

/**
 * The final reveal: the reader's path from Before to After (through every step)
 * drawn between the crowd's Before distribution (top) and After distribution (bottom).
 */
export function JourneyChart({
  path,
  beforeHistogram,
  afterHistogram,
  leftLabel,
  rightLabel,
  accessibilityLabel,
}: {
  /** The reader's main answers in order: Before, then After. */
  path: number[];
  beforeHistogram: Histogram | null;
  afterHistogram: Histogram | null;
  leftLabel: string;
  rightLabel: string;
  /** What the chart shows, in words, for screen readers. */
  accessibilityLabel: string;
}) {
  const progress = useEntrance({ delay: 120, duration: 700 });
  const binW = PLOT_W / 10;
  const maxOf = (h: Histogram) => Math.max(...h, 0.0001);
  const points = path.map((v, i) => {
    const y = path.length > 1 ? PATH_TOP + (i / (path.length - 1)) * (PATH_BOTTOM - PATH_TOP) : PATH_TOP;
    return { x: xOf(v), y };
  });
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <View testID={testIds.finalChart} accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      <Text style={[type.small, styles.bandLabel]}>Everyone, before</Text>
      <Animated.View style={[styles.svgBox, { opacity: progress }]}>
        <Svg width="100%" height="100%" viewBox={`0 0 ${VB_W} ${VB_H}`}>
          {[0, 50, 100].map((v) => (
            <Line
              key={v}
              x1={xOf(v)}
              x2={xOf(v)}
              y1={0}
              y2={VB_H}
              stroke={colors.rule}
              strokeWidth={1}
              strokeDasharray="3 4"
            />
          ))}
          {beforeHistogram?.map((share, i) => {
            const h = Math.max(1, (share / maxOf(beforeHistogram)) * BAND);
            return (
              <Rect
                key={`b${i}`}
                x={PAD_X + i * binW + 1.5}
                y={TOP_BASE - h}
                width={binW - 3}
                height={h}
                fill={colors.accentSoft}
              />
            );
          })}
          <Line x1={PAD_X} x2={VB_W - PAD_X} y1={TOP_BASE} y2={TOP_BASE} stroke={colors.rule} strokeWidth={1} />
          {afterHistogram?.map((share, i) => {
            const h = Math.max(1, (share / maxOf(afterHistogram)) * BAND);
            return (
              <Rect
                key={`a${i}`}
                x={PAD_X + i * binW + 1.5}
                y={BOTTOM_BASE}
                width={binW - 3}
                height={h}
                fill={colors.accentSoft}
              />
            );
          })}
          <Line x1={PAD_X} x2={VB_W - PAD_X} y1={BOTTOM_BASE} y2={BOTTOM_BASE} stroke={colors.rule} strokeWidth={1} />
          {points.length > 1 ? (
            <Polyline
              points={points.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={colors.accent}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}
          {points.slice(1, -1).map((p, i) => (
            <Circle key={`s${i}`} cx={p.x} cy={p.y} r={2.5} fill={colors.accent} />
          ))}
          {first ? (
            <Circle cx={first.x} cy={first.y} r={5.5} fill={colors.paper} stroke={colors.accent} strokeWidth={2} />
          ) : null}
          {last && points.length > 1 ? <Circle cx={last.x} cy={last.y} r={6.5} fill={colors.accent} /> : null}
        </Svg>
      </Animated.View>
      <Text style={[type.small, styles.bandLabel]}>Everyone, after</Text>
      <View style={styles.axis}>
        <Text style={[type.small, styles.axisLeft]}>{leftLabel}</Text>
        <Text style={[type.small, styles.axisRight]}>{rightLabel}</Text>
      </View>
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={styles.legendRing} />
          <Text style={type.small}>You, before</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={styles.legendDot} />
          <Text style={type.small}>You, after</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={styles.legendBar} />
          <Text style={type.small}>Everyone</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  voteRows: { gap: space.sm },
  voteRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  voteLabel: { width: 112 },
  voteTrack: { flex: 1, height: 14, backgroundColor: colors.faint, borderRadius: 2, overflow: 'hidden' },
  voteBar: { height: '100%', borderRadius: 2 },
  votePct: { width: 48, textAlign: 'right', fontVariant: ['tabular-nums'] },
  mine: { color: colors.accent, fontWeight: '600' },
  youMark: { color: colors.accent },
  axis: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, marginTop: space.sm },
  axisLeft: { flexShrink: 1 },
  axisRight: { flexShrink: 1, textAlign: 'right' },
  histogram: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  histogramSlot: { flex: 1, justifyContent: 'flex-end', height: '100%' },
  histogramBar: { backgroundColor: colors.accentSoft },
  histogramAxis: { height: 1, backgroundColor: colors.rule },
  markerRow: { height: 14 },
  marker: { position: 'absolute', top: 3, width: 10, height: 10, marginLeft: -5, borderRadius: 5 },
  markerBefore: { borderWidth: 2, borderColor: colors.accent, backgroundColor: colors.paperRaised },
  markerAfter: { backgroundColor: colors.accent },
  svgBox: { width: '100%', aspectRatio: VB_W / VB_H },
  bandLabel: { marginVertical: 2 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendRing: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.accent },
  legendDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  legendBar: { width: 10, height: 10, backgroundColor: colors.accentSoft },
});
