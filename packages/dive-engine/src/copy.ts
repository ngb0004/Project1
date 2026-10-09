import type { Confidence, PublicCase } from '@sia/case-schema';
import type { FinalReveal, VersionNote, VoteSplit } from './types';

/**
 * Generic interface copy. Every case-specific string (titles, facts, prompts,
 * labels, poll wording) comes from the case record; these helpers only frame it.
 */

/** Before -> After on the main question. */
export function mirrorText(previous: number, value: number): string {
  if (previous === value) return 'You ended where you started.';
  return `You moved from ${previous} to ${value}.`;
}

export type VoteKey = keyof VoteSplit;

/** The three fact votes, in the order the buttons show them. */
export const VOTE_ORDER: readonly VoteKey[] = ['agree', 'unsure', 'disagree'];
export const VOTE_VALUE: Record<VoteKey, number> = { agree: 100, unsure: 50, disagree: 0 };
export const VOTE_LABEL: Record<VoteKey, string> = { agree: 'Agree', unsure: 'Not sure', disagree: 'Disagree' };

export function voteKeyOf(value: number): VoteKey | null {
  return VOTE_ORDER.find((k) => VOTE_VALUE[k] === value) ?? null;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "You agreed, like 62% of readers." */
export function yourVoteText(value: number, votes: VoteSplit | null): string {
  const key = voteKeyOf(value);
  if (!key) return '';
  const verb = key === 'agree' ? 'You agreed' : key === 'disagree' ? 'You disagreed' : "You weren't sure";
  if (!votes) return `${verb}.`;
  const share = votes[key];
  if (share === 0) return `${verb}. Nobody else has so far.`;
  return `${verb}, like ${pct(share)} of readers.`;
}

/** "62% agree · 21% not sure · 17% disagree" */
export function voteSplitText(votes: VoteSplit): string {
  return VOTE_ORDER.map((k) => `${pct(votes[k])} ${VOTE_LABEL[k].toLowerCase()}`).join(' · ');
}

export const CHECK_VERDICT_LABEL = {
  holds_up: 'Holds up',
  partly: 'Partly true',
  not_backed: 'Not backed up',
  false: 'False',
  unknown: 'Not known yet',
} as const;

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
export function estimateMinutes(
  doc: Pick<PublicCase, 'starting_facts' | 'steps' | 'question'> & { takes?: PublicCase['takes'] },
): number {
  const words =
    wordCount(doc.question.prompt) +
    doc.starting_facts.reduce((a, f) => a + wordCount(f.text), 0) +
    doc.steps.reduce((a, s) => a + wordCount(s.headline) + wordCount(s.body) + wordCount(s.micro_poll.statement), 0) +
    (doc.takes ?? []).reduce((a, t) => a + wordCount(t.summary) + t.checks.reduce((b, c) => b + wordCount(c.claim), 0), 0);
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

/** "Updated Oct 12; 3,104 people saw the earlier version." ("Updated Oct 12." when no one finished it), or null for a first version. */
export function versionNoteText(note: VersionNote | null | undefined): string | null {
  if (!note || note.earlier_versions.length === 0 || !note.published_at) return null;
  const updated = `Updated ${formatDate(note.published_at, { year: false })}`;
  const earlier = note.earlier_versions.reduce((a, v) => a + v.completions, 0);
  if (earlier === 0) return `${updated}.`;
  const people = earlier === 1 ? '1 person' : `${earlier.toLocaleString('en-US')} people`;
  const which = note.earlier_versions.length === 1 ? 'the earlier version' : 'earlier versions';
  return `${updated}; ${people} saw ${which}.`;
}

/** Flag shown whenever seeded data is part of a crowd result. */
export function seededNoteText(seededShare: number): string | null {
  if (seededShare <= 0) return null;
  // Rounds to 100% even with a handful of real readers in it, so this never claims there are none.
  if (seededShare >= 0.995) return 'Early estimate: these crowd numbers are seeded until more people finish.';
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
    // With no counted completions the API sends ten zeros; null means there is no crowd to draw.
    crowdAfter: reveal.crowd.mean_after === null ? null : reveal.crowd.after_histogram,
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
