import { z } from 'zod';
import { LocalId, PartialIsoDate, Slug, Text, type Case, type CaseInput } from '@sia/case-schema';
import { block, systemPrompt } from './shared';
import type { AgentSpec } from './types';

/** Agent 1. Defines the single measurable question, the sides, the must-answer list and the content warning. */

export interface ScoperInput {
  /** The admin's one-line brief, e.g. "Harbor bridge closure". */
  brief: string;
}

export const OutlineSide = z
  .object({
    id: LocalId.refine((id) => id !== 'neutral', '"neutral" is reserved'),
    label: Text(80),
    /** The side's view, stated as its supporters would (attributed, not endorsed). */
    position: Text(600),
  })
  .strict();
export type OutlineSide = z.output<typeof OutlineSide>;

export const TimelineEvent = z
  .object({
    date: PartialIsoDate,
    event: Text(400),
    /** The snapshot (opened in this run) the event came from. */
    snapshot_id: z.string().min(1).max(100),
  })
  .strict();
export type TimelineEvent = z.output<typeof TimelineEvent>;

export const Outline = z
  .object({
    slug: Slug,
    title: Text(160),
    question: z
      .object({
        prompt: Text(240),
        /** The 0 end of the slider. */
        left_label: Text(80),
        /** The 100 end of the slider. */
        right_label: Text(80),
      })
      .strict(),
    sides: z.array(OutlineSide).min(2).max(3),
    must_answer: z.array(Text(400)).min(1).max(15),
    content_warning: Text(400).nullable(),
    timeline: z.array(TimelineEvent).max(40),
    /** What downstream agents must respect: people not to name, sealed or contested parts, loaded terms to avoid. */
    notes: z.string().max(2000),
  })
  .strict();
export type Outline = z.output<typeof Outline>;
export type ScoperOutput = Outline;

const METHOD = `
How to work:
1. Run a few WebSearch queries and open 2 to 5 solid sources (court records, official statements, major outlets) with open_source to learn what the story is and where it stands now. Stop there: the researchers do the deep work.
2. question.prompt: ONE question every reader can answer on a 0 to 100 slider. Prefer the form "How responsible is X for Y?". Use another measurable form, such as "How strong is the evidence that X?", only when responsibility does not fit. Name one actor or decision and one outcome, use plain neutral words, and do not presume the answer.
3. question.left_label is the 0 end and question.right_label the 100 end: two to four plain words each, symmetric, with no loaded terms (for example "Not responsible" and "Fully responsible").
4. sides: 2 or 3 positions that real people hold on that question. Each has an id (lowercase words joined by "-", such as "council-responsible"; never "neutral"), a label of a few plain words, and a position: one or two sentences giving the side's view as its own supporters put it, attributed, not endorsed.
5. must_answer: 5 to 12 concrete questions a fair dive has to answer for a skeptic on every side: what happened and when, who decided what, what the records show, what is disputed, what is still unknown.
6. content_warning: one short plain sentence when the case involves the death or abuse of a child, sexual violence, suicide, graphic violence or similar; otherwise null.
7. timeline: the key dated events from the sources you opened, oldest first, each with the snapshot_id it came from. Log each one with log_claim.
8. notes: what downstream agents must respect: minors or private individuals not to name, parts of the record that are sealed or contested, charges that are still allegations, words that are loaded for one side.
9. title: a plain, neutral name for the case (at most 160 characters). slug: the title as lowercase words joined by "-" (at most 80 characters).
10. Labels, positions and notes follow house style too: plain words and no judging words (such as "clearly" or "shocking"), even when you paraphrase a side. Attribute each position to who holds it ("the defense argues", "prosecutors say"), not to unnamed "observers".

Limits on the question:
- Never ask readers to judge the guilt of a private individual who has not been charged. If the story centers on such a person, ask instead about the conduct of institutions, officials or public decisions, or about a charge or verdict that exists in the record.
- When someone has been charged but not convicted, frame the question around evidence or responsibility without presuming guilt, and say in notes that the charges are allegations.
- Do not pick a question whose answer is already settled in the record. Pick one where the evidence leaves room for honest disagreement.`;

const scoper: AgentSpec<ScoperInput, ScoperOutput> = {
  name: 'scoper',
  tools: 'research',
  tier: 'strong',
  maxTurns: 36,
  system: (ctx) =>
    systemPrompt(
      {
        role: 'the scoper (agent 1 of 7)',
        job: 'turn the brief into a case outline: the single measurable question, the sides, the list of things the dive must answer, and whether a content warning is needed.',
        method: METHOD,
        tools: 'research',
      },
      ctx,
    ),
  prompt: (input, ctx) =>
    [
      'Scope this case. The admin wrote this one-line brief:',
      block('brief', input.brief.trim()),
      `Today is ${ctx.asOf}. Search, open a few sources, and return the outline.`,
    ].join('\n\n'),
  output: Outline,
};

export default scoper;

/**
 * An outline for a case that already exists (revisions and live updates skip
 * the scoper): its question, sides, open questions and content warning.
 */
export function outlineFromCase(c: Case | CaseInput): Outline {
  return {
    slug: c.slug,
    title: c.title,
    question: {
      prompt: c.question.prompt,
      left_label: c.question.scale.left_label,
      right_label: c.question.scale.right_label,
    },
    sides: c.sides.map((s) => ({ id: s.id, label: s.label, position: s.steelman.slice(0, 600) })),
    must_answer: c.open_questions?.length ? c.open_questions.slice(0, 15) : [c.question.prompt],
    content_warning: c.content_warning ?? null,
    timeline: [],
    notes: '',
  };
}
