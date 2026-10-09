import { z } from 'zod';
import { LocalId, PartialIsoDate, Slug, TakeLens, Text, type Case, type CaseInput } from '@sia/case-schema';
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

/** How one political lens tells the story online, for the researchers to check. */
export const OnlineFraming = z
  .object({
    lens: TakeLens,
    /** One or two sentences: the story as that lens tells it. */
    how_told: Text(600),
    /** Where readers run into it (platforms, outlets, accounts by type, never private people's handles). */
    where: Text(200),
    /** The specific claims it makes that the researchers must check. */
    claims_to_check: z.array(Text(300)).max(6).default([]),
  })
  .strict();
export type OnlineFraming = z.output<typeof OnlineFraming>;

export const Outline = z
  .object({
    slug: Slug,
    title: Text(160),
    question: z
      .object({
        /** A plain statement readers rate from Disagree (0) to Agree (100). */
        prompt: Text(240),
        /** The 0 end of the slider, normally "Disagree". */
        left_label: Text(80),
        /** The 100 end of the slider, normally "Agree". */
        right_label: Text(80),
      })
      .strict(),
    sides: z.array(OutlineSide).min(2).max(3),
    must_answer: z.array(Text(400)).min(1).max(15),
    content_warning: Text(400).nullable(),
    timeline: z.array(TimelineEvent).max(40),
    /** How the left, the center and the right are telling the story online. */
    online: z.array(OnlineFraming).max(3).default([]),
    /** What downstream agents must respect: people not to name, sealed or contested parts, loaded terms to avoid. */
    notes: z.string().max(2000),
  })
  .strict();
export type Outline = z.output<typeof Outline>;
export type ScoperOutput = Outline;

const METHOD = `
How to work:
1. Run a few WebSearch queries and open 2 to 5 solid sources (court records, official statements, major outlets) with open_source to learn what the story is and where it stands now. Then run a recency sweep before you finish: search for the newest developments (for example "<subject> <this month and year>", "<subject> <last month and year>", "<subject> judge rules", "<subject> latest") and open the newest dated report you find, so the outline does not stop at an older stage of the story. Stop there: the researchers do the deep work.
2. Find out how people are actually meeting this story. Search for the viral posts and the coverage of them (for example "<subject> TikTok", "<subject> viral", "<subject> fact check", "<subject> Fox News", "<subject> MSNBC") and open a fact-check or a report about the online conversation when one exists. Most readers know the story from social media: the dive must cover what they have heard.
3. question.prompt: ONE plain statement about the thing people are actually arguing over, which a reader rates from Disagree to Agree, for example "The system failed the student who reported the assault." or "The city council is to blame for the bridge closing." Use everyday words, at most about 20 words, no legal terms, and do not presume the answer. When the law puts the burden of proof on one party, word it around what that party must prove, or in burden-neutral terms.
4. question.left_label is "Disagree" and question.right_label is "Agree", unless the statement needs another plain pair.
   sides: 2 or 3 positions that real people hold on that statement. Each has an id (lowercase words joined by "-", such as "council-to-blame"; never "neutral"), a label of a few plain words, and a position: one or two sentences giving the side's view as its own supporters put it, attributed, not endorsed.
5. must_answer: 5 to 12 concrete questions a fair dive has to answer for a skeptic on every side: what happened and when (the human story, not only the paperwork: what the people involved say happened, what was said to or about them, how they were treated afterward), who decided what, what the records show, what is disputed, what people online keep saying, and what is still unknown.
6. content_warning: one short plain sentence when the case involves the death or abuse of a child, sexual violence, suicide, graphic violence or similar; otherwise null.
7. timeline: the key dated events from the sources you opened, oldest first, each with the snapshot_id it came from, ending with the newest dated development the recency sweep found. Log each one with log_claim.
8. online: up to three framings, one each for "left", "center" and "right", of how the story is being told online, each with how_told (the story as that side tells it, in a sentence or two), where (platforms and outlets, never a private person's handle) and claims_to_check (the specific claims it makes). Leave a lens out when you found no sign of it.
9. notes: what downstream agents must respect: minors or private individuals not to name, parts of the record that are sealed or contested, charges that are still allegations, words that are loaded for one side, and the newest development you found with its date ("newest development found: ...").
10. title: a plain, neutral name for the case (at most 160 characters). slug: the title as lowercase words joined by "-" (at most 80 characters).
11. Labels, positions and notes follow house style too: plain words and no judging words (such as "clearly" or "shocking"), even when you paraphrase a side. Attribute each position to who holds it ("the defense argues", "prosecutors say"), not to unnamed "observers".

Limits on the question:
- Never ask readers to declare a private individual guilty of a crime they have not been convicted of, and never name a private accused person. When the argument online is about such a person, word the statement around what can be judged from the record: how the people and institutions involved acted, whether an account was handled fairly, or a charge or verdict that exists in the record.
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

export interface OutlineFromCaseOptions {
  /** A revision: the admin's notes, which the draft must carry out. */
  instructions?: string;
  /**
   * A live update: the as-of date of the version being updated (the live
   * version, or the update package already waiting for review on top of it).
   * The draft must report what is new since then.
   */
  sinceAsOf?: string;
}

const clipText = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Most must-answer items an outline carries (the Outline schema allows 15). */
export const MAX_MUST_ANSWER = 15;

/**
 * A must-answer item every new case gets: where the story stands on the as-of
 * date, so a draft cannot stop at an older stage of it.
 */
export const statusItem = (asOf: string) =>
  `What is the status of the case as of ${asOf}, and does the draft report the newest development any opened source describes, with its date (and nothing as pending that a newer source shows was decided)?`;

/** The generic first must-answer item of a live update, before the researchers have reported. */
export const updateDevelopmentsItem = (since: string) =>
  `What has happened since ${since} that bears on the question, and does the draft report each material development with its date and source?`;

/** A must-answer item for one development the update researchers found. */
export function developmentItem(since: string, d: { text: string; publisher: string; date: string | null }): string {
  return clipText(
    `New since ${since}: "${clipText(d.text, 240)}" (${d.publisher}${d.date ? `, ${d.date}` : ''}). Does the draft report it with its date and source, or is it immaterial to the question?`,
    400,
  );
}

/**
 * An outline for a case that already exists (revisions and live updates skip
 * the scoper): its question, sides and content warning, and a must-answer list
 * for this run.
 *
 * The must-answer list is NOT the base version's open questions: those are
 * unknowns by design, and asking the hard-questions agent to see them answered
 * would block every revision for all three rounds. It is, in order: the admin's
 * notes (revision), or for an update the developments since the base as-of date
 * (the orchestrator replaces this item with one per development once the
 * researchers report), that unchanged facts are kept and superseded ones
 * corrected, and that open questions a new source answers are resolved; then the
 * must-answer items the base version's own run answered (its hard questions that
 * belong to no side), and at least the case question itself. The open questions
 * go to `notes` so the drafter keeps them unless a new source answers one.
 */
export function outlineFromCase(c: Case | CaseInput, opts: OutlineFromCaseOptions = {}): Outline {
  const must: string[] = [];
  const add = (q: string) => {
    const text = clipText(q.trim(), 400);
    if (text && must.length < 12 && !must.includes(text)) must.push(text);
  };
  const open = c.open_questions ?? [];
  const notes = opts.instructions?.trim();
  if (notes) add(`Does the draft carry out the admin's notes for this revision: "${notes}"?`);
  if (opts.sinceAsOf) {
    add(updateDevelopmentsItem(opts.sinceAsOf));
    add(
      `Does the draft keep each fact of version ${c.version} that no development since ${opts.sinceAsOf} changes, and correct or retire each step that a development supersedes or contradicts?`,
    );
    if (open.length) {
      add(`Does the draft resolve, with a sourced step, each open question of version ${c.version} that a new source answers, and keep the others as open questions?`);
    }
  }
  for (const q of c.review?.hard_questions ?? []) {
    if (!q.side_id && q.status === 'answered') add(q.question);
  }
  if (must.length === 0) add(`Does the draft set out the facts each side relies on to answer: ${c.question.prompt}`);

  const noteParts: string[] = [];
  if (opts.sinceAsOf) {
    noteParts.push(
      `Live update of version ${c.version}, current as of ${opts.sinceAsOf}. Report only developments dated after ${opts.sinceAsOf}; keep every fact of version ${c.version} that they do not change.`,
    );
  }
  if (open.length) {
    noteParts.push(
      `Version ${c.version} (as of ${c.as_of}) lists these open questions, unknown when it was written. Keep each in open_questions ` +
        `unless a source opened in this run answers it; they are not gaps to close: ${open.map((q) => `"${q}"`).join('; ')}`,
    );
  }
  return {
    slug: c.slug,
    title: c.title,
    question: {
      prompt: c.question.prompt,
      left_label: c.question.scale.left_label,
      right_label: c.question.scale.right_label,
    },
    sides: c.sides.map((s) => ({ id: s.id, label: s.label, position: s.steelman.slice(0, 600) })),
    must_answer: must,
    content_warning: c.content_warning ?? null,
    timeline: [],
    // The version's online takes, so a revision or update re-checks them.
    online: (c.takes ?? []).slice(0, 3).map((t) => ({
      lens: t.lens,
      how_told: clipText(t.summary, 600),
      where: clipText(t.seen_on ?? 'online', 200),
      claims_to_check: (t.checks ?? []).slice(0, 6).map((ch) => clipText(ch.claim, 300)),
    })),
    notes: clipText(noteParts.join(' '), 2000),
  };
}
