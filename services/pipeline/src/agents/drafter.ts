import { z } from 'zod';
import { Text, type Case, type CaseInput } from '@sia/case-schema';
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
  /** A live update: given in every round, so revisions inside the critic loop keep the update rules. */
  update?: DrafterUpdate;
  /** What the researchers looked for and could not find or verify (research gaps, not public unknowns). */
  research_gaps?: ResearchGapRef[];
}

/** A researcher's gap, as the drafter, the hard-questions agent and the admin see it. */
export interface ResearchGapRef {
  /** Who reported it: a side id or "records". */
  scope: string;
  description: string;
  blocking?: boolean;
  search_hint?: string;
}

export interface DrafterUpdate {
  /** The live version the package updates. */
  live_version: number;
  /** The version the draft starts from: the live version, or the update package already in review on top of it. */
  base_version: number;
  /** Developments are dated after this `YYYY-MM-DD` (the base version's as-of date). */
  since: string;
  /** Ids of the claims that are new developments; each needs a resolution. */
  developments: string[];
  /** Step ids already used by the base version (new steps must not reuse them). */
  used_step_ids: string[];
}

/**
 * What was done about one critique item:
 * - `changed`: the draft was changed to answer it;
 * - `not_changed`: it was considered and left as it is (the resolution says why);
 * - `needs_admin`: it cannot be settled from the opened sources or is the admin's call;
 * - `not_applicable`: it does not apply to this case or draft.
 */
export const ResolutionAction = z.enum(['changed', 'not_changed', 'needs_admin', 'not_applicable']);
export type ResolutionAction = z.output<typeof ResolutionAction>;

export const Resolution = z
  .object({
    /** A hard question id, a red-team flag id, a gap id, `fact_check:<target>`, or `admin`. */
    ref: z.string().min(1).max(160),
    action: ResolutionAction,
    resolution: Text(2000),
  })
  .strict();
export type Resolution = z.output<typeof Resolution>;

export const DrafterOutput = z
  .object({
    case: DraftCase,
    resolutions: z.array(Resolution).max(120),
    /**
     * Facts the dive needs that no claim supplies: research gaps for the admin
     * (not open questions, which are unknowns in the public record).
     */
    research_gaps: z.array(Text(600)).max(20).default([]),
  })
  .strict();
export type DrafterOutput = z.output<typeof DrafterOutput>;

const METHOD = `
What to build (the case JSON):
- schema_version 1, id: the slug, status "draft", version 1 (the database assigns the real id, version and status). When revising or updating a base version, keep its id and slug, set version to its version + 1 and parent_version to its version.
- as_of: the run's as-of date.
- slug, title, question ({prompt, scale: {type "slider", min 0, max 100, left_label, right_label}}) and content_warning (leave it out when the outline has none): from the outline. question.prompt is a plain statement rated from Disagree (left_label) to Agree (right_label). In a new case (no base version) you may reword it only to answer a critique flag about its wording (loaded or one-sided framing, hard words, or a framing that puts the burden of proof on one side when the law puts it on the other), keeping the same subject and scale; when the law puts the burden on one party, word the question around what that party must prove, or in burden-neutral terms. In a revision or a live update, never change the question.
- starting_facts: 3 to 6 short, agreed, no-spin baseline facts that every side accepts (who, what, when, where, and procedural facts such as the charges, a trial date or a mistrial). Before a fact goes here, check the claims and snapshots for a party contesting it (for example the two sides' accounts of how something happened): a contested fact is a step labeled "disputed" or "alleged", never a starting fact. Ids "f1", "f2", and so on.
- steps: 8 to 14 steps (fewer when the research is thin), ids "s1", "s2", and so on, with order 1..n matching their position. Tell the story in the order a reader needs it: first what happened and what the people involved say happened (their own words, what was said to or about them, how they were treated afterward, the details people keep repeating online), then what the institutions did, then where things stand. Each step is a fact that bears on the question and ends in a fact vote. Procedural posture (a hearing date, a pending motion, a related filing) is not a step: put it in starting_facts, a context or timeline layer, or open_questions.
  - headline: one plain line, at most 120 characters, stating a fact, not a conclusion. It is the thing readers read first, so make it carry the fact on its own.
  - body: 1 to 3 short sentences (at most 450 characters) a 12-year-old could follow: what happened, who says so, and why it matters. No legal terms, no rhetorical questions, no verdicts on guilt or blame. Exact legal wording, numbers that need explaining and long quotes go in depth layers.
  - depth: 1 to 3 tap-to-go-deeper layers where the research supports them: "document" (title, a summary of the document, source_id), "quote" (words the named speaker said or wrote, copied verbatim from where the source puts them in quotation marks; start at the beginning of a sentence or of the quotation, and never cut a negation or qualifier such as "no", "not", "never" or "only" off its start; speaker is only the person's name and role, with no notes or parentheses; optional context; source_id). A reporter's paraphrase, or a publication describing testimony, is a "context" layer, never a quote layer., "timeline" (dated entries, each with source_ids; use the claims' event_date), "context" (title, background body, source_ids). Layer ids such as "d1", "q1", "t1", "c1", unique within the step.
  - favors: the side id the fact helps, or "neutral" only when it helps neither side (not to keep a step out of the balance count). impact: low, medium or high.
  - source_ids: every source the step relies on, at least one. evidence: at least one {source_id, quote} for each cited source, with the quote copied verbatim from a claim's quote or from read_source output for that source's snapshot.
  - confidence (rules below).
  - micro_poll: {"statement": "..."}: ONE plain statement about this fact that a reader can agree or disagree with, at most about 15 words. Make it about what someone did or decided in this step, or about what the fact means, so readers who share the main view can still split on it (for example "The DA should have read her full interview before deciding." or "Cornell was right to suspend the fraternity."). It must not restate the main question, presume guilt, or name a private accused person. For a background fact, ask about what it means ("This law should change.").
- Starting facts also carry source_ids, confidence and evidence the same way.
- sides: the outline's sides (same ids and labels), each with a steelman: the strongest case for that side in its supporters' own terms, 2 to 5 plain sentences built only from the claims and attributed ("Supporters argue ...").
- timeline: "what happened, in order", a recap shown after the facts: 6 to 15 dated events, oldest first, ids "e1", "e2", and so on. Each has date (YYYY, YYYY-MM or YYYY-MM-DD, from the claims' event_date), text (one short, plain sentence, at most 240 characters, attributed when it is someone's claim), source_ids and evidence quotes, held to the same rules as steps. Cover the whole story from the first event to the newest development; skip events no claim dates.
- takes: how the story is being told online, one take per lens in the outline's "online" list that the claims cover ("left", "center", "right"; ids "left", "center", "right"). Each take has:
  - label: "How the left is telling it", "How the middle is telling it" or "How the right is telling it".
  - summary: 2 to 4 plain sentences telling the story the way that side tells it online, in its own voice (it is that side's framing, not the dive's; keep loaded words out unless quoted).
  - seen_on: where readers run into it (platforms and outlets), when the claims say.
  - source_ids: sources showing people are telling it this way (reporting on the online conversation, opinion pieces, fact-checks, or public posts of type "social").
  - checks: 2 to 5 specific claims the take makes, each with verdict "holds_up", "partly", "not_backed", "false" or "unknown", a one- or two-sentence plain note saying what the record shows, source_ids, and evidence quotes. A verdict other than "unknown" needs a news, official, court or primary source behind it, never a social post alone. Check each take as hard as the others: no lens gets an easier ride.
- open_questions: 2 to 6 things that are still unknown in the public record as of the as-of date (a pending ruling, a sealed record, a report not yet released), as plain questions. A fact you could not find in the claims is a research gap, not an open question: list it in research_gaps instead.
- research_gaps: facts the dive needs that no claim supplies (the admin sees them; readers never do). Empty when there are none.
- sources: one per URL you cite, id "src-<short-name>": title, publisher, url (exactly the claim's url), date (the claim's source_date; when it is null, the year shown on the page, or else the year in accessed_at), type (the claim's source_type; "social" for a public post, which can show what people say but never supports a step or a starting fact on its own), accessed_at (the fetched_at of its snapshot in <opened>, or else the as-of date at 00:00:00Z). Include no source that no claim or base version supplied.

Rules:
- Use ONLY the claims and snapshots in the prompt. Add no outside claims, numbers, names, dates or context from memory. If a fact you need is not in the claims, leave it out and, when it matters, list it in research_gaps (not in open_questions).
- Every statement in a headline, body, layer, starting fact or steelman must be supported by the evidence quotes of the sources that item cites. Use read_source on a claim's snapshot_id when you need a longer or different verbatim passage from the same source.
- Confidence: "established" only when a court_record, official or primary source supports it and it is not contested. With only news or analysis sources it is at most "reported". When it rests on one party's assertion it is "alleged". When credible sources conflict it is "disputed". Never label a fact stronger than the claims behind it.
- Say it in the words too: "prosecutors allege", "the company denies", "according to the lawsuit".
- Write for readers. User-facing copy never mentions the research process ("the opened text", "the sources opened for this dive"); put such limits in open_questions or in resolutions. Draw no inferences the sources do not state: no computed deadlines, totals or motives. Anything described as pending, undecided or upcoming must rest on a source dated close to the as-of date; otherwise say it as of that source's date ("as of Sept. 30, the motion was under advisement"). Never say when something will be decided unless a source says so.
- Order is identical for every reader. Interleave the sides so that no side's strongest (high impact) facts are bunched at the end, and do not end on one side's strongest fact. Keep the number of steps per side roughly even when the research allows. Fairness is not false balance: do not inflate a side the record does not support; say so in a resolution instead.
- Copy fields are short: headline 160 characters (aim for 120), body 450, quote layer 1200, steelman 2000, open question 400, take summary 600, check note 400.
- Never name a private person who is accused but not convicted, even when a source does; say "an accused student" or "one of the men". Use the name a victim is publicly known by (for example "Jane Doe") and no other.

Revising:
- With a previous draft and critique: revise that draft. Keep the ids of steps that survive, and renumber order to match position. Address each critique item the claims allow: reword loaded language, fix confidence labels, correct or cut unsupported text, reorder steps, and add steps from new claims that close gaps.
- With a base version and admin notes: apply the notes to the base version and change nothing else unless a note requires it.
- resolutions: one entry per critique item, gap or admin note you handled. ref is the hard question id, red-team flag id or gap id, "fact_check:<target>" for a fact-check row, or "admin" for the admin's notes. action: "changed" when you changed the draft to answer it; "not_changed" when you left the draft as it is (say why); "needs_admin" when it cannot be settled from the opened sources or is the admin's call; "not_applicable" when it does not apply. resolution says what you changed, or why you did not (for example, no opened source covers it). Never mark an item "changed" unless the draft changed for it.

Live updates (the prompt has an <update> block): the draft is the next version of a published case, and the admin reviews it as a diff against the live version.
- Start from the base version and change only what the new developments require. Keep every starting fact, step, depth layer, side, open question and source that no development changes exactly as it is, with the same id and the same evidence: unchanged facts must show as unchanged in the diff.
- Add a step for each material development, with a new id that is not in used_step_ids (for example "s<n>" above the highest number used). Never give a retired step's id to a different fact.
- Modify a step (keeping its id) when a development changes the fact it states: a ruling decides a pending motion, a verdict replaces a pending trial, a figure is corrected. Update its headline, body, confidence, evidence and source_ids to match.
- Retire (remove) a step only when a development shows it is wrong or no longer relevant, and give the reason in a resolution whose ref is the step id.
- open_questions: remove each one a new claim answers, and state the answer in a step that cites that claim; keep the others word for word; add one when a development raises a new unknown.
- Change starting_facts and steelmen only when a development changes them.
- Place new steps where they belong in the story, keeping the order rules above (spread each side's strongest facts; do not end on one side's strongest fact), and renumber order 1..n.
- resolutions: one entry per development (ref is its claim id, action "changed" when it went into a step, else "not_changed") saying which step it went into, or why it was left out; one per retired step (ref is the step id, action "changed"); one per resolved open question (ref "open_question", action "changed").
- Inside the critic loop the previous draft already carries these changes: keep them while you answer the critique.
- In the critic loop, change a fact that no development touches only for a blocking finding on it: a fact-check failure, a high-severity red-team flag, or a blocking hard question or gap. For any other critique of an unchanged fact, leave the fact exactly as it is and give that item action "needs_admin" with a resolution saying it is left for the admin. The live version was reviewed; the update's diff should show the developments, not rewording.`;

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
    if (input.update) {
      const u = input.update;
      parts.push(
        `Live update of published version ${u.live_version}` +
          (u.base_version !== u.live_version ? ` (starting from version ${u.base_version}, the update already waiting for review, which this one replaces)` : '') +
          `. Every claim below is a development dated after ${u.since}, unless it closes a critic's gap. Follow the live-update rules.`,
        block('update', u),
      );
    }
    parts.push(`Claims from the researchers (${input.claims.length}). Use only these:`, block('claims', input.claims));
    if (input.research_gaps?.length) {
      parts.push(
        'What the researchers looked for and could not find or verify (research gaps: name them in research_gaps when the dive needs them; they are not open questions unless the public record itself does not know):',
        block('research_gaps', input.research_gaps),
      );
    }
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
