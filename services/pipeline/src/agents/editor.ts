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
import type { AgentSpec } from './types';

/** Agent 7. Applies fixes that need no new facts, enforces house style, and returns a schema-valid case. */

export interface EditorInput {
  draft: CaseInput | DraftCase;
  /** What the critics said about the last draft. */
  critiques: Critiques;
  /** What is still unresolved after the loop; these go to the admin. */
  openIssues: OpenIssueLike[];
}

export const EditorOutput = z
  .object({
    case: DraftCase,
    /** What the editor changed, and what it left for the admin. */
    notes: z.array(z.string().min(1).max(1000)).max(60),
  })
  .strict();
export type EditorOutput = z.output<typeof EditorOutput>;

const METHOD = `
What to fix (only fixes that need no new facts):
- House style: plain words and no adjectives that judge. Replace every judging word listed in the prompt, and any others like them (${JUDGING_WORDS.slice(0, 8).join(', ')}, ...), with neutral wording or cut it. Words inside a quotation are reported speech and stay as they are.
- Attribution: anything alleged or disputed must read that way ("prosecutors allege", "the company denies"), and its confidence label must say so too.
- Fact-check results: apply every confidence downgrade. Cut or narrow text the fact-checker marked unsupported, uncited or partially supported so that what remains is supported; never patch it with new facts. Where a fix needs new research, leave the text out or reduce it to what the sources support, and say so in notes.
- Red-team flags that need no new facts: reword loaded language, reorder steps to spread each side's strongest facts (renumber order 1..n to match position), and restore context that the cited evidence already contains.
- Schema and validator: fix every validator error listed in the prompt. Bodies are 2 to 4 sentences, headlines one line, every step and starting fact cites at least one source, every evidence quote's source is cited by its item, and every cited source is in sources.
- Keep ids stable. Keep every evidence quote, quote layer and source field exactly as it is: they were checked against the stored sources.
- Never add a fact, a source, a quote, a number or a name. Removing or narrowing is allowed; adding is not.

notes: one line per change you made (what and where), then one line per thing you could not fix without new facts, for the admin.`;

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
