import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { FlagReason } from '@sia/dive-engine';
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

  const submit = async () => {
    if (!reason || status === 'sending') return;
    setStatus('sending');
    setError(null);
    try {
      await onSubmit(reason, note.trim() || undefined);
      setStatus('sent');
    } catch (e) {
      setError(errorMessage(e));
      setStatus('idle');
    }
  };

  return (
    <View style={styles.overlay}>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close"
        accessibilityRole="button"
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.avoider}>
        <View style={styles.sheet} testID={testIds.flagSheet} accessibilityViewIsModal>
          <Kicker>Flag this fact</Kicker>
          <Title>{headline}</Title>
          {status === 'sent' ? (
            <>
              <Text style={type.body} testID={testIds.flagThanks}>
                Thank you. Your flag goes to the editor who reviews this dive.
              </Text>
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
});
