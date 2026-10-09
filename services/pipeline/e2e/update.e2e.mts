/**
 * Phase 5 acceptance, end to end (docs/SPEC.md, build phase 5): "A scheduled job
 * that produces revision packages against a live case. Done when a revision
 * appears in the queue as a diff, and the live case is unchanged until it is
 * approved."
 *
 *   pnpm --filter @sia/pipeline e2e:update
 *
 * Deterministic: the agents are scripted (FakeRunner) and every page they open
 * comes from a small fictional web (no network, no model calls). Everything
 * else is real: the local Supabase stack, the pg_cron function, the worker,
 * the source store and research log, the package writer, and a production
 * build of the admin console driven in Chromium.
 *
 *   1. A fixture case (cases/fixtures/fixture-harbor-bridge.json) is submitted
 *      under a fresh slug as the pipeline account and published by the admin.
 *   2. One anonymous reader plays the dive at reading pace (counted responses).
 *   3. The admin sets a re-research cadence; the cadence is forced due in the
 *      database; the pg_cron command (read from cron.job) queues one update job.
 *   4. The worker runs that job once with scripted agents that report one new
 *      development; the drafter adds a step, revises one and drops the open
 *      question the development answers.
 *   5. Database checks: the job succeeded; v2 is in review, updates v1, tagged
 *      update; anon get_published_case still returns v1 byte for byte; the
 *      reader's responses stay on v1.
 *   6. Browser: the admin finds v2 in the queue, its review screen shows the
 *      scripted changes as a diff against live v1, then Approve and publish
 *      moves the live version; v1 is still published and unchanged.
 *
 * Environment (all optional):
 *   E2E_SCREENSHOTS   directory for screenshots (default: <tmp>/sia-pipeline-update-e2e)
 *   E2E_PORT          port for `next start` (default 3212)
 *   E2E_SKIP_BUILD=1  reuse the admin's existing .next build
 *   ADMIN_URL         test an already running console instead of building and starting one
 *   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_DB_URL   (default: the local demo stack)
 *
 * TEST SETUP ONLY: the staff test accounts are created by supabase/tests/helpers
 * (local demo service key), and the cadence is forced due over a direct
 * database connection as postgres. The worker gets only the signed-in pipeline
 * client; the console process is started with the anon key only.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright';
import { diffCases, summarizeDiff, type Case } from '@sia/case-schema';
import {
  adminFinalCrowd,
  adminPublish,
  adminSetUpdateCadence,
  createAnonClient,
  getPipelineJob,
  getStaffCase,
  getStaffVersion,
  listQueue,
  listResearchLog,
  listReviewDecisions,
  submitCasePackage,
  type Db,
} from '@sia/case-store';
import { ANON_KEY, API_URL, loadFixture, pool, sql, userClient, withQueueLock } from '../../../supabase/tests/helpers';
import type { DrafterInput, DrafterOutput } from '../src/agents/drafter';
import type { FactCheckerInput, FactCheckerOutput, FactCheckItem } from '../src/agents/factChecker';
import { factCheckTargets } from '../src/agents/factChecker';
import type { HardQuestionsOutput } from '../src/agents/hardQuestions';
import type { RedTeamOutput } from '../src/agents/redTeam';
import type { AgentContext } from '../src/agents/types';
import type { ResearchTools } from '../src/research/tools';
import { matchQuote } from '../src/research/text';
import { FakeRunner, type FakeScript } from '../src/runner/fake';
import { verifyJob } from '../src/verify';
import { claimJobById, runWorker } from '../src/worker';
import { SIDE_A, SIDE_B, buildDraft, editorScript, fakeFetcher, researcherScript, type FakePage } from '../test/helpers';

const ADMIN_DIR = fileURLToPath(new URL('../../../apps/admin/', import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 3212);
const SHOTS = process.env.E2E_SCREENSHOTS ?? join(tmpdir(), 'sia-pipeline-update-e2e');
const ADMIN_EMAIL = 'admin-test@sia.local'; // created by supabase/tests/helpers userClient('admin')
const ADMIN_PASSWORD = 'local-test-password-1';
const WORKER = 'e2e-pipeline-update-worker';
/** The as-of date the update run stamps on its package (fixed, so the run is deterministic). */
const UPDATE_AS_OF = '2026-10-09';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

let checks = 0;
const ok = (msg: string) => {
  checks++;
  console.log(`  ✓ ${msg}`);
};
const step = (title: string) => console.log(`\n${title}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const words = (s: string | undefined) => (s?.trim() ? s.trim().split(/\s+/).length : 0);

// ---------------------------------------------------------------------------
// The fictional web: the fixture's five sources, plus one new development
// ---------------------------------------------------------------------------

/**
 * The fixture, plus an evidence quote for every fact and step against every
 * source it cites. The hand-written fixture cites sources without quoting
 * them, and the pipeline's citation check fails any cited source with no
 * evidence quote (a pipeline-built or hand-checked case, like the Cornell
 * seed, has one for each). The quote layer's speaker also loses its
 * "(fictional)" note, which the quote-layer check fails. Nothing else changes.
 */
function liveFixture(): Case {
  const doc = structuredClone(loadFixture('fixture-harbor-bridge'));
  delete (doc as Partial<Case>).parent_version;
  const evidence: Record<string, { source_id: string; quote: string }[]> = {
    'fact:f1': [{ source_id: 'src-inspection', quote: 'closed to traffic on 2026-08-01 after an inspection report' }],
    'fact:f2': [{ source_id: 'src-charter', quote: 'The city council controls the bridge maintenance budget.' }],
    s2: [{ source_id: 'src-minutes', quote: 'the council postponed the repair line item in 2024 and 2025' }],
    s3: [
      { source_id: 'src-state', quote: 'reduced local bridge grants in 2024' },
      { source_id: 'src-news', quote: "the city's share of state bridge grants fell by 40 percent" },
    ],
    s4: [{ source_id: 'src-news', quote: 'the crack that forced the closure appeared within weeks' }],
  };
  for (const f of doc.starting_facts) f.evidence = [...(f.evidence ?? []), ...(evidence[`fact:${f.id}`] ?? [])];
  for (const st of doc.steps) st.evidence = [...(st.evidence ?? []), ...(evidence[st.id] ?? [])];
  // The citation check holds a quote layer's speaker to a name and role, with no note in parentheses.
  for (const st of doc.steps) for (const l of st.depth) if (l.kind === 'quote') l.speaker = l.speaker.replace(/\s*\([^)]*\)\s*$/, '');
  return doc;
}
const fixture = liveFixture();
const pad = (s: string) => `${s}\n\nThis page is part of a fictional test fixture used by the pipeline end-to-end test. It describes no real place or person.`;
const urlOf = (id: string) => fixture.sources.find((s) => s.id === id)!.url;

/** Every page says what the fixture cites it for, so the unchanged facts re-check cleanly. */
const PAGES: Record<string, FakePage> = {
  [urlOf('src-inspection')]: {
    title: 'Harbor Bridge Inspection Report 2023 (fixture)',
    text: pad(
      'Summary of findings, deck condition: poor. A 2023 inspection gave the bridge deck a poor rating. ' +
        'The report lists cracking in three deck panels and recommends repair. The report recommended repairs within two years. ' +
        'Addendum, August 2026: The fictional Harbor Bridge closed to traffic on 2026-08-01 after an inspection report.',
    ),
  },
  [urlOf('src-charter')]: {
    title: 'Fixture City Charter',
    text: pad('Article 4, Public works. The city council controls the bridge maintenance budget. The city engineer reports to the council on the condition of city bridges.'),
  },
  [urlOf('src-minutes')]: {
    title: 'Council budget minutes 2024-2025 (fixture)',
    text: pad(
      'Minutes show the council postponed the repair line item in 2024 and 2025. Both votes passed 5 to 4. ' +
        'June 2024: First postponement vote, 5-4. June 2025: Second postponement vote, 5-4.',
    ),
  },
  [urlOf('src-state')]: {
    title: 'State bridge grant allocations (fixture)',
    text: pad('The state transportation agency reduced local bridge grants in 2024. The city\'s share fell by 40 percent.'),
  },
  [urlOf('src-news')]: {
    title: 'Contractor: bridge crack appeared suddenly (fixture)',
    text: pad(
      'The repair contractor told a local paper the crack that forced the closure appeared within weeks. The city engineer has not confirmed this. ' +
        'Council members pointed to the state cut: the city\'s share of state bridge grants fell by 40 percent in 2024. ' +
        'A council member said: “We had to choose between the bridge and the school roof.” ' +
        'An engineer not involved in the project said: If the failure was sudden, earlier repairs might not have prevented it.',
    ),
  },
};

/** The new development the update must find: published after the live version's as-of date (2026-09-30). */
const DEVELOPMENT = {
  url: 'https://example.org/fixtures/harbor/engineering-review-2026-10',
  title: 'City engineer: bridge crack grew over two years (fixture)',
  quote: 'found that the crack that closed the bridge had been growing since at least 2024',
  text: 'A city engineering review released on October 6, 2026 found that the crack that closed the bridge had been growing since at least 2024.',
  date: '2026-10-06',
};
PAGES[DEVELOPMENT.url] = {
  title: DEVELOPMENT.title,
  text: pad(
    'On October 6, 2026 the city engineer released a review of the Harbor Bridge closure. ' +
      'The review found that the crack that closed the bridge had been growing since at least 2024. ' +
      'It said the 2023 repairs would likely have slowed the crack.',
  ),
};
/** The source id the scripted drafter gives the development's page (as test/helpers buildDraft does). */
const DEV_SOURCE_ID = 'src-engineering-review-2026-10';
const ANSWERED_QUESTION = 'Would the 2023 repairs have prevented the 2025 crack?';
const S4_ADDED_SENTENCE = 'A city engineering review released on October 6, 2026 found the crack had been growing since at least 2024.';

// ---------------------------------------------------------------------------
// Scripted agents
// ---------------------------------------------------------------------------

/**
 * The drafter, following the update rules: unchanged facts keep their ids and
 * text; the development becomes a new step (s5, via buildDraft); s4, which the
 * development contradicts, is revised and cites it; and the open question it
 * answers is dropped. One resolution per development and per answered question.
 */
function updateDrafter(input: DrafterInput, ctx: AgentContext): DrafterOutput {
  assert.ok(input.update, 'the drafter gets the live-update context');
  if (input.previous) {
    // A redraft inside the critic loop: the scripted critics raise nothing to change, so keep the draft.
    const refs = [...(input.critique?.hard_questions ?? []).map((q) => q.id), ...(input.critique?.bias_reports ?? []).flatMap((r) => r.flags.map((f) => f.id))];
    return {
      case: structuredClone(input.previous) as DrafterOutput['case'],
      resolutions: refs.map((ref) => ({ ref, action: 'not_changed' as const, resolution: 'The draft already covers this.' })),
      research_gaps: [],
    };
  }
  const out = buildDraft(input, ctx);
  const dev = input.claims.find((c) => c.url === DEVELOPMENT.url);
  assert.ok(dev, 'the development reached the drafter');
  const s4 = out.case.steps.find((s) => s.id === 's4');
  assert.ok(s4, 'the draft starts from the live version (keeps s4)');
  s4.body =
    'The repair contractor told a local paper the crack that forced the closure appeared within weeks. ' +
    `${S4_ADDED_SENTENCE} This is a fictional test fixture.`;
  s4.source_ids = ['src-news', DEV_SOURCE_ID];
  s4.evidence = [...(s4.evidence ?? []), { source_id: DEV_SOURCE_ID, quote: DEVELOPMENT.quote }];
  out.case.open_questions = out.case.open_questions.filter((q) => q !== ANSWERED_QUESTION);
  out.resolutions.push(
    { ref: dev.id, action: 'changed', resolution: 'Added as step s5; step s4 now notes the review, which disputes the contractor account.' },
    { ref: 'open_question', action: 'changed', resolution: `Removed "${ANSWERED_QUESTION}": the engineering review says the crack grew since 2024; s4 and s5 state it.` },
  );
  return out;
}

/** Every passage an item could be checked by: its evidence for that source, its sentences, and its quote layers. */
function candidatePassages(text: string, evidence: { source_id: string; quote: string }[] | undefined, sourceId: string): string[] {
  const pieces = text.split(/\s*\|\s*|(?<=[.!?]["”]?)\s+/).map((p) => p.trim()).filter(Boolean);
  const stripped = pieces.flatMap((p) => {
    const noLabel = p.replace(/^[^:"“]{1,60}:\s*/, '');
    return [p, noLabel, noLabel.replace(/^["“](.*)["”]\.?$/, '$1')];
  });
  return [...(evidence ?? []).filter((e) => e.source_id === sourceId).map((e) => e.quote), ...stripped];
}

/**
 * A fact-checker that works like the real one is told to: for each checklist
 * item, it reads every cited source's snapshot and quotes the passage that
 * supports it; an item none of whose passages is in the source fails.
 */
function factChecker(input: FactCheckerInput, _ctx: AgentContext, tools: ResearchTools): FactCheckerOutput {
  const refs = new Map(input.sources.map((s) => [s.source_id, s]));
  const rows: FactCheckItem[] = [];
  for (const t of factCheckTargets(input.draft)) {
    if (input.only && !input.only.includes(t.target)) continue;
    for (const sid of new Set(t.source_ids)) {
      const ref = refs.get(sid);
      if (!ref?.snapshot_id) {
        rows.push({ target: t.target, claim: t.text, source_id: sid, verdict: 'source_unavailable', note: 'No snapshot of this source.' });
        continue;
      }
      const page = tools.readSource(ref.snapshot_id, 0, 20_000).text;
      const quote = candidatePassages(t.text, t.evidence, sid).find((q) => matchQuote(q, page).ok);
      rows.push({
        target: t.target,
        claim: t.text,
        source_id: sid,
        verdict: quote ? 'supported' : 'unsupported',
        ...(quote ? { quote } : {}),
        note: quote ? 'The source says this.' : 'No passage in the source supports this.',
        ...(t.confidence ? { confidence_before: t.confidence, confidence_after: t.confidence } : {}),
      });
    }
  }
  return { rows };
}

const hardQuestions: HardQuestionsOutput = {
  questions: [
    {
      id: 'hq-1',
      side_id: SIDE_B.id,
      question: 'Does the new engineering review say when the crack started?',
      blocking: true,
      status: 'answered',
      resolution: 'Steps s4 and s5 say the review found it growing since at least 2024.',
      step_ids: ['s4', 's5'],
    },
  ],
  gaps: [],
  most_moving_fact: 'The engineering review dating the crack to 2024.',
};
const redTeam: RedTeamOutput = { summary: 'The update reports the review and keeps the contractor account; fair to this side.', flags: [] };

function updateScripts(): Record<string, FakeScript> {
  return {
    // Side A finds nothing; side B finds only an old fact (screened out as not new).
    [`researcher#${SIDE_A.id}`]: researcherScript([]),
    [`researcher#${SIDE_B.id}`]: researcherScript([
      {
        url: urlOf('src-state'),
        quote: 'The state transportation agency reduced local bridge grants in 2024.',
        text: 'The state reduced local bridge grants in 2024.',
        type: 'official',
        favors: SIDE_B.id,
        impact: 'high',
        date: '2024-01-15',
      },
    ]),
    // The records researcher finds the new development.
    records_researcher: researcherScript([
      { url: DEVELOPMENT.url, quote: DEVELOPMENT.quote, text: DEVELOPMENT.text, type: 'official', favors: SIDE_A.id, impact: 'high', date: DEVELOPMENT.date },
    ]),
    drafter: (input: DrafterInput, ctx: AgentContext) => updateDrafter(input, ctx),
    hard_questions: hardQuestions,
    red_team: redTeam,
    fact_checker: factChecker,
    editor: editorScript(),
  };
}

// ---------------------------------------------------------------------------
// Public API helpers (anon key, exactly what the dive app calls)
// ---------------------------------------------------------------------------

/**
 * The raw body of anon get_published_case, narrowed to version, published_at
 * and doc (is_live legitimately flips when a newer version goes live). Compared
 * as bytes: the public sees exactly the same document.
 */
async function rawPublished(slug: string, version: number | null = null): Promise<string> {
  const res = await fetch(`${API_URL}/rest/v1/rpc/get_published_case?select=version,published_at,doc`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_slug: slug, p_version: version }),
  });
  assert.equal(res.status, 200, `get_published_case answered ${res.status}`);
  return res.text();
}

const parsedPublished = (raw: string) => (JSON.parse(raw) as { version: number; published_at: string; doc: Case }[])[0];

/**
 * Plays one dive as an anonymous reader through the public RPCs, at reading
 * pace so every answer counts. A per-run TEST-NET-2 address keeps repeated
 * runs under the per-network session limit without touching app.settings.
 */
async function playDive(slug: string) {
  const anon = createAnonClient(API_URL, ANON_KEY, { 'cf-connecting-ip': `198.51.100.${randomInt(1, 255)}` });
  const loaded = await anon.rpc('get_published_case', { p_slug: slug, p_version: null });
  if (loaded.error) throw loaded.error;
  const row = (loaded.data as { case_id: string; version: number; doc: Case }[])[0]!;
  const start = await anon.rpc('start_session', { p_case_id: row.case_id, p_version: row.version, p_device_id: `e2e-device-${randomUUID()}` });
  if (start.error) throw start.error;
  const sessionId = (start.data as { session_id: string }).session_id;
  const doc = row.doc;
  const slots: [string, number][] = [
    ['before', doc.starting_facts.reduce((n, f) => n + words(f.text), 0) + words(doc.question.prompt)],
    ...doc.steps.map((s) => [s.id, words(s.headline) + words(s.body)] as [string, number]),
    ['after', 0],
  ];
  const values = [70, 64, 58, 61, 55, 52];
  for (let i = 0; i < slots.length; i++) {
    const [slot, n] = slots[i]!;
    if (slot !== 'after') await sleep(Math.max(1500, (n / 15) * 1000) + 400);
    const r = await anon.rpc('submit_response', { p_session_id: sessionId, p_step_id: slot, p_value: values[i] ?? 50 });
    if (r.error) throw r.error;
  }
  return { sessionId, version: row.version, slots: slots.map(([s]) => s) };
}

// ---------------------------------------------------------------------------
// Admin console (production build, anon key only)
// ---------------------------------------------------------------------------

function consoleEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!/SERVICE_ROLE|SECRET|DB_URL/i.test(k)) env[k] = v;
  env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
  env.NEXT_TELEMETRY_DISABLED = '1';
  return env as NodeJS.ProcessEnv;
}

async function startConsole(): Promise<{ url: string; stop: () => void }> {
  if (process.env.ADMIN_URL) return { url: process.env.ADMIN_URL.replace(/\/$/, ''), stop: () => undefined };
  const nextBin = createRequire(join(ADMIN_DIR, 'package.json')).resolve('next/dist/bin/next');
  const url = `http://127.0.0.1:${PORT}`;
  if (await fetch(`${url}/login`).then(() => true, () => false)) throw new Error(`port ${PORT} is already in use; set E2E_PORT or ADMIN_URL`);
  if (process.env.E2E_SKIP_BUILD !== '1') {
    console.log('  next build (production) …');
    const build = spawnSync(process.execPath, [nextBin, 'build'], { cwd: ADMIN_DIR, env: consoleEnv(), stdio: ['ignore', 'ignore', 'inherit'] });
    if (build.status !== 0) throw new Error(`next build failed (exit ${build.status})`);
  }
  const logPath = join(SHOTS, 'next-start.log');
  const child: ChildProcess = spawn(process.execPath, [nextBin, 'start', '--port', String(PORT), '--hostname', '127.0.0.1'], {
    cwd: ADMIN_DIR,
    env: consoleEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logFile = createWriteStream(logPath);
  child.stdout?.pipe(logFile);
  child.stderr?.pipe(logFile);
  const stop = () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  };
  process.on('exit', stop);
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(300)) {
    if (child.exitCode !== null) throw new Error(`next start exited (${child.exitCode}); see ${logPath}`);
    if (await fetch(`${url}/login`).then((r) => r.ok, () => false)) return { url, stop };
  }
  stop();
  throw new Error(`next start did not come up within 60s; see ${logPath}`);
}

async function shot(target: Page | Locator, name: string, fullPage = true) {
  const path = join(SHOTS, `${name}.png`);
  if ('goto' in target) await target.screenshot({ path, fullPage });
  else await target.screenshot({ path });
  return path;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const t0 = Date.now();
  const slug = `e2e-update-${randomUUID().slice(0, 8)}`;
  let admin: Db | undefined;
  let caseId: string | undefined;
  let stopConsole = () => {};
  try {
    step(`1. A live case: the fixture under the fresh slug "${slug}"`);
    const [a, pipeline] = await Promise.all([userClient('admin'), userClient('pipeline')]);
    admin = a;
    const submitted = await submitCasePackage(pipeline, { slug, doc: fixture });
    caseId = submitted.case_id;
    assert.equal(submitted.version, 1);
    assert.equal((await getStaffVersion(admin, caseId, 1))?.status, 'in_review');
    await adminPublish(admin, caseId, 1, 'Phase 5 e2e: the live version');
    const v1Staff = (await getStaffVersion(admin, caseId, 1))!;
    assert.equal(v1Staff.status, 'published');
    assert.equal((await getStaffCase(admin, caseId))?.live_version, 1);
    const publicV1 = await rawPublished(slug);
    const liveDoc = parsedPublished(publicV1)!.doc;
    assert.equal(parsedPublished(publicV1)?.version, 1);
    assert.equal(liveDoc.as_of, fixture.as_of);
    assert.ok(liveDoc.steps.every((s) => !('favors' in s)), 'favors never reaches the public');
    ok(`submitted as the pipeline (v1 in review), published by the admin; anon get_published_case serves v1 (${publicV1.length} bytes, sha256 ${sha(publicV1).slice(0, 12)}…)`);

    step('2. One anonymous reader plays the dive on v1');
    const played = await playDive(slug);
    assert.equal(played.version, 1);
    const responsesBefore = await sql<{ step_id: string; case_version: number; excluded: boolean }>(
      `select step_id, case_version, excluded from public.responses where session_id = $1 order by step_index`,
      [played.sessionId],
    );
    assert.deepEqual(responsesBefore.map((r) => r.step_id), played.slots);
    assert.ok(responsesBefore.every((r) => r.case_version === 1 && r.excluded === false));
    ok(`${responsesBefore.length} responses (${played.slots.join(', ')}), all case_version 1, none under the reading-time floor`);

    step('3. Cadence, forced due, and the pg_cron command queues one update job');
    await adminSetUpdateCadence(admin, caseId, '1 day');
    const [cadence] = await sql<{ update_cadence: string; due_later: boolean }>(
      `select update_cadence::text, next_update_at > now() as due_later from public.cases where id = $1`,
      [caseId],
    );
    assert.equal(cadence?.update_cadence, '1 day');
    assert.equal(cadence?.due_later, true, 'a fresh cadence is not due yet');
    const [cron] = await sql<{ command: string; schedule: string }>(`select command, schedule from cron.job where jobname = 'enqueue-due-updates'`);
    assert.ok(cron, 'pg_cron has the enqueue-due-updates job');
    const jobId = await withQueueLock(async () => {
      await sql(cron.command);
      const early = await sql(`select id from public.pipeline_jobs where case_id = $1 and kind = 'update'`, [caseId]);
      assert.equal(early.length, 0, 'nothing is queued before the cadence is due');
      // Test setup only: as postgres, move the next run into the past (what waiting a day would do).
      await sql(`update public.cases set next_update_at = now() - interval '1 minute' where id = $1`, [caseId]);
      await sql(cron.command);
      await sql(cron.command); // firing again queues no second job
      const jobs = await sql<{ id: string; created_by: string; base_version: number; status: string }>(
        `select id, created_by, base_version, status from public.pipeline_jobs where case_id = $1 and kind = 'update'`,
        [caseId],
      );
      assert.equal(jobs.length, 1, 'exactly one update job');
      assert.equal(jobs[0]!.status, 'queued');
      assert.equal(jobs[0]!.created_by, 'system:schedule');
      assert.equal(jobs[0]!.base_version, 1);
      const [next] = await sql<{ moved_on: boolean }>(`select next_update_at > now() + interval '23 hours' as moved_on from public.cases where id = $1`, [caseId]);
      assert.equal(next?.moved_on, true, 'next_update_at moved on by the cadence');
      return jobs[0]!.id;
    });
    ok(`cadence 1 day; "${cron.command}" (pg_cron, ${cron.schedule}) queued nothing until due, then exactly one update job ${jobId.slice(0, 8)} against v1 by system:schedule`);
    assert.equal(await rawPublished(slug), publicV1);

    step('4. The worker runs the update once (scripted agents, one new development)');
    const runner = new FakeRunner(updateScripts());
    const fetcher = fakeFetcher(PAGES);
    const [outcome] = await runWorker(
      { db: pipeline, runner, claim: claimJobById(jobId), workerId: WORKER, fetcher, asOf: UPDATE_AS_OF },
      { once: true },
    );
    assert.ok(outcome, 'the worker claimed the job');
    assert.equal(outcome.status, 'succeeded', `job outcome: ${outcome.status} ${outcome.error ?? ''}`);
    assert.equal(outcome.result?.version, 2);
    for (const u of fixture.sources.map((s) => s.url)) assert.ok(fetcher.calls.includes(u), `the update re-opened ${u}`);
    assert.ok(fetcher.calls.includes(DEVELOPMENT.url));
    const job = (await getPipelineJob(admin, jobId))!;
    assert.equal(job.status, 'succeeded');
    // A clean run: one critic round with nothing blocking, the editor's version kept, and no open issue for the admin.
    assert.equal(outcome.result?.rounds, 1, 'one critic round');
    assert.equal(outcome.result?.clean, true, 'the critics found nothing blocking');
    assert.equal(outcome.result?.editor_fallback, false);
    assert.equal(outcome.result?.open_issues, 0, 'no open issues');
    assert.deepEqual(
      runner.calls.map((c) => `${c.agent}${c.scope ? `#${c.scope}` : ''}@${c.round}`).sort(),
      [
        `researcher#${SIDE_A.id}@0`,
        `researcher#${SIDE_B.id}@0`,
        'records_researcher#records@0',
        'drafter@0',
        'hard_questions@1',
        `red_team#${SIDE_A.id}@1`,
        `red_team#${SIDE_B.id}@1`,
        'fact_checker@1',
        'editor@1',
      ].sort(),
      'no scoper (an update keeps the live question and sides), one draft, one critic round, the editor',
    );
    const log = await listResearchLog(admin, jobId);
    assert.ok(log.some((r) => r.kind === 'note' && r.excerpt?.startsWith('1 new development(s) since 2026-09-30')), 'the research log records the screening');
    assert.ok(log.some((r) => r.kind === 'open' && r.url === DEVELOPMENT.url));
    assert.ok(log.some((r) => r.kind === 'claim'));
    const audit = await verifyJob(pipeline, jobId);
    assert.deepEqual(audit.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`), [], 'pipeline verify accepts the package');
    ok(
      `job ${jobId.slice(0, 8)} succeeded cleanly: 1 critic round, 0 open issues, ${runner.calls.length} scripted agent calls, all 5 live sources re-opened plus the new page; ` +
        `pipeline verify: ${audit.checks.length} checks ok`,
    );

    step('5. Database: v2 in review against the live version; the live case unchanged');
    const v2 = (await getStaffVersion(admin, caseId, 2))!;
    assert.equal(v2.status, 'in_review');
    assert.equal(v2.parent_version, 1);
    assert.equal(v2.based_on_version, 1);
    assert.deepEqual(v2.tags, ['update']);
    assert.equal(v2.origin, 'pipeline');
    assert.equal(v2.pipeline_job_id, jobId);
    assert.equal(v2.doc.as_of, UPDATE_AS_OF);
    const queued = (await listQueue(admin)).filter((q) => q.case_id === caseId);
    assert.deepEqual(queued.map((q) => [q.version, q.status, q.live_version]), [[2, 'in_review', 1]]);
    ok('v2: in_review, parent_version 1 (= live), based_on_version 1, tags [update], origin pipeline, in staff_queue');

    // The console diffs the staff copy of the live version (the public copy has no favors or evidence).
    const diff = diffCases(v1Staff.doc, v2.doc);
    const changedSteps = diff.steps.filter((d) => d.status !== 'unchanged' || d.moved).map((d) => `${d.id}:${d.status}`);
    assert.deepEqual(changedSteps.sort(), ['s4:changed', 's5:added']);
    assert.deepEqual(diff.startingFacts.filter((d) => d.status !== 'unchanged').map((d) => d.id), []);
    assert.deepEqual(diff.sources.filter((d) => d.status !== 'unchanged').map((d) => `${d.id}:${d.status}`), [`${DEV_SOURCE_ID}:added`]);
    assert.deepEqual(diff.fields.map((f) => f.path).sort(), ['as_of', 'open_questions']);
    const s5 = v2.doc.steps.find((s) => s.id === 's5')!;
    assert.equal(s5.headline, DEVELOPMENT.text.slice(0, 150));
    assert.ok(v2.doc.steps.find((s) => s.id === 's4')!.body.includes(S4_ADDED_SENTENCE));
    const expectedSummary = summarizeDiff(diff, v2.doc);
    ok(`the revision against live v1: ${expectedSummary}`);

    const summary = v2.doc.review?.agent_reports.find((r) => r.agent === 'editor' && r.scope === 'update')?.summary ?? '';
    assert.match(summary, /^Update of live version 1 \(as of 2026-09-30\): re-researched for developments after 2026-09-30\./);
    assert.ok(summary.includes(DEVELOPMENT.text), 'the update summary names the development');
    assert.match(summary, /In the draft: s4, s5\./);
    assert.match(summary, /Claims the researchers found that are not new developments: 1 dated on or before 2026-09-30\./);
    assert.ok(summary.includes(`Open questions no longer listed: "${ANSWERED_QUESTION}"`));
    assert.equal(outcome.result?.update_summary, summary, 'the job result carries the same summary');
    assert.equal(outcome.result?.developments, 1);
    ok('the review record carries the update summary: what changed and why (the development, its date and source, where it went)');

    assert.equal(await rawPublished(slug), publicV1, 'anon get_published_case is byte-identical');
    assert.equal(await rawPublished(slug, 2), '[]', 'v2 is not readable by the public');
    const v1After = (await getStaffVersion(admin, caseId, 1))!;
    assert.equal(v1After.status, 'published');
    assert.equal(v1After.published_at, v1Staff.published_at);
    assert.equal(JSON.stringify(v1After.doc), JSON.stringify(v1Staff.doc));
    assert.equal((await getStaffCase(admin, caseId))?.live_version, 1);
    const responsesAfterJob = await sql<{ case_version: number }>(`select case_version from public.responses where session_id = $1`, [played.sessionId]);
    assert.ok(responsesAfterJob.length === played.slots.length && responsesAfterJob.every((r) => r.case_version === 1));
    ok(`anon get_published_case still returns v1, byte-identical (sha256 ${sha(publicV1).slice(0, 12)}…); v2 is invisible to anon; the reader's responses stay on v1`);

    step('6. Browser: the revision is in the queue as a diff against the live version');
    const started = await startConsole();
    const url = started.url;
    stopConsole = started.stop;
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('dialog', (d) => void d.accept());
      await page.goto(`${url}/login`);
      await page.getByLabel('Email').fill(ADMIN_EMAIL);
      await page.getByLabel('Password').fill(ADMIN_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(`${url}/`);
      const row = page.getByTestId('queue-table').locator('tbody tr', { hasText: slug });
      await row.first().waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(await row.count(), 1, 'one queue row for the case');
      const rowText = (await row.innerText()).replace(/\s+/g, ' ').trim();
      for (const want of ['v2', 'updates v1', 'update', 'In review']) assert.ok(rowText.includes(want), `queue row shows "${want}"; got: ${rowText}`);
      await row.scrollIntoViewIfNeeded();
      await shot(page, '01-queue-revision', false); // the viewport: the local queue can hold hundreds of test cases
      ok(`the queue lists the revision: ${rowText}`);

      await row.getByTestId('queue-link').click();
      await page.waitForURL(`${url}/review/${caseId}/2`);
      await page.getByTestId('preview').getByTestId('case-card').first().waitFor({ state: 'visible', timeout: 30_000 });
      const select = page.getByTestId('compare-select');
      if (await select.count()) {
        assert.equal(await select.locator('option:checked').textContent(), 'Live version v1', 'the diff compares against the live version by default');
      }
      const diffSection = page.locator('#diff');
      const heads = await diffSection.locator('.diff-col-head').allTextContents();
      assert.deepEqual(heads, ['Live version v1', 'This version (v2)'], 'the diff is the live version against the revision');
      assert.equal(await page.getByTestId('diff-summary').innerText(), expectedSummary);
      const items = (await diffSection.locator('[data-testid^="diff-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))).filter((id) =>
        /^diff-(steps|sources|startingFacts|sides)-/.test(id),
      );
      assert.deepEqual(items.sort(), ['diff-sources-' + DEV_SOURCE_ID, 'diff-steps-s4', 'diff-steps-s5'].sort(), `diff items: ${items.join(', ')}`);

      const added = page.getByTestId('diff-steps-s5');
      assert.match(await added.innerText(), /^added/m);
      assert.ok((await added.locator('ins').allInnerTexts()).some((t) => t === s5.headline), 'the added step shows its headline');
      const changed = page.getByTestId('diff-steps-s4');
      const inserted = (await changed.locator('ins.d-ins').allInnerTexts()).join(' ');
      assert.ok(inserted.includes('engineering review released on October 6, 2026'), `s4 shows the inserted words; got: ${inserted}`);
      const deleted = (await changed.locator('del.d-del').allInnerTexts()).join(' ');
      assert.ok(deleted.includes('not confirmed'), `s4 shows the deleted words; got: ${deleted}`);
      assert.ok((await page.getByTestId(`diff-sources-${DEV_SOURCE_ID}`).innerText()).includes(DEVELOPMENT.url));
      const fieldsText = await diffSection.locator('.diff-item').first().innerText();
      assert.ok(fieldsText.includes(ANSWERED_QUESTION), 'the removed open question is shown');
      assert.ok((await diffSection.locator('.diff-item').first().locator('del').allInnerTexts()).some((t) => t.includes(ANSWERED_QUESTION)));
      // The as-of row is a word-level diff of the two dates: the old one struck, the new one inserted.
      const fields = diffSection.locator('.diff-item').first();
      const fieldText = (await fields.textContent()) ?? '';
      assert.ok(fieldText.includes('2026-09-30') && fieldText.includes(UPDATE_AS_OF), `the as-of change is shown; got: ${fieldText.slice(0, 300)}`);

      const updateSummary = await page.getByTestId('update-summary').innerText();
      assert.ok(updateSummary.includes(`What changed against the live version: ${expectedSummary}`));
      assert.ok(updateSummary.includes(DEVELOPMENT.text));
      await page.getByTestId('update-summary').scrollIntoViewIfNeeded();
      await shot(page.getByTestId('update-summary'), '02-update-summary');
      await diffSection.scrollIntoViewIfNeeded();
      await shot(diffSection, '03-diff-against-live');
      await shot(page, '04-review-screen-full');
      ok(`review screen: "${expectedSummary}"; steps s4 (changed, inserted words) and s5 (added), source ${DEV_SOURCE_ID} (added), as-of and the answered open question`);

      assert.equal(await rawPublished(slug), publicV1);
      ok('after the admin opened the revision, anon still gets v1 byte for byte');

      step('7. Browser: Approve and publish moves the live version; v1 stays as it was');
      await page.getByTestId('action-publish').click();
      await page.waitForFunction(() => /Published v2/.test(document.querySelector('[data-testid="action-result"]')?.textContent ?? ''), null, { timeout: 30_000 });
      await page.getByTestId('action-result').scrollIntoViewIfNeeded();
      await shot(page, '05-approved-and-published');
      assert.equal((await getStaffCase(admin, caseId))?.live_version, 2);
      const publicNow = parsedPublished(await rawPublished(slug))!;
      assert.equal(publicNow.version, 2);
      assert.ok(publicNow.doc.steps.some((s) => s.id === 's5'));
      assert.ok(!publicNow.doc.open_questions.includes(ANSWERED_QUESTION));
      assert.equal(await rawPublished(slug, 1), publicV1, 'v1 is still published to the public, byte for byte');
      const v1Final = (await getStaffVersion(admin, caseId, 1))!;
      assert.equal(v1Final.status, 'published');
      assert.equal(v1Final.published_at, v1Staff.published_at);
      assert.equal(JSON.stringify(v1Final.doc), JSON.stringify(v1Staff.doc));
      const decisions = await listReviewDecisions(admin, caseId, 2);
      assert.ok(decisions.some((d) => d.action === 'approve_publish'), `a publish decision is recorded for v2: ${decisions.map((d) => d.action).join(', ')}`);
      ok('Approve and publish: v2 is live for the public; v1 is still published, readable and byte-identical; the decision is recorded');

      const responsesFinal = await sql<{ case_version: number; excluded: boolean }>(`select case_version, excluded from public.responses where session_id = $1`, [played.sessionId]);
      assert.equal(responsesFinal.length, played.slots.length);
      assert.ok(responsesFinal.every((r) => r.case_version === 1 && !r.excluded));
      const [crowd1, crowd2, note] = await Promise.all([adminFinalCrowd(admin, caseId, 1, false), adminFinalCrowd(admin, caseId, 2, false), adminFinalCrowd(admin, caseId, 2)]);
      assert.equal(crowd1.real_completions, 1);
      assert.equal(crowd2.real_completions, 0);
      assert.equal(note.version_note?.earlier_versions.find((e) => e.version === 1)?.completions, 1);
      ok("the reader's responses still have case_version 1; v1's crowd counts them, v2's crowd starts empty, and v2's version note counts the reader on v1");

      await page.goto(`${url}/cases/${caseId}`);
      const updates = await page.locator('#updates-h').locator('xpath=ancestor::section').innerText();
      assert.match(updates, /Currently: Daily/);
      assert.match(updates, /update of v1/);
      await shot(page, '06-case-live-updates');
      ok('the case page shows the daily cadence and the finished update job');
      assert.deepEqual(problems, [], 'no page errors');
    } catch (e) {
      const pages = browser.contexts().flatMap((c) => c.pages());
      if (pages[0]) await shot(pages[0], 'zz-failure').catch(() => undefined);
      throw e;
    } finally {
      await browser.close();
    }
    console.log(`\n${checks} checks passed in ${Math.round((Date.now() - t0) / 1000)}s; case ${slug}; screenshots in ${SHOTS}`);
  } finally {
    stopConsole();
    // Leave no schedule behind: the test case must not keep queuing daily updates.
    if (admin && caseId) await adminSetUpdateCadence(admin, caseId, null).catch(() => undefined);
    await pool.end();
  }
}

main().then(
  () => process.exit(0),
  (e: Error) => {
    console.error(`\nFAILED: ${e.stack ?? e.message}`);
    process.exit(1);
  },
);
