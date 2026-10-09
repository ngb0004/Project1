import { z } from 'zod';
import { JUDGING_WORDS, type CaseInput } from '@sia/case-schema';
import {
  DraftCase,
  balanceWarnings,
  block,
  draftOnly,
  judgingWordReport,
  systemPrompt,
  validationReport,
  type Critiques,
  type OpenIssueLike,
} from './shared';
import { Resolution } from './drafter';
import type { AgentSpec } from './types';

/** Agent 7. Applies fixes that need no new facts, enforces house style, and returns a schema-valid case. */

export interface EditorInput {
  draft: CaseInput | DraftCase;
  /** What the critics said about the last draft. */
  critiques: Critiques;
  /** What is still unresolved after the loop; these go to the admin. */
  openIssues: OpenIssueLike[];
  /**
   * A live update: steps (ids) and starting facts (`fact:<id>`) that are exactly
   * as in the live version, which was edited and approved before.
   */
  unchanged?: string[];
  /** A new case (not a revision or live update): the question's wording may still change. */
  newCase?: boolean;
}

export const EditorOutput = z
  .object({
    case: DraftCase,
    /** What the editor changed, and what it left for the admin. */
    notes: z.array(z.string().min(1).max(1000)).max(60),
    /** One per critique item (red-team flag, hard question, fact-check row) the editor acted on or left. */
    resolutions: z.array(Resolution).max(120).default([]),
  })
  .strict();
export type EditorOutput = z.output<typeof EditorOutput>;

const METHOD = `
What to fix (only fixes that need no new facts):
- House style: plain words and no adjectives that judge. Replace every judging word listed in the prompt, and any others like them (${JUDGING_WORDS.slice(0, 8).join(', ')}, ...), with neutral wording or cut it. Words inside a quotation are reported speech and stay as they are.
- Attribution: anything alleged or disputed must read that way ("prosecutors allege", "the company denies"), and its confidence label must say so too.
- Fact-check results: apply every confidence downgrade. Cut or narrow text the fact-checker marked unsupported, uncited or partially supported so that what remains is supported; never patch it with new facts. Where a fix needs new research, leave the text out or reduce it to what the sources support, and say so in notes.
- Red-team flags that need no new facts: reword loaded language, reorder steps to spread each side's strongest facts (renumber order 1..n to match position), and restore context that the cited evidence already contains.
- Plain language: rewrite every item the validator flags for reading level (and any other main-path text a 12-year-old would stumble on) into short sentences and everyday words, keeping exactly the same facts and attributions; move exact legal wording into an existing depth layer rather than adding new text. Each fact-vote statement (micro_poll.statement) is one plain statement of about 15 words or fewer that does not restate the main question, presume guilt or name a private accused person.
- Schema and validator: fix every validator error listed in the prompt. Bodies are 1 to 3 short sentences, headlines one line, every step and starting fact cites at least one source, every evidence quote's source is cited by its item, and every cited source is in sources.
- Quote layers: a quote layer holds words its speaker said or wrote, with speaker as only a name and role. When a quote layer is a reporter's paraphrase or a publication's narration, or its speaker field carries a note, turn it into a context layer (same source_id in source_ids) or fix the speaker field; when it starts after a cut negation or qualifier ("no", "not", "never"), remove it. Never edit the text inside a quote.
- The question: never change it, except in a new case to answer a flag about its wording (loaded or one-sided framing, hard words, or one that puts the burden of proof on the wrong side), keeping the same subject and the Disagree to Agree scale.
- Online takes: keep each take's summary in its own side's voice (that is the point), but apply the same rules to its checks as to steps: plain notes, verdicts the cited sources support, and the same standard for every lens.
- Keep ids stable. Keep every evidence quote and source field exactly as it is: they were checked against the stored sources.
- Never add a fact, a source, a quote, a number or a name. Removing or narrowing is allowed; adding is not. Everything you change is fact-checked again after you, and a change that adds an unsupported fact is reverted.
- Apply the fixes for every side the same way: when a flag for one side needs new facts you do not have, say so in its resolution rather than leave the two sides' fixes uneven without comment.

- Live updates: items listed as unchanged are as the live version has them, which was edited and approved before. Leave them exactly as they are unless a validator error or a fact-check result on that item requires a change; edit the new and changed items.

notes: one line per change you made (what and where), then one line per thing you could not fix without new facts, for the admin.
resolutions: one per critique item you acted on or considered: ref is the red-team flag id, hard question id or "fact_check:<target>"; action "changed" (you changed the case for it), "not_changed" (say why), "needs_admin" (it needs new facts or is the admin's call) or "not_applicable".`;

const editor: AgentSpec<EditorInput, EditorOutput> = {
  name: 'editor',
  tools: 'none',
  tier: 'strong',
  maxTurns: 6,
  system: (ctx) =>
    systemPrompt(
      {
        role: 'the editor (agent 7 of 7)',
        job: 'apply the critics\' fixes that need no new facts, enforce house style (plain words, no adjectives that judge), and return a final case that passes schema validation.',
        method: METHOD,
        tools: 'none',
      },
      ctx,
    ),
  prompt: (input) => {
    const draft = draftOnly(input.draft);
    const parts = ['Edit this draft into the final case.', block('draft', draft), 'Critiques from the last round:', block('critiques', input.critiques)];
    if (input.openIssues.length) parts.push('Open issues that go to the admin (fix any that need no new facts):', block('open_issues', input.openIssues));
    parts.push(input.newCase ? 'This is a new case.' : 'This is a revision or live update of an existing case: never change the question.');
    if (input.unchanged?.length) {
      parts.push('Live update. These items are unchanged from the live version; leave them as they are unless a validator error or a fact-check result on them requires a change:', block('unchanged', input.unchanged));
    }
    const words = judgingWordReport(draft);
    parts.push(
      words.length ? 'Judging words found in user-facing copy (replace them):' : 'No listed judging words were found in user-facing copy.',
      ...(words.length ? [block('judging_words', words)] : []),
    );
    const { errors, warnings } = validationReport(draft);
    if (errors.length) parts.push('Validator errors (must be fixed):', block('validator_errors', errors));
    if (warnings.length) parts.push('Validator warnings (fix where possible):', block('validator_warnings', warnings));
    const balance = balanceWarnings(draft);
    if (balance.length) parts.push('Balance warnings:', block('balance', balance));
    parts.push('Return the final case and your notes.');
    return parts.join('\n\n');
  },
  output: EditorOutput,
};

export default editor;
