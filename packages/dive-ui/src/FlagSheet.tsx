import { useEffect, useRef, useState, type RefObject } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { FlagReason } from '@sia/dive-engine';
import { announce, useFocusOnMount } from './a11y';
import { errorMessage } from './copy';
import { flagReasonId, testIds } from './testIds';
import { MAX_WIDTH, colors, fonts, space, type } from './theme';
import { Button, Choice, Kicker, TextLink, Title } from './ui';

const REASONS: { value: FlagReason; label: string }[] = [
  { value: 'unfair', label: 'Unfair' },
  { value: 'cherry_picked', label: 'Cherry-picked' },
  { value: 'inaccurate', label: 'Inaccurate' },
  { value: 'other', label: 'Something else' },
];

const FOCUSABLE = 'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])';

/**
 * On the web, a modal sheet keeps keyboard focus inside itself, closes on
 * Escape, and hands focus back to whatever opened it. (iOS uses
 * accessibilityViewIsModal; Android's back button closes the sheet.)
 */
function useWebDialog(sheet: RefObject<View | null>, onClose: () => void) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const node = sheet.current as unknown as HTMLElement | null;
    if (!node) return;
    const opener = document.activeElement as HTMLElement | null;
    node.focus({ preventScroll: true });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === node || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !node.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [sheet]);
}

/** Replaces the form, and the focused Send button with it, so it takes focus. */
function FlagThanks() {
  const ref = useFocusOnMount(true);
  return (
    <View ref={ref} tabIndex={-1} accessible style={styles.focusTarget}>
      <Text style={type.body} testID={testIds.flagThanks}>
        Thank you. Your flag goes to the editor who reviews this dive.
      </Text>
    </View>
  );
}

/**
 * "Flag this fact": an in-place sheet (not a native Modal, so it stays inside
 * the admin console's phone-sized preview frame). Flags go to the admin console.
 */
export function FlagSheet({
  headline,
  onSubmit,
  onClose,
}: {
  headline: string;
  onSubmit: (reason: FlagReason, note?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<FlagReason | null>(null);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const sheet = useRef<View>(null);
  useWebDialog(sheet, onClose);

  const submit = async () => {
    if (!reason || status === 'sending') return;
    setStatus('sending');
    setError(null);
    try {
      await onSubmit(reason, note.trim() || undefined);
      setStatus('sent');
    } catch (e) {
      const message = errorMessage(e, 'flag');
      setError(message);
      announce(message);
      setStatus('idle');
    }
  };

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close"
        accessibilityRole="button"
        // The sheet's own Cancel and Close are the keyboard route out.
        focusable={false}
        tabIndex={-1}
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.avoider}>
        <View
          ref={sheet}
          style={styles.sheet}
          testID={testIds.flagSheet}
          role="dialog"
          aria-modal
          aria-label="Flag this fact"
          tabIndex={-1}
        >
          <Kicker>Flag this fact</Kicker>
          <Title>{headline}</Title>
          {status === 'sent' ? (
            <>
              <FlagThanks />
              <Button label="Close" onPress={onClose} variant="secondary" testID={testIds.flagCancel} />
            </>
          ) : (
            <>
              <View accessibilityRole="radiogroup">
                {REASONS.map((r) => (
                  <Choice
                    key={r.value}
                    label={r.label}
                    selected={reason === r.value}
                    onPress={() => setReason(r.value)}
                    testID={flagReasonId(r.value)}
                  />
                ))}
              </View>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Add a note (optional)"
                placeholderTextColor={colors.muted}
                multiline
                maxLength={1000}
                style={styles.note}
                testID={testIds.flagNote}
                accessibilityLabel="Note (optional)"
              />
              {error ? (
                <Text style={[type.small, styles.error]} testID={testIds.error}>
                  {error}
                </Text>
              ) : null}
              <Button
                label={status === 'sending' ? 'Sending…' : 'Send flag'}
                onPress={submit}
                disabled={!reason || status === 'sending'}
                testID={testIds.flagSubmit}
              />
              <TextLink label="Cancel" onPress={onClose} testID={testIds.flagCancel} />
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.backdrop,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  avoider: { width: '100%', alignItems: 'center' },
  sheet: {
    width: '100%',
    maxWidth: MAX_WIDTH,
    backgroundColor: colors.paperRaised,
    padding: space.lg,
    paddingBottom: space.xl,
    gap: space.md,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    outlineWidth: 0,
  },
  note: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: colors.rule,
    borderRadius: 2,
    padding: space.sm,
    fontFamily: fonts.sans,
    fontSize: 16,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  error: { color: colors.ink },
  focusTarget: { outlineWidth: 0 },
});
