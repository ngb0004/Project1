import { hostname } from 'node:os';
import { Case as CaseSchema } from '@sia/case-schema';
import { getStaffVersion, type Db, type PipelineJobRow } from '@sia/case-store';
import { PIPELINE_LOG_AGENT, runCasePipeline, type PipelineAgents, type PipelineRequest } from './orchestrator';
import { submitPackage } from './package';
import type { FetchOptions } from './research/fetch';
import { DbResearchLog } from './research/log';
import { SourceStore, type Fetcher } from './research/store';
import type { AgentRunner } from './runner/types';

/**
 * The pipeline worker. It signs in as the pipeline account (never the service
 * role), claims the oldest queued job, heartbeats while it runs, writes the
 * research log and snapshots for the job, submits the package for review and
 * finishes the job: succeeded, no_changes (an update with nothing material
 * new) or failed with the error.
 */

/** Takes the next job off the queue for this worker, or null when there is none. */
export type ClaimJob = (db: Db, workerId: string) => Promise<PipelineJobRow | null>;

export interface WorkerDeps {
  db: Db;
  runner: AgentRunner;
  workerId?: string;
  /**
   * How a job is claimed (default `claimNextJob`: the oldest queued job, through
   * pipeline_claim_job). Tests that share the queue with other suites pass a claim
   * that only takes the job they queued.
   */
  claim?: ClaimJob;
  agents?: PipelineAgents;
  /** Spend cap per job, in USD. */
  budgetUsd?: number;
  maxRounds?: number;
  asOf?: string;
  fetch?: FetchOptions;
  fetcher?: Fetcher;
  heartbeatMs?: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface JobOutcome {
  jobId: string;
  kind: PipelineJobRow['kind'];
  status: 'succeeded' | 'no_changes' | 'failed';
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

/** Builds the pipeline request for a claimed job. */
export async function requestForJob(db: Db, job: PipelineJobRow): Promise<PipelineRequest> {
  switch (job.kind) {
    case 'new_case':
      if (!job.brief?.trim()) throw new Error('the job has no brief');
      return { kind: 'new_case', brief: job.brief.trim() };
    case 'revision':
      if (!job.case_id || job.base_version === null) throw new Error('a revision job needs a case and a base version');
      return { kind: 'revision', base: await loadVersion(db, job.case_id, job.base_version), instructions: job.instructions ?? '' };
    case 'update':
      if (!job.case_id || job.base_version === null) throw new Error('an update job needs a case and a live version');
      return { kind: 'update', live: await loadVersion(db, job.case_id, job.base_version) };
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

/** Claims and runs one job. Returns null when the queue is empty. */
export async function runWorkerOnce(deps: WorkerDeps): Promise<JobOutcome | null> {
  const { db } = deps;
  const job = await (deps.claim ?? claimNextJob)(db, deps.workerId ?? defaultWorkerId());
  if (!job) return null;

  const progress = (m: string) => deps.onProgress?.(`[job ${job.id.slice(0, 8)}] ${m}`);
  progress(`claimed ${job.kind} job (attempt ${job.attempts})`);
  const heartbeat = setInterval(() => {
    void db.rpc('pipeline_heartbeat', { p_job_id: job.id }).then(({ error }) => {
      if (error) progress(`heartbeat failed: ${error.message}`);
    });
  }, deps.heartbeatMs ?? 60_000);

  const log = new DbResearchLog(db, job.id, job.case_id);
  const store = new SourceStore({ log, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.fetcher ? { fetcher: deps.fetcher } : {}) });
  try {
    const request = await requestForJob(db, job);
    const result = await runCasePipeline(request, {
      runner: deps.runner,
      store,
      runId: job.id,
      ...(deps.agents ? { agents: deps.agents } : {}),
      ...(deps.asOf ? { asOf: deps.asOf } : {}),
      ...(deps.maxRounds ? { maxRounds: deps.maxRounds } : {}),
      ...(deps.budgetUsd ? { budgetUsd: deps.budgetUsd } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      onProgress: progress,
    });

    if (result.kind === 'no_changes') {
      const out = { summary: result.summary, cost_usd: result.costUsd, sources_opened: result.researchLog.opened.length, research_log_rows: result.researchLog.total };
      await rpc(db, 'pipeline_finish_job', { p_job_id: job.id, p_status: 'no_changes', p_result: out });
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
    const ref = await submitPackage(db, result, {
      jobId: job.id,
      basedOnVersion: job.kind === 'new_case' ? null : job.base_version,
      tags: [job.kind],
    });
    const out = {
      case_id: ref.case_id,
      slug: ref.slug ?? result.case.slug,
      version: ref.version,
      rounds: result.rounds,
      clean: result.clean,
      editor_fallback: result.editorFallback,
      open_issues: result.review.open_issues.length,
      cost_usd: Math.round(result.costUsd * 10000) / 10000,
      sources_opened: result.researchLog.opened.length,
      research_log_rows: result.researchLog.total,
    };
    await rpc(db, 'pipeline_finish_job', { p_job_id: job.id, p_status: 'succeeded', p_result: out });
    progress(`submitted ${out.slug} v${out.version} for review`);
    return { jobId: job.id, kind: job.kind, status: 'succeeded', result: out };
  } catch (e) {
    const err = e as Error & { costUsd?: number };
    const message = `${err.name}: ${err.message}`;
    progress(`failed: ${message}`);
    await log.append({ agent: PIPELINE_LOG_AGENT, round: 0, kind: 'note', excerpt: `Job failed: ${message}` }).catch(() => {});
    const out = { cost_usd: Math.round((err.costUsd ?? 0) * 10000) / 10000, sources_opened: store.opened().length };
    await rpc(db, 'pipeline_finish_job', { p_job_id: job.id, p_status: 'failed', p_result: out, p_error: message.slice(0, 20000) }).catch((fe: Error) =>
      progress(`could not mark the job failed: ${fe.message}`),
    );
    return { jobId: job.id, kind: job.kind, status: 'failed', result: out, error: message };
  } finally {
    clearInterval(heartbeat);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** Polls the queue until aborted (or once, with `once`). */
export async function runWorker(deps: WorkerDeps, opts: { once?: boolean; pollMs?: number } = {}): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];
  while (!deps.signal?.aborted) {
    let outcome: JobOutcome | null = null;
    try {
      outcome = await runWorkerOnce(deps);
    } catch (e) {
      deps.onProgress?.(`worker error: ${(e as Error).message}`);
    }
    if (outcome) outcomes.push(outcome);
    if (opts.once) break;
    if (!outcome) await sleep(opts.pollMs ?? 30_000, deps.signal);
  }
  return outcomes;
}
