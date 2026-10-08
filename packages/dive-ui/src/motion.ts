import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';
import { USE_NATIVE_DRIVER } from './theme';

/** Motion is reserved for reveals, and skipped entirely when the reader asks for reduced motion. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setReduced(v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      sub?.remove();
    };
  }, []);
  return reduced;
}

/**
 * A 0 -> 1 progress value that runs once when a reveal mounts. With
 * `nativeDriver: false` it can drive layout props such as bar heights.
 */
export function useEntrance({ delay = 0, duration = 520, nativeDriver = USE_NATIVE_DRIVER } = {}): Animated.Value {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    const anim = Animated.timing(progress, {
      toValue: 1,
      delay,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: nativeDriver,
    });
    anim.start();
    return () => anim.stop();
  }, [progress, reduced, delay, duration, nativeDriver]);
  return progress;
}
