#!/usr/bin/env tsx
/**
 * pipeline run --brief "<one line>" [--out <dir>] [--budget-usd N] [--max-rounds N]
 *   Runs the whole pipeline offline and writes the package directory (case,
 *   review record, research log, snapshots; default services/pipeline/.runs/<run>).
 *   Nothing touches the database.
 *
 * pipeline worker [--once] [--budget-usd N] [--poll-seconds N]
 *   Claims and runs queued jobs as the pipeline account. Needs SUPABASE_URL,
 *   SUPABASE_ANON_KEY, PIPELINE_EMAIL and PIPELINE_PASSWORD. It never uses the
 *   service-role key.
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
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { signInStaff } from '@sia/case-store';
import { runCasePipeline, toLocalId } from './orchestrator';
import { checkSavedPackage, manifestOf, writeAuditDir, writePackageToDir } from './package';
import { FileResearchLog } from './research/log';
import { SourceStore } from './research/store';
import { ClaudeAgentRunner } from './runner/claude';
import { verifyJob } from './verify';
import { runWorker } from './worker';

/** Spend cap per run. A measured three-round run on a two-side case cost $18.20; three sides add a researcher and a red team per round. */
export const DEFAULT_RUN_BUDGET_USD = 40;
/** Offline runs land here by default (git-ignored). */
export const DEFAULT_RUNS_DIR = resolve(import.meta.dirname, '..', '.runs');

const USAGE = `usage:
  pipeline run --brief "<one line>" [--out <dir>] [--budget-usd N] [--max-rounds N] [--verbose]
  pipeline worker [--once] [--budget-usd N] [--poll-seconds N] [--verbose]
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
  log(`run ${runId}: "${brief}" (budget $${budgetUsd}) -> ${dir}`);
  const result = await runCasePipeline(
    { kind: 'new_case', brief },
    {
      runner: new ClaudeAgentRunner(values.verbose ? { onMessage: toolTrace } : {}),
      store,
      runId,
      budgetUsd,
      ...(values['max-rounds'] ? { maxRounds: Number(values['max-rounds']) } : {}),
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
      'budget-usd': { type: 'string' },
      'poll-seconds': { type: 'string' },
      verbose: { type: 'boolean' },
    },
  });
  const db = await signInStaff(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    email: requireEnv('PIPELINE_EMAIL'),
    password: requireEnv('PIPELINE_PASSWORD'),
  });
  const abort = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => abort.abort(new Error(`received ${sig}`)));
  const outcomes = await runWorker(
    { db, runner: new ClaudeAgentRunner(values.verbose ? { onMessage: toolTrace } : {}), budgetUsd: budgetFrom(values['budget-usd']), onProgress: log, signal: abort.signal },
    { once: values.once ?? false, pollMs: Number(values['poll-seconds'] ?? 30) * 1000 },
  );
  for (const o of outcomes) process.stdout.write(`${JSON.stringify(o)}\n`);
  if (values.once && outcomes.length === 0) log('no queued jobs');
  return outcomes.some((o) => o.status === 'failed') ? 1 : 0;
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
      process.stderr.write(`${USAGE}\n`);
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
