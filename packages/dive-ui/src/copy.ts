import type { FinalCrowd, StepCrowd } from '@sia/dive-engine';
import { DiveApiError } from '@sia/dive-engine';

/**
 * Interface copy specific to these screens. Like @sia/dive-engine's copy
 * helpers, it only frames strings that come from the case record.
 */

const pct = (x: number) => `${Math.round(x * 100)}%`;
const points = (n: number) => (n === 1 ? '1 point' : `${n} points`);

/** "41% of readers moved here. On average, they moved 6 points toward “<right label>”." */
export function stepCrowdSummary(crowd: StepCrowd, leftLabel: string, rightLabel: string): string | null {
  if (crowd.moved_share === null) return null;
  const moved = `${pct(crowd.moved_share)} of readers moved here.`;
  const d = Math.round(crowd.mean_delta ?? 0);
  if (d === 0) return `${moved} On average, the crowd held steady.`;
  return `${moved} On average, they moved ${points(Math.abs(d))} toward “${d < 0 ? leftLabel : rightLabel}”.`;
}

/** "Everyone else went from 62 to 55 on average." */
export function finalCrowdSummary(crowd: FinalCrowd): string | null {
  if (crowd.mean_before === null || crowd.mean_after === null) return null;
  const from = Math.round(crowd.mean_before);
  const to = Math.round(crowd.mean_after);
  if (from === to) return `On average, everyone else stayed at ${from}.`;
  return `On average, everyone else went from ${from} to ${to}.`;
}

export function crowdStepDeltaText(meanAbsDelta: number | null): string | null {
  if (meanAbsDelta === null) return null;
  return `Readers moved ${points(Math.round(meanAbsDelta))} on average here.`;
}

export function completionsText(n: number): string {
  if (n === 0) return 'no one has finished it yet';
  return n === 1 ? '1 person finished it' : `${n.toLocaleString('en-US')} people finished it`;
}

export function yourStepDeltaText(previous: number, value: number): string {
  return `You moved from ${previous} to ${value} here.`;
}

/** A message the reader can act on, for any error thrown by the dive API. */
export function errorMessage(err: unknown): string {
  if (err instanceof DiveApiError) {
    switch (err.code) {
      case 'rate_limited':
        return 'Too many answers from this network. Wait a minute and try again.';
      case 'gone':
        return 'This version of the dive has been replaced. Reload to see the latest version.';
      case 'out_of_order':
        return 'Your answers are out of sync with the server. Reload the dive to continue.';
      case 'not_found':
        return 'This dive is not available any more.';
      case 'network':
        return "Couldn't reach the server. Check your connection and try again.";
      default:
        return err.message;
    }
  }
  if (err instanceof Error && /network|fetch/i.test(err.message)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  return 'Something went wrong. Try again.';
}

export const PROCESS_LINE =
  'An agent pipeline researched this dive and logged every source it opened, separate fact-check and ' +
  'red-team agents tried to break the draft, and a human editor approved every version before it went live.';
