import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminCreateCase, getPipelineJob, listResearchLog, type Db, type PipelineJobRow } from '@sia/case-store';
import { ANON_KEY, API_URL, pool, sql, userClient, withQueueLock } from '../../../supabase/tests/helpers';
import { FakeRunner, type FakeScript } from '../src/runner/fake';
import { createShutdown } from '../src/shutdown';
import { claimJobById, currentJob, isAuthError, runWorker, runWorkerOnce, type ClaimJob } from '../src/worker';
import { AS_OF, cleanScripts, fakeFetcher, scoperScript } from './helpers';

/**
 * The worker as a long-running service: the poll loop, graceful shutdown (a
 * stopped job is released back to the queue, never failed), the lease (a worker
 * that lost its job stops without submitting), and one job at a time per process.
 */

describe('createShutdown', () => {
  it('the first signal stops claiming and releases the job after the grace period; a second signal releases it at once', async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const s = createShutdown(10_000, (m) => logs.push(m));
      s.trigger('SIGTERM');
      expect(s.stop.aborted).toBe(true);
      expect(s.abort.aborted).toBe(false);
      vi.advanceTimersByTime(9_999);
      expect(s.abort.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(s.abort.aborted).toBe(true);
      expect((s.abort.reason as Error).message).toMatch(/10 s shutdown grace ran out/);

      const t = createShutdown(10_000, (m) => logs.push(m));
      t.trigger('SIGTERM');
      t.trigger('SIGINT');
      expect(t.abort.aborted).toBe(true);
      expect(logs.at(-1)).toMatch(/SIGINT again: releasing the job in progress now/);

      const z = createShutdown(0);
      z.trigger('SIGTERM');
      expect([z.stop.aborted, z.abort.aborted]).toEqual([true, true]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runWorker (poll loop, no database)', () => {
  const fakeDb = {} as Db;
  const runner = new FakeRunner({});

  it('polls an empty queue every pollMs until stopped, and --once returns after one poll', async () => {
    let claims = 0;
    const claim: ClaimJob = async () => {
      claims++;
      return null;
    };
    expect(await runWorker({ db: fakeDb, runner, claim }, { once: true })).toEqual([]);
    expect(claims).toBe(1);

    claims = 0;
    const stop = new AbortController();
    const loop = runWorker({ db: fakeDb, runner, claim }, { pollMs: 20, stop: stop.signal });
    await new Promise((r) => setTimeout(r, 110));
    stop.abort();
    expect(await loop).toEqual([]);
    expect(claims).toBeGreaterThanOrEqual(3);
    expect(claims).toBeLessThanOrEqual(7);
  });

  it('backs off after errors and signs in again after an auth error', async () => {
    const calls: number[] = [];
    const t0 = Date.now();
    let n = 0;
    const claim: ClaimJob = async (db) => {
      calls.push(Date.now() - t0);
      n++;
      if (n === 1) throw new Error('pipeline_claim_job failed: JWT expired');
      if (n === 2) throw new Error('fetch failed');
      expect(db).toBe(fresh);
      return null;
    };
    const fresh = {} as Db;
    const reconnect = vi.fn(async () => fresh);
    const progress: string[] = [];
    const stop = new AbortController();
    const loop = runWorker({ db: fakeDb, runner, claim, onProgress: (m) => progress.push(m) }, { pollMs: 20, stop: stop.signal, reconnect });
    await vi.waitFor(() => expect(n).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    stop.abort();
    await loop;
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(progress).toEqual(expect.arrayContaining(['worker error: pipeline_claim_job failed: JWT expired', 'signed in again', 'worker error: fetch failed']));
    // 20 ms after the first error, 40 ms after the second.
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(35);
    expect(isAuthError(new Error('JWT expired'))).toBe(true);
    expect(isAuthError(new Error('relation does not exist'))).toBe(false);
  });
});

const reachable = await fetch(`${API_URL}/rest/v1/`, { headers: { apikey: ANON_KEY } })
  .then((r) => r.ok)
  .catch(() => false);
if (!reachable) console.warn(`worker service tests skipped: no local Supabase stack at ${API_URL}`);

describe.skipIf(!reachable)('the worker service against the local Supabase stack', () => {
  let admin: Db;
  let pipeline: Db;
  const WORKER = 'vitest-service-worker';

  beforeAll(async () => {
    [admin, pipeline] = await Promise.all([userClient('admin'), userClient('pipeline')]);
  });
  afterAll(() => pool.end());

  /** A scoper that tells the test it started, then waits for `release` (or for the run to be aborted). */
  function blockingScoper(slug: string) {
    let started!: () => void;
    let release!: () => void;
    const isStarted = new Promise<void>((r) => (started = r));
    const released = new Promise<void>((r) => (release = r));
    const script: FakeScript = async (input, ctx, tools, call) => {
      started();
      await released;
      return (scoperScript(slug) as (...a: unknown[]) => unknown)(input, ctx, tools, call);
    };
    return { script, isStarted, release };
  }

  const job = (id: string) => sql<PipelineJobRow>(`select * from public.pipeline_jobs where id = $1`, [id]).then((r) => r[0]!);

  it('a stopped worker releases its job to the queue (never fails it), and claims nothing new', async () => {
    const slug = `svc-release-${randomUUID().slice(0, 8)}`;
    const blocker = blockingScoper(slug);
    await withQueueLock(async () => {
      const jobId = await adminCreateCase(admin, `Release test ${slug}`);
      const shutdown = createShutdown(50);
      let claims = 0;
      const byId = claimJobById(jobId);
      const loop = runWorker(
        {
          db: pipeline,
          runner: new FakeRunner(cleanScripts({ scoper: blocker.script })),
          claim: (db, w) => (claims++, byId(db, w)),
          workerId: WORKER,
          fetcher: fakeFetcher(),
          asOf: AS_OF,
          heartbeatMs: 25,
          signal: shutdown.abort,
        },
        { pollMs: 10, stop: shutdown.stop },
      );
      await blocker.isStarted;
      expect(currentJob()).toBe(jobId);
      // One job at a time per process.
      await expect(runWorkerOnce({ db: pipeline, runner: new FakeRunner({}), claim: async () => null })).rejects.toThrow(/already running job/);

      shutdown.trigger('SIGTERM');
      const outcomes = await loop;
      expect(outcomes).toEqual([expect.objectContaining({ jobId, status: 'released', error: expect.stringMatching(/SIGTERM.*grace ran out/) })]);
      expect(claims).toBe(1);
      expect(currentJob()).toBeNull();
      expect(await job(jobId)).toMatchObject({ status: 'queued', attempts: 1, claimed_by: null, error: null });
      const log = await listResearchLog(admin, jobId);
      expect(log.some((r) => r.kind === 'note' && r.excerpt?.startsWith(`Released by worker ${WORKER} on attempt 1`))).toBe(true);
      await sql(`update public.pipeline_jobs set status = 'cancelled' where id = $1`, [jobId]);
    });
  });

  it('within the grace period the job in progress finishes normally, then the loop ends', async () => {
    const slug = `svc-finish-${randomUUID().slice(0, 8)}`;
    const blocker = blockingScoper(slug);
    await withQueueLock(async () => {
      const jobId = await adminCreateCase(admin, `Finish test ${slug}`);
      const shutdown = createShutdown(30_000);
      const loop = runWorker(
        {
          db: pipeline,
          runner: new FakeRunner(cleanScripts({ scoper: blocker.script })),
          claim: claimJobById(jobId),
          workerId: WORKER,
          fetcher: fakeFetcher(),
          asOf: AS_OF,
          heartbeatMs: 25,
          signal: shutdown.abort,
        },
        { pollMs: 10, stop: shutdown.stop },
      );
      await blocker.isStarted;
      shutdown.trigger('SIGTERM');
      blocker.release();
      const outcomes = await loop;
      shutdown.dispose();
      expect(outcomes).toEqual([expect.objectContaining({ jobId, status: 'succeeded' })]);
      expect(await getPipelineJob(admin, jobId)).toMatchObject({ status: 'succeeded', claimed_by: WORKER });
    });
  });

  it('a worker that lost its lease stops without submitting and leaves the job to its new holder', async () => {
    const slug = `svc-lost-${randomUUID().slice(0, 8)}`;
    const blocker = blockingScoper(slug);
    await withQueueLock(async () => {
      const jobId = await adminCreateCase(admin, `Lost lease test ${slug}`);
      const run = runWorkerOnce({
        db: pipeline,
        runner: new FakeRunner(cleanScripts({ scoper: blocker.script })),
        claim: claimJobById(jobId),
        workerId: WORKER,
        fetcher: fakeFetcher(),
        asOf: AS_OF,
        heartbeatMs: 25,
      });
      await blocker.isStarted;
      // Another worker reclaims it (as pipeline_claim_job does after 30 minutes without a heartbeat).
      await sql(`update public.pipeline_jobs set claimed_by = 'other-worker', attempts = attempts + 1 where id = $1`, [jobId]);
      const outcome = await run;
      expect(outcome).toMatchObject({ jobId, status: 'lost' });
      expect(await job(jobId)).toMatchObject({ status: 'running', claimed_by: 'other-worker', result: null });
      expect((await sql(`select count(*)::int as n from public.staff_case_versions where pipeline_job_id = $1`, [jobId]))[0]).toEqual({ n: 0 });
      const log = await listResearchLog(admin, jobId);
      expect(log.some((r) => r.kind === 'note' && r.excerpt?.includes('no longer holds this job'))).toBe(true);
      await sql(`update public.pipeline_jobs set status = 'cancelled' where id = $1`, [jobId]);
    });
  });

  it('records the job\'s spend with its heartbeat, release and finish, and gives a later attempt only what is left of the budget', async () => {
    const slug = `svc-spend-${randomUUID().slice(0, 8)}`;
    // The scoper finishes ($0.25); the records researcher blocks until the worker is stopped.
    let started!: () => void;
    const isStarted = new Promise<void>((r) => (started = r));
    const blocker = { isStarted, release: () => {} };
    const blockingRecords: FakeScript = () => {
      started();
      return new Promise(() => {});
    };
    await withQueueLock(async () => {
      const jobId = await adminCreateCase(admin, `Spend test ${slug}`);
      // Attempt 1 spends $0.25 per call and is stopped mid-run: the release records what it spent.
      const shutdown = createShutdown(0);
      const first = runWorkerOnce({
        db: pipeline,
        runner: new FakeRunner(cleanScripts({ scoper: scoperScript(slug), records_researcher: blockingRecords }), { costPerCall: 0.25 }),
        claim: claimJobById(jobId),
        workerId: WORKER,
        fetcher: fakeFetcher(),
        asOf: AS_OF,
        heartbeatMs: 25,
        budgetUsd: 10,
        signal: shutdown.abort,
      });
      await blocker.isStarted;
      shutdown.trigger('SIGTERM');
      blocker.release();
      expect(await first).toMatchObject({ jobId, status: 'released' });
      const afterRelease = await job(jobId);
      expect(afterRelease).toMatchObject({ status: 'queued', attempts: 1 });
      // At least the scoper's $0.25 (the side researchers may have finished too).
      expect(Number(afterRelease.spent_usd)).toBeGreaterThanOrEqual(0.25);
      // Pretend the earlier attempts spent most of the budget.
      await sql(`update public.pipeline_jobs set spent_usd = 9.5 where id = $1`, [jobId]);

      // Attempt 2: $9.50 of the $10 budget is gone, so it does not run at all.
      const second = await runWorkerOnce({
        db: pipeline,
        runner: new FakeRunner(cleanScripts({ scoper: scoperScript(slug) }), { costPerCall: 0.25 }),
        claim: claimJobById(jobId),
        workerId: WORKER,
        fetcher: fakeFetcher(),
        asOf: AS_OF,
        budgetUsd: 10,
      });
      expect(second).toMatchObject({ jobId, status: 'failed', error: expect.stringMatching(/budget of \$10\.00 was used up by earlier attempts \(\$9\.50 spent\)/) });
      expect(Number((await job(jobId)).spent_usd)).toBe(9.5);
    });
  });

  it('a finished job records what all its attempts spent', async () => {
    const slug = `svc-spend-ok-${randomUUID().slice(0, 8)}`;
    await withQueueLock(async () => {
      const jobId = await adminCreateCase(admin, `Spend finish test ${slug}`);
      await sql(`update public.pipeline_jobs set spent_usd = 1.5 where id = $1`, [jobId]);
      const runner = new FakeRunner(cleanScripts({ scoper: scoperScript(slug) }), { costPerCall: 0.1 });
      const out = await runWorkerOnce({ db: pipeline, runner, claim: claimJobById(jobId), workerId: WORKER, fetcher: fakeFetcher(), asOf: AS_OF, budgetUsd: 40 });
      expect(out).toMatchObject({ jobId, status: 'succeeded' });
      const calls = runner.calls.length;
      const row = await job(jobId);
      expect(Number(row.spent_usd)).toBeCloseTo(1.5 + calls * 0.1, 4);
      expect(row.result).toMatchObject({ spent_usd_all_attempts: expect.closeTo(1.5 + calls * 0.1, 4) });
      // The research log says how much of the budget this attempt got.
      const log = await listResearchLog(admin, jobId);
      expect(log.some((r) => r.kind === 'note' && r.excerpt?.includes('Earlier attempts of this job spent $1.50 of its $40.00 budget; attempt 1 gets $38.50.'))).toBe(true);
    });
  });
});
