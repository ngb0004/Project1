import type { Confidence, PublicCase } from '@sia/case-schema';
import type { FinalReveal, VersionNote } from './types';

/**
 * Generic interface copy. Every case-specific string (titles, facts, prompts,
 * labels, poll wording) comes from the case record; these helpers only frame it.
 */

export function mirrorText(previous: number, value: number): string {
  if (previous === value) return "This didn't move you.";
  return `You moved from ${previous} to ${value}.`;
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  established: 'Established',
  reported: 'Reported',
  disputed: 'Disputed',
  alleged: 'Alleged',
};

export const CONFIDENCE_HINT: Record<Confidence, string> = {
  established: 'Confirmed by court records, official statements or primary documents.',
  reported: 'Reported by news outlets; not independently confirmed in primary records.',
  disputed: 'The sides disagree about this.',
  alleged: 'A claim made by one party that has not been proven.',
};

const wordCount = (s: string | undefined) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);

/** Estimated minutes to finish a dive: reading at 220 wpm plus ~12 seconds per poll. */
export function estimateMinutes(doc: Pick<PublicCase, 'starting_facts' | 'steps' | 'question'>): number {
  const words =
    wordCount(doc.question.prompt) +
    doc.starting_facts.reduce((a, f) => a + wordCount(f.text), 0) +
    doc.steps.reduce((a, s) => a + wordCount(s.headline) + wordCount(s.body), 0);
  const polls = doc.steps.length + 2;
  return Math.max(1, Math.round(words / 220 + (polls * 12) / 60));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 7, 2026" from an ISO date or timestamp, without timezone drift for plain dates. */
export function formatDate(iso: string, opts: { year?: boolean } = {}): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const month = MONTHS[Number(mo) - 1] ?? mo;
  const withYear = opts.year ?? true;
  if (!d) return withYear ? `${month} ${y}` : `${month}`;
  return withYear ? `${month} ${Number(d)}, ${y}` : `${month} ${Number(d)}`;
}

/** "Updated Oct 12; 3,104 people saw the earlier version." or null for a first version. */
export function versionNoteText(note: VersionNote | null | undefined): string | null {
  if (!note || note.earlier_versions.length === 0 || !note.published_at) return null;
  const earlier = note.earlier_versions.reduce((a, v) => a + v.completions, 0);
  const people = earlier === 1 ? '1 person' : `${earlier.toLocaleString('en-US')} people`;
  const which = note.earlier_versions.length === 1 ? 'the earlier version' : 'earlier versions';
  return `Updated ${formatDate(note.published_at, { year: false })}; ${people} saw ${which}.`;
}

/** Flag shown whenever seeded data is part of a crowd result. */
export function seededNoteText(seededShare: number): string | null {
  if (seededShare <= 0) return null;
  if (seededShare >= 0.995) return 'Early estimate: these crowd numbers are seeded, not yet from real readers.';
  return `Includes seeded estimates (${Math.round(seededShare * 100)}% of this crowd) until more people finish.`;
}

export function crowdCountText(nReal: number): string {
  if (nReal === 0) return 'No readers yet';
  return nReal === 1 ? '1 reader' : `${nReal.toLocaleString('en-US')} readers`;
}

export interface ShareCardData {
  before: number;
  after: number;
  title: string;
  question: string;
  leftLabel: string;
  rightLabel: string;
  crowdAfter: number[] | null;
  seeded: boolean;
  url: string;
  headline: string;
  tagline: string;
}

export const SHARE_TAGLINE = 'Find where you break.';

/** "I started at 95. I ended at 70." */
export function shareHeadline(before: number, after: number): string {
  return `I started at ${before}. I ended at ${after}.`;
}

export function shareText(before: number, after: number, url: string): string {
  return `${shareHeadline(before, after)} ${SHARE_TAGLINE} ${url}`;
}

export function shareCardData(doc: PublicCase, reveal: FinalReveal, url: string): ShareCardData {
  const before = reveal.you.answers.find((a) => a.step_id === 'before')?.value ?? reveal.previous_value;
  return {
    before,
    after: reveal.value,
    title: doc.title,
    question: doc.question.prompt,
    leftLabel: doc.question.scale.left_label,
    rightLabel: doc.question.scale.right_label,
    crowdAfter: reveal.crowd.after_histogram,
    seeded: reveal.crowd.seeded_share > 0,
    url,
    headline: shareHeadline(before, reveal.value),
    tagline: SHARE_TAGLINE,
  };
}

/** Deep link into a case for share cards. Accepts a web origin or a bare app scheme such as "dive://". */
export function caseUrl(baseUrl: string, slug: string): string {
  // Trim trailing slashes, but keep the "//" of a bare scheme ("dive://" must not become "dive:").
  const base = /^[a-z][a-z0-9+.-]*:\/*$/i.test(baseUrl) ? baseUrl.replace(/:\/*$/, '://') : `${baseUrl.replace(/\/+$/, '')}/`;
  return `${base}case/${encodeURIComponent(slug)}`;
}
