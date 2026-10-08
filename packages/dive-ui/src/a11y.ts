import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, type View } from 'react-native';

/**
 * Screen-reader support that react-native-web lacks: its
 * AccessibilityInfo.announceForAccessibility and setAccessibilityFocus do
 * nothing, and an aria-live region inserted together with its text is not read.
 * On the web these use one live region that exists before anything is said, and
 * DOM focus; on iOS and Android, the platform calls.
 */

let liveRegion: HTMLElement | null = null;

function webLiveRegion(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (!liveRegion || !liveRegion.isConnected) {
    liveRegion = document.createElement('div');
    liveRegion.setAttribute('role', 'status');
    liveRegion.setAttribute('aria-live', 'polite');
    Object.assign(liveRegion.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clip: 'rect(0 0 0 0)',
      whiteSpace: 'nowrap',
    });
    document.body.appendChild(liveRegion);
  }
  return liveRegion;
}

/** Creates the web live region ahead of time, so the first announcement is read. */
export function prepareAnnouncer() {
  if (Platform.OS === 'web') webLiveRegion();
}

/** Has the screen reader say `message` without moving focus. */
export function announce(message: string) {
  if (Platform.OS !== 'web') {
    AccessibilityInfo.announceForAccessibility(message);
    return;
  }
  const region = webLiveRegion();
  if (!region) return;
  // Clear first so the same message twice in a row is read twice.
  region.textContent = '';
  setTimeout(() => {
    if (region.isConnected) region.textContent = message;
  }, 50);
}

const NO_OP = () => undefined;

/**
 * Moves screen-reader (and on the web, keyboard) focus to a view. Returns a
 * cancel function for effects to return.
 */
export function focusView(view: View | null): () => void {
  if (!view) return NO_OP;
  if (Platform.OS === 'web') {
    (view as unknown as HTMLElement).focus?.({ preventScroll: true });
    return NO_OP;
  }
  // VoiceOver and TalkBack only find a view once it is laid out.
  const timer = setTimeout(() => AccessibilityInfo.sendAccessibilityEvent(view, 'focus'), 100);
  return () => clearTimeout(timer);
}

/**
 * A ref for a view that takes focus when it mounts, if `enabled` then. Pair it
 * with `tabIndex={-1}` so the web can focus a non-interactive view.
 */
export function useFocusOnMount(enabled: boolean) {
  const ref = useRef<View>(null);
  const shouldFocus = useRef(enabled);
  useEffect(() => (shouldFocus.current ? focusView(ref.current) : undefined), []);
  return ref;
}
