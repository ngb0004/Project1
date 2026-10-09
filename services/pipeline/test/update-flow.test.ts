import { describe, expect, it } from 'vitest';
import { diffCases, validateCase, type Case } from '@sia/case-schema';
import type { DrafterInput } from '../src/agents/drafter';
import type { HardQuestionsInput } from '../src/agents/hardQuestions';
import type { ResearchClaim, ResearcherInput } from '../src/agents/researcher';
import { checkCitations } from '../src/factcheck';
import { MemoryResearchLog } from '../src/research/log';
import { SourceStore } from '../src/research/store';
import { PipelineError, runCasePipeline, type PipelinePackage, type PipelineResult } from '../src/orchestrator';
import { FakeRunner, type FakeScript } from '../src/runner/fake';
import { describeScreening, isAfter, screenDevelopments, updateSummaryText } from '../src/update';
import { AS_OF, PAGES, SIDE_A, SIDE_B, URLS, blockingHardQuestions, buildDraft, cleanHardQuestions, cleanScripts, drafterScript, memoryStore, researcherScript } from './helpers';

/**
 * Live updates at the orchestrator level (no database): what the researchers
 * are asked, which claims count as developments, what the drafter and the
 * critics receive, when an update ends with no changes, and the update summary
 * that goes into the review record.
 */

const UPDATE_DAY = '2026-10-09';

const AUDIT = {
  url: URLS.audit,
  quote: 'moved $400,000 of water repair funds to road paving in 2025',
  text: 'An audit released on October 5, 2026 found $400,000 of water repair funds went to road paving.',
  type: 'news' as const,
  favors: SIDE_A.id,
  impact: 'high' as const,
  date: '2026-10-05',
};
const RESTORE = {
  url: URLS.restore,
  quote: 'voted 7-2 to move $400,000 from road paving back to the water repair fund',
  text: 'On October 11, 2026 the council voted 7-2 to move $400,000 back to the water repair fund.',
  type: 'news' as const,
  favors: SIDE_B.id,
  impact: 'high' as const,
  date: '2026-10-11',
};

const quiet: Record<string, FakeScript> = {
  [`researcher#${SIDE_A.id}`]: researcherScript([]),
  [`researcher#${SIDE_B.id}`]: researcherScript([]),
  records_researcher: researcherScript([]),
};

function asPackage(r: PipelineResult): PipelinePackage {
  if (r.kind !== 'package') throw new Error(`expected a package, got ${r.kind}: ${'summary' in r ? r.summary : ''}`);
  return r;
}

/** A published version 3, as the live case an update starts from. */
async function liveCase(): Promise<Case> {
  const { store } = memoryStore();
  const r = await runCasePipeline({ kind: 'new_case', brief: 'Maple County water main break' }, { runner: new FakeRunner(cleanScripts()), store, runId: 'base', asOf: AS_OF });
  return { ...asPackage(r).case, id: '7d1c6a52-0000-4000-8000-000000000003', status: 'published', version: 3 } as Case;
}

async function update(
  live: Case,
  scripts: Record<string, FakeScript>,
  opts: { pending?: Case; asOf?: string; signal?: AbortSignal; pages?: typeof PAGES; archive?: Parameters<typeof runCasePipeline>[1]['archive'] } = {},
) {
  const { store, log } = memoryStore(opts.pages);
  const runner = new FakeRunner(cleanScripts(scripts));
  const result = await runCasePipeline(
    { kind: 'update', live, ...(opts.pending ? { pending: opts.pending } : {}) },
    { runner, store, runId: 'upd', asOf: opts.asOf ?? UPDATE_DAY, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.archive ? { archive: opts.archive } : {}) },
  );
  return { result, runner, store, log };
}

const claim = (over: Partial<ResearchClaim>): ResearchClaim => ({
  id: 'c-1',
  text: 'A fact.',
  quote: 'a quote long enough to be checked',
  snapshot_id: 'snap',
  url: 'https://example.org/a',
  source_title: 'A',
  publisher: 'example.org',
  source_date: null,
  source_type: 'news',
  event_date: null,
  confidence: 'reported',
  favors: 'neutral',
  impact: 'medium',
  ...over,
});

describe('screenDevelopments', () => {
  it('keeps only dated, material claims that the base version does not already carry', async () => {
    const live = await liveCase();
    const knownQuote = live.steps[0]!.evidence![0]!.quote;
    const s = screenDevelopments(
      [
        claim({ id: 'new-event', event_date: '2026-10-05' }),
        claim({ id: 'new-source', source_date: '2026-10-06', event_date: '2025-06-03' }),
        claim({ id: 'month-only', source_date: '2026-10' }),
        claim({ id: 'old', source_date: '2026-09-30', event_date: '2025-06-03' }),
        claim({ id: 'same-day', event_date: live.as_of }),
        claim({ id: 'undated' }),
        claim({ id: 'low', event_date: '2026-10-05', impact: 'low' }),
        claim({ id: 'repeat', source_date: '2026-10-07', quote: knownQuote }),
      ],
      live.as_of,
      live,
    );
    expect(s.material.map((c) => c.id)).toEqual(['new-event', 'new-source', 'month-only']);
    expect(Object.fromEntries(s.dropped.map((d) => [d.claim.id, d.reason]))).toEqual({
      old: 'not_after',
      'same-day': 'not_after',
      undated: 'undated',
      low: 'low_impact',
      repeat: 'already_known',
    });
    expect(describeScreening(s, 3)).toBe(
      `8 verified claim(s) found: 3 new development(s), 2 dated on or before ${live.as_of}, 1 with no date, 1 low impact, 1 already in version 3`,
    );
    expect(isAfter('2026', '2026-10-01')).toBe(true);
    expect(isAfter('2025-12-31', '2026-10-01')).toBe(false);
  });
});

describe('runCasePipeline (live updates)', () => {
  it('asks every researcher only for developments after the live as-of date, with what the case already states and its open questions', async () => {
    const live = await liveCase();
    const { result, runner } = await update(live, quiet);
    expect(result.kind).toBe('no_changes');
    const calls = [...runner.callsTo('researcher'), ...runner.callsTo('records_researcher')];
    expect(calls.map((c) => c.scope).sort()).toEqual([SIDE_A.id, SIDE_B.id, 'records'].sort());
    for (const c of calls) {
      const input = c.input as ResearcherInput;
      expect(input.sinceAsOf).toBe(live.as_of);
      expect(input.known_facts).toEqual(expect.arrayContaining([live.steps[0]!.headline, live.starting_facts[0]!.text]));
      expect(input.open_questions).toEqual(live.open_questions);
      expect(c.prompt).toContain(`Look only for developments dated after ${live.as_of}`);
      expect(c.prompt).toContain('<open_questions>');
    }
    expect(runner.callsTo('scoper')).toHaveLength(0);
    expect(runner.callsTo('drafter')).toHaveLength(0);
  });

  it('with nothing new it ends as no_changes and says why, in the result and the research log', async () => {
    const live = await liveCase();
    // A researcher re-finds a fact from before the live as-of date: that is not a development.
    const { result, log } = await update(live, { ...quiet, records_researcher: researcherScript([{ ...AUDIT, date: '2026-09-20' }]) });
    expect(result.kind).toBe('no_changes');
    if (result.kind !== 'no_changes') return;
    expect(result.summary).toBe(
      `No material developments since ${live.as_of} (version 3): 1 verified claim(s) found: 1 dated on or before ${live.as_of}. Nothing was drafted or submitted.`,
    );
    expect(result).toMatchObject({ baseVersion: 3, since: live.as_of });
    expect(log.entries.some((e) => e.kind === 'note' && e.excerpt === result.summary)).toBe(true);
  });

  it('fails instead of reporting no changes when a researcher failed and the rest found nothing', async () => {
    const live = await liveCase();
    const broken: FakeScript = () => {
      throw new Error('search backend down');
    };
    await expect(update(live, { ...quiet, [`researcher#${SIDE_B.id}`]: broken })).rejects.toThrow(/incomplete .*search backend down/);
  });

  it('a stopped run never reports no changes', async () => {
    const live = await liveCase();
    const abort = new AbortController();
    const hang: FakeScript = () => {
      abort.abort(new Error('worker stopping'));
      return new Promise(() => {});
    };
    const err = await update(live, { ...quiet, records_researcher: hang }, { signal: abort.signal }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(PipelineError);
  });

  it('a development becomes a revision of the live version: same ids for unchanged facts, one step and one source added, and an update summary for the admin', async () => {
    const live = await liveCase();
    const { result, runner, store } = await update(live, { ...quiet, records_researcher: researcherScript([AUDIT]) });
    const pkg = asPackage(result);
    expect(validateCase(pkg.case).ok).toBe(true);
    expect(pkg.case).toMatchObject({ id: live.id, slug: live.slug, parent_version: 3, as_of: UPDATE_DAY, status: 'in_review' });
    expect(checkCitations(pkg.case, store)).toEqual([]);

    // The diff against the live version is exactly the development (and the as-of date).
    const d = diffCases(live, pkg.case);
    expect(d.fields.map((f) => f.path)).toEqual(['as_of']);
    expect(d.steps.filter((x) => x.status !== 'unchanged').map((x) => x.status)).toEqual(['added']);
    expect(d.sources.filter((x) => x.status !== 'unchanged').map((x) => x.status)).toEqual(['added']);
    expect(d.startingFacts.every((x) => x.status === 'unchanged')).toBe(true);
    expect(d.sides.every((x) => x.status === 'unchanged')).toBe(true);
    const added = pkg.case.steps.find((s) => !live.steps.some((l) => l.id === s.id))!;
    expect(added.source_ids.map((id) => pkg.case.sources.find((s) => s.id === id)!.url)).toEqual([URLS.audit]);

    // The drafter got the live version, the developments and the update rules; the critics checked the developments.
    const drafter = runner.callsTo('drafter', { round: 0 })[0]!;
    const dIn = drafter.input as DrafterInput;
    expect(dIn.base?.version).toBe(3);
    expect(dIn.claims.map((c) => c.url)).toEqual([URLS.audit]);
    expect(dIn.update).toEqual({ live_version: 3, base_version: 3, since: live.as_of, developments: [dIn.claims[0]!.id], used_step_ids: live.steps.map((s) => s.id) });
    expect(drafter.prompt).toContain('Live update of published version 3');
    expect(drafter.system).toContain('Live updates (the prompt has an <update> block)');
    const hq = runner.callsTo('hard_questions', { round: 1 })[0]!.input as HardQuestionsInput;
    expect(hq.must_answer[0]).toBe(
      `New since ${live.as_of}: "${AUDIT.text}" (news.example.com, 2026-10-05). Does the draft report it with its date and source, or is it immaterial to the question?`,
    );
    expect(hq.must_answer.some((m) => m.includes('correct or retire each step'))).toBe(true);
    for (const q of live.open_questions) expect(hq.must_answer).not.toContain(q);
    // The live facts were reviewed and edited before: in the loop the drafter changes them only for blocking findings,
    // and the editor is told which items are unchanged so it leaves them alone.
    expect(drafter.system).toContain('change a fact that no development touches only for a blocking finding');
    const editor = runner.callsTo('editor')[0]!;
    expect((editor.input as { unchanged?: string[] }).unchanged).toEqual([...live.starting_facts.map((f) => `fact:${f.id}`), ...live.steps.map((s) => s.id)]);
    expect(editor.prompt).toContain('Live update. These items are unchanged from the live version');

    // The update summary: in the package, and as the editor's "update" report in the review record.
    expect(pkg.update).toMatchObject({ live_version: 3, base_version: 3, since: live.as_of, developments: [{ url: URLS.audit, date: '2026-10-05' }] });
    const report = pkg.review.agent_reports.find((r) => r.agent === 'editor' && r.scope === 'update')!;
    expect(report.summary).toBe(pkg.update!.summary);
    expect(report.summary).toContain(`Update of live version 3 (as of ${live.as_of}): re-researched for developments after ${live.as_of}.`);
    expect(report.summary).toContain(`What changed against the live version: As-of date changed from ${live.as_of} to ${UPDATE_DAY}. 1 step added (${added.id}), 1 source added (`);
    expect(report.summary).toContain(`1. [2026-10-05, news.example.com, news] ${AUDIT.text} In the draft: ${added.id}.`);
    // Unchanged base sources keep their access time, so the diff does not show every source as changed.
    for (const s of live.sources) expect(pkg.case.sources.find((x) => x.id === s.id)?.accessed_at).toBe(s.accessed_at);
  });

  it('builds on the update already waiting for review: researches since its as-of date, keeps the live version as parent', async () => {
    const live = await liveCase();
    const first = asPackage((await update(live, { ...quiet, records_researcher: researcherScript([AUDIT]) })).result);
    const pending = { ...first.case, version: 4, status: 'in_review' } as Case;
    const { result, runner } = await update(
      live,
      { ...quiet, records_researcher: researcherScript([AUDIT, RESTORE]) },
      { pending, asOf: '2026-10-12' },
    );
    const pkg = asPackage(result);
    expect(pkg.case.parent_version).toBe(3);
    const r = runner.callsTo('records_researcher')[0]!.input as ResearcherInput;
    expect(r.sinceAsOf).toBe(UPDATE_DAY);
    // The audit (dated before the pending package's as-of date) is not new again; the council vote is.
    expect((runner.callsTo('drafter', { round: 0 })[0]!.input as DrafterInput).claims.map((c) => c.url)).toEqual([URLS.restore]);
    expect(pkg.update).toMatchObject({ live_version: 3, base_version: 4, since: UPDATE_DAY });
    expect(pkg.update!.summary).toContain('Builds on version 4, the earlier update still waiting for review, and replaces it in the queue.');
    // Against the live version the package carries both developments.
    const d = diffCases(live, pkg.case);
    expect(d.steps.filter((x) => x.status === 'added')).toHaveLength(2);
    expect(pkg.update!.summary).toContain('2 steps added');
  });

  it('claims researched later for the critics are not counted as developments', async () => {
    const live = await liveCase();
    const { result, runner } = await update(live, {
      ...quiet,
      records_researcher: researcherScript([AUDIT]),
      // Round 1 finds a blocking question; the round-1 research closes it with another claim.
      hard_questions: [blockingHardQuestions, cleanHardQuestions],
      [`researcher#${SIDE_B.id}@1`]: researcherScript([{ ...RESTORE, date: '2026-10-08' }]),
    });
    const pkg = asPackage(result);
    expect(runner.callsTo('drafter')).toHaveLength(2);
    expect(pkg.update!.developments.map((d) => d.url)).toEqual([URLS.audit]);
    expect(pkg.update!.summary).toContain(`Why: 1 new development(s) since ${live.as_of}`);
  });

  it('ends as no_changes when the reviewed draft changes nothing but the as-of date', async () => {
    const live = await liveCase();
    // A drafter that judges the development immaterial and returns the live version as it is.
    const keep: FakeScript = (input: DrafterInput, ctx) => {
      const out = buildDraft({ ...input, claims: [] as ResearchClaim[] }, ctx);
      out.case.steps = structuredClone(live.steps);
      out.case.sources = structuredClone(live.sources);
      return { case: out.case, resolutions: input.update!.developments.map((ref) => ({ ref, resolution: 'Left out: the audit does not bear on the 2025 vote.' })) };
    };
    const { result } = await update(live, { ...quiet, records_researcher: researcherScript([AUDIT]), drafter: keep });
    expect(result.kind).toBe('no_changes');
    if (result.kind !== 'no_changes') return;
    expect(result.summary).toMatch(/^No material change to version 3: the researchers found 1 development\(s\) since 2026-10-01, but the reviewed draft changes nothing beyond its as-of date/);
    expect(result.summary).toContain('drafter: Left out: the audit does not bear on the 2025 vote.');
  });

  it('a revision (not an update) still gets the snapshot time for new sources and no update summary', async () => {
    const live = await liveCase();
    const { store } = memoryStore();
    const r = await runCasePipeline(
      { kind: 'revision', base: live, instructions: 'Add the audit.' },
      { runner: new FakeRunner(cleanScripts({ ...quiet, records_researcher: researcherScript([AUDIT]), drafter: drafterScript() })), store, runId: 'rev', asOf: UPDATE_DAY },
    );
    const pkg = asPackage(r);
    expect(pkg.update).toBeUndefined();
    expect(pkg.review.agent_reports.some((x) => x.scope === 'update')).toBe(false);
    const audit = pkg.case.sources.find((s) => s.url === URLS.audit)!;
    expect(audit.accessed_at).toBe(store.findByUrl(URLS.audit)!.fetchedAt);
  });
});

describe('a source that changed since the live version cited it', () => {
  it('unchanged facts are checked against the archived snapshot, the admin is told, and the diff shows only the development', async () => {
    // The live version's own run, whose snapshots are the archive.
    const base = memoryStore();
    const r = await runCasePipeline({ kind: 'new_case', brief: 'Maple County water main break' }, { runner: new FakeRunner(cleanScripts()), store: base.store, runId: 'base', asOf: AS_OF });
    const live = { ...asPackage(r).case, id: '7d1c6a52-0000-4000-8000-000000000003', status: 'published', version: 3 } as Case;
    const archive = base.log.snapshots.map((x) => ({ ...x, job_id: 'job-of-v3' }));
    // Since then the council put its minutes behind a login page.
    const paywalled = { ...PAGES, [URLS.minutes]: { title: 'Sign in', text: 'Sign in to read council records. Create an account or log in with your library card to continue to this page. '.repeat(3) } };

    const { result, store, log } = await update(live, { ...quiet, records_researcher: researcherScript([AUDIT]) }, { pages: paywalled, archive });
    const pkg = asPackage(result);
    // Every citation checks out, the minutes' passage against the archived snapshot.
    expect(checkCitations(pkg.case, store)).toEqual([]);
    const minutesStep = live.steps.find((s) => s.source_ids.includes('src-minutes-2025-06-03'))!;
    // Without the archive the same facts would fail: the page as it is now no longer has the passage.
    const freshOnly = new SourceStore({ log: new MemoryResearchLog() });
    freshOnly.load(store.opened().map((x) => ({ id: x.id, url: x.url, final_url: x.finalUrl, http_status: x.status, content_type: x.contentType, title: x.title, sha256: x.sha256, text_content: x.text, fetched_at: x.fetchedAt })));
    expect(checkCitations(pkg.case, freshOnly)).toContainEqual(expect.objectContaining({ target: minutesStep.id, verdict: 'unsupported' }));

    // The facts stay as they were: the diff against the live version is the development alone.
    const d = diffCases(live, pkg.case);
    expect(d.steps.filter((x) => x.status !== 'unchanged').map((x) => x.status)).toEqual(['added']);
    expect(d.sources.filter((x) => x.status !== 'unchanged').map((x) => x.status)).toEqual(['added']);

    // The admin is told, and so is the research log; archived snapshots are not counted as opened in this run.
    const issue = pkg.review.open_issues.find((o) => o.description.startsWith('Source "src-minutes-2025-06-03"'));
    expect(issue).toMatchObject({ source: 'pipeline', severity: 'medium' });
    expect(issue!.description).toMatch(/has changed since version 3 cited it: re-opened in this run it has \d+ characters of text, and 1 of the 1 passage\(s\) the case quotes from it are no longer in it\. The facts that cite it are checked against the snapshot taken on \d{4}-\d{2}-\d{2} \(job job-of-v\), which still has the quoted passages/);
    expect(log.entries.some((e) => e.kind === 'note' && e.excerpt?.startsWith(`Loaded ${archive.length} archived snapshot(s) of version 3's sources`))).toBe(true);
    expect(pkg.researchLog.opened.every((o) => !archive.some((a) => a.id === o.snapshot_id))).toBe(true);
    expect(store.archived()).toHaveLength(archive.length);
  });

  it('archived snapshots cannot back a new claim', async () => {
    const base = memoryStore();
    const r = await runCasePipeline({ kind: 'new_case', brief: 'Maple County water main break' }, { runner: new FakeRunner(cleanScripts()), store: base.store, runId: 'base', asOf: AS_OF });
    const live = { ...asPackage(r).case, id: '7d1c6a52-0000-4000-8000-000000000003', status: 'published', version: 3 } as Case;
    const archive = base.log.snapshots.map((x) => ({ ...x, job_id: 'job-of-v3' }));
    const minutes = archive.find((a) => a.url === URLS.minutes)!;
    // A researcher that cites the archived snapshot instead of opening the page.
    const cheat: FakeScript = () => ({
      claims: [
        {
          id: 'records-r0-1',
          text: 'The council voted 5-4 to postpone the replacement.',
          quote: 'The council voted 5-4 to postpone the replacement project to the 2027 budget.',
          snapshot_id: minutes.id,
          url: URLS.minutes,
          source_title: 'Minutes',
          publisher: 'records.example.gov',
          source_date: '2026-10-05',
          source_type: 'official',
          event_date: null,
          confidence: 'established',
          favors: SIDE_A.id,
          impact: 'high',
        },
      ],
      gaps: [],
      summary: 'One claim.',
    });
    const { result, log } = await update(live, { ...quiet, records_researcher: cheat }, { archive });
    expect(result.kind).toBe('no_changes');
    expect(log.entries.some((e) => e.kind === 'note' && /records-r0-1: snapshot .* was not taken in this run/.test(e.excerpt ?? ''))).toBe(true);
  });
});

describe('updateSummaryText', () => {
  it('lists retired steps, answered and new open questions, and what the screen left out, within 4,000 characters', async () => {
    const live = await liveCase();
    const final = { ...structuredClone(live), status: 'draft' as const, as_of: UPDATE_DAY };
    delete (final as Partial<Case>).review;
    const retired = final.steps.pop()!;
    final.open_questions = ['Will the state restore the grants?'];
    const many = Array.from({ length: 14 }, (_, i) => claim({ id: `d-${i}`, text: `Development ${i} `.repeat(30), event_date: '2026-10-05' }));
    const text = updateSummaryText({
      live,
      base: live,
      since: live.as_of,
      final: final as never,
      developments: many,
      screening: { since: live.as_of, material: many, dropped: [{ claim: claim({ id: 'x' }), reason: 'not_after' }] },
      resolutions: new Map([[retired.id, 'The audit shows this figure was wrong.']]),
    });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain(`Steps retired: ${retired.id} ("`);
    expect(text).toContain('The audit shows this figure was wrong.');
    expect(text).toContain(`Open questions no longer listed: "${live.open_questions[0]}"`);
    expect(text).toContain('New open questions: "Will the state restore the grants?"');
    // The developments get the room the other sections leave; the rest are counted.
    expect(text).toMatch(/\n… and \d+ more\.\n/);
    expect(text).toContain(`Claims the researchers found that are not new developments: 1 dated on or before ${live.as_of}.`);
  });
});
