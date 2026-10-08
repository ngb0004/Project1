/**
 * Build-time configuration. Expo inlines EXPO_PUBLIC_* variables, so each one
 * must be read with a literal `process.env.EXPO_PUBLIC_...` expression.
 */
export const config = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL || null,
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || null,
  /**
   * A JSON array of { doc, seedProfile? } played in memory when no Supabase project
   * is configured. Each doc must be a public projection (see .env.example).
   */
  demoCasesUrl: process.env.EXPO_PUBLIC_DEMO_CASES_URL || null,
  /**
   * Public web origin for share-card deep links, e.g. https://dive.example.
   * Required for native release builds; see .env.example.
   */
  shareBaseUrl: process.env.EXPO_PUBLIC_SHARE_BASE_URL || null,
};
