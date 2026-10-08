import type { ReactNode, Ref } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { MAX_WIDTH, colors, space, type } from './theme';

/** A scrolling reading column on warm paper. */
export function Page({
  children,
  testID,
  scrollRef,
}: {
  children: ReactNode;
  testID?: string;
  scrollRef?: Ref<ScrollView>;
}) {
  return (
    <ScrollView
      ref={scrollRef}
      style={styles.page}
      contentContainerStyle={styles.pageContent}
      keyboardShouldPersistTaps="handled"
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}

export function Kicker({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[type.caps, style]}>{children}</Text>;
}

export function Display({ children }: { children: ReactNode }) {
  return (
    <Text style={type.display} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Headline({ children }: { children: ReactNode }) {
  return (
    <Text style={type.headline} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Title({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[type.title, style]}>{children}</Text>;
}

export function Body({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  return (
    <Text style={[type.body, style]} testID={testID}>
      {children}
    </Text>
  );
}

export function Small({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  return (
    <Text style={[type.small, style]} testID={testID}>
      {children}
    </Text>
  );
}

export function Rule({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.rule, style]} />;
}

export function Gap({ size = 'md' }: { size?: keyof typeof space }) {
  return <View style={{ height: space[size] }} />;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  testID,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  testID?: string;
  accessibilityHint?: string;
}) {
  const primary = variant === 'primary';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonSecondary,
        pressed && !disabled && styles.buttonPressed,
        disabled && styles.buttonDisabled,
      ]}
    >
      <Text style={[styles.buttonLabel, primary ? styles.buttonLabelPrimary : styles.buttonLabelSecondary]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Quiet underlined text action, e.g. "Go deeper" or "Flag this fact". */
export function TextLink({
  label,
  onPress,
  testID,
  accessibilityRole = 'button',
  expanded,
  style,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  accessibilityRole?: 'button' | 'link';
  expanded?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      hitSlop={8}
      style={styles.textLink}
    >
      <Text style={[styles.textLinkLabel, style]}>{label}</Text>
    </Pressable>
  );
}

/** A radio or checkbox row with a square/round mark, used for flags, fairness and the content warning. */
export function Choice({
  label,
  selected,
  onPress,
  kind = 'radio',
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  kind?: 'radio' | 'checkbox';
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole={kind}
      accessibilityState={{ checked: selected }}
      style={styles.choice}
    >
      <View style={[styles.choiceMark, kind === 'radio' && styles.choiceMarkRound, selected && styles.choiceMarkOn]} />
      <Text style={[type.body, styles.choiceLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  pageContent: {
    width: '100%',
    maxWidth: MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.xxl,
    gap: space.lg,
  },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.rule, alignSelf: 'stretch' },
  button: {
    minHeight: 50,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.ink,
  },
  buttonPrimary: { backgroundColor: colors.ink },
  buttonSecondary: { backgroundColor: 'transparent' },
  buttonPressed: { opacity: 0.8 },
  buttonDisabled: { opacity: 0.35 },
  buttonLabel: { fontFamily: type.body.fontFamily, fontSize: 16, fontWeight: '600', letterSpacing: 0.3 },
  buttonLabelPrimary: { color: colors.paper },
  buttonLabelSecondary: { color: colors.ink },
  textLink: { alignSelf: 'flex-start', paddingVertical: space.xs },
  textLinkLabel: { ...type.small, color: colors.ink, textDecorationLine: 'underline' },
  choice: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12 },
  choiceMark: { width: 18, height: 18, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 2 },
  choiceMarkRound: { borderRadius: 9 },
  choiceMarkOn: { backgroundColor: colors.ink },
  choiceLabel: { flex: 1 },
});
