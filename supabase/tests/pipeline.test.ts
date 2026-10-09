import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminCreateCase, adminPublish, adminSetUpdateCadence, type Db } from '@sia/case-store';
import { anonClient, clearJobQueue, pool, sql, submitFixture, userClient, withQueueLock } from './helpers';

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
