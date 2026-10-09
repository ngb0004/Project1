import { DiveApiError, VOTE_LABEL, VOTE_ORDER, voteKeyOf, type FinalCrowd, type VoteKey } from '@sia/dive-engine';

/**
 * Interface copy specific to these screens. Like @sia/dive-engine's copy
 * helpers, it only frames strings that come from the case record.
 */

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Crowd sentences call the crowd "readers" only when every row in it is a real
 * reader. While seeded estimates are part of it, they say "the crowd".
 */

/** "On average, everyone went from 62 to 55." The average includes the reader's own answers. */
export function finalCrowdSummary(crowd: FinalCrowd): string | null {
  if (crowd.mean_before === null || crowd.mean_after === null) return null;
  const who = crowd.seeded_share > 0 ? 'the crowd' : 'everyone';
  const from = Math.round(crowd.mean_before);
  const to = Math.round(crowd.mean_after);
  if (from === to) return `On average, ${who} stayed at ${from}.`;
  return `On average, ${who} went from ${from} to ${to}.`;
}

/** The text alternative for the final chart: the reader's Before and After, then the crowd's. */
export function journeyLabel(before: number, after: number, crowd: FinalCrowd): string {
  const yours = `Your answer went from ${before} to ${after}.`;
  const summary = finalCrowdSummary(crowd);
  return summary ? `${yours} ${summary}` : yours;
}

/** The fact where the reader's vote had the least company in the crowd. */
export interface StandApart {
  stepId: string;
  yours: VoteKey;
  /** Share of the crowd that voted the same way as the reader. */
  share: number;
  /** The crowd's most common vote on that fact. */
  top: VoteKey;
  topShare: number;
}

/** Ties go to the earlier fact. Null when the crowd has no votes yet. */
export function standApart(answers: { step_id: string; value: number }[], crowd: FinalCrowd): StandApart | null {
  let best: StandApart | null = null;
  for (const stat of crowd.steps) {
    if (!stat.votes) continue;
    const answer = answers.find((a) => a.step_id === stat.step_id);
    const yours = answer ? voteKeyOf(answer.value) : null;
    if (!yours) continue;
    const share = stat.votes[yours];
    if (best && share >= best.share) continue;
    const top = VOTE_ORDER.reduce((a, b) => (stat.votes![b] > stat.votes![a] ? b : a));
    best = { stepId: stat.step_id, yours, share, top, topShare: stat.votes[top] };
  }
  return best;
}

/** "You said agree. 71% of readers said disagree." */
export function standApartText(s: StandApart, seeded: boolean): string {
  const who = seeded ? 'the crowd' : 'readers';
  const yours = `You said ${VOTE_LABEL[s.yours].toLowerCase()}.`;
  if (s.top === s.yours) return `${yours} So did ${pct(s.share)} of ${who}.`;
  return `${yours} ${pct(s.topShare)} of ${who} said ${VOTE_LABEL[s.top].toLowerCase()}.`;
}

export function completionsText(n: number): string {
  if (n === 0) return 'no one has finished it yet';
  return n === 1 ? '1 person finished it' : `${n.toLocaleString('en-US')} people finished it`;
}

/** What the reader was doing when a call failed, so the message can say what to do next. */
export type ErrorContext = 'load' | 'start' | 'answer' | 'reveal' | 'flag' | 'rating' | 'share';

const RATE_LIMITED: Record<ErrorContext, string> = {
  load: 'Too many requests from this network. Wait a minute and try again.',
  start: 'Too many people have started dives from this network in the last hour. Try again later.',
  answer: 'Too many answers from this network. Wait a minute and try again.',
  reveal: 'Too many requests from this network. Wait a minute and try again.',
  flag: 'Too many flags from this network in the last hour. Try again later.',
  rating: 'Too many ratings from this network in the last hour. Try again later.',
  share: 'Too many requests from this network. Try again later.',
};

/** Errors that only reloading the dive (and resyncing its answers) can clear. */
export function needsReload(err: unknown): boolean {
  return err instanceof DiveApiError && (err.code === 'gone' || err.code === 'not_found' || err.code === 'out_of_order');
}

/** Errors worth retrying on their own after a pause. */
export function isTransient(err: unknown): boolean {
  return !(err instanceof DiveApiError) || err.code === 'network' || err.code === 'rate_limited';
}

/** A message the reader can act on, for any error thrown by the dive API. */
export function errorMessage(err: unknown, context: ErrorContext = 'load'): string {
  if (err instanceof DiveApiError) {
    switch (err.code) {
      case 'rate_limited':
        return RATE_LIMITED[context];
      case 'gone':
        return 'This version of the dive is no longer available.';
      case 'out_of_order':
        return 'Your answers are out of sync with the server.';
      case 'not_found':
        return 'This dive is not available any more.';
      case 'network':
        return "Couldn't reach the server. Check your connection and try again.";
      case 'forbidden':
      case 'invalid':
        return 'The server did not accept that. Try again, or reload the dive.';
    }
  }
  if (err instanceof Error && /network|fetch/i.test(err.message)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  return 'Something went wrong. Try again.';
}

/**
 * How every published dive is made, true for each way a case can arrive (the
 * agent pipeline, an admin edit, or a hand-checked import): no version goes
 * live without an editor's approval, and every fact cites a source.
 */
export const PROCESS_LINE =
  'Every fact in this dive cites at least one of the sources listed below. An editor reviewed and approved ' +
  'each version before it went live, and every published version is listed under Version history.';
