import { z } from 'zod';
import { HardQuestion, Text, type CaseInput } from '@sia/case-schema';
import { Gap, block, draftOnly, idPrefix, systemPrompt, type DraftCase, type HardQuestionLike } from './shared';
import type { AgentSpec } from './types';

/** Agent 4. Asks what a sharp skeptic on each side would ask, and finds what the draft avoids or leaves out. */

export interface HardQuestionsInput {
  draft: CaseInput | DraftCase;
  /** The scoper's must-answer list. */
  must_answer: string[];
  /** Questions from earlier rounds, with how the drafter resolved them. */
  previous?: HardQuestionLike[];
}

/**
 * A hard question exactly as the review record stores it, minus `round`
 * (the orchestrator adds that), so `{ ...q, round }` is a valid `HardQuestion`.
 */
export const HardQuestionItem = HardQuestion.omit({ round: true });
export type HardQuestionItem = z.output<typeof HardQuestionItem>;

export const HardQuestionsOutput = z
  .object({
    questions: z.array(HardQuestionItem).max(40),
    gaps: z.array(Gap).max(30),
    /** The single fact that would move readers most if true, and whether the draft establishes it. */
    most_moving_fact: Text(1200),
  })
  .strict();
export type HardQuestionsOutput = z.output<typeof HardQuestionsOutput>;

/** Questions and gaps that still block the package: blocking and not answered. */
export function blockingItems(out: HardQuestionsOutput): { questions: HardQuestionItem[]; gaps: Gap[] } {
  return {
    questions: out.questions.filter((q) => q.blocking && q.status === 'open'),
    gaps: out.gaps.filter((g) => g.blocking),
  };
}

const METHOD = `
How to work:
- Read the draft as a skeptic from each side in turn. For each side, ask the 2 to 5 questions that side's sharpest skeptic would press hardest: an inconvenient fact the draft skips, a step that leans on a weak or one-sided source, a number without context, a contested point presented as settled, a hole in the timeline, a steelman that misses the side's best argument.
- Check every must_answer item. Each is either answered by specific steps or starting facts (status "answered", step_ids set, resolution saying where and how), or it is not (status "open"). An item that nobody can know yet as of the as-of date (a future decision, a sealed record) counts as answered when the draft says so in open_questions; say that in resolution.
- status "not_applicable" is for a question that does not apply to this case; say why in resolution.
- blocking is true only for a gap a fair dive cannot ship without AND that more research could plausibly close: a must_answer item with no answer, a central fact resting on one party's assertion when records exist, or a missing fact without which the other side would rightly call the whole dive unfair. Everything else is non-blocking; "more detail would help" is never blocking, and neither is something no public source can know yet.
- gaps: for each open question that more research could close, a gap with a concrete search_hint (which record, statement or data to look for, and where). These go back to the researchers.
- most_moving_fact: one or two sentences naming the single fact that would move readers most if it were true, and whether the draft establishes it, reports it, or leaves it open.
- When previous questions are given, keep their ids, re-check each against this draft, and update status and resolution.
- Each question: id "<prefix>-<n>" with the prefix in the prompt (or its previous id), side_id for the side whose skeptic asks it (omit it for must_answer items that belong to no side), the question in one or two plain sentences, blocking, status, resolution when answered or not applicable, step_ids it concerns.
- Your questions are about the draft. Do not answer them from memory or add facts of your own.`;

const hardQuestions: AgentSpec<HardQuestionsInput, HardQuestionsOutput> = {
  name: 'hard_questions',
  tools: 'none',
  tier: 'strong',
  maxTurns: 6,
  system: (ctx) =>
    systemPrompt(
      {
        role: 'the hard-questions agent (agent 4 of 7)',
        job: 'ask what a sharp skeptic on each side would ask of this draft, find what it avoids or leaves out, and name the fact that would move readers most if true. Unanswered questions go back to the researchers.',
        method: METHOD,
        tools: 'none',
      },
      ctx,
    ),
  prompt: (input, ctx) => {
    const parts = [
      'Question this draft.',
      block('draft', draftOnly(input.draft)),
      'The dive must answer:',
      block('must_answer', input.must_answer),
      `Question id prefix: "${idPrefix('hq', ctx)}".`,
    ];
    if (input.previous?.length) parts.push('Questions from earlier rounds (keep their ids):', block('previous_questions', input.previous));
    parts.push('Return your questions, gaps and the most moving fact.');
    return parts.join('\n\n');
  },
  output: HardQuestionsOutput,
};

export default hardQuestions;
