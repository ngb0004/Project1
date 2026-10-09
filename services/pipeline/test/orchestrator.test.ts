import { describe, expect, it } from 'vitest';
import { assertValidCase, validateCase, type Case } from '@sia/case-schema';
import { checkCitations } from '../src/factcheck';
import { runCasePipeline, type PipelinePackage, type PipelineResult } from '../src/orchestrator';
import { FakeRunner, type FakeScript } from '../src/runner/fake';
import { AgentRunError } from '../src/runner/types';
import { AGENT_STANDARDS } from '../src/standards';
import {
  AS_OF,
  FABRICATED_QUOTE,
  FABRICATED_STEP_ID,
  RECORDS_CLAIMS,
  SIDE_A,
  SIDE_B,
  URLS,
  blockingHardQuestions,
  cleanHardQuestions,
  cleanScripts,
  drafterScript,
  editorScript,
  highFlagRedTeam,
  memoryStore,
  researcherScript,
} from './helpers';

const BRIEF = 'Maple County water main break';

async function run(scripts: Record<string, FakeScript>, opts: { maxRounds?: number; budgetUsd?: number; costPerCall?: number } = {}) {
  const { log, store, fetcher } = memoryStore();
  const runner = new FakeRunner(scripts, { costPerCall: opts.costPerCall ?? 0.01 });
  const result = await runCasePipeline(
    { kind: 'new_case', brief: BRIEF },
    { runner, store, runId: 'test-run', asOf: AS_OF, ...(opts.maxRounds ? { maxRounds: opts.maxRounds } : {}), ...(opts.budgetUsd ? { budgetUsd: opts.budgetUsd } : {}) },
  );
  return { result, runner, log, store, fetcher };
}

function asPackage(r: PipelineResult): PipelinePackage {
  if (r.kind !== 'package') throw new Error(`expected a package, got ${r.kind}`);
  return r;
}

describe('runCasePipeline (new case)', () => {
  it('turns a one-line brief into a schema-valid package whose sources were all opened in this run', async () => {
    const { result, store, runner } = await run(cleanScripts());
    const pkg = asPackage(result);

    const valid = assertValidCase(pkg.case);
    expect(valid.status).toBe('in_review');
    expect(valid.slug).toBe('maple-county-water-main');
    expect(valid.as_of).toBe(AS_OF);
    expect(pkg.case.sources.length).toBeGreaterThanOrEqual(4);
    for (const s of pkg.case.sources) {
      const snap = store.findByUrl(s.url);
      expect(snap, `${s.url} was opened`).toBeDefined();
      expect(snap!.status).toBe(200);
      // accessed_at is the real fetch time of that snapshot, not what the drafter wrote
      expect(s.accessed_at).toBe(snap!.fetchedAt);
    }
    expect(checkCitations(pkg.case, store)).toEqual([]);
    expect(pkg.researchLog.opened.length).toBe(store.opened().length);

    // Every agent ran, with the standards in its system prompt.
    const agents = runner.calls.map((c) => c.agent);
    for (const a of ['scoper', 'researcher', 'records_researcher', 'drafter', 'hard_questions', 'red_team', 'fact_checker', 'editor']) {
      expect(agents).toContain(a);
    }
    for (const c of runner.calls) expect(c.system).toContain(AGENT_STANDARDS);
    expect(runner.callsTo('researcher').map((c) => c.scope).sort()).toEqual([SIDE_A.id, SIDE_B.id].sort());
    expect(runner.callsTo('red_team').map((c) => c.scope).sort()).toEqual([SIDE_A.id, SIDE_B.id].sort());
  });

  it('stops after the first round when nothing is blocking', async () => {
    const { result, runner } = await run(cleanScripts());
    const pkg = asPackage(result);
    expect(pkg.rounds).toBe(1);
    expect(pkg.clean).toBe(true);
    expect(runner.callsTo('drafter')).toHaveLength(1);
    expect(runner.callsTo('hard_questions')).toHaveLength(1);
    expect(runner.callsTo('editor')).toHaveLength(1);
    expect(pkg.review.open_issues).toEqual([]);
    expect(pkg.review.rounds).toBe(1);
    // The package carries every review artifact the spec lists.
    expect(pkg.review.hard_questions.map((q) => q.id)).toEqual(['hq-1']);
    expect(pkg.review.bias_reports.map((b) => b.side_id).sort()).toEqual([SIDE_A.id, SIDE_B.id].sort());
    expect(pkg.review.fact_check.length).toBeGreaterThan(0);
    expect(pkg.review.fact_check.every((r) => r.verdict === 'supported')).toBe(true);
    expect(pkg.review.balance?.per_side).toEqual({ [SIDE_A.id]: 2, [SIDE_B.id]: 2 });
    expect(pkg.review.agent_reports).toHaveLength(runner.calls.length);
  });

  it('logs every agent call, and every query, open and claim, with agent, scope and round', async () => {
    const { log, runner } = await run(cleanScripts());
    const notes = log.entries.filter((e) => e.kind === 'note' && e.excerpt?.startsWith('Agent call finished'));
    expect(notes).toHaveLength(runner.calls.length);
    for (const c of runner.calls) {
      expect(notes.some((n) => n.agent === c.agent && (n.scope ?? undefined) === c.scope && n.round === c.round), `${c.agent}/${c.scope}/${c.round}`).toBe(true);
    }
    for (const scope of [SIDE_A.id, SIDE_B.id, 'records']) {
      const rows = log.entries.filter((e) => e.scope === scope && e.round === 0);
      expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['query', 'open', 'claim', 'note']));
    }
    const opens = log.entries.filter((e) => e.kind === 'open');
    expect(opens.every((o) => o.snapshot_id && o.http_status === 200)).toBe(true);
    const claim = log.entries.find((e) => e.kind === 'claim');
    expect(claim?.claims).toEqual([expect.objectContaining({ text: expect.any(String), quote: expect.any(String) })]);
  });

  it('loops back to targeted research and the drafter while a gap is blocking, then stops when it is closed', async () => {
    const { result, runner } = await run(
      cleanScripts({
        'hard_questions@1': blockingHardQuestions,
        'hard_questions@2': {
          ...blockingHardQuestions,
          questions: [{ ...blockingHardQuestions.questions[0]!, status: 'answered', resolution: 'Step s5 covers the deferred projects.' }],
        },
        [`researcher#${SIDE_B.id}@1`]: researcherScript([
          { url: URLS.analysis, quote: 'the state cuts forced counties to defer maintenance', text: 'Analysts said the cuts forced counties to defer maintenance.', type: 'analysis', favors: SIDE_B.id },
        ]),
      }),
    );
    const pkg = asPackage(result);
    expect(pkg.rounds).toBe(2);
    expect(pkg.clean).toBe(true);

    // The gap went to the side whose skeptic asked it, and only to that researcher.
    const targeted = runner.calls.filter((c) => (c.agent === 'researcher' || c.agent === 'records_researcher') && c.round === 1);
    expect(targeted.map((c) => c.scope)).toEqual([SIDE_B.id]);
    expect((targeted[0]!.input as { gaps: { description: string }[] }).gaps.map((g) => g.description)).toEqual([blockingHardQuestions.questions[0]!.question]);

    // The drafter revised the round-1 draft with the critique.
    const drafts = runner.callsTo('drafter');
    expect(drafts.map((c) => c.round)).toEqual([0, 1]);
    const revision = drafts[1]!.input as { previous?: unknown; critique?: { hard_questions?: { id: string }[] }; claims: unknown[] };
    expect(revision.previous).toBeDefined();
    expect(revision.critique?.hard_questions?.map((q) => q.id)).toEqual(['hq-r1-1']);
    expect(revision.claims.length).toBe(6);

    const q = pkg.review.hard_questions.find((x) => x.id === 'hq-r1-1')!;
    expect(q.status).toBe('answered');
    expect(q.round).toBe(1);
    expect(q.resolution).toContain('Drafter: Addressed in the revision.');
    expect(pkg.review.open_issues).toEqual([]);
  });

  it('stops at 3 rounds and turns everything unresolved into open issues', async () => {
    const { result, runner } = await run(
      cleanScripts({
        hard_questions: blockingHardQuestions,
        [`red_team#${SIDE_B.id}`]: highFlagRedTeam,
      }),
    );
    const pkg = asPackage(result);
    expect(pkg.rounds).toBe(3);
    expect(pkg.clean).toBe(false);
    expect(runner.callsTo('hard_questions').map((c) => c.round)).toEqual([1, 2, 3]);
    expect(runner.callsTo('drafter').map((c) => c.round)).toEqual([0, 1, 2]);
    expect(runner.callsTo('editor')).toHaveLength(1);

    const sources = pkg.review.open_issues.map((o) => o.source).sort();
    expect(sources).toEqual(['hard_questions', 'red_team']);
    expect(pkg.review.open_issues.every((o) => o.severity === 'high' && !o.resolved)).toBe(true);
    expect(pkg.review.open_issues.find((o) => o.source === 'red_team')?.description).toContain('order effect');
    // Earlier rounds' flags were addressed by the drafter; the last round's are not.
    const reports = pkg.review.bias_reports.filter((b) => b.side_id === SIDE_B.id);
    expect(reports.map((b) => b.round)).toEqual([1, 2, 3]);
    expect(reports.map((b) => b.flags[0]!.status)).toEqual(['addressed', 'addressed', 'unaddressed']);
    expect(validateCase(pkg.case).ok).toBe(true);
  });

  it('runs each red team as a fresh call that receives only the draft, never the drafter\'s reasoning', async () => {
    const MARKER = 'DRAFTER-REASONING-7f3a';
    const { runner } = await run(
      cleanScripts({
        hard_questions: blockingHardQuestions,
        drafter: drafterScript({ reasoningMarker: MARKER }),
      }),
    );
    const reds = runner.callsTo('red_team');
    expect(reds).toHaveLength(6); // 2 sides x 3 rounds, one call each
    for (const c of reds) {
      const input = c.input as Record<string, unknown>;
      expect(Object.keys(input).sort()).toEqual(['draft', 'side', 'sources']);
      const draft = input.draft as Record<string, unknown>;
      expect(draft).not.toHaveProperty('review');
      expect(draft).not.toHaveProperty('resolutions');
      expect(JSON.stringify(input)).not.toContain(MARKER);
      expect(c.prompt).not.toContain(MARKER);
      expect(c.access).toBe('read_sources');
    }
    // The drafter's reasoning did reach the review record, so the marker was really produced.
    const drafterRevisions = runner.callsTo('drafter').filter((c) => c.round > 0);
    expect(drafterRevisions.length).toBe(2);
    expect(JSON.stringify(runner.callsTo('drafter', { round: 1 })[0]!.output)).toContain(MARKER);
  });

  it('fails a fabricated claim planted in the draft (fact-checker and citation check), and reports it as an open issue', async () => {
    const { result, runner, store } = await run(cleanScripts({ drafter: drafterScript({ plantFabrication: true }) }));
    const pkg = asPackage(result);
    expect(pkg.clean).toBe(false);
    expect(pkg.rounds).toBe(3);

    // The planted quote is really absent from every snapshot of its source.
    for (const snap of store.findAllByUrl(URLS.breakNews)) expect(snap.text).not.toContain(FABRICATED_QUOTE);

    const rows = pkg.review.fact_check.filter((r) => r.target === FABRICATED_STEP_ID);
    // The LLM fact-checker (re-reading the snapshot with read_source) fails it...
    expect(rows.some((r) => r.verdict === 'unsupported' && !r.note?.startsWith('Deterministic'))).toBe(true);
    // ...and so does the deterministic layer, in every round.
    const det = rows.filter((r) => r.verdict === 'unsupported' && r.note?.startsWith('Deterministic'));
    expect(det.map((r) => r.round)).toEqual([1, 2, 3]);
    expect(det[0]!.quote).toBe(FABRICATED_QUOTE);

    const issues = pkg.review.open_issues.filter((o) => o.source === 'fact_checker' && o.step_id === FABRICATED_STEP_ID);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.every((o) => o.severity === 'high')).toBe(true);
    // The fact-checker re-read the cited snapshots through its tools.
    expect(runner.callsTo('fact_checker').every((c) => c.access === 'read_sources')).toBe(true);
  });

  it('passes once the drafter removes the fabricated claim', async () => {
    const { result } = await run(cleanScripts({ drafter: drafterScript((input) => ({ plantFabrication: !input.previous })) }));
    const pkg = asPackage(result);
    expect(pkg.rounds).toBe(2);
    expect(pkg.clean).toBe(true);
    expect(pkg.case.steps.some((s) => s.id === FABRICATED_STEP_ID)).toBe(false);
    expect(pkg.review.fact_check.some((r) => r.target === FABRICATED_STEP_ID && r.round === 1 && r.verdict === 'unsupported')).toBe(true);
    expect(pkg.review.open_issues).toEqual([]);
  });

  it('falls back to the last valid draft when the editor breaks a quote, and says so in an open issue', async () => {
    const { result, store } = await run(
      cleanScripts({
        editor: editorScript((d) => {
          d.steps[0]!.evidence = [{ source_id: d.steps[0]!.source_ids[0]!, quote: 'The council voted unanimously to cancel the project.' }];
          d.steps[1]!.headline = 'Edited headline';
          return d;
        }),
      }),
    );
    const pkg = asPackage(result);
    expect(pkg.editorFallback).toBe(true);
    expect(pkg.case.steps[1]!.headline).not.toBe('Edited headline');
    expect(checkCitations(pkg.case, store)).toEqual([]);
    expect(pkg.review.open_issues).toEqual([expect.objectContaining({ source: 'editor', severity: 'medium' })]);
  });

  it('keeps the editor\'s version when it passes the same checks', async () => {
    const { result } = await run(
      cleanScripts({
        editor: editorScript((d) => {
          d.steps[1]!.headline = 'A 2024 inspection rated the Elm Street main poor.';
          return d;
        }),
      }),
    );
    const pkg = asPackage(result);
    expect(pkg.editorFallback).toBe(false);
    expect(pkg.case.steps[1]!.headline).toBe('A 2024 inspection rated the Elm Street main poor.');
  });

  it('drops researcher claims whose quote is not in the snapshot they cite', async () => {
    const bad: FakeScript = async (input, ctx, tools) => {
      const out = await (researcherScript(RECORDS_CLAIMS) as (...a: unknown[]) => Promise<{ claims: { quote: string }[] }>)(input, ctx, tools);
      out.claims[0]!.quote = 'A sentence that the page never contained at all.';
      return out;
    };
    const { result, log } = await run(cleanScripts({ records_researcher: bad }));
    const pkg = asPackage(result);
    expect(pkg.case.sources.some((s) => s.url === URLS.breakNews)).toBe(false);
    expect(log.entries.some((e) => e.agent === 'pipeline' && e.excerpt?.includes('could not be verified'))).toBe(true);
  });

  it('keeps the current draft when a revision fails, and reports what is still unresolved', async () => {
    const { result, runner } = await run(
      cleanScripts({
        hard_questions: blockingHardQuestions,
        'drafter@1': () => {
          throw new Error('drafter crashed');
        },
      }),
    );
    const pkg = asPackage(result);
    expect(pkg.rounds).toBe(1);
    expect(runner.callsTo('editor')).toHaveLength(1);
    expect(validateCase(pkg.case).ok).toBe(true);
    expect(pkg.review.open_issues.map((o) => o.source).sort()).toEqual(['hard_questions', 'pipeline']);
    expect(pkg.review.open_issues.find((o) => o.source === 'pipeline')?.description).toMatch(/revision in round 1 failed \(drafter crashed\)/);
  });

  it('treats a critic that does not finish as blocking and reports it', async () => {
    const { result } = await run(
      cleanScripts({
        fact_checker: () => {
          throw new Error('fact-checker ran out of turns');
        },
      }),
    );
    const pkg = asPackage(result);
    expect(pkg.clean).toBe(false);
    expect(pkg.rounds).toBe(3);
    expect(pkg.review.open_issues).toEqual([
      expect.objectContaining({ source: 'pipeline', severity: 'high', description: expect.stringContaining('fact-checker ran out of turns') }),
    ]);
  });

  it('keeps the claims a researcher logged before it hit its turn limit', async () => {
    const stopsEarly: FakeScript = async (_input, _ctx, tools) => {
      const opened = await tools.openSource(URLS.grants);
      await tools.logClaim('The state cut water grants by 40 percent.', 'reduced local water infrastructure grants by 40 percent', opened.snapshot!.id);
      throw new AgentRunError('researcher stopped: error_max_turns', 'researcher', 0.5, 'max_turns');
    };
    const { result } = await run(cleanScripts({ [`researcher#${SIDE_B.id}`]: stopsEarly }));
    const pkg = asPackage(result);
    const grants = pkg.case.sources.find((s) => s.url === URLS.grants);
    expect(grants).toMatchObject({ type: 'news' });
    expect(pkg.review.open_issues).toEqual([expect.objectContaining({ source: 'pipeline', description: expect.stringMatching(/council-not-responsible.*error_max_turns.*1 claim/) })]);
  });

  it('stops the loop when the run budget is used up and says so', async () => {
    const { result } = await run(cleanScripts({ hard_questions: blockingHardQuestions }), { budgetUsd: 0.12, costPerCall: 0.01 });
    const pkg = asPackage(result);
    expect(pkg.rounds).toBeLessThan(3);
    expect(pkg.review.open_issues.some((o) => o.source === 'pipeline' && /budget/.test(o.description))).toBe(true);
    expect(validateCase(pkg.case).ok).toBe(true);
  });
});

describe('runCasePipeline (revisions and updates)', () => {
  async function baseCase(): Promise<Case> {
    const { result } = await run(cleanScripts());
    const pkg = asPackage(result);
    return { ...pkg.case, id: '7d1c6a52-0000-4000-8000-000000000001', status: 'published', version: 3 } as Case;
  }

  it('a revision re-opens the base sources, researches the admin notes and keeps the case identity', async () => {
    const base = await baseCase();
    const { log, store } = memoryStore();
    const runner = new FakeRunner(cleanScripts({ researcher: researcherScript([]), records_researcher: researcherScript([]) }));
    const result = await runCasePipeline(
      { kind: 'revision', base, instructions: 'Say who chairs the council.' },
      { runner, store, runId: 'rev', asOf: AS_OF },
    );
    const pkg = asPackage(result);
    expect(runner.callsTo('scoper')).toHaveLength(0);
    expect(pkg.case.id).toBe(base.id);
    expect(pkg.case.slug).toBe(base.slug);
    expect(pkg.case.parent_version).toBe(3);
    expect(pkg.case.version).toBe(4);
    const reopened = log.entries.filter((e) => e.kind === 'open' && e.agent === 'pipeline' && e.scope === 'base_sources');
    expect(reopened.length).toBe(new Set(base.sources.map((s) => s.url)).size);
    expect(checkCitations(pkg.case, store)).toEqual([]);
    const research = runner.callsTo('researcher', { round: 0 })[0]!.input as { gaps: { description: string }[] };
    expect(research.gaps[0]!.description).toContain('Say who chairs the council.');
    const draft = runner.callsTo('drafter', { round: 0 })[0]!.input as { instructions?: string; base?: unknown };
    expect(draft.instructions).toBe('Say who chairs the council.');
    expect(draft.base).toBeDefined();
  });

  it('an update with nothing new after the live as_of returns no_changes', async () => {
    const live = await baseCase();
    const { store } = memoryStore();
    const runner = new FakeRunner(cleanScripts());
    const result = await runCasePipeline({ kind: 'update', live }, { runner, store, runId: 'upd', asOf: '2026-10-09' });
    expect(result.kind).toBe('no_changes');
    expect(runner.callsTo('drafter')).toHaveLength(0);
    const r = runner.callsTo('researcher')[0]!.input as { sinceAsOf?: string; known_facts?: string[] };
    expect(r.sinceAsOf).toBe(live.as_of);
    expect(r.known_facts?.length).toBeGreaterThan(0);
  });

  it('an update with a material new development drafts a revision of the live version', async () => {
    const live = await baseCase();
    const { store } = memoryStore();
    const runner = new FakeRunner(
      cleanScripts({
        records_researcher: researcherScript([
          { url: URLS.audit, quote: 'moved $400,000 of water repair funds to road paving in 2025', text: 'An audit found $400,000 of repair funds went to paving.', type: 'news', favors: SIDE_A.id, impact: 'high', date: '2026-10-05' },
        ]),
      }),
    );
    const result = await runCasePipeline({ kind: 'update', live }, { runner, store, runId: 'upd2', asOf: '2026-10-09' });
    const pkg = asPackage(result);
    expect(pkg.case.parent_version).toBe(live.version);
    expect(pkg.case.as_of).toBe('2026-10-09');
    expect(pkg.case.sources.some((s) => s.url === URLS.audit)).toBe(true);
    expect(pkg.case.steps.length).toBe(live.steps.length + 1);
    expect(checkCitations(pkg.case, store)).toEqual([]);
  });
});
