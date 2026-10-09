import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertValidCase } from '@sia/case-schema';
import {
  adminCreateCase,
  adminPublish,
  adminRequestChanges,
  adminRequestUpdate,
  getPipelineJob,
  listResearchLog,
  listSnapshotMeta,
  listStaffVersions,
  researchLogOpenedUrls,
  type Db,
} from '@sia/case-store';
// The local stack's test helpers provision the admin and pipeline accounts (the
// way supabase/scripts/create-staff-user.ts does). The worker itself only ever
// receives the signed-in pipeline client.
import { ANON_KEY, API_URL, pool, sql, userClient } from '../../../supabase/tests/helpers';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCitations } from '../src/factcheck';
import { checkSavedPackage, writeAuditDir } from '../src/package';
import { MemoryResearchLog } from '../src/research/log';
import { SourceStore } from '../src/research/store';
import { FakeRunner, type FakeScript } from '../src/runner/fake';
import { verifyJob } from '../src/verify';
import { runWorkerOnce } from '../src/worker';
import { AS_OF, SIDE_A, SIDE_B, URLS, cleanScripts, fakeFetcher, researcherScript, scoperScript } from './helpers';

const reachable = await fetch(`${API_URL}/rest/v1/`, { headers: { apikey: ANON_KEY } })
  .then((r) => r.ok)
  .catch(() => false);
if (!reachable) console.warn(`worker tests skipped: no local Supabase stack at ${API_URL}`);

const ALL_AGENTS = ['scoper', 'researcher', 'records_researcher', 'drafter', 'hard_questions', 'red_team', 'fact_checker', 'editor'];

/** Researchers that find nothing new. */
const quietResearch: Record<string, FakeScript> = {
  [`researcher#${SIDE_A.id}`]: researcherScript([]),
  [`researcher#${SIDE_B.id}`]: researcherScript([]),
  records_researcher: researcherScript([]),
};

describe.skipIf(!reachable)('pipeline worker against the local Supabase stack', () => {
  let admin: Db;
  let pipeline: Db;
  let caseId: string;
  let firstVersion: number;
  const slug = `maple-water-${randomUUID().slice(0, 8)}`;

  const work = (scripts: Record<string, FakeScript>) =>
    runWorkerOnce({ db: pipeline, runner: new FakeRunner(scripts), fetcher: fakeFetcher(), asOf: AS_OF, workerId: 'vitest-worker', heartbeatMs: 25 });

  beforeAll(async () => {
    [admin, pipeline] = await Promise.all([userClient('admin'), userClient('pipeline')]);
    // The worker claims the oldest queued job (or a stale running one): leave none from other test files in the
    // way. A job another worker is running right now (fresh heartbeat) is left alone.
    await sql(
      `update public.pipeline_jobs set status = 'cancelled'
        where status = 'queued' or (status = 'running' and heartbeat_at < now() - interval '30 minutes')`,
    );
  });
  afterAll(() => pool.end());

  it('claims an admin-created job, runs it and lands the package in review with its research log and snapshots', async () => {
    const jobId = await adminCreateCase(admin, 'Maple County water main break');
    const outcome = await work(cleanScripts({ scoper: scoperScript(slug) }));
    expect(outcome).toMatchObject({ jobId, kind: 'new_case', status: 'succeeded' });

    const job = await getPipelineJob(admin, jobId);
    expect(job).toMatchObject({ status: 'succeeded', claimed_by: 'vitest-worker', attempts: 1, error: null });
    expect(job!.result).toMatchObject({ slug, rounds: 1, clean: true, open_issues: 0 });
    caseId = job!.result!.case_id as string;
    firstVersion = job!.result!.version as number;

    const [v] = await listStaffVersions(admin, caseId);
    expect(v).toMatchObject({ status: 'in_review', origin: 'pipeline', version: firstVersion, pipeline_job_id: jobId, tags: ['new_case'], slug });
    const doc = assertValidCase(v!.doc);
    expect(doc.review.pipeline_run_id).toBe(jobId);
    expect(doc.review.decisions.map((d) => d.action)).toEqual(['submitted']);
    expect(doc.review.agent_reports.map((r) => r.agent)).toEqual(expect.arrayContaining(ALL_AGENTS));

    // The research log: every agent, every kind, and a snapshot row behind every logged open.
    const log = await listResearchLog(admin, jobId);
    expect(new Set(log.map((r) => r.kind))).toEqual(new Set(['query', 'open', 'claim', 'note']));
    expect(new Set(log.map((r) => r.agent))).toEqual(new Set([...ALL_AGENTS, 'pipeline']));
    for (const agent of ALL_AGENTS) {
      expect(log.some((r) => r.agent === agent && r.kind === 'note' && r.excerpt?.startsWith('Agent call finished')), agent).toBe(true);
    }
    const snaps = await listSnapshotMeta(admin, jobId);
    const snapIds = new Set(snaps.map((s) => s.id));
    const opens = log.filter((r) => r.kind === 'open');
    expect(opens.length).toBeGreaterThan(0);
    for (const o of opens) expect(snapIds.has(o.snapshot_id!), o.url!).toBe(true);
    expect(snaps.every((s) => s.http_status === 200 && /^[0-9a-f]{64}$/.test(s.sha256))).toBe(true);

    // Every source in the case was opened by this job.
    const opened = await researchLogOpenedUrls(admin, jobId, doc.sources.map((s) => s.url));
    expect([...opened].sort()).toEqual(doc.sources.map((s) => s.url).sort());

    // `pipeline verify` proves the same from the database alone, as the pipeline account...
    const audit = await verifyJob(pipeline, jobId);
    expect(audit.checks.filter((c) => !c.ok)).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.quotesChecked).toBeGreaterThan(0);
    // ...and the package it saves passes `pipeline check` offline.
    const dir = await mkdtemp(join(tmpdir(), 'pipeline-verify-'));
    await writeAuditDir(audit, dir);
    const saved = await checkSavedPackage(join(dir, 'case.json'), join(dir, 'snapshots'));
    expect(saved).toMatchObject({ ok: true, failures: [], schemaErrors: [] });
  });

  it('the snapshots verify reads back from the database catch a tampered quote', async () => {
    const [v] = await listStaffVersions(admin, caseId);
    const tampered = structuredClone(v!.doc);
    tampered.steps[0]!.evidence = [{ source_id: tampered.steps[0]!.source_ids[0]!, quote: 'A sentence that no opened page ever contained.' }];
    const audit = await verifyJob(pipeline, v!.pipeline_job_id!);
    const store = new SourceStore({ log: new MemoryResearchLog() });
    store.load(audit.snapshots);
    expect(checkCitations(tampered, store)).toEqual([expect.objectContaining({ target: tampered.steps[0]!.id, verdict: 'unsupported' })]);
  });

  it('runs a revision from the admin\'s notes against that version and supersedes it', async () => {
    const { job_id } = await adminRequestChanges(admin, caseId, firstVersion, 'Name the council chair in step 1.');
    const outcome = await work(cleanScripts(quietResearch));
    expect(outcome).toMatchObject({ jobId: job_id, kind: 'revision', status: 'succeeded' });

    const versions = await listStaffVersions(admin, caseId);
    const latest = versions[0]!;
    expect(latest).toMatchObject({ status: 'in_review', based_on_version: firstVersion, tags: ['revision'], pipeline_job_id: job_id, slug });
    expect(versions.find((x) => x.version === firstVersion)?.status).toBe('archived');
    // The base version's sources were re-opened in this job, so they count as opened.
    const doc = assertValidCase(latest.doc);
    const opened = await researchLogOpenedUrls(admin, job_id, doc.sources.map((s) => s.url));
    expect(opened.size).toBe(new Set(doc.sources.map((s) => s.url)).size);
  });

  it('an update with nothing new finishes as no_changes and leaves the live version alone', async () => {
    const [latest] = await listStaffVersions(admin, caseId);
    await adminPublish(admin, caseId, latest!.version);
    const jobId = await adminRequestUpdate(admin, caseId);
    const outcome = await work(cleanScripts(quietResearch));
    expect(outcome).toMatchObject({ jobId, kind: 'update', status: 'no_changes' });
    expect((await getPipelineJob(admin, jobId))?.status).toBe('no_changes');
    const versions = await listStaffVersions(admin, caseId);
    expect(versions[0]).toMatchObject({ version: latest!.version, status: 'published', is_live: true });
  });

  it('an update with a material development lands a revision of the live version in review', async () => {
    const [live] = await listStaffVersions(admin, caseId);
    const jobId = await adminRequestUpdate(admin, caseId);
    const outcome = await work(
      cleanScripts({
        ...quietResearch,
        records_researcher: researcherScript([
          { url: URLS.audit, quote: 'moved $400,000 of water repair funds to road paving in 2025', text: 'An audit found $400,000 of repair funds went to paving.', type: 'news', favors: SIDE_A.id, impact: 'high', date: '2026-10-05' },
        ]),
      }),
    );
    expect(outcome?.jobId).toBe(jobId);
    expect(outcome?.status).toBe('succeeded');
    const versions = await listStaffVersions(admin, caseId);
    expect(versions[0]).toMatchObject({ status: 'in_review', based_on_version: live!.version, parent_version: live!.version, tags: ['update'] });
    expect(versions.find((x) => x.version === live!.version)).toMatchObject({ status: 'published', is_live: true });
  });

  it('marks the job failed, with the error, when the pipeline cannot finish', async () => {
    const jobId = await adminCreateCase(admin, 'A brief the researchers cannot handle');
    const outcome = await work({ scoper: scoperScript(`${slug}-fail`) });
    expect(outcome).toMatchObject({ jobId, status: 'failed' });
    const job = await getPipelineJob(admin, jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/every researcher failed/);
    const log = await listResearchLog(admin, jobId);
    expect(log.some((r) => r.kind === 'note' && r.excerpt?.startsWith('Job failed'))).toBe(true);
  });

  it('returns null when the queue is empty', async () => {
    expect(await work(cleanScripts())).toBeNull();
  });
});
