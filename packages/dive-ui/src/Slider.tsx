import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { testIds } from './testIds';
import { colors, fonts, space, type } from './theme';

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  leftLabel: string;
  rightLabel: string;
  accessibilityLabel: string;
  disabled?: boolean;
  /** Step for screen-reader increment/decrement and Page Up/Down. Arrow keys move by 1. */
  step?: number;
  testID?: string;
}

const MIN = 0;
const MAX = 100;
const THUMB = 26;
const clamp = (v: number) => Math.max(MIN, Math.min(MAX, Math.round(v)));

/**
 * A 0-100 position slider. Drag (touch, mouse or pen via PanResponder), tap the
 * track, use the arrow keys on the web, or swipe up/down with a screen reader
 * (accessibilityRole="adjustable" with increment/decrement actions).
 */
export function Slider({
  value,
  onChange,
  leftLabel,
  rightLabel,
  accessibilityLabel,
  disabled = false,
  step = 5,
  testID = testIds.slider,
}: SliderProps) {
  const [width, setWidth] = useState(0);
  // The pan responder is created once; it reads the latest props through this ref.
  const latest = useRef({ onChange, disabled, width, value });
  useEffect(() => {
    latest.current = { onChange, disabled, width, value };
  });
  const startX = useRef(0);

  const responder = useMemo(() => {
    const emit = (x: number) => {
      const { width: w, onChange: change, value: current } = latest.current;
      if (w <= 0) return;
      const next = clamp(((x - THUMB / 2) / (w - THUMB)) * MAX);
      if (next !== current) {
        latest.current.value = next;
        change(next);
      }
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !latest.current.disabled,
      onMoveShouldSetPanResponder: () => !latest.current.disabled,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (e) => {
        startX.current = e.nativeEvent.locationX;
        emit(startX.current);
      },
      onPanResponderMove: (_e, g) => emit(startX.current + g.dx),
    });
  }, []);

  const nudge = (delta: number) => {
    if (disabled) return;
    const next = clamp(value + delta);
    if (next !== value) onChange(next);
  };

  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'increment') nudge(step);
    if (e.nativeEvent.actionName === 'decrement') nudge(-step);
  };

  // Keyboard support on the web (react-native-web forwards onKeyDown to the DOM node).
  const webKeyboard =
    Platform.OS === 'web'
      ? {
          focusable: !disabled,
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            const moves: Record<string, number> = {
              ArrowRight: 1,
              ArrowUp: 1,
              ArrowLeft: -1,
              ArrowDown: -1,
              PageUp: step * 2,
              PageDown: -step * 2,
              Home: -MAX,
              End: MAX,
            };
            const delta = moves[e.key];
            if (delta === undefined) return;
            e.preventDefault();
            nudge(delta);
          },
        }
      : {};

  const nearer = value < 50 ? leftLabel : value > 50 ? rightLabel : null;
  const valueText = nearer ? `${value} of 100, toward ${nearer}` : `${value} of 100, the middle`;
  const thumbLeft = width > 0 ? (value / MAX) * (width - THUMB) : 0;

  return (
    <View style={styles.wrap}>
      <Text style={[styles.value, disabled && styles.valueLocked]} testID={testIds.sliderValue}>
        {value}
      </Text>
      <View
        testID={testID}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled }}
        accessibilityValue={{ min: MIN, max: MAX, now: value, text: valueText }}
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={value}
        aria-valuetext={valueText}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={onAccessibilityAction}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        style={styles.touchArea}
        {...webKeyboard}
        {...responder.panHandlers}
      >
        <View style={[styles.track, styles.passThrough]} />
        <View style={[styles.tick, styles.passThrough, { left: THUMB / 2 }]} />
        <View style={[styles.tick, styles.passThrough, styles.tickMiddle]} />
        <View style={[styles.tick, styles.passThrough, { right: THUMB / 2 }]} />
        <View style={[styles.thumb, styles.passThrough, disabled && styles.thumbLocked, { left: thumbLeft }]} />
      </View>
      <View style={styles.labels}>
        <Text style={[type.small, styles.label]}>{leftLabel}</Text>
        <Text style={[type.small, styles.label, styles.labelRight]}>{rightLabel}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch' },
  value: {
    fontFamily: fonts.serif,
    fontSize: 44,
    lineHeight: 52,
    color: colors.ink,
    textAlign: 'center',
    marginBottom: space.sm,
    fontVariant: ['tabular-nums'],
  },
  valueLocked: { color: colors.muted },
  touchArea: {
    height: 48,
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? ({ cursor: 'pointer', userSelect: 'none', touchAction: 'none' } as object) : null),
  },
  track: {
    position: 'absolute',
    left: THUMB / 2,
    right: THUMB / 2,
    height: 2,
    backgroundColor: colors.rule,
  },
  // Touches land on the touch area itself, so locationX is always relative to the track.
  passThrough: { pointerEvents: 'none' },
  tick: { position: 'absolute', width: 1, height: 12, backgroundColor: colors.rule },
  tickMiddle: { left: '50%' },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: colors.ink,
  },
  thumbLocked: { backgroundColor: colors.paper, borderWidth: 2, borderColor: colors.muted },
  labels: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, marginTop: space.xs },
  label: { flexShrink: 1, maxWidth: '48%' },
  labelRight: { textAlign: 'right' },
});
