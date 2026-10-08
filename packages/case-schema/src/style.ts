/**
 * House style: plain words, no adjectives that judge.
 *
 * The editor agent and the validator use this list to flag user-facing copy.
 * Words inside quotation marks are exempt, because a quote is reported speech,
 * not the dive's own voice.
 */
export const JUDGING_WORDS = [
  'shocking',
  'shockingly',
  'clearly',
  'obviously',
  'brutal',
  'brutally',
  'horrific',
  'horrifying',
  'outrageous',
  'disgusting',
  'heinous',
  'appalling',
  'egregious',
  'damning',
  'devastating',
  'explosive',
  'bombshell',
  'stunning',
  'shameful',
  'disgraceful',
  'absurd',
  'ridiculous',
  'undeniably',
  'unquestionably',
  'blatant',
  'blatantly',
  'scandalous',
  'monstrous',
  'evil',
  'chilling',
  'sickening',
  'notorious',
  'infamous',
  'so-called',
] as const;

const WORD_RE = new RegExp(`\\b(${JUDGING_WORDS.map((w) => w.replace('-', '\\-')).join('|')})\\b`, 'gi');

/** Remove quoted spans (straight or curly double quotes) so reported speech is not linted. */
export function stripQuotedSpans(text: string): string {
  return text.replace(/“[^”]*”/g, ' ').replace(/"[^"]*"/g, ' ');
}

/** Returns the judging words used in `text`, lowercased and de-duplicated, ignoring quoted spans. */
export function findJudgingWords(text: string): string[] {
  const found = new Set<string>();
  for (const m of stripQuotedSpans(text).matchAll(WORD_RE)) {
    found.add(m[1]!.toLowerCase());
  }
  return [...found];
}

/** Rough sentence count used for the "2-4 sentences" body guideline. */
export function countSentences(text: string): number {
  const cleaned = text
    // Titles and month abbreviations never end a sentence in this house style.
    .replace(
      /\b(?:Mr|Mrs|Ms|Dr|Gov|Rep|Sen|St|Jr|Sr|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|No|vs|Inc|Co|Corp|Lt|Sgt|Det|Atty|Gen|Prof|Supt|Capt)\./g,
      (m) => m.replace(/\./g, ''),
    )
    // Lowercase abbreviations: e.g., i.e., a.m., p.m., etc.
    .replace(/\b(?:e\.g|i\.e|a\.m|p\.m|etc|approx|est)\./gi, (m) => m.replace(/\./g, ''))
    // Dotted initialisms (U.S., N.Y., D.C.) and initials followed by a name (J. Smith).
    .replace(/\b(?:[A-Z]\.){2,}(?=\s+[a-z0-9])/g, (m) => m.replace(/\./g, ''))
    .replace(/\b([A-Z])\.(?=\s?[A-Z]\.|\s(?!(?:The|Then|It|He|She|They|This|That|These|Those|In|On|At|A|An|But|And|After|Before|When|While|Its|His|Her|Their|We|No|Yes)\b)[A-Z][a-z])/g, '$1')
    .replace(/\d\.\d/g, '0');
  const parts = cleaned
    .split(/(?<=[.!?])["”’)]?\s+(?=["“(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return Math.max(1, parts.length);
}
