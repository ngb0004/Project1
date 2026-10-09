import { z } from 'zod';
import { Confidence, HttpUrl, Impact, LocalId, PartialIsoDate, SourceType, Text } from '@sia/case-schema';
import type { Outline } from './scoper';
import { Gap, block, idPrefix, resolveSide, systemPrompt, type GapInput, type SideRef } from './shared';
import type { AgentContext, AgentSpec } from './types';

/** Agent 2 (one per side). Builds the strongest honest case for one side from sources opened in this run. */

export interface ResearcherInput {
  outline: Outline;
  /** The side this researcher works for (an id from the outline, or the side itself). */
  side?: SideRef;
  /** Targeted research: gaps the critics found in the last draft. */
  gaps?: GapInput[];
  /** Live updates: only developments dated after this `YYYY-MM-DD`. */
  sinceAsOf?: string;
  /** Live updates: facts the live case already states, so they are not re-reported. */
  known_facts?: string[];
}

/** One fact taken from one opened source, with the verbatim quote that supports it. */
export const ResearchClaim = z
  .object({
    id: LocalId,
    /** One factual statement in plain words, attributed when it is someone's assertion. */
    text: Text(600),
    /** Verbatim span from the snapshot. */
    quote: Text(1500),
    snapshot_id: z.string().min(1).max(100),
    /** The URL that was opened (as open_source reported it). */
    url: HttpUrl,
    source_title: Text(300),
    publisher: Text(200),
    /** Publication date of the source, or null when the page shows none. */
    source_date: PartialIsoDate.nullable(),
    source_type: SourceType,
    /** When the event in the claim happened, or null. */
    event_date: PartialIsoDate.nullable(),
    confidence: Confidence,
    /** The side this fact helps, or "neutral". */
    favors: LocalId,
    impact: Impact,
  })
  .strict();
export type ResearchClaim = z.output<typeof ResearchClaim>;

export const ResearchOutput = z
  .object({
    claims: z.array(ResearchClaim).max(60),
    gaps: z.array(Gap).max(30),
    summary: Text(3000),
  })
  .strict();
export type ResearchOutput = z.output<typeof ResearchOutput>;
export type ResearcherOutput = ResearchOutput;

/** Claim rules shared by the side researchers and the records researcher. */
export const CLAIM_RULES = `
Each claim:
- id: "<prefix>-<n>" using the claim id prefix given in the prompt (for example "council-responsible-r0-3").
- text: one factual statement in plain words, one or two sentences. Attribute anything that is someone's assertion ("Police said ...", "The lawsuit alleges ..."). The text says only what the quote supports.
- quote: the verbatim span from the snapshot that supports the text.
- snapshot_id and url: from the open_source call for that page.
- source_title, publisher, source_date: from the page itself. source_date is the publication date (YYYY, YYYY-MM or YYYY-MM-DD), or null when the page shows none.
- source_type: court_record (filings, dockets, indictments, rulings, verdicts, transcripts, exhibits); official (government agencies, police, prosecutors, regulators, official reports and statements); primary (first-hand material from the people or organizations involved: their own statements, documents, data, video); news (reporting by news organizations); analysis (opinion, commentary, explainers, advocacy).
- event_date: when the event in the claim happened (same formats), or null.
- confidence: "established" only when a court record, official or primary source shows it and nothing credible contests it; "reported" when the support is news or analysis only; "alleged" when it rests on one party's assertion (a charge, a lawsuit, an accusation, a denial); "disputed" when credible sources contradict each other.
- favors: the id of the side this fact helps, or "neutral".
- impact: low, medium or high: how much the fact would move a fair-minded reader on the question.

gaps: what you looked for and could not find or verify, each with a concrete search_hint. Set blocking only when the case cannot be told fairly without it.`;

const METHOD = `
"Strongest honest case" means:
- Find the facts this side's most careful advocates rely on, in their most accurate form, from the best source available: court records, official documents and statements, and first-hand records first; then major news outlets; commentary last.
- Get every detail right: numbers, dates, the names of public officials and institutions, who said what and when.
- Also log the facts that cut against your side, with favors set to the side they help. An honest advocate knows the weak points; the dive needs them, and the red team will look for them.
- A claim says only what its quote supports. Never stretch a quote, and never fill a gap from memory.

Aim for 8 to 20 claims from at least 4 different publishers, including at least 2 that cut against your side when they exist. Prefer fewer solid claims over many thin ones, and avoid paywalled pages.
${CLAIM_RULES}

summary: 3 to 6 plain sentences on the state of the evidence for your side, including its weakest points.

Targeted rounds: when the prompt lists gaps, research those first and return claims that close them (or gaps saying why they could not be closed). Live updates: when the prompt gives a "since" date, look only for developments dated after it. Return no claims if nothing material is new, and say so in summary.`;

/** The prompt sections every researcher shares: outline, gaps, update window. */
export function researchPromptSections(input: ResearcherInput, ctx: AgentContext, prefix: string): string[] {
  const parts = [block('outline', input.outline), `Claim id prefix: "${prefix}". Number claims ${prefix}-1, ${prefix}-2, and so on.`];
  if (input.gaps?.length) {
    parts.push('Targeted round. The critics found these gaps in the last draft; research them first:', block('gaps', input.gaps));
  }
  if (input.sinceAsOf) {
    parts.push(
      `Live update. The published case is current as of ${input.sinceAsOf}. Look only for developments dated after ${input.sinceAsOf} and up to ${ctx.asOf}. ` +
        'If nothing material is new, return an empty claims list and say so in summary.',
    );
    if (input.known_facts?.length) parts.push('The live case already states these facts; do not re-report them:', block('known_facts', input.known_facts));
  }
  return parts;
}

const researcher: AgentSpec<ResearcherInput, ResearcherOutput> = {
  name: 'researcher',
  tools: 'research',
  tier: 'fast',
  maxTurns: 80,
  system: (ctx) =>
    systemPrompt(
      {
        role: 'a side researcher (agent 2 of 7); one researcher works for each side of the question',
        job: 'build the strongest honest case for your side from sources you open in this run, and log every source you open and every claim you extract.',
        method: METHOD,
        tools: 'research',
      },
      ctx,
    ),
  prompt: (input, ctx) => {
    const side = resolveSide(input.side ?? ctx.scope, input.outline.sides);
    const prefix = idPrefix(side?.id ?? 'side', ctx);
    const who = side
      ? `You research for the side "${side.label}" (id "${side.id}").${side.position ? ` Its position: ${side.position}` : ''}`
      : 'No side was named: research the strongest facts on every side evenly.';
    return [who, ...researchPromptSections(input, ctx, prefix), 'Search, open and read sources, log each claim, then return your claims, gaps and summary.'].join(
      '\n\n',
    );
  },
  output: ResearchOutput,
};

export default researcher;
