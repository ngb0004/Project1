import { z } from 'zod';
import { BiasFlag, Text, type CaseInput } from '@sia/case-schema';
import {
  block,
  draftOnly,
  idPrefix,
  resolveSide,
  systemPrompt,
  type BiasFlagLike,
  type DraftCase,
  type SideRef,
  type SourceSnapshotRef,
} from './shared';
import type { AgentSpec } from './types';

/**
 * Agent 5 (one per side). Reads the draft as a partisan of its side and flags
 * bias. Every call is a fresh query that sees only the draft JSON, never the
 * drafter's reasoning or the review record.
 */

export interface RedTeamInput {
  /** The draft JSON only. Any review record on it is stripped before the prompt is built. */
  draft: CaseInput | DraftCase;
  /** The side this red team reads as (an id from the draft, or the side itself). */
  side: SideRef;
  /** Cited sources mapped to their snapshots, so cited passages can be read in context. */
  sources?: SourceSnapshotRef[];
  /** This side's flags on the previous draft: re-raise (same id) those that still apply. */
  previous_flags?: BiasFlagLike[];
}

/**
 * A bias flag exactly as the review record stores it, minus `status` and
 * `resolution` (the orchestrator sets those), so `{ ...flag, status }` is a valid `BiasFlag`.
 */
export const RedTeamFlag = BiasFlag.omit({ status: true, resolution: true });
export type RedTeamFlag = z.output<typeof RedTeamFlag>;

export const RedTeamOutput = z
  .object({
    summary: Text(3000),
    flags: z.array(RedTeamFlag).max(40),
  })
  .strict();
export type RedTeamOutput = z.output<typeof RedTeamOutput>;

/** Flags that stop the loop: high severity. */
export function highSeverityFlags(out: RedTeamOutput): RedTeamFlag[] {
  return out.flags.filter((f) => f.severity === 'high');
}

const METHOD = `
You have not seen how the draft was made; you see only the draft. Read it as a committed partisan of your side who wants the dive to be fair to that side, and find every way it is not.

Flag kinds:
- cherry_picking: a step uses a selective part of a source, picks a weak fact where the same source has a stronger one for the other view, or drops context that changes the meaning. When snapshots are listed, use read_source to check cited passages in context.
- loaded_wording: words that judge, insinuate or frame (in the question, labels, headlines, bodies, layers or steelmen), or an assertion presented as fact without "alleged", "said" or "according to".
- order_effect: an order that stacks one side's strongest facts at the end (the last word) or at the start, or puts a rebuttal far from what it answers.
- missing_exculpatory_fact / missing_damning_fact: a fact your side would rightly expect to see that is absent. Describe it as a lead to research and where it might be found; never state it as fact.
- other: anything else a fair-minded member of your side would call unfair: a weak or wrong steelman for your side, a confidence label too strong for the other side's claims (or weaker for your side's than for the same kind of evidence on the other side, such as each side's expert testimony), a misleading number, or a question worded so that your side carries a burden the law does not put on it.

Fact votes and online takes: flag (loaded_wording) a fact-vote statement that is worded to push readers toward one answer, presumes guilt, or restates the main question. Flag (other) an online take that is a strawman of the side it speaks for, or whose checks are harder on one lens than on the others (verdicts, wording or sources held to different standards), and a dive that leaves out the human details or viral claims people on your side keep raising, when the sources support them.

Neutral steps and the ending: for every step tagged favors "neutral", ask whether it actually helps one side (an outcome, a vote tally, a procedural setback, a related lawsuit). If it does, flag it (order_effect, with step_id) and say which side it helps, so the balance count is honest. Read the last third of the dive as a whole: flag it when it leans to one side, counting neutral-tagged steps by the side they really help.

Severity:
- high: a fair-minded reader on your side would call the whole dive unfair, or a fact is misstated.
- medium: it tilts a step noticeably.
- low: wording or polish.

Be honest. You argue for fairness to your side, not for your side winning: do not flag a fact because it hurts your side when it is accurate, sourced and fairly placed.
Each flag: id "<prefix>-<n>" with the prefix in the prompt (or the id of a previous flag you raise again), step_id when it concerns one step, kind, severity, and a note of 1 to 4 sentences stating the problem and the fix.
summary: 2 to 5 sentences: is the dive fair to your side overall, and what must change.`;

const redTeam: AgentSpec<RedTeamInput, RedTeamOutput> = {
  name: 'red_team',
  tools: 'read_sources',
  tier: 'strong',
  maxTurns: 30,
  system: (ctx) =>
    systemPrompt(
      {
        role: `a red team (agent 5 of 7) reading for one side${ctx.scope ? ` (side "${ctx.scope}")` : ''}`,
        job: 'read the draft as a partisan of your side and flag cherry-picking, loaded wording, order effects, and missing exculpatory or damning facts, each with a severity.',
        method: METHOD,
        tools: 'read_sources',
      },
      ctx,
    ),
  prompt: (input, ctx) => {
    const draft = draftOnly(input.draft);
    const side = resolveSide(input.side, draft.sides ?? []);
    const parts = [
      side
        ? `You read for the side "${side.label}" (id "${side.id}").${side.position ? ` Its case as the draft states it: ${side.position}` : ''}`
        : 'You read for one side of the question.',
      block('draft', draft),
    ];
    if (input.sources?.length) parts.push('Cited sources and their snapshots (read them with read_source):', block('sources', input.sources));
    else parts.push('No snapshots are listed: judge the draft from its text and evidence quotes.');
    parts.push(`Flag id prefix: "${idPrefix(`rt-${side?.id ?? ctx.scope ?? 'side'}`, ctx)}".`);
    if (input.previous_flags?.length) {
      parts.push('Your flags on the previous draft. Re-raise, with the same id, each one that still applies; drop the ones that are fixed:', block('previous_flags', input.previous_flags));
    }
    parts.push('Return your summary and flags.');
    return parts.join('\n\n');
  },
  output: RedTeamOutput,
};

export default redTeam;
