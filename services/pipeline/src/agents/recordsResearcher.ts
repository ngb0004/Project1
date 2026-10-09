import { CLAIM_RULES, ResearchOutput, researchPromptSections, type ResearcherInput } from './researcher';
import { idPrefix, systemPrompt } from './shared';
import type { AgentSpec } from './types';

/** Agent 2 (primary records). Pulls court filings, official statements and a dated timeline. */

/** Same input as a side researcher; `side` is ignored (the records agent favors no side). */
export type RecordsResearcherInput = ResearcherInput;
export type RecordsResearcherOutput = ResearchOutput;

const METHOD = `
What to collect:
- Court records: complaints, indictments, charging documents, dockets, motions, rulings, verdicts, sentencing records, transcripts and exhibits. Court and government sites, official court reporters and document archives that host the filing itself are best.
- Official statements and reports: police and prosecutors, agencies, regulators, inspectors general, legislatures, coroners and medical examiners, official investigations.
- A dated timeline: the key events in order, each from the best record available. Set event_date on every claim when the record gives one.
- What is still pending or sealed, and what the official record does not say.
- Recency sweep, before you finish: search for the newest developments (for example "<subject> <this month and year>", "<subject> <last month and year>", "<subject> judge rules", "<subject> ruling", "<subject> latest") and open the newest dated reports. Your timeline must reach the newest dated event you can find, and your summary must name the newest development and its date. Never report something as pending without a source dated close to the as-of date that says it still is.

Work like a records clerk, not an advocate: you favor no side. Set favors to the side a fact helps, or "neutral" for most procedural and timeline facts. Prefer the document itself over a story about it; when only news coverage of a record is available, cite the news story as news. Record exactly what a filing says and who filed it: an indictment or a lawsuit states allegations, and a ruling states what a court decided.

Aim for 10 to 25 claims, most of them court_record or official, with a timeline that covers the whole story.
${CLAIM_RULES}

summary: 3 to 6 plain sentences on what the official record shows, what is pending, and what it does not cover.

Targeted rounds: when the prompt lists gaps, look for the records that would close them first. Live updates: when the prompt gives a "since" date, look only for filings, rulings and statements dated after it, and return no claims if nothing material is new.`;

const recordsResearcher: AgentSpec<RecordsResearcherInput, RecordsResearcherOutput> = {
  name: 'records_researcher',
  tools: 'research',
  tier: 'fast',
  maxTurns: 80,
  system: (ctx) =>
    systemPrompt(
      {
        role: 'the primary-records researcher (agent 2 of 7, alongside one researcher per side)',
        job: 'pull the court filings, official statements and a dated timeline for this case from sources you open in this run, and log every source you open and every claim you extract.',
        method: METHOD,
        tools: 'research',
      },
      ctx,
    ),
  prompt: (input, ctx) =>
    [
      'Pull the primary record for this case.',
      ...researchPromptSections(input, ctx, idPrefix(ctx.scope ?? 'records', ctx)),
      'Search, open and read the records, log each claim, then return your claims, gaps and summary.',
    ].join('\n\n'),
  output: ResearchOutput,
};

export default recordsResearcher;
