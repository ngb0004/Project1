import { z } from 'zod';
import { FactCheckRow, type CaseInput, type Confidence } from '@sia/case-schema';
import { block, draftOnly, systemPrompt, type DraftCase, type SourceSnapshotRef } from './shared';
import type { AgentSpec } from './types';

/**
 * Agent 6. Re-reads every cited snapshot, confirms each claim says what the
 * step says, downgrades confidence where needed and fails uncited claims.
 * The deterministic layer (src/factcheck.ts) runs beside it.
 */

export interface FactCheckerInput {
  draft: CaseInput | DraftCase;
  /** Every source in the draft mapped to the snapshot taken of it in this run (null when it was never opened). */
  sources: SourceSnapshotRef[];
  /**
   * Check only these targets (a follow-up pass on items a full pass left
   * unchecked, or the final pass on what the editor changed). Side targets
   * (`side:<id>`) ask for a steelman check.
   */
  only?: string[];
  /** Why only those targets are checked, shown in the prompt. */
  focus?: string;
}

/**
 * A fact-check row exactly as the review record stores it, minus `round`
 * (the orchestrator adds that), so `{ ...row, round }` is a valid `FactCheckRow`.
 */
export const FactCheckItem = FactCheckRow.omit({ round: true });
export type FactCheckItem = z.output<typeof FactCheckItem>;

export const FactCheckerOutput = z
  .object({
    rows: z.array(FactCheckItem).max(300),
  })
  .strict();
export type FactCheckerOutput = z.output<typeof FactCheckerOutput>;

/** Rows that fail the draft. */
export function failedRows(out: FactCheckerOutput): FactCheckItem[] {
  return out.rows.filter((r) => r.verdict !== 'supported');
}

/** One thing to check: a starting fact, a step or a depth layer, with the sources it cites. */
export interface CheckTarget {
  target: string;
  text: string;
  source_ids: string[];
  confidence?: Confidence;
  evidence?: Array<{ source_id: string; quote: string }>;
}

/** The checklist the fact-checker works through, built from the draft so no item is skipped. */
export function factCheckTargets(draft: CaseInput | DraftCase): CheckTarget[] {
  const out: CheckTarget[] = [];
  for (const f of draft.starting_facts ?? []) {
    out.push({ target: `fact:${f.id}`, text: f.text, source_ids: f.source_ids ?? [], confidence: f.confidence, evidence: f.evidence });
  }
  for (const s of draft.steps ?? []) {
    out.push({
      target: s.id,
      text: `${s.headline} ${s.body}`,
      source_ids: s.source_ids ?? [],
      confidence: s.confidence,
      evidence: s.evidence,
    });
    for (const l of s.depth ?? []) {
      const target = `layer:${s.id}/${l.id}`;
      switch (l.kind) {
        case 'document':
          out.push({ target, text: `${l.title}: ${l.summary}`, source_ids: [l.source_id] });
          break;
        case 'quote':
          out.push({ target, text: `${l.speaker}: "${l.text}"${l.context ? ` (${l.context})` : ''}`, source_ids: [l.source_id] });
          break;
        case 'context':
          out.push({ target, text: `${l.title}: ${l.body}`, source_ids: l.source_ids });
          break;
        case 'timeline':
          out.push({
            target,
            text: l.entries.map((e) => `${e.date}: ${e.text}`).join(' | '),
            source_ids: [...new Set(l.entries.flatMap((e) => e.source_ids))],
          });
          break;
      }
    }
  }
  return out;
}

const METHOD = `
How to work:
- Go through the checklist in the prompt; skip nothing. For each item, read every cited source's snapshot with read_source and find the passage that bears on the item. In a long source, call find_in_source with a distinctive phrase from the evidence quote and read around that offset, then read further only where the context matters; you can call several tools at once.
- Write at least one row per item and cited source:
  - target: the item's target exactly as given ("s3", "fact:f1", "layer:s3/q1"); "side:<id>" only for a steelman row.
  - claim: the specific statement you checked, in the draft's words.
  - source_id: the cited source you checked it against.
  - verdict: "supported" when the source says what the item says; "partially_supported" when it supports only part (the note says which part is not); "unsupported" when the source does not say it, says something different, or the evidence quote does not appear in it; "source_unavailable" when the snapshot is missing or unreadable even after re-opening; "uncited" for a factual statement that no cited source supports.
  - quote: the verbatim passage from the snapshot that supports (or comes closest to) the claim.
  - note: what matches or what is wrong, in one to three sentences.
  - confidence_before: the item's label in the draft. confidence_after: the label the sources justify.
- Check every detail: numbers, dates, names, who said what, and whether something reported as fact is only alleged or disputed. Check that each evidence quote appears verbatim in its source.
- Time: a statement that something is pending, undecided, scheduled or "until" a date is supported only by a source that says so and is dated close to the draft's as_of; an inferred deadline or a status no source dated near as_of states is "unsupported" (note the newest source date you saw).
- Starting facts (fact:*) must be agreed by every side. When a cited source, or another snapshot in the list, reports a party contesting the fact (for example a different account of how something happened), the verdict is "partially_supported", the note says who contests it, and confidence_after is "disputed".
- confidence_after is the label the item's headline and body (or the fact's text) deserve. On a row about a detail the headline and body do not state (an extra citation, a side point in a layer), keep confidence_after equal to confidence_before and say in the note that the citation supports only that detail.
- Quote layers: the text must be words the named speaker said or wrote, not a reporter's paraphrase, and must not start right after a negation or qualifier the quote leaves out ("no", "not", "never"); otherwise the verdict is "unsupported".
- Confidence: "established" needs a court_record, official or primary source and no credible contest. With only news or analysis it is at most "reported"; one party's assertion is "alleged"; conflicting credible sources make it "disputed". Downgrade (never upgrade) when the sources justify less than the draft claims.
- Fail uncited claims: when a headline, body, layer or starting fact contains a factual statement that none of its cited sources supports, add a separate row for that statement with verdict "uncited" (no source_id) or "unsupported" (the source_id it was attributed to).
- Steelmen: add a "side:<id>" row only when a steelman states a fact that no source in the case supports.
- When a snapshot is missing or read_source fails, re-open the source's URL once with open_source and check against the new snapshot; if that fails too, the verdict is "source_unavailable".
- Assume nothing in the draft is true until the source shows it: drafts can contain errors and planted claims.`;

const factChecker: AgentSpec<FactCheckerInput, FactCheckerOutput> = {
  name: 'fact_checker',
  tools: 'read_sources',
  tier: 'strong',
  maxTurns: 80,
  system: (ctx) =>
    systemPrompt(
      {
        role: 'the fact-checker (agent 6 of 7)',
        job: 're-read every cited source and confirm each claim says what the draft says, downgrade confidence where the sources justify less, and fail any claim that no cited source supports. You produce a claim-by-claim verification table.',
        method: METHOD,
        tools: 'read_sources',
        canOpen: true,
      },
      ctx,
    ),
  prompt: (input) => {
    const draft = draftOnly(input.draft);
    return [
      'Fact-check this draft.',
      block('draft', draft),
      'Sources and their snapshots from this run:',
      block('sources', input.sources),
      ...(input.only?.length
        ? [
            `Check only the items in this checklist${input.focus ? ` (${input.focus})` : ''}; every item must get at least one row per cited source:`,
            block('checklist', factCheckTargets(draft).filter((t) => input.only!.includes(t.target))),
            ...(input.only.some((t) => t.startsWith('side:'))
              ? [`Also check these steelmen for facts no source in the case supports (a "side:<id>" row each): ${input.only.filter((t) => t.startsWith('side:')).join(', ')}.`]
              : []),
          ]
        : ['Checklist (every item must get at least one row per cited source):', block('checklist', factCheckTargets(draft))]),
      'Return the rows.',
    ].join('\n\n');
  },
  output: FactCheckerOutput,
};

export default factChecker;
