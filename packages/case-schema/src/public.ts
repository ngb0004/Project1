import { z } from 'zod';
import { Case, Fact, Question, Side, Source, Step, Take, TakeCheck, TimelineEvent } from './schema';

/**
 * The client-facing projection of a case. Admin-only fields (`favors`, `impact`,
 * `evidence` on steps, facts, timeline events and take checks, `review`, `status`) never reach the dive app.
 *
 * The database computes the same projection in SQL (`public.case_public_projection`)
 * and the tests check that the two agree.
 */

/** Keys removed from every step and starting fact. */
export const ADMIN_ONLY_STEP_KEYS = ['favors', 'impact', 'evidence'] as const;
/** Keys removed from the top level of the case. */
export const ADMIN_ONLY_CASE_KEYS = ['review', 'status'] as const;

export const PublicStep = Step.omit({ favors: true, impact: true, evidence: true }).strict();
export type PublicStep = z.infer<typeof PublicStep>;

export const PublicFact = Fact.omit({ evidence: true }).strict();
export type PublicFact = z.infer<typeof PublicFact>;

export const PublicTimelineEvent = TimelineEvent.omit({ evidence: true }).strict();
export type PublicTimelineEvent = z.infer<typeof PublicTimelineEvent>;

export const PublicTakeCheck = TakeCheck.omit({ evidence: true }).strict();
export const PublicTake = Take.extend({ checks: z.array(PublicTakeCheck).min(1).max(6) }).strict();
export type PublicTake = z.infer<typeof PublicTake>;

export const PublicCase = Case.omit({ review: true, status: true })
  .extend({
    starting_facts: z.array(PublicFact).min(1),
    steps: z.array(PublicStep).min(1),
    sides: z.array(Side).min(2),
    timeline: z.array(PublicTimelineEvent),
    takes: z.array(PublicTake),
    sources: z.array(Source).min(1),
    question: Question,
  })
  .strict();
export type PublicCase = z.infer<typeof PublicCase>;

const omit = <T extends object, K extends string>(obj: T, keys: readonly K[]) => {
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const k of keys) delete out[k];
  return out;
};

/** Strips every admin-only field. The result always parses as `PublicCase`. */
export function toPublicCase(c: Case): PublicCase {
  const base = omit(c, ADMIN_ONLY_CASE_KEYS);
  return PublicCase.parse({
    ...base,
    starting_facts: c.starting_facts.map((f) => omit(f, ['evidence'])),
    steps: c.steps.map((s) => omit(s, ADMIN_ONLY_STEP_KEYS)),
    timeline: c.timeline.map((e) => omit(e, ['evidence'])),
    takes: c.takes.map((t) => ({ ...t, checks: t.checks.map((ch) => omit(ch, ['evidence'])) })),
  });
}
