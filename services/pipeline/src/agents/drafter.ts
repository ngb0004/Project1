import { z } from 'zod';
import { DEFAULT_MICRO_POLL_PROMPT, Text, type Case, type CaseInput } from '@sia/case-schema';
import type { ResearchClaim } from './researcher';
import type { Outline } from './scoper';
import {
  DraftCase,
  balanceWarnings,
  block,
  draftOnly,
  judgingWordReport,
  systemPrompt,
  type Critiques,
  type OpenedSourceRef,
} from './shared';
import type { AgentSpec } from './types';

/** Agent 3. Builds the case JSON from the research only. */

export interface DrafterInput {
  outline: Outline;
  /** Every claim the researchers logged (each tied to a snapshot opened in this run). */
  claims: ResearchClaim[];
  /** Sources opened in this run; their fetch times become `accessed_at`. */
  opened?: OpenedSourceRef[];
  /** The draft being revised inside the critic loop. */
  previous?: CaseInput | DraftCase;
  /** What the critics said about `previous`. */
  critique?: Critiques;
  /** The admin's notes from a "request changes" decision. */
  instructions?: string;
  /** The version being revised (admin revision) or updated (live update). */
  base?: Case | CaseInput;
}

export const Resolution = z
  .object({
    /** A hard question id, a red-team flag id, a gap id, `fact_check:<target>`, or `admin`. */
    ref: z.string().min(1).max(160),
    resolution: Text(2000),
  })
  .strict();
export type Resolution = z.output<typeof Resolution>;

export const DrafterOutput = z
  .object({
    case: DraftCase,
    resolutions: z.array(Resolution).max(120),
  })
  .strict();
export type DrafterOutput = z.output<typeof DrafterOutput>;

const METHOD = `
What to build (the case JSON):
- schema_version 1, id: the slug, status "draft", version 1 (the database assigns the real id, version and status). When revising or updating a base version, keep its id and slug, set version to its version + 1 and parent_version to its version.
- as_of: the run's as-of date.
- slug, title, question ({prompt, scale: {type "slider", min 0, max 100, left_label, right_label}}) and content_warning (leave it out when the outline has none): from the outline.
- starting_facts: 3 to 6 agreed, no-spin baseline facts that every side accepts (who, what, when, where). Ids "f1", "f2", and so on.
- steps: 8 to 14 steps (fewer when the research is thin), ids "s1", "s2", and so on, with order 1..n matching their position.
  - headline: one line, at most 160 characters, stating a fact, not a conclusion.
  - body: 2 to 4 sentences giving the fact and the context a reader needs. No rhetorical questions, no verdicts on guilt or blame.
  - depth: 1 to 3 tap-to-go-deeper layers where the research supports them: "document" (title, a summary of the document, source_id), "quote" (text copied verbatim from a source, the speaker, optional context, source_id), "timeline" (dated entries, each with source_ids; use the claims' event_date), "context" (title, background body, source_ids). Layer ids such as "d1", "q1", "t1", "c1", unique within the step.
  - favors: the side id the fact helps, or "neutral". impact: low, medium or high.
  - source_ids: every source the step relies on, at least one. evidence: at least one {source_id, quote} for each cited source, with the quote copied verbatim from a claim's quote or from read_source output for that source's snapshot.
  - confidence (rules below). micro_poll: {"prompt": "${DEFAULT_MICRO_POLL_PROMPT}", "re_ask_slider": true}.
- Starting facts also carry source_ids, confidence and evidence the same way.
- sides: the outline's sides (same ids and labels), each with a steelman: the strongest case for that side in its supporters' own terms, 2 to 5 sentences built only from the claims and attributed ("Supporters argue ...").
- open_questions: 2 to 6 things that are still unknown or unresolved, as plain questions.
- sources: one per URL you cite, id "src-<short-name>": title, publisher, url (exactly the claim's url), date (the claim's source_date; when it is null, the year shown on the page, or else the year in accessed_at), type (the claim's source_type), accessed_at (the fetched_at of its snapshot in <opened>, or else the as-of date at 00:00:00Z). Include no source that no claim or base version supplied.

Rules:
- Use ONLY the claims and snapshots in the prompt. Add no outside claims, numbers, names, dates or context from memory. If a fact you need is not in the claims, leave it out and, when it matters, list it in open_questions.
- Every statement in a headline, body, layer, starting fact or steelman must be supported by the evidence quotes of the sources that item cites. Use read_source on a claim's snapshot_id when you need a longer or different verbatim passage from the same source.
- Confidence: "established" only when a court_record, official or primary source supports it and it is not contested. With only news or analysis sources it is at most "reported". When it rests on one party's assertion it is "alleged". When credible sources conflict it is "disputed". Never label a fact stronger than the claims behind it.
- Say it in the words too: "prosecutors allege", "the company denies", "according to the lawsuit".
- Write for readers. User-facing copy never mentions the research process ("the opened text", "the sources opened for this dive"); put such limits in open_questions or in resolutions. Draw no inferences the sources do not state: no computed deadlines, totals or motives.
- Order is identical for every reader. Interleave the sides so that no side's strongest (high impact) facts are bunched at the end, and do not end on one side's strongest fact. Keep the number of steps per side roughly even when the research allows. Fairness is not false balance: do not inflate a side the record does not support; say so in a resolution instead.
- Copy fields are short: headline 160 characters, body 1000, quote layer 1200, steelman 2000, open question 400.

Revising:
- With a previous draft and critique: revise that draft. Keep the ids of steps that survive, and renumber order to match position. Address each critique item the claims allow: reword loaded language, fix confidence labels, correct or cut unsupported text, reorder steps, and add steps from new claims that close gaps.
- With a base version and admin notes: apply the notes to the base version and change nothing else unless a note requires it.
- With a base version and new claims but no notes (a live update): add or revise steps for material new developments, update as_of, and keep everything else.
- resolutions: one entry per critique item, gap or admin note you handled. ref is the hard question id, red-team flag id or gap id, "fact_check:<target>" for a fact-check row, or "admin" for the admin's notes. resolution says what you changed, or why you could not address it (for example, no opened source covers it).`;

const drafter: AgentSpec<DrafterInput, DrafterOutput> = {
  name: 'drafter',
  tools: 'read_sources',
  tier: 'strong',
  maxTurns: 30,
  system: (ctx) =>
    systemPrompt(
      {
        role: 'the drafter (agent 3 of 7)',
        job: 'build the dive from the research only: the starting facts, the ordered steps with their depth layers and evidence, the side steelmen, the open questions and the source list. You add no outside claims.',
        method: METHOD,
        tools: 'read_sources',
      },
      ctx,
    ),
  prompt: (input, ctx) => {
    const parts: string[] = [];
    if (input.previous) parts.push('Revise the previous draft to answer the critique.');
    else if (input.base && input.instructions) parts.push(`Revise version ${input.base.version} of this case following the admin's notes.`);
    else if (input.base) parts.push(`Update version ${input.base.version} of this live case with the new developments in the claims.`);
    else parts.push('Write the first draft of this case.');
    parts.push(`As-of date: ${ctx.asOf}.`, block('outline', input.outline));
    parts.push(`Claims from the researchers (${input.claims.length}). Use only these:`, block('claims', input.claims));
    if (input.opened?.length) parts.push('Sources opened in this run:', block('opened', input.opened));
    if (input.base) parts.push(`Base version ${input.base.version}:`, block('base', draftOnly(input.base)));
    if (input.instructions?.trim()) {
      parts.push(
        "The admin's notes (the owner's instructions for this revision; follow them unless they conflict with the standards):",
        block('admin_notes', input.instructions.trim()),
      );
    }
    if (input.previous) {
      parts.push('Previous draft:', block('previous', draftOnly(input.previous)));
      if (input.critique) parts.push('Critique of the previous draft:', block('critique', input.critique));
      const balance = balanceWarnings(input.previous);
      if (balance.length) parts.push('Balance check on the previous draft:', block('balance', balance));
      const words = judgingWordReport(input.previous);
      if (words.length) parts.push('Judging words in the previous draft (replace them with plain words):', block('judging_words', words));
    }
    parts.push('Return the case and your resolutions.');
    return parts.join('\n\n');
  },
  output: DrafterOutput,
};

export default drafter;
