import { describe, expect, it } from 'vitest';
import { validateCase } from '@sia/case-schema';
import type { DrafterInput, DrafterOutput } from '../src/agents/drafter';
import type { FactCheckerInput, FactCheckerOutput } from '../src/agents/factChecker';
import type { HardQuestionsInput } from '../src/agents/hardQuestions';
import type { ResearcherInput } from '../src/agents/researcher';
import { statusItem } from '../src/agents/scoper';
import type { AgentContext } from '../src/agents/types';
import { checkCitations } from '../src/factcheck';
import { MAX_ROUNDS, claimConcernsText, runCasePipeline, type PipelinePackage } from '../src/orchestrator';
import type { ResearchTools } from '../src/research/tools';
import { FakeRunner, type FakeScript } from '../src/runner/fake';
import {
  AS_OF,
  SIDE_A,
  SIDE_A_CLAIMS,
  URLS,
  blockingHardQuestions,
  buildDraft,
  cleanScripts,
  drafterScript,
  editorScript,
  factCheckerScript,
  memoryStore,
  researcherScript,
} from './helpers';

/**
 * Review rules the spec sets for the critic loop and the package: the editor's
 * changes are fact-checked again, sources are opened before they are cited,
 * every accepted claim is in the research log, what stays unresolved reaches
 * the admin, and a reply is not a fix.
 */

async function run(scripts: Record<string, FakeScript>, opts: { maxRounds?: number } = {}) {
  const { log, store } = memoryStore();
  const runner = new FakeRunner(scripts, { costPerCall: 0.01 });
  const result = await runCasePipeline(
    { kind: 'new_case', brief: 'Maple County water main break' },
    { runner, store, runId: 'rules', asOf: AS_OF, ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}) },
  );
  if (result.kind !== 'package') throw new Error('expected a package');
  return { pkg: result as PipelinePackage, runner, log, store };
}

type FcFn = (input: FactCheckerInput, ctx: AgentContext, tools: ResearchTools) => FactCheckerOutput;
const readingFactChecker = factCheckerScript() as FcFn;

describe('the editor works after the last critic round, so its changes are checked', () => {
  it('cannot raise a confidence label the fact-checker lowered', async () => {
    const fc: FakeScript = (input: FactCheckerInput, ctx: AgentContext, tools: ResearchTools) => {
      const out = readingFactChecker(input, ctx, tools);
      for (const r of out.rows) if (r.target === 's1') r.confidence_after = 'alleged';
      return out;
    };
    const editor = editorScript((d) => {
      d.steps.find((s) => s.id === 's1')!.confidence = 'established';
      return d;
    });
    const { pkg, log } = await run(cleanScripts({ fact_checker: fc, editor }));
    expect(pkg.case.steps.find((s) => s.id === 's1')!.confidence).toBe('alleged');
    expect(log.entries.some((e) => e.excerpt?.includes('The editor raised confidence labels the fact-check had set'))).toBe(true);
  });

  it('a fact the editor adds is fact-checked; when it fails, the step is put back as it was checked', async () => {
    const ADDED = 'The council chair later resigned over the vote.';
    const fc: FakeScript = (input: FactCheckerInput, ctx: AgentContext, tools: ResearchTools) => {
      const out = readingFactChecker(input, ctx, tools);
      const s1 = input.draft.steps.find((s) => s.id === 's1');
      if (s1?.body.includes(ADDED)) {
        out.rows.push({ target: 's1', claim: ADDED, verdict: 'uncited', note: 'No cited source says the chair resigned.' });
      }
      return out;
    };
    const editor = editorScript((d) => {
      const s1 = d.steps.find((s) => s.id === 's1')!;
      s1.body = `${s1.body} ${ADDED}`;
      return d;
    });
    const { pkg, runner } = await run(cleanScripts({ fact_checker: fc, editor }));
    const s1 = pkg.case.steps.find((s) => s.id === 's1')!;
    expect(s1.body).not.toContain(ADDED);
    expect((runner.callsTo('fact_checker').at(-1)!.input as FactCheckerInput).only).toEqual(['s1']);
    expect(pkg.editorFallback).toBe(false);
    expect(pkg.review.open_issues).toContainEqual(
      expect.objectContaining({ source: 'editor', severity: 'medium', step_id: 's1', description: expect.stringContaining('uncited') }),
    );
    expect(pkg.review.fact_check.some((r) => r.target === 's1' && r.verdict === 'uncited' && r.note?.startsWith('Final check after the editor:'))).toBe(true);
  });

  it('a new depth layer the editor adds is checked like any other layer', async () => {
    const editor = editorScript((d) => {
      const s1 = d.steps.find((s) => s.id === 's1')!;
      s1.depth.push({ kind: 'context', id: 'c9', title: 'Background', body: 'The main was installed in 1952.', source_ids: [s1.source_ids[0]!] });
      return d;
    });
    const fc: FakeScript = (input: FactCheckerInput, ctx: AgentContext, tools: ResearchTools) => {
      const out = readingFactChecker(input, ctx, tools);
      if (input.only?.includes('layer:s1/c9')) {
        const sid = input.draft.steps.find((s) => s.id === 's1')!.source_ids[0]!;
        tools.readSource(input.sources.find((x) => x.source_id === sid)!.snapshot_id!, 0, 100);
        out.rows.push({ target: 'layer:s1/c9', claim: 'The main was installed in 1952.', source_id: sid, verdict: 'unsupported', note: 'No date of installation.' });
      }
      return out;
    };
    const { pkg } = await run(cleanScripts({ fact_checker: fc, editor }));
    expect(pkg.case.steps.find((s) => s.id === 's1')!.depth.some((l) => l.id === 'c9')).toBe(false);
    expect(pkg.review.open_issues).toContainEqual(expect.objectContaining({ source: 'editor', description: expect.stringContaining('removed (the editor added it)') }));
  });

  it('when the check of its changes cannot run, each changed item reaches the admin as not re-checked', async () => {
    let calls = 0;
    const fc: FakeScript = (input: FactCheckerInput, ctx: AgentContext, tools: ResearchTools) => {
      calls++;
      if (input.only) throw new Error('fact-checker crashed');
      return readingFactChecker(input, ctx, tools);
    };
    const editor = editorScript((d) => {
      d.steps.find((s) => s.id === 's2')!.headline = 'A 2024 inspection rated the Elm Street main poor.';
      return d;
    });
    const { pkg } = await run(cleanScripts({ fact_checker: fc, editor }));
    expect(calls).toBeGreaterThan(1);
    expect(pkg.case.steps.find((s) => s.id === 's2')!.headline).toBe('A 2024 inspection rated the Elm Street main poor.');
    expect(pkg.review.open_issues).toContainEqual(
      expect.objectContaining({ source: 'editor', severity: 'medium', step_id: 's2', description: expect.stringContaining('did not run') }),
    );
  });

  it('the editor never changes the question of an existing case (and a new case is told it may only for a flag)', async () => {
    const { runner } = await run(cleanScripts());
    expect(runner.callsTo('editor')[0]!.prompt).toContain('This is a new case.');
  });
});

describe('fact-check downgrades follow the item\'s own text', () => {
  it('a row about a detail only an extra citation supports does not relabel the step; the admin is asked to check it', async () => {
    const fc: FakeScript = (input: FactCheckerInput, ctx: AgentContext, tools: ResearchTools) => {
      const out = readingFactChecker(input, ctx, tools);
      const s1 = input.draft.steps.find((s) => s.id === 's1')!;
      out.rows.push({
        target: 's1',
        claim: 'Residents filed a separate malpractice lawsuit against the engineering contractor in 2026.',
        source_id: s1.source_ids[0]!,
        verdict: 'partially_supported',
        quote: s1.evidence![0]!.quote,
        note: 'Only the lawsuit detail is alleged.',
        confidence_before: s1.confidence,
        confidence_after: 'alleged',
      });
      return out;
    };
    const { pkg } = await run(cleanScripts({ fact_checker: fc }));
    const s1 = pkg.case.steps.find((s) => s.id === 's1')!;
    expect(s1.confidence).not.toBe('alleged');
    expect(pkg.review.open_issues).toContainEqual(
      expect.objectContaining({ source: 'fact_checker', severity: 'medium', step_id: 's1', description: expect.stringContaining('which the item\'s own text does not state') }),
    );
  });

  it('a row about the step\'s own claim still downgrades it', async () => {
    const fc: FakeScript = (input: FactCheckerInput, ctx: AgentContext, tools: ResearchTools) => {
      const out = readingFactChecker(input, ctx, tools);
      for (const r of out.rows) if (r.target === 's1') r.confidence_after = 'disputed';
      return out;
    };
    const { pkg } = await run(cleanScripts({ fact_checker: fc }));
    expect(pkg.case.steps.find((s) => s.id === 's1')!.confidence).toBe('disputed');
  });

  it('claimConcernsText matches a claim to the text it was taken from', () => {
    const body = 'The council voted 5-4 in June 2025 to postpone the replacement. The source is records.example.gov.';
    expect(claimConcernsText('The council voted 5-4 to postpone the replacement', body)).toBe(true);
    expect(claimConcernsText('Her civil complaint alleges malpractice by three hospital psychiatrists', body)).toBe(false);
    expect(claimConcernsText('Vote 5-4', body)).toBe(true); // too short to tell: counts as about the item
  });
});

describe('sources are opened before they are cited', () => {
  it('a source nobody opened leaves the package with its citations; the step keeps its opened source', async () => {
    const GHOST = 'https://news.example.com/never-opened-story';
    const drafter: FakeScript = (input: DrafterInput, ctx: AgentContext) => {
      const out = buildDraft(input, ctx);
      out.case.sources.push({ id: 'src-ghost', title: 'Ghost story', publisher: 'example', url: GHOST, date: '2025', type: 'news', accessed_at: `${ctx.asOf}T00:00:00Z` });
      const s = out.case.steps[0]!;
      s.source_ids = [...s.source_ids, 'src-ghost'];
      s.evidence = [...(s.evidence ?? []), { source_id: 'src-ghost', quote: 'The chair said the council knew of the risk for years.' }];
      return out;
    };
    const { pkg, store } = await run(cleanScripts({ drafter }));
    expect(pkg.case.sources.some((s) => s.url === GHOST)).toBe(false);
    expect(pkg.case.steps[0]!.source_ids).not.toContain('src-ghost');
    expect(pkg.case.steps[0]!.evidence?.some((e) => e.source_id === 'src-ghost')).toBe(false);
    expect(checkCitations(pkg.case, store)).toEqual([]);
    expect(validateCase(pkg.case).ok).toBe(true);
    expect(pkg.review.open_issues).toContainEqual(expect.objectContaining({ severity: 'high', description: expect.stringContaining('src-ghost') }));
  });
});

describe('every claim that reaches the drafter is in the research log', () => {
  it('a claim returned without log_claim is logged by the pipeline, and the accepted claim set is recorded', async () => {
    const silent: FakeScript = async (_input: ResearcherInput, ctx: AgentContext, tools: ResearchTools) => {
      const opened = await tools.openSource(URLS.minutes);
      return {
        claims: [
          {
            id: `${SIDE_A.id}-r${ctx.round}-1`,
            text: 'The council voted 5-4 in June 2025 to postpone the replacement.',
            quote: 'The council voted 5-4 to postpone the replacement project to the 2027 budget.',
            snapshot_id: opened.snapshot!.id,
            url: URLS.minutes,
            source_title: 'Minutes',
            publisher: 'records.example.gov',
            source_date: '2025',
            source_type: 'official',
            event_date: null,
            confidence: 'established',
            favors: SIDE_A.id,
            impact: 'high',
          },
        ],
        gaps: [],
        summary: 'one claim',
      };
    };
    const { log } = await run(cleanScripts({ [`researcher#${SIDE_A.id}`]: silent }));
    const rows = log.entries.filter((e) => e.kind === 'claim' && e.scope === SIDE_A.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: 'researcher', round: 0, url: URLS.minutes });
    expect(JSON.stringify(rows[0]!.claims)).toContain('"logged_by":"pipeline"');
    const accepted = log.entries.find((e) => e.kind === 'note' && e.scope === SIDE_A.id && e.excerpt?.startsWith('Accepted 1 claim(s)'));
    expect(accepted?.claims).toEqual([expect.objectContaining({ id: `${SIDE_A.id}-r0-1`, favors: SIDE_A.id, confidence: 'established', source_type: 'official', impact: 'high' })]);
    // A claim the researcher did log is not logged twice.
    const { log: log2 } = await run(cleanScripts());
    expect(log2.entries.filter((e) => e.kind === 'claim' && e.scope === SIDE_A.id)).toHaveLength(SIDE_A_CLAIMS.length);
  });
});

describe('what stays unresolved reaches the admin', () => {
  it('open non-blocking questions, researcher gaps and the drafter\'s research gaps become open issues', async () => {
    const hq = {
      questions: [
        { id: 'hq-1', question: 'Did the council have reserve funds?', blocking: false, status: 'open', step_ids: [] },
        { id: 'hq-2', side_id: SIDE_A.id, question: 'Why did two members switch votes?', blocking: false, status: 'open', step_ids: [] },
      ],
      gaps: [{ id: 'gap-1', description: 'Reserve fund balance', blocking: false, search_hint: 'county budget 2025' }],
      most_moving_fact: 'x',
    };
    const records = researcherScript(
      [{ url: URLS.breakNews, quote: 'The Elm Street water main broke on September 12, 2025, closing three blocks for four days.', text: 'The main broke on September 12, 2025.', type: 'news', favors: 'neutral' }],
      { gaps: [{ id: 'records-gap-1', description: 'No court filings could be opened.', blocking: false, search_hint: 'county court docket' }] },
    );
    const drafter: FakeScript = (input: DrafterInput, ctx: AgentContext): DrafterOutput => ({ ...buildDraft(input, ctx), research_gaps: ['When the main was installed.'] });
    const { pkg, runner } = await run(cleanScripts({ hard_questions: hq, records_researcher: records, drafter }));
    expect(pkg.clean).toBe(true);
    const issues = pkg.review.open_issues;
    expect(issues).toContainEqual(expect.objectContaining({ source: 'hard_questions', severity: 'low', description: expect.stringContaining('Did the council have reserve funds?') }));
    expect(issues).toContainEqual(expect.objectContaining({ source: 'hard_questions', severity: 'low', description: expect.stringContaining('Why did two members switch votes?') }));
    expect(issues).toContainEqual(expect.objectContaining({ source: 'pipeline', severity: 'low', description: expect.stringMatching(/records researcher: \(1\) No court filings could be opened\./) }));
    expect(issues).toContainEqual(expect.objectContaining({ source: 'pipeline', severity: 'low', description: expect.stringContaining('When the main was installed.') }));
    // The drafter and the hard-questions agent were told what the researchers could not find.
    expect((runner.callsTo('drafter')[0]!.input as DrafterInput).research_gaps).toEqual([expect.objectContaining({ scope: 'records', description: 'No court filings could be opened.' })]);
    expect((runner.callsTo('hard_questions')[0]!.input as HardQuestionsInput).research_gaps?.length).toBe(1);
  });

  it('when a research round runs, it also gets the open non-blocking questions and gaps', async () => {
    const hq = [
      {
        ...blockingHardQuestions,
        questions: [...blockingHardQuestions.questions, { id: 'hq-r1-2', side_id: blockingHardQuestions.questions[0]!.side_id, question: 'What did the 2025 budget hearing say?', blocking: false, status: 'open', step_ids: [] }],
      },
      { questions: [], gaps: [], most_moving_fact: 'x' },
    ];
    const { runner } = await run(cleanScripts({ hard_questions: hq }));
    const targeted = runner.callsTo('researcher', { round: 1 }).map((c) => c.input as ResearcherInput);
    const gaps = targeted.flatMap((i) => i.gaps ?? []);
    expect(gaps).toContainEqual(expect.objectContaining({ id: 'hq-r1-1', blocking: true }));
    expect(gaps).toContainEqual(expect.objectContaining({ id: 'hq-r1-2', blocking: false }));
  });

  it('a flag the drafter could not address is not recorded as addressed, and a medium one left for the admin is an open issue', async () => {
    const drafter: FakeScript = (input: DrafterInput, ctx: AgentContext): DrafterOutput => {
      const out = buildDraft(input, ctx);
      return { ...out, resolutions: out.resolutions.map((r) => ({ ...r, action: 'needs_admin' as const, resolution: 'Could not address: no opened source covers this.' })) };
    };
    const redTeam = [
      { summary: 'unfair', flags: [{ id: 'rt-x-1', kind: 'order_effect', severity: 'high', note: 'Move the grant step.' }, { id: 'rt-x-2', kind: 'loaded_wording', severity: 'medium', note: 'The question puts the burden on one side.' }] },
      { summary: 'fair now', flags: [] },
    ];
    const { pkg } = await run(cleanScripts({ drafter, red_team: redTeam }));
    const r1 = pkg.review.bias_reports.filter((b) => b.round === 1).flatMap((b) => b.flags);
    expect(r1.every((f) => f.status === 'unaddressed')).toBe(true);
    expect(r1[0]!.resolution).toContain('Drafter (needs admin): Could not address');
    // The scripted red-team answers are consumed one per call: the first side's round-1 call raised both flags.
    const redIssues = pkg.review.open_issues.filter((o) => o.source === 'red_team');
    expect(redIssues.map((o) => o.severity).sort()).toEqual(['high', 'medium']);
    expect(redIssues.find((o) => o.severity === 'medium')!.description).toContain('The question puts the burden on one side.');
    expect(redIssues.every((o) => o.description.includes('not addressed') && !o.resolved)).toBe(true);
  });

  it('judging words still in the final text are open issues for the admin', async () => {
    const drafter: FakeScript = (input: DrafterInput, ctx: AgentContext) => {
      const o = buildDraft(input, ctx);
      o.case.steps[0]!.headline = 'The council clearly made a shocking, brutal decision to postpone the repair.';
      return o;
    };
    const { pkg } = await run(cleanScripts({ drafter }));
    expect(pkg.review.open_issues).toContainEqual(
      expect.objectContaining({ source: 'editor', severity: 'medium', step_id: pkg.case.steps[0]!.id, description: expect.stringMatching(/judging word.*"clearly".*"shocking".*"brutal"/) }),
    );
  });
});

describe('the loop limit', () => {
  it('never runs more than 3 rounds, and a non-number falls back to 3', async () => {
    for (const maxRounds of [7, Number('abc')]) {
      const { pkg, runner } = await run(cleanScripts({ hard_questions: blockingHardQuestions }), { maxRounds });
      expect(pkg.rounds).toBe(MAX_ROUNDS);
      expect(runner.callsTo('hard_questions')).toHaveLength(3);
    }
  });

  it('a new case must say where the story stands on its as-of date', async () => {
    const { pkg, runner } = await run(cleanScripts());
    expect(pkg.outline.must_answer).toContain(statusItem(AS_OF));
    expect((runner.callsTo('hard_questions')[0]!.input as HardQuestionsInput).must_answer).toContain(statusItem(AS_OF));
  });
});
