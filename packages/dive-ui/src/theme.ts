import { Platform, type TextStyle } from 'react-native';

/**
 * Design tokens. The dive is editorial and calm: ink on warm paper, serif
 * headlines, heavy whitespace. `accent` and `accentSoft` belong to reveals only
 * (the personal mirror, crowd charts, the final reveal and the share card);
 * every other screen stays near-monochrome.
 */
export const colors = {
  paper: '#F6F2EA',
  /** Slightly lifted paper for sheets and the share card. */
  paperRaised: '#FBF8F2',
  ink: '#1D1B18',
  muted: '#6A645A',
  rule: '#DCD4C5',
  faint: '#ECE6DA',
  /** Reveal-only. */
  accent: '#B04A2E',
  /** Reveal-only: crowd bars behind the accent mark. */
  accentSoft: '#E5C2B5',
  backdrop: 'rgba(29, 27, 24, 0.45)',
} as const;

export const fonts = {
  serif: Platform.select({
    ios: 'Georgia',
    android: 'serif',
    web: 'Georgia, "Times New Roman", serif',
    default: 'serif',
  }),
  sans: Platform.select({
    web: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
    default: undefined,
  }),
};

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 40,
  xxl: 64,
} as const;

/** Reading column width on wide screens (web, tablets). */
export const MAX_WIDTH = 620;

export const type = {
  display: { fontFamily: fonts.serif, fontSize: 34, lineHeight: 41, color: colors.ink },
  headline: { fontFamily: fonts.serif, fontSize: 26, lineHeight: 33, color: colors.ink },
  title: { fontFamily: fonts.serif, fontSize: 20, lineHeight: 27, color: colors.ink },
  body: { fontFamily: fonts.sans, fontSize: 17, lineHeight: 26, color: colors.ink },
  small: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.muted },
  caps: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontWeight: '600',
    color: colors.muted,
  },
} satisfies Record<string, TextStyle>;

/** Native driver where it exists; react-native-web animates on the JS side. */
export const USE_NATIVE_DRIVER = Platform.OS !== 'web';
