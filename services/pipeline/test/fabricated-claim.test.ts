import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateCase, weakerConfidence, type Confidence } from '@sia/case-schema';
import factCheckerSpec, { factCheckTargets, type FactCheckItem, type FactCheckerInput, type FactCheckerOutput } from '../src/agents/factChecker';
import type { DraftCase, SourceSnapshotRef } from '../src/agents/shared';
import type { AgentContext, AgentSpec } from '../src/agents/types';
import { checkCitations } from '../src/factcheck';
import { runCasePipeline, type PipelinePackage, type PipelineResult } from '../src/orchestrator';
import { MemoryResearchLog } from '../src/research/log';
import { SourceStore } from '../src/research/store';
import { ResearchTools } from '../src/research/tools';
import { ClaudeAgentRunner } from '../src/runner/claude';
import { FakeRunner, type FakeScript } from '../src/runner/fake';
import type { AgentRunResult, AgentRunner, RunOptions } from '../src/runner/types';
import { AS_OF, SIDE_A, SIDE_B, cleanHardQuestions, cleanRedTeam, editorScript, outline, researcherScript } from './helpers';

/**
 * Phase 4 acceptance: plant a fabricated claim in a draft whose sources were
 * really opened, and confirm the fact-check fails it.
 *
 * The sources are pages on a local HTTP server, fetched through the real
 * fetchSource (HTML through Readability, plain text as-is) into the real
 * SourceStore, so "opened in this run" means what it means in production.
 *
 * Three ways to plant a claim in step `s-planted`:
 *   1. fabricated_quote  the claim and an evidence quote the cited source does not contain
 *   2. unopened_source   the claim cites a source nobody opened in this run (a made-up URL)
 *   3. misused_quote     a real quote from the cited source that does not support the claim
 *
 * The deterministic layer (checkCitations) must fail 1 and 2 on its own, and the
 * orchestrator must never let them through even when the LLM fact-checker misses
 * them. Variant 3 passes the deterministic layer by construction; only the LLM
 * fact-checker can catch it. The live tests (PIPELINE_LIVE=1) run the real
 * fact-checker agent through the Agent SDK on these drafts.
 */

// ---------------------------------------------------------------------------
// A small fictional web on a local server
// ---------------------------------------------------------------------------

interface SitePage {
  title: string;
  paragraphs: string[];
  /** Served as text/plain instead of HTML. */
  plain?: boolean;
}

const SITE: Record<string, SitePage> = {
  '/council/minutes-2025-06-03': {
    title: 'Maple County Council minutes, June 3, 2025',
    paragraphs: [
      'Item 7. Water main replacement. Staff reported that the Elm Street water main was rated "poor" in the 2024 inspection.',
      'The council voted 5-4 to postpone the replacement project to the 2027 budget. Councilmember Ortiz said the county could not fund the work this year.',
      'Item 8. Road resurfacing. The council approved the 2025 paving schedule without discussion. The meeting adjourned at 9:40 p.m.',
    ],
  },
  '/inspections/elm-street-2024.txt': {
    title: 'Elm Street water main inspection report, 2024',
    plain: true,
    paragraphs: [
      'Elm Street water main inspection report, 2024. Maple County Public Works.',
      'Summary: the Elm Street main has 14 documented leaks since 2020. Condition rating: poor.',
      'Recommendation: replace the main within 24 months to avoid a failure.',
    ],
  },
  '/state/grants-2025': {
    title: 'State water infrastructure grants, 2025 allocations',
    paragraphs: [
      'The state reduced local water infrastructure grants by 40 percent for the 2025 fiscal year.',
      "Maple County's allocation fell from $2.1 million to $1.26 million. Allocations for 2026 have not been announced.",
    ],
  },
  '/news/2025/09/elm-street-main-breaks': {
    title: 'Elm Street water main breaks, closing three blocks',
    paragraphs: [
      'The Elm Street water main broke on September 12, 2025, closing three blocks for four days.',
      'County officials said the break was in the section the council had postponed replacing.',
      '“We made the best choice we could with the money we had,” council chair Dana Price said.',
    ],
  },
  '/news/2025/09/state-cuts-analysis': {
    title: 'How state grant cuts squeezed county budgets',
    paragraphs: [
      'Analysts at the Civic Budget Project said the state cuts forced counties to defer maintenance.',
      'Maple County deferred two of its five planned water projects in 2025, according to the county budget office.',
    ],
  },
  // A real page that no agent opens in any run below.
  '/news/2025/10/council-letters': {
    title: 'Engineers warned the council in writing, records show',
    paragraphs: [
      'Records released on October 2, 2025 show that county engineers sent the council three written warnings about the Elm Street main before the June vote.',
      'The council has not commented on the letters.',
    ],
  },
};

/** Paths a scripted researcher opens; the rest of the site is never opened. */
const P = {
  minutes: '/council/minutes-2025-06-03',
  inspection: '/inspections/elm-street-2024.txt',
  grants: '/state/grants-2025',
  breaks: '/news/2025/09/elm-street-main-breaks',
  analysis: '/news/2025/09/state-cuts-analysis',
  letters: '/news/2025/10/council-letters',
  /** Nothing is served here: a URL the drafter made up. */
  madeUp: '/news/2025/10/leaked-council-memo',
} as const;

function renderHtml(page: SitePage): string {
  return [
    '<!doctype html><html><head>',
    `<title>${page.title} | Maple County Record</title>`,
    '<script>var tracker = "not part of the page text";</script>',
    '</head><body>',
    '<nav><a href="/">Home</a> <a href="/news">News</a> <a href="/council">Council</a></nav>',
    `<article><h1>${page.title}</h1>`,
    ...page.paragraphs.map((p) => `<p>${p}</p>`),
    '<p>This page is a fictional fixture for the pipeline tests. It describes no real place or person.</p>',
    '</article>',
    '<footer>Copyright Maple County Record</footer>',
    '</body></html>',
  ].join('\n');
}

let server: Server;
let base = '';
const url = (path: string) => `${base}${path}`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const page = SITE[(req.url ?? '/').split('?')[0]!];
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Not found</title><p>Not found</p>');
      return;
    }
    if (page.plain) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(page.paragraphs.join('\n\n'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHtml(page));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A run's source store with the real network fetcher (local addresses allowed for the fixture server). */
function realStore() {
  const log = new MemoryResearchLog();
  const store = new SourceStore({ log, fetch: { allowPrivateHosts: true, timeoutMs: 10_000 } });
  return { log, store };
}

// ---------------------------------------------------------------------------
// The draft: written only from the opened pages, every quote verbatim
// ---------------------------------------------------------------------------

const MICRO_POLL = { prompt: 'Does this change your position?', re_ask_slider: true as const };
export const PLANTED = 's-planted';

type Step = DraftCase['steps'][number];

function cleanDraft(): DraftCase {
  const o = outline();
  const src = (id: string, path: string, title: string, publisher: string, type: DraftCase['sources'][number]['type'], date: string) => ({
    id,
    title,
    publisher,
    url: url(path),
    date,
    type,
    accessed_at: `${AS_OF}T00:00:00Z`,
  });
  const step = (n: number, s: Omit<Step, 'id' | 'order' | 'depth' | 'micro_poll'> & { depth?: Step['depth'] }): Step => ({
    id: `s${n}`,
    order: n,
    depth: [],
    micro_poll: MICRO_POLL,
    ...s,
  });
  return {
    schema_version: 1,
    id: o.slug,
    slug: o.slug,
    title: o.title,
    status: 'draft',
    version: 1,
    as_of: AS_OF,
    question: { prompt: o.question.prompt, scale: { type: 'slider', min: 0, max: 100, left_label: o.question.left_label, right_label: o.question.right_label } },
    starting_facts: [
      {
        id: 'f1',
        text: 'The Elm Street water main in Maple County broke on September 12, 2025, closing three blocks for four days.',
        source_ids: ['src-break'],
        confidence: 'reported',
        evidence: [{ source_id: 'src-break', quote: 'The Elm Street water main broke on September 12, 2025, closing three blocks for four days.' }],
      },
    ],
    steps: [
      step(1, {
        headline: 'A 2024 inspection rated the Elm Street main poor and recommended replacing it within 24 months.',
        body: "The county's 2024 inspection report counted 14 documented leaks since 2020 and rated the main's condition as poor. It recommended replacing the main within 24 months to avoid a failure.",
        favors: SIDE_A.id,
        impact: 'high',
        source_ids: ['src-inspection'],
        confidence: 'established',
        evidence: [
          { source_id: 'src-inspection', quote: 'the Elm Street main has 14 documented leaks since 2020. Condition rating: poor.' },
          { source_id: 'src-inspection', quote: 'Recommendation: replace the main within 24 months to avoid a failure.' },
        ],
      }),
      step(2, {
        headline: 'The state cut local water infrastructure grants by 40 percent for 2025.',
        body: "The state reduced local water infrastructure grants by 40 percent for the 2025 fiscal year. Maple County's allocation fell from $2.1 million to $1.26 million.",
        favors: SIDE_B.id,
        impact: 'high',
        source_ids: ['src-grants'],
        confidence: 'established',
        evidence: [
          { source_id: 'src-grants', quote: 'The state reduced local water infrastructure grants by 40 percent for the 2025 fiscal year.' },
          { source_id: 'src-grants', quote: "Maple County's allocation fell from $2.1 million to $1.26 million." },
        ],
      }),
      step(3, {
        headline: 'In June 2025 the council voted 5-4 to postpone the replacement to the 2027 budget.',
        body: 'According to the minutes of the June 3, 2025 meeting, the council voted 5-4 to postpone the replacement project to the 2027 budget. Councilmember Ortiz said the county could not fund the work that year.',
        favors: SIDE_A.id,
        impact: 'high',
        source_ids: ['src-minutes'],
        confidence: 'established',
        evidence: [
          { source_id: 'src-minutes', quote: 'The council voted 5-4 to postpone the replacement project to the 2027 budget.' },
          { source_id: 'src-minutes', quote: 'Councilmember Ortiz said the county could not fund the work this year.' },
        ],
      }),
      step(4, {
        headline: 'Analysts said the state cuts forced counties to defer maintenance.',
        body: 'Analysts at the Civic Budget Project said the state cuts forced counties to defer maintenance. Maple County deferred two of its five planned water projects in 2025, according to the county budget office.',
        favors: SIDE_B.id,
        impact: 'medium',
        source_ids: ['src-analysis'],
        confidence: 'reported',
        evidence: [
          { source_id: 'src-analysis', quote: 'Analysts at the Civic Budget Project said the state cuts forced counties to defer maintenance.' },
          { source_id: 'src-analysis', quote: 'Maple County deferred two of its five planned water projects in 2025' },
        ],
      }),
      step(5, {
        headline: 'County officials said the break was in the section the council had postponed replacing.',
        body: 'County officials said the break was in the section the council had postponed replacing. Council chair Dana Price said the council "made the best choice we could with the money we had."',
        favors: 'neutral',
        impact: 'medium',
        source_ids: ['src-break'],
        confidence: 'reported',
        evidence: [
          { source_id: 'src-break', quote: 'County officials said the break was in the section the council had postponed replacing.' },
          // Straight quotes here, curly quotes on the page: the match normalizes them.
          { source_id: 'src-break', quote: '"We made the best choice we could with the money we had," council chair Dana Price said.' },
        ],
      }),
    ],
    sides: [
      { id: SIDE_A.id, label: SIDE_A.label, steelman: 'Supporters argue the council knew from the 2024 inspection that the main was in poor condition and still voted to postpone the replacement.' },
      { id: SIDE_B.id, label: SIDE_B.label, steelman: 'Supporters argue the 40 percent cut in state grants left the county without the money to replace the main on time.' },
    ],
    open_questions: ['Could the county have moved other funds to the replacement in 2025?'],
    sources: [
      src('src-minutes', P.minutes, 'Maple County Council minutes, June 3, 2025', 'Maple County Council', 'official', '2025-06-03'),
      src('src-inspection', P.inspection, 'Elm Street water main inspection report, 2024', 'Maple County Public Works', 'official', '2024'),
      src('src-grants', P.grants, 'State water infrastructure grants, 2025 allocations', 'State of Example', 'official', '2025'),
      src('src-break', P.breaks, 'Elm Street water main breaks, closing three blocks', 'Maple County Record', 'news', '2025-09-12'),
      src('src-analysis', P.analysis, 'How state grant cuts squeezed county budgets', 'Maple County Record', 'analysis', '2025-09'),
    ],
  };
}

type Variant = 'fabricated_quote' | 'unopened_source' | 'misused_quote';

/** Inserts the planted step after s3 (the middle of the dive, where it would matter) and renumbers. */
function plant(draft: DraftCase, variant: Variant, opts: { id?: string; unopenedPath?: string } = {}): DraftCase {
  const d = structuredClone(draft);
  const id = opts.id ?? PLANTED;
  const common = { id, order: 0, depth: [], micro_poll: MICRO_POLL, impact: 'high' as const };
  let s: Step;
  switch (variant) {
    case 'fabricated_quote':
      s = {
        ...common,
        headline: 'The council chair admitted the council ignored three written warnings from engineers.',
        body: 'After the break, council chair Dana Price admitted that the council ignored three written warnings from county engineers before the June vote.',
        favors: SIDE_A.id,
        source_ids: ['src-break'],
        confidence: 'reported',
        evidence: [{ source_id: 'src-break', quote: 'Council chair Dana Price admitted the council ignored three written warnings from engineers.' }],
      };
      break;
    case 'unopened_source': {
      const path = opts.unopenedPath ?? P.madeUp;
      d.sources.push({
        id: 'src-letters',
        title: 'Engineers warned the council in writing, records show',
        publisher: 'Maple County Record',
        url: url(path),
        date: '2025-10-02',
        type: 'news',
        accessed_at: `${AS_OF}T00:00:00Z`,
      });
      s = {
        ...common,
        headline: 'County engineers sent the council three written warnings before the June vote.',
        body: 'Records released in October 2025 show that county engineers sent the council three written warnings about the Elm Street main before the June vote.',
        favors: SIDE_A.id,
        source_ids: ['src-letters'],
        confidence: 'reported',
        evidence: [{ source_id: 'src-letters', quote: 'county engineers sent the council three written warnings about the Elm Street main before the June vote.' }],
      };
      break;
    }
    case 'misused_quote':
      s = {
        ...common,
        headline: 'The council voted unanimously to cancel the Elm Street replacement project.',
        body: 'According to the June 3, 2025 minutes, the council voted unanimously to cancel the Elm Street water main replacement. Members said the work was no longer needed.',
        favors: SIDE_B.id,
        source_ids: ['src-minutes'],
        confidence: 'established',
        // A real, verbatim quote from the minutes. It does not say what the step says.
        evidence: [{ source_id: 'src-minutes', quote: 'The council voted 5-4 to postpone the replacement project to the 2027 budget.' }],
      };
      break;
  }
  const at = d.steps.findIndex((x) => x.id === 's3') + 1;
  d.steps.splice(at, 0, s);
  d.steps.forEach((x, i) => (x.order = i + 1));
  return d;
}

/** Opens every page a researcher would, through the research tools (the real fetch, logged as opens). */
async function openResearchPages(store: SourceStore) {
  const tools = new ResearchTools(store, { agent: 'researcher', scope: 'records', round: 0 }, 'research');
  for (const path of [P.minutes, P.inspection, P.grants, P.breaks, P.analysis]) {
    const r = await tools.openSource(url(path));
    expect(r.ok, `${path}: ${r.error ?? ''}`).toBe(true);
  }
  return tools;
}

const sourceRefs = (draft: DraftCase, store: SourceStore): SourceSnapshotRef[] =>
  draft.sources.map((s) => ({ source_id: s.id, snapshot_id: store.findByUrl(s.url)?.id ?? null, url: s.url }));

const isDowngrade = (before: Confidence | undefined, after: Confidence | undefined) =>
  !!before && !!after && before !== after && weakerConfidence(before, after) === after;

/** Whether the fact-check rows fail a target: a failing verdict, or "partially supported" with a confidence downgrade. */
function failsTarget(rows: Array<Pick<FactCheckItem, 'target' | 'verdict' | 'confidence_before' | 'confidence_after'>>, target: string): boolean {
  return rows.some(
    (r) =>
      r.target === target &&
      (r.verdict === 'unsupported' || r.verdict === 'uncited' || r.verdict === 'source_unavailable' || (r.verdict === 'partially_supported' && isDowngrade(r.confidence_before, r.confidence_after))),
  );
}

// ---------------------------------------------------------------------------
// 1. The deterministic layer
// ---------------------------------------------------------------------------

describe('a planted claim against the deterministic citation check (real fetch, real source store)', () => {
  it('the clean draft is schema-valid and every quote is in a snapshot opened in this run', async () => {
    const { store, log } = realStore();
    await openResearchPages(store);
    const draft = cleanDraft();
    expect(validateCase(draft).errors).toEqual([]);
    expect(checkCitations(draft, store)).toEqual([]);
    // The snapshots are the extracted page text, not the raw HTML.
    const minutes = store.findByUrl(url(P.minutes))!;
    expect(minutes.status).toBe(200);
    expect(minutes.text).toContain('The council voted 5-4 to postpone');
    expect(minutes.text).not.toContain('tracker');
    expect(log.entries.filter((e) => e.kind === 'open')).toHaveLength(5);
  });

  it('variant 1: fails a step whose evidence quote is not in its source', async () => {
    const { store } = realStore();
    await openResearchPages(store);
    const draft = plant(cleanDraft(), 'fabricated_quote');
    expect(validateCase(draft).ok).toBe(true); // the schema alone cannot tell
    const failures = checkCitations(draft, store);
    expect(failures).toEqual([
      expect.objectContaining({
        target: PLANTED,
        source_id: 'src-break',
        verdict: 'unsupported',
        quote: 'Council chair Dana Price admitted the council ignored three written warnings from engineers.',
      }),
    ]);
  });

  it('variant 2: fails a step that cites a source nobody opened in this run (made-up URL, or a real page never opened)', async () => {
    const { store, log } = realStore();
    await openResearchPages(store);

    const madeUp = checkCitations(plant(cleanDraft(), 'unopened_source'), store);
    expect(madeUp).toEqual([expect.objectContaining({ target: PLANTED, source_id: 'src-letters', verdict: 'source_unavailable' })]);

    // The letters page exists and contains the quote, but it was not opened in this run.
    const unopened = checkCitations(plant(cleanDraft(), 'unopened_source', { unopenedPath: P.letters }), store);
    expect(unopened).toEqual([expect.objectContaining({ target: PLANTED, source_id: 'src-letters', verdict: 'source_unavailable' })]);
    expect(log.entries.some((e) => e.kind === 'open' && e.url?.endsWith(P.letters))).toBe(false);

    // A made-up URL stays unavailable even when an agent tries to open it: the fetch fails and nothing is snapshotted.
    const tools = new ResearchTools(store, { agent: 'fact_checker', round: 1 }, 'read_sources');
    const reopen = await tools.openSource(url(P.madeUp));
    expect(reopen).toMatchObject({ ok: false, status: 404 });
    expect(checkCitations(plant(cleanDraft(), 'unopened_source'), store)).toEqual([
      expect.objectContaining({ target: PLANTED, verdict: 'source_unavailable' }),
    ]);
  });

  it('variant 3: a real quote that does not support the claim passes the deterministic layer (only the LLM fact-checker can catch it)', async () => {
    const { store } = realStore();
    await openResearchPages(store);
    expect(checkCitations(plant(cleanDraft(), 'misused_quote'), store)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The orchestrator never lets a planted claim through
// ---------------------------------------------------------------------------

const SIDE_A_SPECS = [
  { url: '', path: P.minutes, quote: 'The council voted 5-4 to postpone the replacement project to the 2027 budget.', text: 'The council voted 5-4 in June 2025 to postpone the replacement.', type: 'official' as const, favors: SIDE_A.id, impact: 'high' as const },
  { url: '', path: P.inspection, quote: 'Condition rating: poor.', text: 'A 2024 inspection rated the main poor.', type: 'official' as const, favors: SIDE_A.id },
];
const SIDE_B_SPECS = [
  { url: '', path: P.grants, quote: 'The state reduced local water infrastructure grants by 40 percent for the 2025 fiscal year.', text: 'The state cut water grants by 40 percent in 2025.', type: 'official' as const, favors: SIDE_B.id, impact: 'high' as const },
  { url: '', path: P.analysis, quote: 'Maple County deferred two of its five planned water projects in 2025', text: 'The county deferred two of five water projects in 2025.', type: 'analysis' as const, favors: SIDE_B.id },
];
const RECORDS_SPECS = [
  { url: '', path: P.breaks, quote: 'The Elm Street water main broke on September 12, 2025, closing three blocks for four days.', text: 'The main broke on September 12, 2025.', type: 'news' as const, favors: 'neutral' },
];

/** Researcher scripts that open the fixture pages through the tools (the real fetch) and log their claims. */
const researching = (specs: typeof SIDE_A_SPECS | typeof RECORDS_SPECS) => researcherScript(specs.map(({ path, ...s }) => ({ ...s, url: url(path) })));

/** A fact-checker that marks every item supported without reading anything: the worst case for an LLM. */
const rubberStampFactChecker: FakeScript = (input: FactCheckerInput): FactCheckerOutput => ({
  rows: factCheckTargets(input.draft).flatMap((t) =>
    t.source_ids.map((sid) => ({ target: t.target, claim: t.text.slice(0, 2000), source_id: sid, verdict: 'supported' as const, note: 'Looks fine.' })),
  ),
});

/**
 * A fact-checker that re-reads each cited snapshot through read_source and judges
 * the planted step the way the live tests show the real agent does.
 */
function judgingFactChecker(planted: Pick<FactCheckItem, 'verdict' | 'note' | 'confidence_after'>): FakeScript {
  return (input: FactCheckerInput, _ctx: AgentContext, tools: ResearchTools): FactCheckerOutput => {
    const snaps = new Map(input.sources.map((s) => [s.source_id, s.snapshot_id]));
    const rows: FactCheckItem[] = [];
    for (const t of factCheckTargets(input.draft)) {
      for (const sid of t.source_ids) {
        const snap = snaps.get(sid);
        if (snap) tools.readSource(snap, 0, 20_000);
        rows.push(
          t.target === PLANTED
            ? { target: t.target, claim: t.text.slice(0, 2000), source_id: sid, ...planted, ...(t.confidence ? { confidence_before: t.confidence } : {}) }
            : { target: t.target, claim: t.text.slice(0, 2000), source_id: sid, verdict: 'supported', note: 'The source says this.' },
        );
      }
    }
    return { rows };
  };
}

function scripts(opts: { variant: Variant | null; factChecker: FakeScript; plantInRevisions?: boolean }): Record<string, FakeScript> {
  return {
    scoper: async (_input: unknown, _ctx: AgentContext, tools: ResearchTools) => {
      await tools.logQuery('Maple County Elm Street water main break', [{ url: url(P.breaks) }]);
      await tools.openSource(url(P.breaks));
      return outline();
    },
    [`researcher#${SIDE_A.id}`]: researching(SIDE_A_SPECS),
    [`researcher#${SIDE_B.id}`]: researching(SIDE_B_SPECS),
    records_researcher: researching(RECORDS_SPECS),
    // The drafter writes the clean dive from the opened pages and plants the claim (in every revision too, unless told otherwise).
    drafter: (input: { previous?: unknown }) => {
      const planting = opts.variant && (opts.plantInRevisions ?? true ? true : !input.previous);
      return { case: planting ? plant(cleanDraft(), opts.variant!) : cleanDraft(), resolutions: [] };
    },
    hard_questions: cleanHardQuestions,
    red_team: cleanRedTeam,
    fact_checker: opts.factChecker,
    editor: editorScript(),
  };
}

async function runPipeline(s: Record<string, FakeScript>, maxRounds?: number) {
  const { store, log } = realStore();
  const runner = new FakeRunner(s, { costPerCall: 0.01 });
  const result: PipelineResult = await runCasePipeline(
    { kind: 'new_case', brief: 'Maple County water main break' },
    { runner, store, runId: 'fabricated-claim', asOf: AS_OF, ...(maxRounds ? { maxRounds } : {}) },
  );
  if (result.kind !== 'package') throw new Error(`expected a package, got ${result.kind}`);
  return { pkg: result as PipelinePackage, store, log, runner };
}

describe('the orchestrator with a planted claim (real fetch, scripted agents)', () => {
  it('the clean draft goes through in one round with nothing open', async () => {
    const { pkg, store } = await runPipeline(scripts({ variant: null, factChecker: rubberStampFactChecker }));
    expect(pkg.clean).toBe(true);
    expect(pkg.rounds).toBe(1);
    expect(pkg.review.open_issues).toEqual([]);
    expect(checkCitations(pkg.case, store)).toEqual([]);
    // Every source in the package was opened in this run, over HTTP, with status 200.
    for (const s of pkg.case.sources) expect(store.findByUrl(s.url)?.status, s.url).toBe(200);
  });

  for (const [variant, verdict] of [
    ['fabricated_quote', 'unsupported'],
    ['unopened_source', 'source_unavailable'],
  ] as const) {
    it(`variant ${variant}: fails in every round even when the LLM fact-checker misses it, and reaches the admin as a high open issue`, async () => {
      const { pkg, store } = await runPipeline(scripts({ variant, factChecker: rubberStampFactChecker }));
      expect(pkg.clean).toBe(false);
      expect(pkg.rounds).toBe(3);

      // The deterministic rows in the fact-check table, one per round.
      const rows = pkg.review.fact_check.filter((r) => r.target === PLANTED && r.verdict === verdict);
      expect(rows.map((r) => r.round)).toEqual([1, 2, 3]);
      expect(rows.every((r) => r.note?.startsWith('Deterministic check'))).toBe(true);

      // It is an open issue on that step, never silently in the package.
      const issues = pkg.review.open_issues.filter((o) => o.step_id === PLANTED);
      expect(issues.length).toBeGreaterThanOrEqual(1);
      expect(issues.every((o) => o.source === 'fact_checker' && o.severity === 'high' && !o.resolved)).toBe(true);

      // The package itself is still for review only: schema-valid, in_review, and its citation failure reproducible.
      expect(pkg.case.status).toBe('in_review');
      expect(validateCase(pkg.case).ok).toBe(true);
      expect(checkCitations(pkg.case, store)).toEqual([expect.objectContaining({ target: PLANTED, verdict })]);
      // The critique sent the gap back to research.
      expect(pkg.review.agent_reports.some((r) => r.agent === 'records_researcher' && r.round === 1)).toBe(true);
    });
  }

  it('variant fabricated_quote: the loop closes once the drafter drops the planted step', async () => {
    const { pkg, store } = await runPipeline(scripts({ variant: 'fabricated_quote', factChecker: rubberStampFactChecker, plantInRevisions: false }));
    expect(pkg.rounds).toBe(2);
    expect(pkg.clean).toBe(true);
    expect(pkg.case.steps.some((s) => s.id === PLANTED)).toBe(false);
    expect(pkg.review.fact_check.some((r) => r.target === PLANTED && r.round === 1 && r.verdict === 'unsupported')).toBe(true);
    expect(pkg.review.open_issues).toEqual([]);
    expect(checkCitations(pkg.case, store)).toEqual([]);
  });

  it('variant misused_quote: an "unsupported" row from the fact-checker blocks the loop and becomes a high open issue', async () => {
    const { pkg, runner } = await runPipeline(
      scripts({
        variant: 'misused_quote',
        factChecker: judgingFactChecker({ verdict: 'unsupported', note: 'The minutes record a 5-4 vote to postpone, not a unanimous vote to cancel.', confidence_after: 'disputed' }),
      }),
    );
    expect(pkg.clean).toBe(false);
    expect(pkg.rounds).toBe(3);
    expect(pkg.review.open_issues).toContainEqual(
      expect.objectContaining({ source: 'fact_checker', severity: 'high', step_id: PLANTED, description: expect.stringContaining('unsupported') }),
    );
    // The fact-checker re-read the cited snapshots through its tools.
    expect(runner.callsTo('fact_checker').every((c) => c.access === 'read_sources')).toBe(true);
  });

  it('variant misused_quote: "partially supported" downgrades the step and still reaches the admin', async () => {
    const { pkg } = await runPipeline(
      scripts({
        variant: 'misused_quote',
        factChecker: judgingFactChecker({ verdict: 'partially_supported', note: 'The minutes support a vote on the project, not its outcome.', confidence_after: 'disputed' }),
      }),
    );
    const step = pkg.case.steps.find((s) => s.id === PLANTED)!;
    expect(step.confidence).toBe('disputed');
    expect(pkg.review.open_issues).toContainEqual(expect.objectContaining({ source: 'fact_checker', severity: 'medium', step_id: PLANTED, resolved: false }));
  });
});

// ---------------------------------------------------------------------------
// 3. Live: the real fact-checker agent (PIPELINE_LIVE=1; about $0.5 to $2)
// ---------------------------------------------------------------------------

const live = process.env.PIPELINE_LIVE === '1';

/** Runs the fact-checker through the Agent SDK and every other agent from scripts. */
class FactCheckerOnlyRunner implements AgentRunner {
  readonly costs: number[] = [];
  constructor(
    private readonly real: AgentRunner,
    private readonly fake: AgentRunner,
  ) {}
  async run<I, O>(spec: AgentSpec<I, O>, input: I, ctx: AgentContext, tools: ResearchTools, opts?: RunOptions): Promise<AgentRunResult<O>> {
    if (spec.name !== 'fact_checker') return this.fake.run(spec, input, ctx, tools, opts);
    const r = await this.real.run(spec, input, ctx, tools, opts);
    this.costs.push(r.costUsd);
    return r;
  }
}

function report(label: string, r: { costUsd: number; turns: number }, rows: FactCheckItem[], targets: string[]) {
  const lines = rows.filter((x) => targets.includes(x.target)).map((x) => `  ${x.target} [${x.source_id ?? '-'}] ${x.verdict} ${x.confidence_before ?? ''}->${x.confidence_after ?? ''}: ${x.note ?? ''}`);
  const others = rows.filter((x) => !targets.includes(x.target));
  const tally = [...new Set(others.map((x) => x.verdict))].map((v) => `${others.filter((x) => x.verdict === v).length} ${v}`).join(', ');
  process.stderr.write(`\n[live] ${label}: $${r.costUsd.toFixed(4)}, ${r.turns} turns, ${rows.length} rows (other targets: ${tally})\n${lines.join('\n')}\n`);
}

describe.skipIf(!live)('the real fact-checker agent fails a planted claim (live Agent SDK)', () => {
  const runner = () => new ClaudeAgentRunner({ callBudgetUsd: { strong: 3 } });

  async function factCheck(draft: DraftCase) {
    const { store } = realStore();
    await openResearchPages(store);
    const tools = new ResearchTools(store, { agent: 'fact_checker', round: 1 }, 'read_sources');
    const ctx: AgentContext = { runId: 'fabricated-claim-live', asOf: AS_OF, round: 1 };
    const r = await runner().run(factCheckerSpec, { draft, sources: sourceRefs(draft, store) }, ctx, tools);
    return { ...r, tools, store };
  }

  it('variant 3 (a real quote that does not support the claim): the planted step is unsupported', { timeout: 900_000 }, async () => {
    const draft = plant(cleanDraft(), 'misused_quote');
    const r = await factCheck(draft);
    report('misused_quote', r, r.output.rows, [PLANTED]);
    expect(failsTarget(r.output.rows, PLANTED), 'the planted step gets an unsupported row (or partially supported with a downgrade)').toBe(true);
    expect(r.output.rows.some((x) => x.target === PLANTED && x.verdict === 'supported')).toBe(false);
    // It re-read the cited snapshot of the minutes.
    expect(r.tools.reads.has(r.store.findByUrl(url(P.minutes))!.id)).toBe(true);
  });

  it('variants 1 and 2 (a quote the source lacks, a source never opened): both planted steps fail', { timeout: 900_000 }, async () => {
    const draft = plant(plant(cleanDraft(), 'fabricated_quote', { id: 's-planted-quote' }), 'unopened_source', { id: 's-planted-source' });
    const r = await factCheck(draft);
    report('fabricated_quote + unopened_source', r, r.output.rows, ['s-planted-quote', 's-planted-source']);
    expect(failsTarget(r.output.rows, 's-planted-quote')).toBe(true);
    expect(failsTarget(r.output.rows, 's-planted-source')).toBe(true);
  });

  it('variant 3 through the orchestrator: the real fact-checker\'s verdict keeps the planted step from passing', { timeout: 900_000 }, async () => {
    const fake = new FakeRunner(scripts({ variant: 'misused_quote', factChecker: rubberStampFactChecker }));
    const mixed = new FactCheckerOnlyRunner(runner(), fake);
    const { store } = realStore();
    const result = await runCasePipeline(
      { kind: 'new_case', brief: 'Maple County water main break' },
      { runner: mixed, store, runId: 'fabricated-claim-live-orchestrator', asOf: AS_OF, maxRounds: 1 },
    );
    if (result.kind !== 'package') throw new Error('expected a package');
    const llmRows = result.review.fact_check.filter((x) => !x.note?.startsWith('Deterministic'));
    report('orchestrator, misused_quote', { costUsd: mixed.costs.reduce((a, b) => a + b, 0), turns: 0 }, llmRows, [PLANTED]);
    expect(failsTarget(llmRows, PLANTED)).toBe(true);
    // Either way it reaches the admin: a high open issue (unsupported) or a medium one with the step downgraded.
    const issue = result.review.open_issues.find((o) => o.step_id === PLANTED && o.source === 'fact_checker');
    expect(issue, 'an open issue on the planted step').toBeDefined();
    const step = result.case.steps.find((s) => s.id === PLANTED);
    if (issue!.severity !== 'high') expect(step?.confidence).not.toBe('established');
    expect(checkCitations(result.case, store)).toEqual([]);
  });
});
