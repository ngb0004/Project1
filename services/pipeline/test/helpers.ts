import type { DrafterInput, DrafterOutput } from '../src/agents/drafter';
import type { FactCheckerInput, FactCheckerOutput, FactCheckItem } from '../src/agents/factChecker';
import type { Outline } from '../src/agents/scoper';
import type { ResearchClaim, ResearchOutput, ResearcherInput } from '../src/agents/researcher';
import type { EditorInput, EditorOutput } from '../src/agents/editor';
import type { HardQuestionsOutput } from '../src/agents/hardQuestions';
import type { RedTeamOutput } from '../src/agents/redTeam';
import type { DraftCase } from '../src/agents/shared';
import type { AgentContext } from '../src/agents/types';
import type { FetchedSource } from '../src/research/fetch';
import { MemoryResearchLog } from '../src/research/log';
import { SourceStore } from '../src/research/store';
import { matchQuote } from '../src/research/text';
import type { ResearchTools } from '../src/research/tools';
import type { FakeScript } from '../src/runner/fake';

/**
 * A small fictional web for scripted pipeline runs: a county council, a water
 * main, a state grant. Every page is long enough to count as opened. The fake
 * agents below open these pages through ResearchTools, so every "open" goes
 * through the real source store and research log.
 */

export const AS_OF = '2026-10-01';

export const SIDE_A = { id: 'council-responsible', label: 'Council responsible', position: 'The council delayed a repair it knew was needed.' };
export const SIDE_B = { id: 'council-not-responsible', label: 'Council not responsible', position: 'State grant cuts left the council without money for the repair.' };

export interface FakePage {
  title: string;
  text: string;
  status?: number;
  contentType?: string;
}

const pad = (s: string) => `${s}\n\nThis page is part of a fictional test fixture used by the pipeline tests. It describes no real place or person.`;

export const PAGES: Record<string, FakePage> = {
  'https://records.example.gov/council/minutes-2025-06-03': {
    title: 'Maple County Council minutes, June 3, 2025',
    text: pad(
      'Item 7. Water main replacement. Staff reported that the Elm Street water main was rated "poor" in the 2024 inspection. ' +
        'The council voted 5-4 to postpone the replacement project to the 2027 budget. Councilmember Ortiz said the county could not fund the work this year.',
    ),
  },
  'https://records.example.gov/inspections/elm-street-2024': {
    title: 'Elm Street water main inspection report, 2024',
    text: pad(
      'Summary: the Elm Street main has 14 documented leaks since 2020. Condition rating: poor. ' +
        'Recommendation: replace the main within 24 months to avoid a failure.',
    ),
  },
  'https://state.example.gov/grants/water-2025': {
    title: 'State water infrastructure grants, 2025 allocations',
    text: pad(
      'The state reduced local water infrastructure grants by 40 percent for the 2025 fiscal year. ' +
        "Maple County's allocation fell from $2.1 million to $1.26 million.",
    ),
  },
  'https://news.example.com/2025/09/elm-street-main-breaks': {
    title: 'Elm Street water main breaks, closing three blocks',
    text: pad(
      'The Elm Street water main broke on September 12, 2025, closing three blocks for four days. ' +
        'County officials said the break was in the section the council had postponed replacing. ' +
        '“We made the best choice we could with the money we had,” council chair Dana Price said.',
    ),
  },
  'https://news.example.com/2025/09/state-cuts-analysis': {
    title: 'How state grant cuts squeezed county budgets',
    text: pad(
      'Analysts at the Civic Budget Project said the state cuts forced counties to defer maintenance. ' +
        'Maple County deferred two of its five planned water projects in 2025.',
    ),
  },
  'https://news.example.com/2026/10/new-audit': {
    title: 'Audit finds county spent repair funds elsewhere',
    text: pad('An audit released on October 5, 2026 found that Maple County moved $400,000 of water repair funds to road paving in 2025.'),
  },
  'https://news.example.com/2026/10/council-restores-fund': {
    title: 'Council restores water repair money after audit',
    text: pad(
      'On October 11, 2026 the Maple County Council voted 7-2 to move $400,000 from road paving back to the water repair fund. ' +
        'Council chair Dana Price said the vote answers the audit.',
    ),
  },
  'https://news.example.com/2026/10/state-grants-restored': {
    title: 'State restores part of the water grant cut',
    text: pad('On October 13, 2026 the state restored 20 percent of the 2025 cut to local water infrastructure grants, the budget office said.'),
  },
  'https://news.example.com/paywalled': { title: 'Subscribe', text: 'Subscribe to read.', status: 200 },
  'https://news.example.com/gone': { title: 'Not found', text: '', status: 404 },
};

export const URLS = {
  minutes: 'https://records.example.gov/council/minutes-2025-06-03',
  inspection: 'https://records.example.gov/inspections/elm-street-2024',
  grants: 'https://state.example.gov/grants/water-2025',
  breakNews: 'https://news.example.com/2025/09/elm-street-main-breaks',
  analysis: 'https://news.example.com/2025/09/state-cuts-analysis',
  audit: 'https://news.example.com/2026/10/new-audit',
  restore: 'https://news.example.com/2026/10/council-restores-fund',
  grantsRestored: 'https://news.example.com/2026/10/state-grants-restored',
} as const;

/** A fetcher over PAGES (no network). Unknown URLs are a 404. */
export function fakeFetcher(pages: Record<string, FakePage> = PAGES) {
  const calls: string[] = [];
  const fetcher = async (url: string): Promise<FetchedSource> => {
    calls.push(url);
    const p = pages[url];
    if (!p) return { url, finalUrl: url, status: 404, contentType: 'text/html', title: '', text: '', bytes: 0, error: 'HTTP 404' };
    const status = p.status ?? 200;
    return {
      url,
      finalUrl: url,
      status,
      contentType: p.contentType ?? 'text/html; charset=utf-8',
      title: p.title,
      text: status === 200 ? p.text : '',
      bytes: p.text.length,
      ...(status === 200 ? {} : { error: `HTTP ${status}` }),
    };
  };
  return Object.assign(fetcher, { calls });
}

export function memoryStore(pages: Record<string, FakePage> = PAGES) {
  const log = new MemoryResearchLog();
  const fetcher = fakeFetcher(pages);
  const store = new SourceStore({ log, fetcher });
  return { log, store, fetcher };
}

// ---------------------------------------------------------------------------
// Scripted agents
// ---------------------------------------------------------------------------

export function outline(slug = 'maple-county-water-main'): Outline {
  return {
    slug,
    title: 'The Elm Street water main break',
    question: {
      prompt: 'How responsible is the Maple County Council for the Elm Street water main break?',
      left_label: 'Not responsible',
      right_label: 'Fully responsible',
    },
    sides: [SIDE_A, SIDE_B],
    must_answer: ['When did the council learn the main was in poor condition?', 'How much grant money did the county lose?'],
    content_warning: null,
    timeline: [],
    notes: 'Fictional fixture.',
  };
}

/** The scoper opens one page (as a real scoper would) and returns the outline. */
export function scoperScript(slug?: string): FakeScript {
  return async (_input: unknown, _ctx: AgentContext, tools: ResearchTools) => {
    await tools.logQuery('Maple County Elm Street water main', [{ title: 'Breaks', url: URLS.breakNews }]);
    await tools.openSource(URLS.breakNews);
    return outline(slug);
  };
}

interface ClaimSpec {
  url: string;
  quote: string;
  text: string;
  type: ResearchClaim['source_type'];
  favors: string;
  impact?: ResearchClaim['impact'];
  confidence?: ResearchClaim['confidence'];
  date?: string | null;
}

/** A researcher that searches, opens each page through the tools, logs each claim and returns them. */
export function researcherScript(specs: ClaimSpec[], extra: Partial<Pick<ResearchOutput, 'gaps' | 'summary'>> = {}): FakeScript {
  return async (input: ResearcherInput, ctx: AgentContext, tools: ResearchTools): Promise<ResearchOutput> => {
    const side = typeof input.side === 'string' ? input.side : (input.side?.id ?? 'records');
    await tools.logQuery(`${side} elm street water main${input.gaps?.length ? ' (gaps)' : ''}`, specs.map((s) => ({ url: s.url })));
    const claims: ResearchClaim[] = [];
    for (const [i, s] of specs.entries()) {
      const opened = await tools.openSource(s.url);
      if (!opened.ok || !opened.snapshot) continue;
      await tools.logClaim(s.text, s.quote, opened.snapshot.id);
      claims.push({
        id: `${side}-r${ctx.round}-${i + 1}`,
        text: s.text,
        quote: s.quote,
        snapshot_id: opened.snapshot.id,
        url: s.url,
        source_title: opened.title || 'Untitled',
        publisher: new URL(s.url).hostname,
        source_date: s.date === undefined ? '2025' : s.date,
        source_type: s.type,
        event_date: null,
        confidence: s.confidence ?? (s.type === 'news' || s.type === 'analysis' ? 'reported' : 'established'),
        favors: s.favors,
        impact: s.impact ?? 'medium',
      });
    }
    return { claims, gaps: extra.gaps ?? [], summary: extra.summary ?? `${claims.length} claims for ${side}.` };
  };
}

export const SIDE_A_CLAIMS: ClaimSpec[] = [
  { url: URLS.minutes, quote: 'The council voted 5-4 to postpone the replacement project to the 2027 budget.', text: 'The council voted 5-4 in June 2025 to postpone the replacement.', type: 'official', favors: SIDE_A.id, impact: 'high' },
  { url: URLS.inspection, quote: 'Condition rating: poor.', text: 'A 2024 inspection rated the main poor.', type: 'official', favors: SIDE_A.id },
];
export const SIDE_B_CLAIMS: ClaimSpec[] = [
  { url: URLS.grants, quote: 'The state reduced local water infrastructure grants by 40 percent for the 2025 fiscal year.', text: 'The state cut water grants by 40 percent in 2025.', type: 'official', favors: SIDE_B.id, impact: 'high' },
  { url: URLS.analysis, quote: 'Maple County deferred two of its five planned water projects in 2025.', text: 'The county deferred two of five water projects in 2025.', type: 'analysis', favors: SIDE_B.id },
];
export const RECORDS_CLAIMS: ClaimSpec[] = [
  { url: URLS.breakNews, quote: 'The Elm Street water main broke on September 12, 2025, closing three blocks for four days.', text: 'The main broke on September 12, 2025.', type: 'news', favors: 'neutral' },
];

/** Evidence for a claim (its verbatim quote) with the source id the drafter gives its URL. */
const sourceIdFor = (url: string) => `src-${new URL(url).pathname.split('/').filter(Boolean).pop()!.replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;

export interface DraftOptions {
  /** A step whose evidence quote is not in its source: a fabricated claim. */
  plantFabrication?: boolean;
  /** Text added to every resolution, to prove red teams never see it. */
  reasoningMarker?: string;
}

export const FABRICATED_STEP_ID = 's-planted';
export const FABRICATED_QUOTE = 'Council chair Dana Price admitted the council ignored three written warnings from engineers.';

/** Builds a schema-valid draft from the claims it is given, the way the drafter is told to. */
export function buildDraft(input: DrafterInput, ctx: AgentContext, opts: DraftOptions = {}): DrafterOutput {
  const base = input.base;
  const claims = input.claims;
  const sources = new Map<string, DraftCase['sources'][number]>();
  for (const c of claims) {
    const id = sourceIdFor(c.url);
    if (!sources.has(id)) {
      sources.set(id, {
        id,
        title: c.source_title,
        publisher: c.publisher,
        url: c.url,
        date: c.source_date ?? '2025',
        type: c.source_type,
        accessed_at: `${ctx.asOf}T00:00:00Z`,
      });
    }
  }
  // A revision keeps the base version's sources, steps and facts and adds new claims as steps.
  const baseSteps = (base?.steps ?? []) as DraftCase['steps'];
  for (const s of base?.sources ?? []) if (!sources.has(s.id)) sources.set(s.id, { ...s });
  const conf = (c: ResearchClaim) => (c.source_type === 'news' || c.source_type === 'analysis' ? 'reported' : c.confidence) as DraftCase['steps'][number]['confidence'];
  const steps: DraftCase['steps'] = [
    ...baseSteps.map((s) => ({ ...s })),
    ...claims
      .filter((c) => c.favors !== 'neutral' || claims.length < 3)
      .map((c, i) => ({
        id: `s${baseSteps.length + i + 1}`,
        order: 0,
        headline: c.text.slice(0, 150),
        body: `${c.text} The source is ${c.publisher}.`,
        depth: [],
        favors: c.favors,
        impact: c.impact,
        source_ids: [sourceIdFor(c.url)],
        confidence: conf(c),
        evidence: [{ source_id: sourceIdFor(c.url), quote: c.quote }],
        micro_poll: { prompt: 'Does this change your position?', re_ask_slider: true as const },
      })),
  ];
  if (opts.plantFabrication) {
    const first = claims.find((c) => c.url === URLS.breakNews) ?? claims[0]!;
    steps.push({
      id: FABRICATED_STEP_ID,
      order: 0,
      headline: 'The council chair admitted ignoring engineer warnings.',
      body: 'The council chair admitted the council ignored three written warnings. The admission came after the break.',
      depth: [],
      favors: SIDE_A.id,
      impact: 'high',
      source_ids: [sourceIdFor(first.url)],
      confidence: 'reported',
      evidence: [{ source_id: sourceIdFor(first.url), quote: FABRICATED_QUOTE }],
      micro_poll: { prompt: 'Does this change your position?', re_ask_slider: true },
    });
  }
  steps.forEach((s, i) => (s.order = i + 1));
  const factClaim = claims.find((c) => c.favors === 'neutral') ?? claims[0]!;
  const draft: DraftCase = {
    schema_version: 1,
    id: base?.id ?? input.outline.slug,
    slug: input.outline.slug,
    title: input.outline.title,
    status: 'draft',
    version: 1,
    as_of: ctx.asOf,
    question: {
      prompt: input.outline.question.prompt,
      scale: { type: 'slider', min: 0, max: 100, left_label: input.outline.question.left_label, right_label: input.outline.question.right_label },
    },
    starting_facts: (base?.starting_facts as DraftCase['starting_facts'] | undefined) ?? [
      {
        id: 'f1',
        text: factClaim.text,
        source_ids: [sourceIdFor(factClaim.url)],
        confidence: conf(factClaim),
        evidence: [{ source_id: sourceIdFor(factClaim.url), quote: factClaim.quote }],
      },
    ],
    steps,
    // A revision or update keeps the base steelmen; a first draft writes them from the outline.
    sides: (base?.sides as DraftCase['sides'] | undefined)?.map((s) => ({ ...s })) ??
      input.outline.sides.map((s) => ({ id: s.id, label: s.label, steelman: `Supporters argue: ${s.position}` })),
    open_questions: (base?.open_questions as string[] | undefined) ?? ['What did the council know before the June 2025 vote?'],
    sources: [...sources.values()],
  };
  const critiqueRefs = [
    ...(input.critique?.hard_questions ?? []).map((q) => q.id),
    ...(input.critique?.bias_reports ?? []).flatMap((r) => r.flags.map((f) => f.id)),
  ];
  return {
    case: draft,
    resolutions: critiqueRefs.map((ref) => ({ ref, action: 'changed' as const, resolution: `Addressed in the revision.${opts.reasoningMarker ? ` ${opts.reasoningMarker}` : ''}` })),
    research_gaps: [],
  };
}

export function drafterScript(opts: DraftOptions | ((input: DrafterInput, ctx: AgentContext) => DraftOptions) = {}): FakeScript {
  return (input: DrafterInput, ctx: AgentContext) => buildDraft(input, ctx, typeof opts === 'function' ? opts(input, ctx) : opts);
}

export const cleanHardQuestions: HardQuestionsOutput = {
  questions: [
    { id: 'hq-1', question: 'When did the council learn the main was in poor condition?', blocking: true, status: 'answered', resolution: 'Step s2 covers the 2024 inspection.', step_ids: [] },
  ],
  gaps: [],
  most_moving_fact: 'The 5-4 vote to postpone the replacement.',
};

export const blockingHardQuestions: HardQuestionsOutput = {
  questions: [
    { id: 'hq-r1-1', side_id: SIDE_B.id, question: 'Did the county have any other money it could have used for the repair?', blocking: true, status: 'open', step_ids: [] },
  ],
  gaps: [],
  most_moving_fact: 'Whether other funds were available.',
};

export const cleanRedTeam: RedTeamOutput = { summary: 'The draft is fair to this side.', flags: [{ id: 'rt-1', kind: 'loaded_wording', severity: 'low', note: 'Minor: "the source is" phrasing is repetitive.' }] };

export const highFlagRedTeam: RedTeamOutput = {
  summary: 'The order puts the strongest fact for the other side last.',
  flags: [{ id: 'rt-high-1', kind: 'order_effect', severity: 'high', note: 'Move the grant-cut step earlier so it is not buried.' }],
};

/**
 * A fact-checker that re-reads every cited snapshot through read_source and
 * fails any evidence quote it cannot find, the way the real one is told to.
 */
export function factCheckerScript(): FakeScript {
  return (input: FactCheckerInput, _ctx: AgentContext, tools: ResearchTools): FactCheckerOutput => {
    const rows: FactCheckItem[] = [];
    const bySource = new Map(input.sources.map((s) => [s.source_id, s]));
    const items = [
      ...input.draft.starting_facts.map((f) => ({ target: `fact:${f.id}`, text: f.text, evidence: f.evidence ?? [], confidence: f.confidence })),
      ...input.draft.steps.map((s) => ({ target: s.id, text: s.headline, evidence: s.evidence ?? [], confidence: s.confidence })),
    ];
    for (const item of items) {
      for (const e of item.evidence) {
        const ref = bySource.get(e.source_id);
        if (!ref?.snapshot_id) {
          rows.push({ target: item.target, claim: item.text, source_id: e.source_id, verdict: 'source_unavailable', note: 'No snapshot.' });
          continue;
        }
        const page = tools.readSource(ref.snapshot_id, 0, 20000);
        const found = matchQuote(e.quote, page.text).ok;
        rows.push({
          target: item.target,
          claim: item.text,
          source_id: e.source_id,
          verdict: found ? 'supported' : 'unsupported',
          ...(found ? { quote: e.quote } : {}),
          note: found ? 'The quote is in the source.' : 'The source does not say this.',
          confidence_before: item.confidence,
          confidence_after: item.confidence,
        });
      }
    }
    return { rows };
  };
}

/** An editor that changes nothing (or applies `edit`). */
export function editorScript(edit?: (draft: DraftCase) => DraftCase): FakeScript {
  return (input: EditorInput): EditorOutput => ({ case: edit ? edit(structuredClone(input.draft) as DraftCase) : (input.draft as DraftCase), notes: ['No changes needed.'], resolutions: [] });
}

/** The scripts for a run that is clean on the first round. */
export function cleanScripts(overrides: Record<string, FakeScript> = {}): Record<string, FakeScript> {
  return {
    scoper: scoperScript(),
    [`researcher#${SIDE_A.id}`]: researcherScript(SIDE_A_CLAIMS),
    [`researcher#${SIDE_B.id}`]: researcherScript(SIDE_B_CLAIMS),
    records_researcher: researcherScript(RECORDS_CLAIMS),
    drafter: drafterScript(),
    hard_questions: cleanHardQuestions,
    red_team: cleanRedTeam,
    fact_checker: factCheckerScript(),
    editor: editorScript(),
    ...overrides,
  };
}
