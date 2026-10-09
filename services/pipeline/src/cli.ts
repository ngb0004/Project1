#!/usr/bin/env tsx
/**
 * pipeline run --brief "<one line>" [--out <dir>] [--budget-usd N] [--max-rounds N]
 *   Runs the whole pipeline offline and writes the package directory (case,
 *   review record, research log, snapshots; default services/pipeline/.runs/<run>).
 *   Nothing touches the database.
 *
 * pipeline worker [--once] [--job <id>] [--budget-usd N] [--max-rounds N] [--poll-seconds N]
 *   Claims and runs queued jobs (new cases, revisions, live updates) as the
 *   pipeline account, one at a time. Without --once it is a long-running
 *   service: it polls the queue, renews each job's lease while it runs, and on
 *   SIGTERM/SIGINT stops claiming, gives the job in progress a grace period,
 *   then releases it back to the queue. --job claims only that job. It never
 *   uses the service-role key. Environment: see WORKER_ENV below and README.md.
 *
 * pipeline check <case.json> --snapshots <dir>
 *   Validates a saved case and re-runs the citation check against saved snapshots.
 *
 * pipeline verify <job-id> [--out <dir>]
 *   Audits a finished job from the database (same env as the worker): the package
 *   is in the review queue and schema-valid, every source has an HTTP 200 snapshot
 *   from that job, every quote is in its snapshot, and every agent logged its work.
 *   With --out, saves the package, research log and snapshots to <dir>.
 *
 * Models: PIPELINE_MODEL_STRONG / PIPELINE_MODEL_FAST. Budget: --budget-usd or PIPELINE_BUDGET_USD.
 */
import { existsSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { signInStaff } from '@sia/case-store';
import { MAX_ROUNDS, runCasePipeline, toLocalId } from './orchestrator';
import { checkSavedPackage, manifestOf, writeAuditDir, writePackageToDir } from './package';
import { FileResearchLog } from './research/log';
import { SourceStore } from './research/store';
import { ClaudeAgentRunner } from './runner/claude';
import { verifyJob } from './verify';
import { createShutdown, onShutdownSignals } from './shutdown';
import { claimJobById, defaultWorkerId, runWorker } from './worker';

/** Spend cap per run. A measured three-round run on a two-side case cost $18.20; three sides add a researcher and a red team per round. */
export const DEFAULT_RUN_BUDGET_USD = 40;
/** Offline runs land here by default (git-ignored). */
export const DEFAULT_RUNS_DIR = resolve(import.meta.dirname, '..', '.runs');

/** The worker's environment variables (also listed in README.md). */
export const WORKER_ENV = {
  SUPABASE_URL: 'API URL of the Supabase project (required)',
  SUPABASE_ANON_KEY: 'anon (publishable) key of the project (required); the worker never uses the service-role key',
  PIPELINE_EMAIL: 'the pipeline account (app_metadata.app_role = pipeline) (required)',
  PIPELINE_PASSWORD: 'its password (required)',
  PIPELINE_WORKER_ID: 'name recorded on claimed jobs (default: <hostname>:<pid>)',
  PIPELINE_POLL_SECONDS: 'wait between polls of an empty queue (default 30; --poll-seconds)',
  PIPELINE_HEARTBEAT_SECONDS: 'lease renewal interval while a job runs (default 60; a lease goes stale after 30 minutes)',
  PIPELINE_SHUTDOWN_GRACE_SECONDS: 'on SIGTERM/SIGINT, time the job in progress gets before it is released (default 10)',
  PIPELINE_BUDGET_USD: `spend cap per job in USD (default ${DEFAULT_RUN_BUDGET_USD}; --budget-usd)`,
  PIPELINE_MAX_ROUNDS: 'critic-loop rounds per job, 1 to 3 (default 3; --max-rounds)',
  PIPELINE_MODEL_STRONG: 'model for the scoper, drafter, critics and editor',
  PIPELINE_MODEL_FAST: 'model for the researchers',
  PIPELINE_HEALTH_FILE: 'optional file touched on every poll and heartbeat (for a container health check)',
} as const;

const USAGE = `usage:
  pipeline run --brief "<one line>" [--out <dir>] [--budget-usd N] [--max-rounds N] [--verbose]
  pipeline worker [--once] [--job <id>] [--budget-usd N] [--max-rounds N] [--poll-seconds N] [--verbose]
  pipeline check <case.json> --snapshots <dir>
  pipeline verify <job-id> [--out <dir>]`;

const log = (m: string) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);

/** With --verbose: one line per tool call an agent makes (search, open, read, claim). */
function toolTrace(agent: string, msg: SDKMessage): void {
  if (msg.type !== 'assistant') return;
  for (const block of msg.message.content) {
    if (block.type !== 'tool_use') continue;
    const name = block.name.replace(/^mcp__research__/, '');
    const input = block.input as Record<string, unknown>;
    const arg = input.query ?? input.url ?? input.snapshot_id ?? input.phrase ?? '';
    log(`  ${agent}: ${name} ${String(arg).slice(0, 140)}`);
  }
}

function budgetFrom(arg: string | undefined): number {
  const raw = arg ?? process.env.PIPELINE_BUDGET_USD;
  if (raw === undefined) return DEFAULT_RUN_BUDGET_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--budget-usd must be a positive number, got "${raw}"`);
  return n;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

/** A non-negative number of seconds from a flag or an environment variable, in milliseconds. */
export function secondsFrom(name: string, raw: string | undefined, fallbackSeconds: number): number {
  if (raw === undefined || raw === '') return fallbackSeconds * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of seconds, got "${raw}"`);
  return n * 1000;
}

/** Critic-loop rounds: a whole number from 1 to 3 (the spec's loop stops at 3 rounds). */
export function roundsFrom(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ROUNDS) throw new Error(`--max-rounds must be a whole number from 1 to ${MAX_ROUNDS}, got "${raw}"`);
  return n;
}

async function cmdRun(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      brief: { type: 'string' },
      out: { type: 'string' },
      'budget-usd': { type: 'string' },
      'max-rounds': { type: 'string' },
      verbose: { type: 'boolean' },
    },
  });
  const brief = values.brief?.trim();
  if (!brief) throw new Error('--brief is required');
  const runId = `local-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${toLocalId(brief).slice(0, 30)}`;
  const dir = values.out ? resolve(values.out) : join(DEFAULT_RUNS_DIR, runId);
  const fileLog = new FileResearchLog(dir);
  const store = new SourceStore({ log: fileLog });
  const budgetUsd = budgetFrom(values['budget-usd']);
  const maxRounds = roundsFrom(values['max-rounds']);
  log(`run ${runId}: "${brief}" (budget $${budgetUsd}) -> ${dir}`);
  const result = await runCasePipeline(
    { kind: 'new_case', brief },
    {
      runner: new ClaudeAgentRunner(values.verbose ? { onMessage: toolTrace } : {}),
      store,
      runId,
      budgetUsd,
      ...(maxRounds ? { maxRounds } : {}),
      onProgress: log,
    },
  );
  if (result.kind !== 'package') throw new Error('a new case cannot come back with no changes');
  await writePackageToDir(result, dir, { store });
  process.stdout.write(`${JSON.stringify({ dir, ...manifestOf(result) }, null, 2)}\n`);
  return 0;
}

async function cmdWorker(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      once: { type: 'boolean' },
      job: { type: 'string' },
      'budget-usd': { type: 'string' },
      'max-rounds': { type: 'string' },
      'poll-seconds': { type: 'string' },
      verbose: { type: 'boolean' },
    },
  });
  const env = process.env;
  const url = requireEnv('SUPABASE_URL');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');
  const creds = { email: requireEnv('PIPELINE_EMAIL'), password: requireEnv('PIPELINE_PASSWORD') };
  const pollMs = secondsFrom('--poll-seconds', values['poll-seconds'] ?? env.PIPELINE_POLL_SECONDS, 30);
  const heartbeatMs = Math.max(1000, secondsFrom('PIPELINE_HEARTBEAT_SECONDS', env.PIPELINE_HEARTBEAT_SECONDS, 60));
  const graceMs = secondsFrom('PIPELINE_SHUTDOWN_GRACE_SECONDS', env.PIPELINE_SHUTDOWN_GRACE_SECONDS, 10);
  const maxRounds = roundsFrom(values['max-rounds'] ?? env.PIPELINE_MAX_ROUNDS);
  const budgetUsd = budgetFrom(values['budget-usd']);
  const workerId = env.PIPELINE_WORKER_ID || defaultWorkerId();
  const healthFile = env.PIPELINE_HEALTH_FILE;
  const touch = healthFile
    ? () => {
        try {
          const now = new Date();
          if (existsSync(healthFile)) utimesSync(healthFile, now, now);
          else writeFileSync(healthFile, `${workerId}\n`);
        } catch {
          // A health file that cannot be written must not stop the worker.
        }
      }
    : undefined;

  const db = await signInStaff(url, anonKey, creds);
  const shutdown = createShutdown(graceMs, log);
  const unwire = onShutdownSignals(shutdown);
  const once = values.once ?? false;
  log(
    `worker ${workerId}: ${once ? 'one job' : `polling every ${pollMs / 1000} s`}${values.job ? `, job ${values.job} only` : ''}; ` +
      `budget $${budgetUsd} per job; heartbeat ${heartbeatMs / 1000} s; shutdown grace ${graceMs / 1000} s`,
  );
  try {
    const outcomes = await runWorker(
      {
        db,
        runner: new ClaudeAgentRunner(values.verbose ? { onMessage: toolTrace } : {}),
        workerId,
        ...(values.job ? { claim: claimJobById(values.job) } : {}),
        budgetUsd,
        ...(maxRounds ? { maxRounds } : {}),
        heartbeatMs,
        onProgress: log,
        ...(touch ? { onAlive: touch } : {}),
        signal: shutdown.abort,
      },
      {
        once,
        pollMs,
        stop: shutdown.stop,
        reconnect: () => signInStaff(url, anonKey, creds),
        onOutcome: (o) => process.stdout.write(`${JSON.stringify(o)}\n`),
      },
    );
    if (once && outcomes.length === 0) log(values.job ? `job ${values.job} is not claimable (not queued, or running elsewhere)` : 'no queued jobs');
    if (shutdown.stop.aborted) log('stopped');
    return outcomes.some((o) => o.status === 'failed') && once ? 1 : 0;
  } finally {
    unwire();
  }
}

async function cmdVerify(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: 'string' } } });
  const jobId = positionals[0];
  if (!jobId) throw new Error('usage: pipeline verify <job-id> [--out <dir>]');
  const db = await signInStaff(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    email: requireEnv('PIPELINE_EMAIL'),
    password: requireEnv('PIPELINE_PASSWORD'),
  });
  const audit = await verifyJob(db, jobId);
  for (const c of audit.checks) process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}\n`);
  if (values.out) {
    const dir = resolve(values.out);
    await writeAuditDir(audit, dir);
    process.stdout.write(`saved to ${dir}\n`);
  }
  process.stdout.write(audit.ok ? 'verified\n' : 'not verified\n');
  return audit.ok ? 0 : 1;
}

async function cmdCheck(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { snapshots: { type: 'string' } } });
  const casePath = positionals[0];
  if (!casePath || !values.snapshots) throw new Error('usage: pipeline check <case.json> --snapshots <dir>');
  const r = await checkSavedPackage(resolve(casePath), resolve(values.snapshots));
  for (const e of r.schemaErrors) process.stdout.write(`schema  ${e.path}: ${e.message}\n`);
  for (const f of r.failures) process.stdout.write(`${f.verdict.padEnd(18)} ${f.target}${f.source_id ? ` [${f.source_id}]` : ''}: ${f.note}\n`);
  process.stdout.write(
    r.ok
      ? `ok: every source was opened and every quote is in its snapshot (${r.snapshots} snapshots)\n`
      : `failed: ${r.schemaErrors.length} schema error(s), ${r.failures.length} citation failure(s)\n`,
  );
  return r.ok ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'run':
      return cmdRun(rest);
    case 'worker':
      return cmdWorker(rest);
    case 'check':
      return cmdCheck(rest);
    case 'verify':
      return cmdVerify(rest);
    default:
      process.stderr.write(`${USAGE}\n\nworker environment:\n${Object.entries(WORKER_ENV).map(([k, v]) => `  ${k.padEnd(32)} ${v}`).join('\n')}\n`);
      return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2;
  }
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e: Error) => {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(1);
    },
  );
}
