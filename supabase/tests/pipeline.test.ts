import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminCreateCase,
  adminPublish,
  adminRequestUpdate,
  adminSaveEdit,
  adminSchedule,
  adminSetUpdateCadence,
  getStaffVersion,
  listReviewDecisions,
  submitCasePackage,
  type Db,
} from '@sia/case-store';
import { anonClient, clearJobQueue, loadFixture, pool, sql, submitFixture, userClient, withQueueLock } from './helpers';

let admin: Db;
let pipeline: Db;
let plainUser: Db;
const anon = anonClient();

beforeAll(async () => {
  [admin, pipeline, plainUser] = await Promise.all([userClient('admin'), userClient('pipeline'), userClient('none')]);
  // Leave no queued jobs from earlier files in the way of claim order.
  await clearJobQueue();
});
afterAll(() => pool.end());

describe('pipeline jobs', () => {
  it('a brief becomes a queued job that only the pipeline can claim and finish', async () => {
    // Under the queue lock, so a suite running beside this one cannot claim or cancel the job first.
    const { jobId, claim } = await withQueueLock(async () => {
      const jobId = await adminCreateCase(admin, 'Lindsay Clancy trial verdict');
      for (const client of [admin, anon, plainUser]) {
        const r = await client.rpc('pipeline_claim_job', { p_worker: 'x' });
        expect(r.error).not.toBeNull();
      }
      return { jobId, claim: await pipeline.rpc('pipeline_claim_job', { p_worker: 'worker-1' }) };
    });
    expect(claim.error).toBeNull();
    expect(claim.data[0]).toMatchObject({ id: jobId, kind: 'new_case', status: 'running', brief: 'Lindsay Clancy trial verdict', attempts: 1 });

    const fin = await pipeline.rpc('pipeline_finish_job', { p_job_id: jobId, p_status: 'succeeded', p_result: { ok: true } });
    expect(fin.error).toBeNull();
    const again = await pipeline.rpc('pipeline_finish_job', { p_job_id: jobId, p_status: 'failed' });
    expect(again.error?.message).toMatch(/not running/);
  });

  it('the public cannot create jobs or read them', async () => {
    const r = await anon.rpc('admin_create_case', { p_brief: 'x' });
    expect(r.error).not.toBeNull();
    const read = await anon.from('pipeline_jobs').select('*');
    expect(read.error?.message ?? '').toMatch(/permission denied/);
    const pr = await pipeline.rpc('admin_create_case', { p_brief: 'x' });
    expect(pr.error?.message).toMatch(/admin only/);
  });
});

describe('research log', () => {
  it('pipeline writes logs and snapshots; admin can audit; nobody can edit them', async () => {
    const jobId = await adminCreateCase(admin, 'Research log test');
    const text = 'The council voted 5-4 to delay the repair.';
    const sha = createHash('sha256').update(text).digest('hex');
    const snap = await pipeline
      .from('source_snapshots')
      .insert({ job_id: jobId, url: 'https://example.org/a', http_status: 200, title: 'A', sha256: sha, text_content: text })
      .select('id')
      .single();
    expect(snap.error).toBeNull();
    const log = await pipeline.from('research_log').insert([
      { job_id: jobId, agent: 'researcher', scope: 'side-a', kind: 'query', query: 'harbor bridge vote' },
      { job_id: jobId, agent: 'researcher', scope: 'side-a', kind: 'open', url: 'https://example.org/a', snapshot_id: snap.data!.id, http_status: 200 },
      { job_id: jobId, agent: 'researcher', scope: 'side-a', kind: 'claim', url: 'https://example.org/a', claims: [{ text: 'Vote was 5-4', quote: 'voted 5-4' }] },
    ]);
    expect(log.error).toBeNull();

    const audit = await admin.from('research_log').select('kind, agent, url').eq('job_id', jobId).order('id');
    expect(audit.data?.map((r) => r.kind)).toEqual(['query', 'open', 'claim']);
    const snaps = await admin.from('source_snapshots').select('text_content').eq('job_id', jobId);
    expect(snaps.data?.[0]?.text_content).toBe(text);

    expect((await anon.from('research_log').select('*')).error).not.toBeNull();
    expect((await plainUser.from('research_log').select('*').eq('job_id', jobId)).data).toEqual([]);
    expect((await admin.from('research_log').insert({ job_id: jobId, agent: 'x', kind: 'note' })).error).not.toBeNull();
    await expect(sql(`delete from public.research_log where job_id = $1`, [jobId])).rejects.toThrow(/append-only/);
  });
});

describe('live update scheduling', () => {
  it('queues a re-research job against the live version when the cadence is due', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await adminPublish(admin, case_id, version);
    await adminSetUpdateCadence(admin, case_id, '1 day');
    const [c] = await sql(`select update_cadence::text, next_update_at > now() as future from public.cases where id = $1`, [case_id]);
    expect(c).toEqual({ update_cadence: '1 day', future: true });

    await sql(`update public.cases set next_update_at = now() - interval '1 minute' where id = $1`, [case_id]);
    await sql(`select app.enqueue_due_updates()`);
    await sql(`select app.enqueue_due_updates()`); // idempotent while a job is queued
    const jobs = await sql(`select kind, base_version, status from public.pipeline_jobs where case_id = $1`, [case_id]);
    expect(jobs).toEqual([{ kind: 'update', base_version: version, status: 'queued' }]);
    const [next] = await sql(`select next_update_at > now() as future from public.cases where id = $1`, [case_id]);
    expect(next.future).toBe(true);
  });
});

describe('package import', () => {
  it('refuses a package whose parent_version is not a published version of the case', async () => {
    const { submitCasePackage } = await import('@sia/case-store');
    const { loadFixture, freshSlug } = await import('./helpers');
    const doc = { ...loadFixture('fixture-harbor-bridge'), parent_version: 1, version: 2 };
    await expect(submitCasePackage(pipeline, { slug: freshSlug(), doc })).rejects.toThrow(/not a published version/);
  });
});

describe('live update jobs', () => {
  const activeUpdates = (caseId: string) =>
    sql(`select id, status from public.pipeline_jobs where case_id = $1 and kind = 'update' and status in ('queued', 'running')`, [caseId]);

  it('a case never has two update jobs queued or running at once', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await adminPublish(admin, case_id, version);
    await adminSetUpdateCadence(admin, case_id, '1 hour');
    await withQueueLock(async () => {
      await sql(`update public.cases set next_update_at = now() - interval '1 minute' where id = $1`, [case_id]);
      const [first] = await sql(`select app.enqueue_due_updates() as n`);
      expect(first.n).toBeGreaterThanOrEqual(1);
      // The schedule firing again, racing the admin: still one job.
      await sql(`update public.cases set next_update_at = now() - interval '1 minute' where id = $1`, [case_id]);
      await Promise.all([sql(`select app.enqueue_due_updates()`), adminRequestUpdate(admin, case_id).catch(() => null)]);
      const jobs = await activeUpdates(case_id);
      expect(jobs).toEqual([{ id: expect.any(String), status: 'queued' }]);
      await expect(adminRequestUpdate(admin, case_id)).rejects.toThrow(/already queued or running/);
      await expect(
        sql(`insert into public.pipeline_jobs (kind, case_id, base_version) values ('update', $1, $2)`, [case_id, version]),
      ).rejects.toThrow(/pipeline_jobs_one_active_update/);

      // Running counts too.
      const claim = await pipeline.rpc('pipeline_claim_job', { p_worker: 'w-upd', p_job_id: jobs[0].id });
      expect(claim.data[0]).toMatchObject({ id: jobs[0].id, status: 'running' });
      await expect(adminRequestUpdate(admin, case_id)).rejects.toThrow(/already queued or running/);
      expect((await pipeline.rpc('pipeline_finish_job', { p_job_id: jobs[0].id, p_status: 'no_changes', p_worker: 'w-upd' })).error).toBeNull();
    });
    // Once it finished, the admin can ask for the next one.
    const next = await adminRequestUpdate(admin, case_id);
    expect(await activeUpdates(case_id)).toEqual([{ id: next, status: 'queued' }]);
    await sql(`update public.pipeline_jobs set status = 'cancelled' where id = $1`, [next]);
    await adminSetUpdateCadence(admin, case_id, null);
  });

  it('a worker claims a named job, renews its lease, and only the holder can finish or release it', async () => {
    const jobId = await adminCreateCase(admin, 'Lease test brief');
    await withQueueLock(async () => {
      const c1 = await pipeline.rpc('pipeline_claim_job', { p_worker: 'w-a', p_job_id: jobId });
      expect(c1.data).toEqual([expect.objectContaining({ id: jobId, status: 'running', claimed_by: 'w-a', attempts: 1 })]);
      // A running job with a fresh heartbeat cannot be claimed again.
      expect((await pipeline.rpc('pipeline_claim_job', { p_worker: 'w-b', p_job_id: jobId })).data).toEqual([]);
    });

    expect((await pipeline.rpc('pipeline_renew_lease', { p_job_id: jobId, p_worker: 'w-a' })).data).toBe(true);
    expect((await pipeline.rpc('pipeline_renew_lease', { p_job_id: jobId, p_worker: 'w-b' })).data).toBe(false);
    for (const fn of ['pipeline_renew_lease', 'pipeline_release_job']) {
      expect((await admin.rpc(fn, { p_job_id: jobId, p_worker: 'w-a' })).error?.message).toMatch(/pipeline only/);
      expect((await anon.rpc(fn, { p_job_id: jobId, p_worker: 'w-a' })).error).not.toBeNull();
    }
    const wrongFinish = await pipeline.rpc('pipeline_finish_job', { p_job_id: jobId, p_status: 'succeeded', p_worker: 'w-b' });
    expect(wrongFinish.error?.message).toMatch(/not running for worker w-b/);
    expect((await pipeline.rpc('pipeline_release_job', { p_job_id: jobId, p_worker: 'w-b' })).error?.message).toMatch(/not running for worker w-b/);

    // Released (a worker shutting down): back in the queue, no longer held.
    const rel = await pipeline.rpc('pipeline_release_job', { p_job_id: jobId, p_worker: 'w-a', p_reason: 'received SIGTERM' });
    expect(rel).toMatchObject({ data: 'queued', error: null });
    const [queued] = await sql(`select status, claimed_by, heartbeat_at, attempts, error from public.pipeline_jobs where id = $1`, [jobId]);
    expect(queued).toEqual({ status: 'queued', claimed_by: null, heartbeat_at: null, attempts: 1, error: null });
    expect((await pipeline.rpc('pipeline_renew_lease', { p_job_id: jobId, p_worker: 'w-a' })).data).toBe(false);

    // The third attempt that is released fails the job instead of queuing it forever.
    await withQueueLock(async () => {
      for (const n of [2, 3]) {
        const c = await pipeline.rpc('pipeline_claim_job', { p_worker: `w-${n}`, p_job_id: jobId });
        expect(c.data[0]).toMatchObject({ attempts: n });
        const r = await pipeline.rpc('pipeline_release_job', { p_job_id: jobId, p_worker: `w-${n}`, p_reason: 'deploy' });
        expect(r.data).toBe(n < 3 ? 'queued' : 'failed');
      }
    });
    const [failed] = await sql(`select status, error, finished_at is not null as finished from public.pipeline_jobs where id = $1`, [jobId]);
    expect(failed).toEqual({ status: 'failed', error: 'Released after attempt 3 and not retried: deploy', finished: true });
  });

  it('a job records its spend across attempts: heartbeat, release and finish never lower it, and only the holder writes it', async () => {
    const jobId = await adminCreateCase(admin, 'Spend test brief');
    const spent = async () => Number((await sql<{ spent_usd: string }>(`select spent_usd from public.pipeline_jobs where id = $1`, [jobId]))[0]!.spent_usd);
    await withQueueLock(async () => {
      const c = await pipeline.rpc('pipeline_claim_job', { p_worker: 'w-s1', p_job_id: jobId });
      expect(c.data).toEqual([expect.objectContaining({ id: jobId, spent_usd: 0 })]);
    });
    expect(await spent()).toBe(0);
    expect((await pipeline.rpc('pipeline_renew_lease', { p_job_id: jobId, p_worker: 'w-s1', p_spent_usd: 1.25 })).data).toBe(true);
    expect(await spent()).toBe(1.25);
    // A lower report (a stale heartbeat) never lowers it; another worker cannot write it; a negative value is refused.
    expect((await pipeline.rpc('pipeline_renew_lease', { p_job_id: jobId, p_worker: 'w-s1', p_spent_usd: 0.5 })).data).toBe(true);
    expect((await pipeline.rpc('pipeline_renew_lease', { p_job_id: jobId, p_worker: 'w-other', p_spent_usd: 99 })).data).toBe(false);
    expect((await pipeline.rpc('pipeline_renew_lease', { p_job_id: jobId, p_worker: 'w-s1', p_spent_usd: -1 })).error?.message).toMatch(/negative/);
    expect(await spent()).toBe(1.25);
    expect((await pipeline.rpc('pipeline_release_job', { p_job_id: jobId, p_worker: 'w-s1', p_reason: 'deploy', p_spent_usd: 2 })).data).toBe('queued');
    expect(await spent()).toBe(2);
    // The next attempt sees what the earlier one spent, and finishing records the total.
    await withQueueLock(async () => {
      const c = await pipeline.rpc('pipeline_claim_job', { p_worker: 'w-s2', p_job_id: jobId });
      expect(c.data).toEqual([expect.objectContaining({ attempts: 2, spent_usd: 2 })]);
    });
    expect((await pipeline.rpc('pipeline_finish_job', { p_job_id: jobId, p_status: 'failed', p_worker: 'w-s2', p_spent_usd: 3.5 })).error).toBeNull();
    expect(await spent()).toBe(3.5);
    // Staff cannot set it: the column is written only through the worker functions.
    expect((await admin.from('pipeline_jobs').update({ spent_usd: 0 }).eq('id', jobId).select('id')).error).not.toBeNull();
  });

  it('a job abandoned after its last attempt fails; an earlier attempt stays reclaimable', async () => {
    const [last, earlier] = await Promise.all([adminCreateCase(admin, 'Abandoned job 1'), adminCreateCase(admin, 'Abandoned job 2')]);
    await withQueueLock(async () => {
      await sql(
        `update public.pipeline_jobs set status = 'running', claimed_by = 'gone', heartbeat_at = now() - interval '31 minutes',
                attempts = case when id = $1 then 3 else 1 end
          where id in ($1, $2)`,
        [last, earlier],
      );
      await sql(`select app.expire_abandoned_jobs()`);
      const rows = await sql(`select id, status, error from public.pipeline_jobs where id in ($1, $2)`, [last, earlier]);
      expect(rows.find((r) => r.id === last)).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Abandoned: no heartbeat from gone since .* after 3 attempt\(s\)\.$/) });
      expect(rows.find((r) => r.id === earlier)).toMatchObject({ status: 'running' });
      const reclaimed = await pipeline.rpc('pipeline_claim_job', { p_worker: 'w-new', p_job_id: earlier });
      expect(reclaimed.data[0]).toMatchObject({ id: earlier, claimed_by: 'w-new', attempts: 2 });
      await sql(`update public.pipeline_jobs set status = 'cancelled' where id = $1`, [earlier]);
    });
  });

  it("an update package supersedes the pipeline's update in review that it builds on, and nothing else", async () => {
    const { case_id, slug, version: v1 } = await submitFixture(pipeline);
    await adminPublish(admin, case_id, v1);
    const base = loadFixture('fixture-harbor-bridge');
    const update = (title: string) => ({ ...base, title, parent_version: v1 });
    const submit = (title: string, basedOnVersion: number, tags: string[]) =>
      submitCasePackage(pipeline, { slug, doc: update(title), basedOnVersion, tags });
    const status = async (v: number) => (await getStaffVersion(admin, case_id, v))!.status;

    const u1 = await submit('Update one', v1, ['update']);
    expect(await status(v1)).toBe('published');
    const u2 = await submit('Update two', u1.version, ['update']);
    expect(await status(u1.version)).toBe('archived');
    expect((await listReviewDecisions(admin, case_id, u1.version)).map((d) => d.notes)).toContain(
      `Superseded by version ${u2.version}, a newer update of live version ${v1} built on this one.`,
    );

    // A package not tagged 'update' does not supersede an update in review.
    const r = await submit('A revision', u2.version, ['revision']);
    expect(await status(u2.version)).toBe('in_review');

    // An update approved for a set time is the admin's decision: not superseded.
    await adminSchedule(admin, case_id, r.version, new Date(Date.now() + 86_400_000));
    await submit('Update three', r.version, ['update']);
    expect(await status(r.version)).toBe('in_review');

    // Nor is an admin edit draft, or an imported package.
    const edit = await adminSaveEdit(admin, case_id, u2.version, { ...(await getStaffVersion(admin, case_id, u2.version))!.doc, title: 'Edited' });
    await submit('Update four', edit.version, ['update']);
    expect(await status(edit.version)).toBe('draft');
    const imported = await submitCasePackage(pipeline, { slug, doc: update('Imported'), basedOnVersion: v1, origin: 'import' });
    await submit('Update five', imported.version, ['update']);
    expect(await status(imported.version)).toBe('in_review');
  });
});
