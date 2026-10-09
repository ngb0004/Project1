import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertValidCase, diffCases, summarizeDiff, type Case } from '@sia/case-schema';
import {
  adminCreateCase,
  adminPublish,
  adminRequestUpdate,
  adminSetUpdateCadence,
  getPipelineJob,
  getPublishedCase,
  getStaffVersion,
  listLiveCases,
  listQueue,
  listResearchLog,
  listReviewDecisions,
  listStaffVersions,
  type Db,
  type PipelineJobRow,
} from '@sia/case-store';
// The local stack's test helpers provision the admin and pipeline accounts and give
// direct SQL for what only the database can do in a test: forcing a cadence due and
// running the cron function. The worker itself only ever receives the signed-in pipeline client.
import { ANON_KEY, API_URL, anonClient, pool, sql, userClient, withQueueLock } from '../../../supabase/tests/helpers';
import type { DrafterInput } from '../src/agents/drafter';
import type { ResearcherInput } from '../src/agents/researcher';
import { FakeRunner, type FakeScript, type FakeScriptFn } from '../src/runner/fake';
import { verifyJob } from '../src/verify';
import { claimJobById, runWorker, type JobOutcome } from '../src/worker';
import { AS_OF, PAGES, SIDE_A, SIDE_B, URLS, cleanScripts, fakeFetcher, researcherScript, scoperScript, type FakePage } from './helpers';

/**
 * Phase 5 acceptance against the local Supabase stack: a scheduled re-research
 * job produces a revision package against the live case, the revision appears
 * in the review queue as a diff, and the live case is unchanged until the admin
 * approves it.
 *
 *   live case published -> admin sets a cadence -> the cadence is forced due ->
 *   app.enqueue_due_updates() (the pg_cron job) queues one 'update' job -> the
 *   worker (`pipeline worker --once --job <id>`) runs it with scripted agents.
 *
 * The queue is shared with the supabase tests, which cancel queued jobs: every
 * enqueue-and-run happens under the queue lock they also take, and the worker
 * claims only this suite's job (through pipeline_claim_job with a job id).
 */

const reachable = await fetch(`${API_URL}/rest/v1/`, { headers: { apikey: ANON_KEY } })
  .then((r) => r.ok)
  .catch(() => false);
if (!reachable) console.warn(`update tests skipped: no local Supabase stack at ${API_URL}`);

const WORKER = 'vitest-update-worker';

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

describe.skipIf(!reachable)('live updates: scheduled re-research against the local Supabase stack', () => {
  let admin: Db;
  let pipeline: Db;
  const anon = anonClient();
  const slug = `maple-update-${randomUUID().slice(0, 8)}`;
  let caseId: string;
  let liveV1: number;
  /** What the public saw before any update ran. */
  let publicV1: unknown;

  const activeUpdateJobs = () =>
    sql<PipelineJobRow>(`select * from public.pipeline_jobs where case_id = $1 and kind = 'update' and status in ('queued', 'running')`, [caseId]);

  /**
   * Forces the case's cadence due, runs the cron function, checks that exactly one
   * update job is queued for the case (however often the schedule fires, and even
   * when the admin asks for one too), then runs the worker once on that job.
   */
  async function scheduledUpdate(
    scripts: Record<string, FakeScript>,
    asOf: string,
    pages: Record<string, FakePage> = PAGES,
  ): Promise<{ job: PipelineJobRow; outcome: JobOutcome; runner: FakeRunner }> {
    return withQueueLock(async () => {
      await sql(`update public.cases set next_update_at = now() - interval '1 minute' where id = $1`, [caseId]);
      await sql(`select app.enqueue_due_updates()`);
      await sql(`update public.cases set next_update_at = now() - interval '1 minute' where id = $1`, [caseId]);
      await sql(`select app.enqueue_due_updates()`);
      await expect(adminRequestUpdate(admin, caseId)).rejects.toThrow(/already queued or running/);
      const jobs = await activeUpdateJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      expect(job).toMatchObject({ kind: 'update', status: 'queued', created_by: 'system:schedule' });

      const runner = new FakeRunner(cleanScripts(scripts));
      const outcomes = await runWorker(
        { db: pipeline, runner, claim: claimJobById(job.id), workerId: WORKER, fetcher: fakeFetcher(pages), asOf, heartbeatMs: 25 },
        { once: true },
      );
      expect(outcomes).toHaveLength(1);
      return { job, outcome: outcomes[0]!, runner };
    });
  }

  beforeAll(async () => {
    [admin, pipeline] = await Promise.all([userClient('admin'), userClient('pipeline')]);
  });
  afterAll(async () => {
    // Leave no schedule behind on this test case.
    if (caseId) await adminSetUpdateCadence(admin, caseId, null).catch(() => {});
    await pool.end();
  });

  it('publishes a case the pipeline researched (the live version updates start from)', async () => {
    const outcome = await withQueueLock(async () => {
      const jobId = await adminCreateCase(admin, 'Maple County water main break');
      const [o] = await runWorker(
        { db: pipeline, runner: new FakeRunner(cleanScripts({ scoper: scoperScript(slug) })), claim: claimJobById(jobId), workerId: WORKER, fetcher: fakeFetcher(), asOf: AS_OF, heartbeatMs: 25 },
        { once: true },
      );
      return o!;
    });
    expect(outcome).toMatchObject({ kind: 'new_case', status: 'succeeded' });
    caseId = outcome.result!.case_id as string;
    liveV1 = outcome.result!.version as number;
    await adminPublish(admin, caseId, liveV1);
    const pub = await getPublishedCase(anon, slug);
    expect(pub).toMatchObject({ version: liveV1, is_live: true });
    publicV1 = pub!.doc;
  });

  it('the schedule queues nothing until the cadence the admin set is due', async () => {
    await adminSetUpdateCadence(admin, caseId, '1 day');
    const [c] = await sql(`select update_cadence::text as cadence, next_update_at > now() + interval '23 hours' as next_tomorrow from public.cases where id = $1`, [caseId]);
    expect(c).toEqual({ cadence: '1 day', next_tomorrow: true });
    await withQueueLock(() => sql(`select app.enqueue_due_updates()`));
    expect(await activeUpdateJobs()).toEqual([]);
  });

  let v2: number;

  it('(a) a new development: the update lands in the queue as a revision of the live version, and the live case does not change', async () => {
    const { job, outcome, runner } = await scheduledUpdate({ ...quiet, records_researcher: researcherScript([AUDIT]) }, '2026-10-09');
    expect(outcome).toMatchObject({ jobId: job.id, kind: 'update', status: 'succeeded' });

    // Each researcher (both sides and records) looked only for developments after the live as-of date.
    for (const call of [...runner.callsTo('researcher'), ...runner.callsTo('records_researcher')]) {
      expect((call.input as ResearcherInput).sinceAsOf).toBe(AS_OF);
    }
    // The drafter revised the live document.
    const dIn = runner.callsTo('drafter', { round: 0 })[0]!.input as DrafterInput;
    expect(dIn.base?.version).toBe(liveV1);
    expect(dIn.update).toMatchObject({ live_version: liveV1, base_version: liveV1, since: AS_OF });

    // The job: finished by this worker, with the update summary in its result.
    const finished = await getPipelineJob(admin, job.id);
    expect(finished).toMatchObject({ status: 'succeeded', claimed_by: WORKER, attempts: 1, error: null, base_version: liveV1 });
    expect(finished!.result).toMatchObject({ based_on_version: liveV1, parent_version: liveV1, developments: 1, since: AS_OF });
    v2 = finished!.result!.version as number;

    // A new version in review: parent and base are the live version, tagged 'update'.
    const row = await getStaffVersion(admin, caseId, v2);
    expect(row).toMatchObject({ status: 'in_review', origin: 'pipeline', parent_version: liveV1, based_on_version: liveV1, tags: ['update'], pipeline_job_id: job.id });
    const doc = assertValidCase(row!.doc);
    expect(doc.as_of).toBe('2026-10-09');

    // It shows in the review queue, and as a diff against the live version: one step and one source added.
    const queued = (await listQueue(admin)).find((q) => q.case_id === caseId && q.version === v2);
    expect(queued).toMatchObject({ status: 'in_review', parent_version: liveV1, live_version: liveV1, tags: ['update'] });
    const live = assertValidCase((await getStaffVersion(admin, caseId, liveV1))!.doc);
    const d = diffCases(live, doc);
    expect(d.hasChanges).toBe(true);
    expect(d.fields.map((f) => f.path)).toEqual(['as_of']);
    const addedSteps = d.steps.filter((x) => x.status === 'added');
    expect(addedSteps).toHaveLength(1);
    expect(d.steps.filter((x) => x.status !== 'added').every((x) => x.status === 'unchanged')).toBe(true);
    expect(d.sources.filter((x) => x.status === 'added')).toHaveLength(1);
    expect(d.sources.filter((x) => x.status === 'changed')).toEqual([]);

    // The plain update summary is in the review record (the editor's "update" report) and in the job result.
    const report = doc.review.agent_reports.find((r) => r.agent === 'editor' && r.scope === 'update');
    expect(report?.summary).toBe(finished!.result!.update_summary);
    expect(report!.summary).toContain(`What changed against the live version: ${summarizeDiff(d, doc)}`);
    expect(report!.summary).toContain(AUDIT.text);
    expect(report!.summary).toContain(`In the draft: ${addedSteps[0]!.id}.`);
    expect(doc.review.decisions.map((x) => x.action)).toEqual(['submitted']);

    // The research log says how the update got here.
    const log = await listResearchLog(admin, job.id);
    expect(log.some((r) => r.kind === 'note' && r.excerpt?.startsWith(`1 new development(s) since ${AS_OF}`))).toBe(true);
    expect(log.some((r) => r.kind === 'note' && r.excerpt?.startsWith('Update summary for the admin'))).toBe(true);
    expect(log.some((r) => r.kind === 'open' && r.url === URLS.audit)).toBe(true);

    // `pipeline verify` accepts the update package from the database alone: every source opened by this job, every quote in its snapshot.
    const audit = await verifyJob(pipeline, job.id);
    expect(audit.checks.filter((c) => !c.ok)).toEqual([]);

    // The live case is unchanged: the public still gets version 1, byte for byte.
    const pub = await getPublishedCase(anon, slug);
    expect(pub).toMatchObject({ version: liveV1, is_live: true });
    expect(pub!.doc).toEqual(publicV1);
    expect((await listLiveCases(anon)).find((c) => c.slug === slug)?.version).toBe(liveV1);
    expect(await getPublishedCase(anon, slug, v2)).toBeNull();
  });

  let v3: number;

  it('(c) a second development while the first update waits for review: the new package builds on it and replaces it in the queue', async () => {
    const { job, outcome, runner } = await scheduledUpdate({ ...quiet, records_researcher: researcherScript([AUDIT, RESTORE]) }, '2026-10-12');
    expect(outcome).toMatchObject({ jobId: job.id, status: 'succeeded' });
    // Researched since the pending package's as-of date; the audit is not new again.
    expect((runner.callsTo('records_researcher')[0]!.input as ResearcherInput).sinceAsOf).toBe('2026-10-09');
    expect((runner.callsTo('drafter', { round: 0 })[0]!.input as DrafterInput).claims.map((c) => c.url)).toEqual([URLS.restore]);

    v3 = outcome.result!.version as number;
    const row = await getStaffVersion(admin, caseId, v3);
    expect(row).toMatchObject({ status: 'in_review', parent_version: liveV1, based_on_version: v2, tags: ['update'] });
    expect((await getStaffVersion(admin, caseId, v2))?.status).toBe('archived');
    expect((await listReviewDecisions(admin, caseId, v2)).map((x) => x.action)).toContain('superseded');
    const queue = (await listQueue(admin)).filter((q) => q.case_id === caseId);
    expect(queue.map((q) => q.version)).toEqual([v3]);

    const live = assertValidCase((await getStaffVersion(admin, caseId, liveV1))!.doc);
    const doc = assertValidCase(row!.doc);
    expect(diffCases(live, doc).steps.filter((x) => x.status === 'added')).toHaveLength(2);
    expect(doc.review.agent_reports.find((r) => r.scope === 'update')?.summary).toContain(`Builds on version ${v2}`);
    expect((await getPublishedCase(anon, slug))!.doc).toEqual(publicV1);
  });

  it('(b) nothing new beyond the package in review: no_changes, and the package stays as it is', async () => {
    const before = (await listStaffVersions(admin, caseId)).map((v) => [v.version, v.status]);
    const { job, outcome } = await scheduledUpdate(quiet, '2026-10-12');
    expect(outcome).toMatchObject({ jobId: job.id, status: 'no_changes' });
    const finished = await getPipelineJob(admin, job.id);
    expect(finished?.status).toBe('no_changes');
    expect(finished?.result?.summary).toBe(
      `No material developments since 2026-10-12 (version ${v3}, the update waiting for review on top of live version ${liveV1}): the researchers found no verifiable claims. Nothing was drafted or submitted.`,
    );
    const log = await listResearchLog(admin, job.id);
    expect(log.some((r) => r.kind === 'note' && r.excerpt === finished?.result?.summary)).toBe(true);
    expect((await listStaffVersions(admin, caseId)).map((v) => [v.version, v.status])).toEqual(before);
  });

  it('approving the revision moves the live version; the old version stays as it was', async () => {
    await adminPublish(admin, caseId, v3);
    const pub = await getPublishedCase(anon, slug);
    expect(pub).toMatchObject({ version: v3, is_live: true });
    expect(pub!.doc.steps.length).toBe((publicV1 as Case).steps.length + 2);
    const old = await getPublishedCase(anon, slug, liveV1);
    expect(old).toMatchObject({ version: liveV1, is_live: false });
    expect(old!.doc).toEqual(publicV1);
  });

  it('(b) nothing new after approval: a re-found old development is screened out, the job ends no_changes, no version is added', async () => {
    const versionsBefore = (await listStaffVersions(admin, caseId)).length;
    // The admin cannot queue a second update while this one is running.
    let refused: string | undefined;
    const records: FakeScript = async (input: ResearcherInput, ctx, tools, call) => {
      refused = await adminRequestUpdate(admin, caseId).then(
        () => 'queued',
        (e: Error) => e.message,
      );
      return (researcherScript([AUDIT, RESTORE]) as FakeScriptFn)(input, ctx, tools, call);
    };
    const { job, outcome } = await scheduledUpdate({ ...quiet, records_researcher: records }, '2026-10-14');
    expect(refused).toMatch(/already queued or running/);
    expect(outcome).toMatchObject({ jobId: job.id, status: 'no_changes' });
    const finished = await getPipelineJob(admin, job.id);
    expect(finished?.result?.summary).toBe(
      `No material developments since 2026-10-12 (version ${v3}): 2 verified claim(s) found: 2 dated on or before 2026-10-12. Nothing was drafted or submitted.`,
    );
    expect(await listStaffVersions(admin, caseId)).toHaveLength(versionsBefore);
    expect((await getPublishedCase(anon, slug))?.version).toBe(v3);
  });

  it('an update waits while a revision of the case is in progress (finishes no_changes, researches nothing)', async () => {
    const [rev] = await sql<{ id: string }>(
      `insert into public.pipeline_jobs (kind, case_id, base_version, instructions, created_by) values ('revision', $1, $2, 'Fairness review (test).', 'system:fairness') returning id`,
      [caseId, v3],
    );
    try {
      const { outcome, runner } = await scheduledUpdate(quiet, '2026-10-14');
      expect(outcome.status).toBe('no_changes');
      expect(outcome.result).toMatchObject({ skipped: true, summary: expect.stringContaining(`revision job ${rev!.id.slice(0, 8)} for this case is queued`) });
      expect(runner.calls).toEqual([]);
    } finally {
      await sql(`update public.pipeline_jobs set status = 'cancelled' where id = $1 and status = 'queued'`, [rev!.id]);
    }
  });

  it('the database never holds two active update jobs for one case', async () => {
    await withQueueLock(async () => {
      await sql(`update public.cases set next_update_at = now() - interval '1 minute' where id = $1`, [caseId]);
      await Promise.all([sql(`select app.enqueue_due_updates()`), sql(`select app.enqueue_due_updates()`), adminRequestUpdate(admin, caseId).catch(() => null)]);
      const jobs = await activeUpdateJobs();
      expect(jobs).toHaveLength(1);
      await expect(
        sql(`insert into public.pipeline_jobs (kind, case_id, base_version, instructions) values ('update', $1, $2, 'duplicate')`, [caseId, v3]),
      ).rejects.toThrow(/pipeline_jobs_one_active_update/);
      await sql(`update public.pipeline_jobs set status = 'cancelled' where id = $1`, [jobs[0]!.id]);
    });
  });

  it('a source that changed since it was cited: unchanged facts are checked against the archived snapshot, and the admin is told', async () => {
    const live = (await getPublishedCase(anon, slug))!;
    const minutesQuote = 'The council voted 5-4 to postpone the replacement project to the 2027 budget.';
    // The council's minutes are now behind a login page.
    const pages = { ...PAGES, [URLS.minutes]: { title: 'Sign in', text: 'Sign in to read council records. Create an account or log in with your library card to continue. '.repeat(3) } };
    const grants = {
      url: URLS.grantsRestored,
      quote: 'the state restored 20 percent of the 2025 cut to local water infrastructure grants',
      text: 'On October 13, 2026 the state restored 20 percent of the 2025 water grant cut.',
      type: 'news' as const,
      favors: SIDE_B.id,
      impact: 'medium' as const,
      date: '2026-10-13',
    };
    const { job, outcome } = await scheduledUpdate({ ...quiet, records_researcher: researcherScript([grants]) }, '2026-10-14', pages);
    expect(outcome).toMatchObject({ jobId: job.id, status: 'succeeded' });
    const row = (await getStaffVersion(admin, caseId, outcome.result!.version as number))!;
    const doc = assertValidCase(row.doc);
    expect(doc.steps.some((s) => s.evidence?.some((e) => e.quote === minutesQuote))).toBe(true);
    const drift = doc.review.open_issues.find((o) => o.description.startsWith('Source "src-minutes-2025-06-03"'));
    expect(drift?.description).toMatch(/has changed since version \d+ cited it: .* checked against the snapshot taken on \d{4}-\d{2}-\d{2} \(job [0-9a-f]{8}\)/);
    // The facts are unchanged in the diff, and `pipeline verify` accepts the package using the archive.
    const liveDoc = assertValidCase((await getStaffVersion(admin, caseId, live.version))!.doc);
    expect(diffCases(liveDoc, doc).steps.filter((x) => x.status !== 'unchanged').map((x) => x.status)).toEqual(['added']);
    const audit = await verifyJob(pipeline, job.id);
    expect(audit.checks.filter((c) => !c.ok)).toEqual([]);
    expect(audit.checks.map((c) => c.name)).toContain('every source opened by this job, or archived by the job that cited it');
    expect((await getPublishedCase(anon, slug))?.version).toBe(live.version);
  });
});
