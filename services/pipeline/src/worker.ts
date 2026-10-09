import { hostname } from 'node:os';
import { Case as CaseSchema } from '@sia/case-schema';
import { getStaffCase, getStaffVersion, type Db, type PipelineJobRow } from '@sia/case-store';
import { archiveFor, type ArchivedSnapshot } from './archive';
import { PIPELINE_LOG_AGENT, runCasePipeline, type PipelineAgents, type PipelineRequest } from './orchestrator';
import { submitPackage } from './package';
import type { FetchOptions } from './research/fetch';
import { DbResearchLog } from './research/log';
import { SourceStore, type Fetcher } from './research/store';
import type { AgentRunner } from './runner/types';

/**
 * The pipeline worker. It signs in as the pipeline account (never the service
 * role), claims the oldest queued job, renews its lease with a heartbeat while
 * it runs, writes the research log and snapshots for the job, submits the
 * package for review and finishes the job: succeeded, no_changes (an update
 * with nothing material new) or failed with the error.
 *
 * As a service (`runWorker`) it polls the queue, runs one job at a time per
 * process, and stops gracefully: a stop signal ends the loop after the job in
 * progress, and an abort signal stops that job and releases it back to the
 * queue (a stopped worker never marks a job failed). A worker that finds it no
 * longer holds its job (another worker reclaimed it after its heartbeat went
 * stale) stops without submitting anything.
 */

/** Takes the next job off the queue for this worker, or null when there is none. */
export type ClaimJob = (db: Db, workerId: string) => Promise<PipelineJobRow | null>;

export interface WorkerDeps {
  db: Db;
  runner: AgentRunner;
  workerId?: string;
  /**
   * How a job is claimed (default `claimNextJob`: the oldest queued job, through
   * pipeline_claim_job). `claimJobById` claims one named job.
   */
  claim?: ClaimJob;
  agents?: PipelineAgents;
  /**
   * Spend cap per job, in USD, across all its attempts: an attempt gets what
   * earlier attempts (the job's recorded spent_usd) left of it.
   */
  budgetUsd?: number;
  maxRounds?: number;
  asOf?: string;
  fetch?: FetchOptions;
  fetcher?: Fetcher;
  /** How often the lease is renewed while a job runs (default 60 s; a lease goes stale after 30 minutes). */
  heartbeatMs?: number;
  onProgress?: (message: string) => void;
  /** Called on every heartbeat and every poll, e.g. to touch a health file. */
  onAlive?: () => void;
  /**
   * Aborts the job in progress. The job is released back to the queue (after
   * its third attempt it fails instead); it is never marked failed for this.
   */
  signal?: AbortSignal;
}

export interface JobOutcome {
  jobId: string;
  kind: PipelineJobRow['kind'];
  /**
   * `released`: the worker was stopped and gave the job back to the queue.
   * `lost`: another worker holds the job now; this one left it alone.
   */
  status: 'succeeded' | 'no_changes' | 'failed' | 'released' | 'lost';
  result?: Record<string, unknown>;
  error?: string;
}

export const defaultWorkerId = () => `${hostname()}:${process.pid}`;

async function rpc<T>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data as T;
}

async function loadVersion(db: Db, caseId: string, version: number) {
  const row = await getStaffVersion(db, caseId, version);
  if (!row) throw new Error(`version ${version} of case ${caseId} was not found`);
  return CaseSchema.parse(row.doc);
}

/** The default claim: pipeline_claim_job, which takes the oldest queued job (or a stale running one). */
export const claimNextJob: ClaimJob = async (db, workerId) => {
  const claimed = await rpc<PipelineJobRow[]>(db, 'pipeline_claim_job', { p_worker: workerId });
  return claimed?.[0] ?? null;
};

/** A claim that takes only the named job (when it is queued, or running with a stale heartbeat). */
export const claimJobById =
  (jobId: string): ClaimJob =>
  async (db, workerId) => {
    const claimed = await rpc<PipelineJobRow[]>(db, 'pipeline_claim_job', { p_worker: workerId, p_job_id: jobId });
    return claimed?.[0] ?? null;
  };

/** What a claimed job will do: run the pipeline, or (an update that would collide with other work) finish at once. */
export type JobPlan =
  | {
      kind: 'run';
      request: PipelineRequest;
      /** The version the package will be submitted against (`based_on_version`). */
      basedOnVersion: number | null;
      /** Research-log notes on how the job was resolved. */
      notes: string[];
    }
  | { kind: 'skip'; summary: string; notes: string[] };

/**
 * Resolves a live update against the case as it is now, not as it was when the
 * job was queued:
 *
 * - the live version is the case's current live version (the job's
 *   base_version is only what was live when it was queued);
 * - while a revision job for the case is queued or running, the update is
 *   skipped: that job's package will be in review shortly, and the next update
 *   builds on it;
 * - when the pipeline's newest package for the live version is waiting in
 *   review (an earlier update, or a revision of one), the update builds on it
 *   and replaces it, so the queue holds one current package per live case;
 * - unless the admin already acted on that package (approved it for a set
 *   time, or has an edit draft of it): then the update is skipped.
 *
 * A skipped update finishes as `no_changes` with `skipped: true` and the reason.
 */
export async function planUpdate(db: Db, job: PipelineJobRow): Promise<JobPlan> {
  if (!job.case_id) throw new Error('an update job needs a case');
  const notes: string[] = [];
  const c = await getStaffCase(db, job.case_id);
  if (!c) throw new Error(`case ${job.case_id} was not found`);
  const liveVersion = c.live_version;
  if (liveVersion === null) throw new Error(`case ${c.slug} has no live version any more; there is nothing to update`);
  if (job.base_version !== null && job.base_version !== liveVersion) {
    notes.push(`The job was queued against version ${job.base_version}; version ${liveVersion} is live now, so the update researches against it.`);
  }

  const { data: active, error: jobsError } = await db
    .from('pipeline_jobs')
    .select('id, status')
    .eq('case_id', job.case_id)
    .eq('kind', 'revision')
    .in('status', ['queued', 'running'])
    .neq('id', job.id)
    .limit(1);
  if (jobsError) throw new Error(`could not check the case's other jobs: ${jobsError.message}`);
  const busy = (active as { id: string; status: string }[])[0];
  if (busy) {
    const summary =
      `Skipped: revision job ${busy.id.slice(0, 8)} for this case is ${busy.status}; its package goes to review shortly, ` +
      'and the next scheduled update builds on it. Nothing was researched.';
    return { kind: 'skip', summary, notes: [...notes, summary] };
  }

  const live = await loadVersion(db, job.case_id, liveVersion);
  const { data: pendingRows, error: pendingError } = await db
    .from('staff_case_versions')
    .select('version, tags, scheduled_publish_at')
    .eq('case_id', job.case_id)
    .eq('status', 'in_review')
    .eq('origin', 'pipeline')
    .eq('parent_version', liveVersion)
    .overlaps('tags', ['update', 'revision'])
    .order('version', { ascending: false })
    .limit(1);
  if (pendingError) throw new Error(`could not look for a pending update: ${pendingError.message}`);
  const pendingRow = (pendingRows as { version: number; tags: string[]; scheduled_publish_at: string | null }[])[0];
  if (!pendingRow) return { kind: 'run', request: { kind: 'update', live }, basedOnVersion: live.version, notes };

  // The admin has already acted on that package: approved it for a set time, or started editing it. Leave it alone.
  if (pendingRow.scheduled_publish_at) {
    const summary =
      `Skipped: version ${pendingRow.version} is approved to go live at ${pendingRow.scheduled_publish_at}; ` +
      'the next scheduled update researches against it once it is live. Nothing was researched.';
    return { kind: 'skip', summary, notes: [...notes, summary] };
  }
  const { data: edits, error: editsError } = await db
    .from('staff_case_versions')
    .select('version')
    .eq('case_id', job.case_id)
    .eq('based_on_version', pendingRow.version)
    .eq('origin', 'admin')
    .eq('status', 'draft')
    .limit(1);
  if (editsError) throw new Error(`could not look for admin edits: ${editsError.message}`);
  const edit = (edits as { version: number }[])[0];
  if (edit) {
    const summary =
      `Skipped: the admin is editing version ${pendingRow.version} (draft v${edit.version}); an update now would replace the package under the edit. ` +
      'The next scheduled update runs once the admin has decided. Nothing was researched.';
    return { kind: 'skip', summary, notes: [...notes, summary] };
  }

  const pending = await loadVersion(db, job.case_id, pendingRow.version);
  notes.push(
    `Version ${pending.version} (${pendingRow.tags.join(', ') || 'pipeline'}, as of ${pending.as_of}) already updates live version ${live.version} and is waiting for review. ` +
      `This update builds on it, researches what is new since ${pending.as_of}, and if it finds anything replaces it in the queue.`,
  );
  return { kind: 'run', request: { kind: 'update', live, pending }, basedOnVersion: pending.version, notes };
}

/** Builds the plan for a claimed job. */
export async function planJob(db: Db, job: PipelineJobRow): Promise<JobPlan> {
  switch (job.kind) {
    case 'new_case':
      if (!job.brief?.trim()) throw new Error('the job has no brief');
      return { kind: 'run', request: { kind: 'new_case', brief: job.brief.trim() }, basedOnVersion: null, notes: [] };
    case 'revision':
      if (!job.case_id || job.base_version === null) throw new Error('a revision job needs a case and a base version');
      return {
        kind: 'run',
        request: { kind: 'revision', base: await loadVersion(db, job.case_id, job.base_version), instructions: job.instructions ?? '' },
        basedOnVersion: job.base_version,
        notes: [],
      };
    case 'update':
      return planUpdate(db, job);
  }
}

/**
 * A slug no other case uses. A new case must never land as a version of an
 * unrelated case that happens to share the scoper's slug.
 */
export async function freeSlug(db: Db, slug: string): Promise<string> {
  const { data, error } = await db.from('staff_cases').select('slug').like('slug', `${slug}%`);
  if (error) throw new Error(`could not check the slug: ${error.message}`);
  const taken = new Set((data as { slug: string }[]).map((r) => r.slug));
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${slug.slice(0, 80 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The worker lost its job to another worker; it stops without touching the job. */
export class JobLostError extends Error {
  constructor(jobId: string) {
    super(`job ${jobId} is no longer held by this worker (another worker reclaimed it, or it was finished elsewhere)`);
    this.name = 'JobLostError';
  }
}

/** One job at a time per process: the job (or claim) in progress, if any. */
let activeJob: string | null = null;

/** The job this process is running, if any. */
export const currentJob = () => (activeJob && activeJob !== 'claiming' ? activeJob : null);

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Claims and runs one job. Returns null when the queue is empty. Refuses to start while this process runs another job. */
export async function runWorkerOnce(deps: WorkerDeps): Promise<JobOutcome | null> {
  if (activeJob) throw new Error(`this process is already running ${activeJob === 'claiming' ? 'a claim' : `job ${activeJob}`}; a worker runs one job at a time`);
  activeJob = 'claiming';
  let job: PipelineJobRow | null;
  try {
    job = await (deps.claim ?? claimNextJob)(deps.db, deps.workerId ?? defaultWorkerId());
  } catch (e) {
    activeJob = null;
    throw e;
  }
  if (!job) {
    activeJob = null;
    return null;
  }
  activeJob = job.id;
  try {
    return await runClaimedJob(deps, job);
  } finally {
    activeJob = null;
  }
}

async function runClaimedJob(deps: WorkerDeps, job: PipelineJobRow): Promise<JobOutcome> {
  const { db } = deps;
  const workerId = deps.workerId ?? defaultWorkerId();
  const progress = (m: string) => deps.onProgress?.(`[job ${job.id.slice(0, 8)}] ${m}`);
  progress(`claimed ${job.kind} job (attempt ${job.attempts})`);

  // The job's own abort: the worker's signal (shutdown), or a lost lease.
  const jobAbort = new AbortController();
  const onStop = () => jobAbort.abort(deps.signal?.reason ?? new Error('the worker is stopping'));
  if (deps.signal?.aborted) onStop();
  else deps.signal?.addEventListener('abort', onStop, { once: true });

  // Spend: what earlier attempts of this job recorded, plus what this attempt has spent so far. It is reported
  // with every heartbeat, on release and on finish, so a job that runs again starts with what is left.
  const priorSpend = Math.max(0, Number(job.spent_usd ?? 0) || 0);
  let attemptSpend = 0;
  const spent = () => round4(priorSpend + attemptSpend);

  // The heartbeat renews the lease; once the outcome is being written it stops, since a finished job has no lease.
  let lost = false;
  let finishing = false;
  const beat = async () => {
    deps.onAlive?.();
    const { data, error } = await db.rpc('pipeline_renew_lease', { p_job_id: job.id, p_worker: workerId, p_spent_usd: spent() });
    if (finishing) return;
    if (error) {
      progress(`heartbeat failed: ${error.message}`);
      return;
    }
    if (data === false) {
      lost = true;
      progress('lost the job: another worker holds it now; stopping without submitting');
      jobAbort.abort(new JobLostError(job.id));
    }
  };
  const heartbeat = setInterval(() => void beat().catch((e: Error) => progress(`heartbeat failed: ${e.message}`)), deps.heartbeatMs ?? 60_000);
  // Never keep the process alive for the heartbeat alone (Node timers have unref; DOM typings do not know it).
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  const log = new DbResearchLog(db, job.id, job.case_id);
  const note = (excerpt: string) => log.append({ agent: PIPELINE_LOG_AGENT, round: 0, kind: 'note', excerpt });
  const store = new SourceStore({ log, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.fetcher ? { fetcher: deps.fetcher } : {}) });
  const finish = async (status: 'succeeded' | 'no_changes' | 'failed', result: Record<string, unknown>, error?: string) => {
    finishing = true;
    clearInterval(heartbeat);
    await rpc(db, 'pipeline_finish_job', {
      p_job_id: job.id,
      p_status: status,
      p_result: result,
      p_worker: workerId,
      p_spent_usd: spent(),
      ...(error !== undefined ? { p_error: error.slice(0, 20000) } : {}),
    });
  };

  try {
    const plan = await planJob(db, job);
    for (const n of plan.notes) await note(n);
    if (plan.kind === 'skip') {
      const out = { summary: plan.summary, skipped: true, cost_usd: 0 };
      await finish('no_changes', out);
      progress(plan.summary);
      return { jobId: job.id, kind: job.kind, status: 'no_changes', result: out };
    }

    // Revisions and updates check the facts they leave unchanged against what the sources said when they were cited.
    let archive: ArchivedSnapshot[] = [];
    const base = plan.request.kind === 'revision' ? plan.request.base : plan.request.kind === 'update' ? (plan.request.pending ?? plan.request.live) : null;
    if (base && job.case_id && plan.basedOnVersion !== null) {
      try {
        archive = (await archiveFor(db, job.case_id, plan.basedOnVersion, base)).snapshots;
      } catch (e) {
        await note(`Could not load the archived snapshots of version ${plan.basedOnVersion} (${(e as Error).message}); sources are checked as re-opened in this run only.`);
      }
    }

    // The budget covers every attempt of the job: this attempt gets what the earlier ones left.
    let budgetUsd = deps.budgetUsd;
    if (budgetUsd !== undefined && priorSpend > 0) {
      budgetUsd = budgetUsd - priorSpend;
      await note(
        `Earlier attempts of this job spent $${priorSpend.toFixed(2)} of its $${deps.budgetUsd!.toFixed(2)} budget; attempt ${job.attempts} gets $${Math.max(0, budgetUsd).toFixed(2)}.`,
      );
      if (budgetUsd < 1) {
        throw new Error(`the job's budget of $${deps.budgetUsd!.toFixed(2)} was used up by earlier attempts ($${priorSpend.toFixed(2)} spent), so attempt ${job.attempts} did not run`);
      }
    }

    const result = await runCasePipeline(plan.request, {
      runner: deps.runner,
      store,
      runId: job.id,
      ...(archive.length ? { archive } : {}),
      ...(deps.agents ? { agents: deps.agents } : {}),
      ...(deps.asOf ? { asOf: deps.asOf } : {}),
      ...(deps.maxRounds ? { maxRounds: deps.maxRounds } : {}),
      ...(budgetUsd ? { budgetUsd } : {}),
      signal: jobAbort.signal,
      onProgress: progress,
      onSpend: (usd) => {
        attemptSpend = usd;
      },
    });
    // From here on the job is completed whatever the stop signal says: submitting takes seconds, and a job whose
    // package is already in the queue must not be released and run again. Only a lost lease stops it.
    if (lost) throw new JobLostError(job.id);

    if (result.kind === 'no_changes') {
      const out = {
        summary: result.summary,
        ...(result.baseVersion !== undefined ? { base_version: result.baseVersion } : {}),
        ...(result.since ? { since: result.since } : {}),
        cost_usd: round4(result.costUsd),
        ...(priorSpend > 0 ? { spent_usd_all_attempts: spent() } : {}),
        sources_opened: result.researchLog.opened.length,
        research_log_rows: result.researchLog.total,
      };
      await finish('no_changes', out);
      progress(`no changes: ${result.summary}`);
      return { jobId: job.id, kind: job.kind, status: 'no_changes', result: out };
    }

    if (job.kind === 'new_case') {
      const slug = await freeSlug(db, result.case.slug);
      if (slug !== result.case.slug) {
        await log.append({ agent: PIPELINE_LOG_AGENT, round: result.rounds, kind: 'note', excerpt: `The slug "${result.case.slug}" is taken by another case; submitting as "${slug}".` });
        result.case = { ...result.case, slug, id: slug };
      }
    }
    finishing = true;
    clearInterval(heartbeat);
    const ref = await submitPackage(db, result, { jobId: job.id, basedOnVersion: plan.basedOnVersion, tags: [job.kind] });
    const out = {
      case_id: ref.case_id,
      slug: ref.slug ?? result.case.slug,
      version: ref.version,
      ...(plan.basedOnVersion !== null ? { based_on_version: plan.basedOnVersion } : {}),
      ...(result.case.parent_version !== undefined ? { parent_version: result.case.parent_version } : {}),
      rounds: result.rounds,
      clean: result.clean,
      editor_fallback: result.editorFallback,
      open_issues: result.review.open_issues.length,
      cost_usd: round4(result.costUsd),
      ...(priorSpend > 0 ? { spent_usd_all_attempts: spent() } : {}),
      sources_opened: result.researchLog.opened.length,
      research_log_rows: result.researchLog.total,
      ...(result.update ? { update_summary: result.update.summary, developments: result.update.developments.length, since: result.update.since } : {}),
    };
    await finish('succeeded', out);
    progress(`submitted ${out.slug} v${out.version} for review`);
    return { jobId: job.id, kind: job.kind, status: 'succeeded', result: out };
  } catch (e) {
    clearInterval(heartbeat);
    const err = e as Error & { costUsd?: number };
    const message = `${err.name}: ${err.message}`;
    attemptSpend = Math.max(attemptSpend, err.costUsd ?? 0);
    const out = { cost_usd: round4(attemptSpend), spent_usd_all_attempts: spent(), sources_opened: store.opened().length };

    if (lost || e instanceof JobLostError) {
      await note(`Worker ${workerId} stopped: it no longer holds this job (${message}). Nothing was submitted by this attempt.`).catch(() => {});
      return { jobId: job.id, kind: job.kind, status: 'lost', result: out, error: message };
    }
    if (jobAbort.signal.aborted && !finishing) {
      const reason = (jobAbort.signal.reason as Error | undefined)?.message ?? 'the worker is stopping';
      try {
        const status = await rpc<string>(db, 'pipeline_release_job', { p_job_id: job.id, p_worker: workerId, p_reason: reason, p_spent_usd: spent() });
        await note(
          status === 'queued'
            ? `Released by worker ${workerId} on attempt ${job.attempts} (${reason}); the job is back in the queue and the next attempt starts over.`
            : `Released by worker ${workerId} on attempt ${job.attempts} (${reason}); that was the last attempt, so the job failed.`,
        ).catch(() => {});
        progress(`released the job (${reason}); it is ${status} now`);
        return { jobId: job.id, kind: job.kind, status: status === 'queued' ? 'released' : 'failed', result: out, error: reason };
      } catch (re) {
        progress(`could not release the job: ${(re as Error).message}; it will be reclaimed once its heartbeat is 30 minutes old`);
        return { jobId: job.id, kind: job.kind, status: 'released', result: out, error: `${reason}; release failed: ${(re as Error).message}` };
      }
    }

    progress(`failed: ${message}`);
    await note(`Job failed: ${message}`).catch(() => {});
    await finish('failed', out, message).catch((fe: Error) => progress(`could not mark the job failed: ${fe.message}`));
    return { jobId: job.id, kind: job.kind, status: 'failed', result: out, error: message };
  } finally {
    clearInterval(heartbeat);
    deps.signal?.removeEventListener('abort', onStop);
  }
}

const sleep = (ms: number, ...signals: (AbortSignal | undefined)[]) =>
  new Promise<void>((resolve) => {
    const live = signals.filter((s): s is AbortSignal => !!s);
    if (live.some((s) => s.aborted)) return resolve();
    const done = () => {
      clearTimeout(t);
      for (const s of live) s.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    for (const s of live) s.addEventListener('abort', done, { once: true });
  });

/** Errors that a fresh sign-in can fix (an expired or revoked session). */
export function isAuthError(e: unknown): boolean {
  return /jwt|token is expired|invalid claim|not authenticated|PGRST30[0-3]|\b401\b/i.test((e as Error)?.message ?? '');
}

export interface WorkerLoopOptions {
  /** Run at most one job, then return (also when the queue is empty). */
  once?: boolean;
  /** How long to wait when the queue is empty (default 30 s). */
  pollMs?: number;
  /** Most time between polls after repeated errors (default 10 minutes). */
  maxBackoffMs?: number;
  /** Graceful stop: claim no new job; the loop ends after the job in progress. */
  stop?: AbortSignal;
  /** Signs in again after an auth error (a long-running service whose session was lost). */
  reconnect?: () => Promise<Db>;
  /** Called with each finished job as it happens. */
  onOutcome?: (o: JobOutcome) => void;
}

/**
 * Polls the queue and runs jobs one at a time until stopped (or once, with
 * `once`). When the queue is empty it waits `pollMs`; after a job it checks
 * again at once; after an error it backs off (doubling, up to `maxBackoffMs`).
 * Returns the last 100 outcomes.
 */
export async function runWorker(deps: WorkerDeps, opts: WorkerLoopOptions = {}): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];
  const pollMs = opts.pollMs ?? 30_000;
  let db = deps.db;
  let errors = 0;
  while (!opts.stop?.aborted && !deps.signal?.aborted) {
    deps.onAlive?.();
    let outcome: JobOutcome | null = null;
    try {
      outcome = await runWorkerOnce({ ...deps, db });
      errors = 0;
    } catch (e) {
      errors++;
      deps.onProgress?.(`worker error: ${(e as Error).message}`);
      if (opts.reconnect && isAuthError(e)) {
        try {
          db = await opts.reconnect();
          deps.onProgress?.('signed in again');
        } catch (re) {
          deps.onProgress?.(`sign-in failed: ${(re as Error).message}`);
        }
      }
    }
    if (outcome) {
      outcomes.push(outcome);
      if (outcomes.length > 100) outcomes.shift();
      opts.onOutcome?.(outcome);
    }
    if (opts.once) break;
    if (outcome && errors === 0) continue;
    const wait = errors ? Math.min(pollMs * 2 ** (errors - 1), opts.maxBackoffMs ?? 600_000) : pollMs;
    await sleep(wait, opts.stop, deps.signal);
  }
  return outcomes;
}
