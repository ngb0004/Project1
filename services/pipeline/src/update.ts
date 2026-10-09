import { diffCases, summarizeDiff, type Case, type CaseDiff, type CaseInput } from '@sia/case-schema';
import type { ResearchClaim } from './agents/researcher';
import type { DraftCase } from './agents/shared';
import { MIN_QUOTE_CHARS, normalizeForMatch, urlKey } from './research/text';

/**
 * Live updates: the deterministic parts of re-researching a published case.
 *
 * - `screenDevelopments` decides which researcher claims are new developments:
 *   dated after the base as-of date (by event or publication date), not low
 *   impact, and not a quote the base version already carries. Only these reach
 *   the drafter; when none is left the job ends as `no_changes`, and
 *   `describeScreening` says why in the research log and the job result.
 * - `updateSummaryText` is the plain update summary recorded in the review
 *   record: what changed against the live version (summarizeDiff) and why (each
 *   development, its source and date, and where it went in the draft).
 */

type AnyCase = Case | CaseInput | DraftCase;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Whether a (possibly partial) date can fall after `asOf`: `2026-10` is after `2026-09-30` and may be after `2026-10-01`. */
export function isAfter(date: string | null | undefined, asOf: string): boolean {
  if (!date) return false;
  return date > asOf.slice(0, date.length) || (date.length < asOf.length && date === asOf.slice(0, date.length));
}

/** What the base version already states, for the researchers (`known_facts`). */
export function knownFactsOf(c: AnyCase): string[] {
  return [...(c.starting_facts ?? []).map((f) => f.text), ...(c.steps ?? []).map((s) => s.headline)];
}

/** Every verbatim quote the base version carries (evidence and quote layers), normalized. */
export function knownQuotesOf(c: AnyCase): string[] {
  const out: string[] = [];
  const add = (q: string | undefined) => {
    const n = q ? normalizeForMatch(q) : '';
    if (n.length >= MIN_QUOTE_CHARS) out.push(n);
  };
  for (const f of c.starting_facts ?? []) f.evidence?.forEach((e) => add(e.quote));
  for (const s of c.steps ?? []) {
    s.evidence?.forEach((e) => add(e.quote));
    for (const l of s.depth ?? []) if (l.kind === 'quote') add(l.text);
  }
  return out;
}

export type DropReason = 'not_after' | 'undated' | 'low_impact' | 'already_known';

export interface ScreenedDevelopments {
  since: string;
  material: ResearchClaim[];
  dropped: { claim: ResearchClaim; reason: DropReason }[];
}

/** The date a development is reported under: when it happened, else when it was published. */
export const developmentDate = (c: Pick<ResearchClaim, 'event_date' | 'source_date'>, since: string): string | null =>
  isAfter(c.event_date, since) ? c.event_date : isAfter(c.source_date, since) ? c.source_date : (c.event_date ?? c.source_date);

/**
 * Splits verified researcher claims into new developments and the rest. A
 * development is dated after `since` (its event or its source), is medium or
 * high impact, and does not repeat a quote the base version already carries.
 */
export function screenDevelopments(claims: ResearchClaim[], since: string, base: AnyCase): ScreenedDevelopments {
  const known = knownQuotesOf(base);
  const material: ResearchClaim[] = [];
  const dropped: ScreenedDevelopments['dropped'] = [];
  for (const c of claims) {
    const q = normalizeForMatch(c.quote);
    if (!c.event_date && !c.source_date) dropped.push({ claim: c, reason: 'undated' });
    else if (!isAfter(c.event_date, since) && !isAfter(c.source_date, since)) dropped.push({ claim: c, reason: 'not_after' });
    else if (c.impact === 'low') dropped.push({ claim: c, reason: 'low_impact' });
    else if (q.length >= MIN_QUOTE_CHARS && known.some((k) => k.includes(q) || q.includes(k))) dropped.push({ claim: c, reason: 'already_known' });
    else material.push(c);
  }
  return { since, material, dropped };
}

const REASON_TEXT: Record<DropReason, string> = {
  not_after: 'dated on or before',
  undated: 'with no date',
  low_impact: 'low impact',
  already_known: 'already in version',
};

/** "3 dated on or before 2026-10-01, 1 low impact, 1 already in version 2" (empty when nothing was dropped). */
export function droppedPhrase(s: ScreenedDevelopments, baseVersion: number): string {
  const counts = new Map<DropReason, number>();
  for (const d of s.dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return [...counts]
    .map(([r, n]) => {
      const what = REASON_TEXT[r];
      return r === 'not_after' ? `${n} ${what} ${s.since}` : r === 'already_known' ? `${n} ${what} ${baseVersion}` : `${n} ${what}`;
    })
    .join(', ');
}

/** "5 verified claim(s) found: 1 new development(s), 3 dated on or before 2026-10-01, 1 low impact." */
export function describeScreening(s: ScreenedDevelopments, baseVersion: number): string {
  const total = s.material.length + s.dropped.length;
  if (total === 0) return 'the researchers found no verifiable claims';
  const parts = [...(s.material.length ? [`${s.material.length} new development(s)`] : []), droppedPhrase(s, baseVersion)].filter(Boolean);
  return `${total} verified claim(s) found: ${parts.join(', ')}`;
}

/** Step ids (and `fact:<id>`) in a case that cite a source at `url`. */
export function itemsCiting(c: AnyCase, url: string): string[] {
  const key = urlKey(url);
  const ids = new Set((c.sources ?? []).filter((s) => urlKey(s.url) === key).map((s) => s.id));
  if (!ids.size) return [];
  return [
    ...(c.starting_facts ?? []).filter((f) => (f.source_ids ?? []).some((x) => ids.has(x))).map((f) => `fact:${f.id}`),
    ...(c.steps ?? []).filter((s) => (s.source_ids ?? []).some((x) => ids.has(x))).map((s) => s.id),
  ];
}

/** Whether `after` changes anything against `before` beyond the as-of date. */
export function changesBeyondAsOf(d: CaseDiff): boolean {
  const s = d.summary;
  return d.fields.some((f) => f.path !== 'as_of') || s.added + s.removed + s.changed + s.moved > 0;
}

export interface UpdateSummaryInput {
  live: Case;
  /** The version the draft started from: the live version, or the update package in review on top of it. */
  base: Case;
  since: string;
  final: DraftCase;
  developments: ResearchClaim[];
  screening: ScreenedDevelopments;
  /** The drafter's resolutions by ref (claim ids, retired step ids, "open_question"). */
  resolutions: Map<string, string>;
}

const MAX_LISTED = 10;
const SUMMARY_MAX = 4000;

/** Ends a sentence with a full stop unless it already ends with one. */
const stop = (s: string) => (/[.!?…]["')]?$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * The plain update summary for the review record: what changed against the
 * live version and why. At most 4,000 characters (an agent report's limit):
 * the header, the diff summary, retired steps, open questions and the screen
 * are kept whole (each clipped), and the list of developments gets the rest.
 */
export function updateSummaryText(u: UpdateSummaryInput): string {
  const { live, base, since, final } = u;
  const finalCase = final as unknown as Case;
  const head = [
    `Update of live version ${live.version} (as of ${live.as_of}): re-researched for developments after ${since}.` +
      (base.version !== live.version
        ? ` Builds on version ${base.version}, the earlier update still waiting for review, and replaces it in the queue.`
        : ''),
    clip(`What changed against the live version: ${summarizeDiff(diffCases(live, finalCase), finalCase)}`, 1000),
  ];

  const tail: string[] = [];
  const retired = base.steps.filter((s) => !final.steps.some((f) => f.id === s.id));
  if (retired.length) {
    const items = retired
      .slice(0, MAX_LISTED)
      .map((s) => `${s.id} ("${clip(s.headline, 100)}")${u.resolutions.get(s.id) ? `: ${clip(u.resolutions.get(s.id)!, 200).replace(/[.\s]+$/, '')}` : ''}`);
    tail.push(clip(stop(`Steps retired: ${items.join('; ')}${retired.length > MAX_LISTED ? `; and ${retired.length - MAX_LISTED} more` : ''}`), 800));
  }
  const answered = base.open_questions.filter((q) => !final.open_questions.includes(q));
  const raised = final.open_questions.filter((q) => !base.open_questions.includes(q));
  if (answered.length) tail.push(clip(`Open questions no longer listed: ${answered.map((q) => `"${clip(q, 160)}"`).join('; ')}.`, 500));
  if (raised.length) tail.push(clip(`New open questions: ${raised.map((q) => `"${clip(q, 160)}"`).join('; ')}.`, 500));
  if (u.screening.dropped.length) tail.push(`Claims the researchers found that are not new developments: ${droppedPhrase(u.screening, base.version)}.`);

  // The developments fill what is left, one whole line at a time.
  const fixed = [...head, ...tail].join('\n').length;
  let room = SUMMARY_MAX - fixed - 40;
  const why = [`Why: ${u.developments.length} new development(s) since ${since}, each from a source opened in this run:`];
  room -= why[0]!.length + 1;
  let listed = 0;
  for (const [i, c] of u.developments.slice(0, MAX_LISTED).entries()) {
    const where = itemsCiting(final, c.url);
    const res = u.resolutions.get(c.id);
    const line =
      `${i + 1}. [${developmentDate(c, since) ?? 'undated'}, ${clip(c.publisher, 60)}, ${c.source_type}] ${stop(clip(c.text, 280))} ` +
      (where.length ? `In the draft: ${where.join(', ')}.` : 'Not in the draft.') +
      (res ? ` Drafter: ${stop(clip(res, 240))}` : '');
    if (line.length + 1 > room) break;
    why.push(line);
    room -= line.length + 1;
    listed++;
  }
  if (u.developments.length > listed) why.push(`… and ${u.developments.length - listed} more.`);
  return clip([...head, ...why, ...tail].join('\n'), SUMMARY_MAX);
}
