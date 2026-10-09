/**
 * Phase 3 acceptance, end to end: the review console (a production build,
 * `next build` + `next start`) against the local Supabase stack.
 *
 *   pnpm --filter @sia/admin e2e
 *
 * Proves: "an edit-then-approve creates a new immutable version and old
 * responses stay attached to the old version", plus the queue, preview, inline
 * edit, balance panel, audit tabs, the five actions and the version diff.
 *
 * Environment (all optional):
 *   E2E_SCREENSHOTS   directory for screenshots (default: <tmp>/sia-admin-e2e)
 *   E2E_PORT          port for `next start` (default 3210)
 *   E2E_SKIP_BUILD=1  reuse the existing .next build
 *   ADMIN_URL         test an already running console instead of building and starting one
 *   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY   (default: the local demo stack)
 *
 * TEST SETUP ONLY: the service-role key (the public local demo key, as in
 * supabase/tests/helpers.ts) is used here to create the two staff accounts.
 * The console process never sees it: it is started with the anon key only,
 * and every service/secret variable is stripped from its environment.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { assertValidCase, diffCases, summarizeDiff, type Case, type ReviewRecord, type Source, type Step } from '@sia/case-schema';
import {
  adminCancelJob,
  adminCreateCase,
  adminFinalCrowd,
  adminReject,
  adminRequestUpdate,
  adminSetSeedProfile,
  createAnonClient,
  getPipelineJob,
  getPublishedCase,
  getStaffCase,
  getStaffVersion,
  listReviewDecisions,
  signInStaff,
  submitCasePackage,
  type Db,
  type StaffVersionRow,
} from '@sia/case-store';
import { SupabaseDiveApi } from '@sia/dive-engine/supabase';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ADMIN_DIR = fileURLToPath(new URL('../', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const API_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const PORT = Number(process.env.E2E_PORT ?? 3210);
const SHOTS = process.env.E2E_SCREENSHOTS ?? join(tmpdir(), 'sia-admin-e2e');
const OWNER_EMAIL = 'owner-e2e@sia.local';
const PIPELINE_EMAIL = 'pipeline-e2e@sia.local';
const PASSWORD = 'local-e2e-password-1';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

let checks = 0;
const ok = (msg: string) => {
  checks++;
  console.log(`  ✓ ${msg}`);
};
const step = (title: string) => console.log(`\n${title}`);

// ---------------------------------------------------------------------------
// The console under test: a production build, started with the anon key only
// ---------------------------------------------------------------------------

function consoleEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/SERVICE_ROLE|SECRET/i.test(k)) env[k] = v;
  }
  env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
  env.NEXT_TELEMETRY_DISABLED = '1';
  return env as NodeJS.ProcessEnv;
}

async function startConsole(): Promise<{ url: string; stop: () => void }> {
  if (process.env.ADMIN_URL) return { url: process.env.ADMIN_URL.replace(/\/$/, ''), stop: () => undefined };
  const nextBin = createRequire(join(ADMIN_DIR, 'package.json')).resolve('next/dist/bin/next');
  const url = `http://127.0.0.1:${PORT}`;
  const busy = await fetch(`${url}/login`).then(() => true, () => false);
  if (busy) throw new Error(`port ${PORT} is already in use; set E2E_PORT or ADMIN_URL`);

  if (process.env.E2E_SKIP_BUILD !== '1') {
    console.log('next build (production) …');
    const t0 = Date.now();
    const build = spawnSync(process.execPath, [nextBin, 'build'], { cwd: ADMIN_DIR, env: consoleEnv(), stdio: 'inherit' });
    if (build.status !== 0) throw new Error(`next build failed (exit ${build.status})`);
    console.log(`next build finished in ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  const logPath = join(SHOTS, 'next-start.log');
  const logFile = createWriteStream(logPath);
  const child: ChildProcess = spawn(process.execPath, [nextBin, 'start', '--port', String(PORT), '--hostname', '127.0.0.1'], {
    cwd: ADMIN_DIR,
    env: consoleEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(logFile);
  child.stderr?.pipe(logFile);
  const stop = () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  };
  process.on('exit', stop);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited (${child.exitCode}); see ${logPath}`);
    const up = await fetch(`${url}/login`).then((r) => r.ok, () => false);
    if (up) {
      console.log(`next start is serving ${url} (log: ${logPath})`);
      return { url, stop };
    }
    await sleep(300);
  }
  stop();
  throw new Error(`next start did not come up within 60s; see ${logPath}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Test setup (outside the UI)
// ---------------------------------------------------------------------------

/** Creates the account, or resets its role and password if it exists. Service key: test setup only. */
async function ensureStaff(svc: SupabaseClient, email: string, role: 'admin' | 'pipeline'): Promise<void> {
  const created = await svc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, app_metadata: { app_role: role } });
  if (!created.error) return;
  if (!/already/i.test(created.error.message)) throw created.error;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const user = data.users.find((u) => u.email === email);
    if (user) {
      const upd = await svc.auth.admin.updateUserById(user.id, { password: PASSWORD, app_metadata: { app_role: role } });
      if (upd.error) throw upd.error;
      return;
    }
    if (data.users.length < 200) break;
  }
  throw new Error(`could not create or find ${email}`);
}

function harborBridge(): Case {
  const doc = assertValidCase(JSON.parse(readFileSync(join(ROOT, 'cases/fixtures/fixture-harbor-bridge.json'), 'utf8')));
  delete (doc as Partial<Case>).parent_version;
  return doc;
}

/** The review record a pipeline run attaches to its package. */
function reviewRecord(jobId: string, kind: 'new' | 'revision'): ReviewRecord {
  if (kind === 'revision') {
    return {
      pipeline_run_id: jobId,
      rounds: 1,
      agent_reports: [{ agent: 'editor', round: 0, at: '2026-10-08T09:00:00Z', summary: 'Revision against the live version; schema valid.' }],
      hard_questions: [],
      bias_reports: [],
      fact_check: [{ target: 's5', claim: 'The council approved a repair contract in October 2026.', source_id: 'src-news-2', verdict: 'supported', round: 0 }],
      open_issues: [],
      decisions: [],
    };
  }
  return {
    pipeline_run_id: jobId,
    rounds: 2,
    agent_reports: [
      { agent: 'scoper', round: 0, at: '2026-10-07T10:00:00Z', summary: 'One question, two sides.' },
      { agent: 'editor', round: 1, at: '2026-10-07T12:00:00Z', summary: 'Applied red-team fixes; schema valid.' },
    ],
    hard_questions: [
      { id: 'hq1', side_id: 'council-responsible', question: 'Did the council see the 2023 inspection?', blocking: true, status: 'open', step_ids: ['s1', 's2'], round: 1 },
      { id: 'hq2', question: 'Who paid for the 2021 repairs?', blocking: false, status: 'answered', resolution: 'Covered by s4.', step_ids: ['s4'], round: 0 },
    ],
    bias_reports: [
      {
        side_id: 'council-not-responsible',
        round: 1,
        summary: 'Opening fact frames the council badly.',
        flags: [{ id: 'b1', step_id: 's1', kind: 'loaded_wording', severity: 'high', note: 'Lead with the rating, not the blame.', status: 'unaddressed' }],
      },
      { side_id: 'council-responsible', round: 1, summary: 'No high-severity issues.', flags: [] },
    ],
    fact_check: [
      { target: 's1', claim: 'Deck rated poor in 2023', source_id: 'src-inspection', verdict: 'supported', round: 1 },
      { target: 's3', claim: 'State grants were offered', source_id: 'src-state', verdict: 'partially_supported', note: 'Offer date unclear.', round: 1 },
    ],
    open_issues: [{ id: 'oi1', source: 'red_team', severity: 'high', description: 'Wording of s1 still contested.', step_id: 's1', resolved: false }],
    decisions: [],
  };
}

/** What a new-case pipeline run leaves behind: a research log with a page snapshot. */
async function writeResearchLog(pipeline: Db, jobId: string, slug: string, doc: Case): Promise<string> {
  const src = doc.sources.find((s) => s.id === 'src-inspection')!;
  const text = `Inspection report (fixture). The deck was rated poor in 2023. ${slug}`;
  const snap = await pipeline
    .from('source_snapshots')
    .insert({ job_id: jobId, url: src.url, title: src.title, http_status: 200, content_type: 'text/html', sha256: createHash('sha256').update(text).digest('hex'), text_content: text })
    .select('id')
    .single();
  if (snap.error) throw snap.error;
  const ins = await pipeline.from('research_log').insert([
    { job_id: jobId, agent: 'records_researcher', round: 0, kind: 'query', query: 'harbor bridge inspection 2023' },
    { job_id: jobId, agent: 'records_researcher', round: 0, kind: 'open', url: src.url, title: src.title, snapshot_id: snap.data.id, http_status: 200 },
    { job_id: jobId, agent: 'records_researcher', round: 0, kind: 'claim', url: src.url, title: src.title, claims: [{ claim: 'The deck was rated poor in 2023.', quote: 'rated poor' }] },
    { job_id: jobId, agent: 'fact_checker', round: 1, kind: 'note', excerpt: 'Re-opened every cited source.' },
  ]);
  if (ins.error) throw ins.error;
  return snap.data.id as string;
}

const NEW_SOURCE: Source = {
  id: 'src-news-2',
  title: 'Council approves bridge repair contract (fixture)',
  publisher: 'Fixture Gazette',
  url: 'https://example.org/fixtures/harbor/gazette-contract',
  date: '2026-10-06',
  type: 'news',
  accessed_at: '2026-10-08T08:00:00Z',
};

const STEP_S5: Step = {
  id: 's5',
  order: 5,
  headline: 'The council approved a repair contract in October 2026.',
  body: 'The council voted to fund repairs after the closure. Work is due to start in 2027. This is a fictional test fixture.',
  depth: [],
  favors: 'council-not-responsible',
  impact: 'medium',
  source_ids: ['src-news-2'],
  confidence: 'reported',
  micro_poll: { prompt: 'Does this change your position?', re_ask_slider: true },
};

const STEP_S6: Step = {
  id: 's6',
  order: 6,
  headline: 'The council cut the bridge maintenance line in its 2019 budget vote.',
  body: 'The 2019 budget moved bridge maintenance money to road resurfacing. The minutes record the vote. This is a fictional test fixture.',
  depth: [],
  favors: 'council-responsible',
  impact: 'medium',
  source_ids: ['src-minutes'],
  confidence: 'established',
  micro_poll: { prompt: 'Does this change your position?', re_ask_slider: true },
};

/** A revision package the pipeline writes against the live version (as a scheduled update would). */
function revisionOf(live: Case, liveVersion: number, jobId: string, extraSteps: Step[]): Case {
  const doc = structuredClone(live) as Case;
  doc.as_of = '2026-10-08';
  doc.parent_version = liveVersion;
  doc.sources = [...doc.sources, NEW_SOURCE];
  doc.steps = [...doc.steps, ...extraSteps];
  doc.review = reviewRecord(jobId, 'revision');
  return doc;
}

/** The staff API's raw bytes for one version (what the database returns, serialised by Postgres). */
async function rawStaffVersion(db: Db, caseId: string, version: number): Promise<string> {
  const { data } = await db.auth.getSession();
  const token = data.session?.access_token;
  assert.ok(token, 'admin session');
  const res = await fetch(
    `${API_URL}/rest/v1/staff_case_versions?select=status,published_at,published_by,tags,parent_version,based_on_version,title,as_of,doc&case_id=eq.${caseId}&version=eq.${version}`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  assert.equal(res.status, 200);
  return res.text();
}

/** The public API's raw bytes for one published version (anon get_published_case). */
async function rawPublished(slug: string, version: number | null): Promise<string> {
  const res = await fetch(`${API_URL}/rest/v1/rpc/get_published_case`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_slug: slug, p_version: version }),
  });
  assert.equal(res.status, 200);
  return res.text();
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const words = (s: string | undefined) => (s?.trim() ? s.trim().split(/\s+/).length : 0);

/**
 * Plays one dive as an anonymous reader through the public dive API, at
 * reading pace so it counts as a real completion. A per-run test address
 * (TEST-NET-2) keeps repeated runs under the per-network session limit
 * without touching app.settings.
 */
async function playDive(slug: string) {
  const anon = createAnonClient(API_URL, ANON_KEY, { 'cf-connecting-ip': `198.51.100.${randomInt(1, 255)}` });
  const api = new SupabaseDiveApi(anon);
  const loaded = await api.getCase(slug);
  assert.ok(loaded, 'the published case loads for anon');
  const doc = loaded.doc;
  const start = await api.startSession(loaded.case_id, loaded.version, `e2e-device-${randomUUID()}`);
  const slots: [string, number][] = [
    ['before', doc.starting_facts.reduce((n, f) => n + words(f.text), 0) + words(doc.question.prompt)],
    ...doc.steps.map((s) => [s.id, words(s.headline) + words(s.body)] as [string, number]),
    ['after', 0],
  ];
  const values = [80, 70, 64, 55, 50, 45];
  for (let i = 0; i < slots.length; i++) {
    const [slot, n] = slots[i]!;
    if (slot !== 'after') await sleep(Math.max(1500, (n / 15) * 1000) + 400);
    await api.submit(start.session_id, slot, values[i] ?? 45);
  }
  await api.flagFact(start.session_id, 's2', 'cherry_picked', 'Leaves out the 2021 vote.');
  await api.rateFairness(start.session_id, 'council-not-responsible', 'somewhat_fair');
  return { sessionId: start.session_id, caseId: loaded.case_id, version: loaded.version, slots: slots.length };
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

const visible = (l: Locator, timeout = 30_000) => l.first().waitFor({ state: 'visible', timeout });

async function shot(target: Page | Locator, name: string, fullPage = false) {
  const path = join(SHOTS, `${name}.png`);
  if ('goto' in target) await target.screenshot({ path, fullPage });
  else await target.screenshot({ path });
  shots.push(path);
}
const shots: string[] = [];

async function signIn(page: Page, url: string, email: string) {
  await page.goto(`${url}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** The review screen is hydrated once the client-only preview has mounted. */
async function openReview(page: Page, url: string, caseId: string, version: number) {
  await page.goto(`${url}/review/${caseId}/${version}`);
  await visible(page.getByTestId('review-title'));
  await visible(page.getByTestId('preview').getByTestId('case-card'));
}

async function waitText(page: Page, testId: string, pattern: RegExp, timeout = 30_000) {
  await page.waitForFunction(
    ([id, src, flags]) => new RegExp(src!, flags).test(document.querySelector(`[data-testid="${id}"]`)?.textContent ?? ''),
    [testId, pattern.source, pattern.flags],
    { timeout },
  );
}

const diffItems = (page: Page) =>
  page.locator('#diff').locator('[data-testid^="diff-steps-"], [data-testid^="diff-startingFacts-"], [data-testid^="diff-sides-"], [data-testid^="diff-sources-"]');

async function diffItemIds(page: Page): Promise<string[]> {
  return (await diffItems(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))).sort();
}

const queueRows = (page: Page, slug: string) => page.getByTestId('queue-table').locator('tbody tr', { hasText: slug });

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  rmSync(join(SHOTS, 'zz-failure.png'), { force: true });
  const t0 = Date.now();

  step('1. Setup outside the UI (service key used for the two test accounts only)');
  const svc = createClient(API_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  await ensureStaff(svc, OWNER_EMAIL, 'admin');
  await ensureStaff(svc, PIPELINE_EMAIL, 'pipeline');
  const admin = await signInStaff(API_URL, ANON_KEY, { email: OWNER_EMAIL, password: PASSWORD });
  const pipeline = await signInStaff(API_URL, ANON_KEY, { email: PIPELINE_EMAIL, password: PASSWORD });
  ok(`staff accounts ready: ${OWNER_EMAIL} (admin), ${PIPELINE_EMAIL} (pipeline)`);

  const slug = `e2e-p3-${randomUUID().slice(0, 8)}`;
  const fixture = harborBridge();
  const newCaseJob = await adminCreateCase(admin, `E2E phase 3: ${slug}`);
  const snapshotId = await writeResearchLog(pipeline, newCaseJob, slug, fixture);
  const pkgDoc: Case = { ...structuredClone(fixture), review: reviewRecord(newCaseJob, 'new') };
  const pkg = await submitCasePackage(pipeline, { slug, doc: pkgDoc, jobId: newCaseJob });
  const caseId = pkg.case_id;
  assert.equal(pkg.version, 1);
  // No worker runs in this test: close the job the package came from so pipeline suites see a clean queue.
  await adminCancelJob(admin, newCaseJob);
  await adminSetSeedProfile(admin, caseId, {
    sessions: 120,
    before_bins: [2, 3, 5, 8, 12, 14, 16, 16, 14, 10],
    steps: { s1: { move_share: 0.4, mean_shift: 8, spread: 5 }, s3: { move_share: 0.5, mean_shift: -12, spread: 6 } },
    fade_after_real_completions: 500,
    rng_seed: 11,
  });
  ok(`pipeline submitted fixture-harbor-bridge as ${slug} v1 (case ${caseId}), with a research log and snapshot ${snapshotId.slice(0, 8)}`);

  const jobsToCancel = new Set<string>();
  // Versions of this run that are still pending; whatever is left when the run ends is rejected as test data.
  const pendingVersions = new Set<number>([1]);
  const cleanup = async () => {
    // Leave the local stack tidy: no queued jobs from this run, nothing of it left pending in the queue.
    for (const id of jobsToCancel) {
      const j = await getPipelineJob(admin, id).catch(() => null);
      if (j?.status === 'queued') await adminCancelJob(admin, id).catch(() => undefined);
    }
    for (const v of pendingVersions) {
      const row: StaffVersionRow | null = await getStaffVersion(admin, caseId, v).catch(() => null);
      if (row && ['in_review', 'changes_requested', 'draft'].includes(row.status)) {
        await adminReject(admin, caseId, v, 'E2E cleanup: test package, not for publishing.').catch(() => undefined);
      }
    }
  };

  let url: string;
  let stop: () => void;
  let browser: Browser;
  try {
    ({ url, stop } = await startConsole());
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  } catch (e) {
    await cleanup();
    throw e;
  }
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  // Confirmations are accepted unless a check sets this to dismiss the next ones.
  let dialogs: 'accept' | 'dismiss' = 'accept';
  const dialogLog: string[] = [];
  page.on('dialog', (d) => {
    dialogLog.push(d.message());
    void (dialogs === 'accept' ? d.accept() : d.dismiss());
  });

  try {
    step('2. Browser: log in, queue, review screen, preview, approve and publish');
    await page.goto(`${url}/`);
    assert.match(page.url(), /\/login$/);
    await visible(page.getByRole('heading', { name: 'Sign in' }));
    await shot(page, '01-login');
    ok('signed-out visitors land on /login');

    const loginHead = await fetch(`${url}/login`);
    assert.equal(loginHead.headers.get('x-frame-options'), 'DENY');
    assert.match(loginHead.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(loginHead.headers.get('referrer-policy'), 'no-referrer');
    ok('every page refuses framing (X-Frame-Options DENY, CSP frame-ancestors none) and sends no referrer');

    await signIn(page, url, OWNER_EMAIL);
    await page.waitForURL(`${url}/`);
    await visible(page.getByTestId('queue-table'));
    assert.equal(await page.getByTestId('signed-in-as').innerText(), OWNER_EMAIL);
    const sessionCookies = (await context.cookies()).filter((ck) => ck.name.includes('auth-token'));
    assert.ok(sessionCookies.length > 0, 'a session cookie is set');
    assert.ok(sessionCookies.every((ck) => ck.httpOnly && ck.sameSite === 'Lax'), 'session cookies are HttpOnly and SameSite=Lax');
    assert.equal(await page.evaluate(() => document.cookie.includes('auth-token')), false, 'page scripts cannot read the session');
    ok('the session cookie is HttpOnly (page scripts cannot read the tokens) and SameSite=Lax');
    const pkgRow = queueRows(page, slug);
    assert.equal(await pkgRow.count(), 1, 'the new package is in the queue once');
    const rowText = await pkgRow.innerText();
    for (const want of [fixture.title, 'v1', 'In review', 'pipeline', '2026-09-30']) assert.ok(rowText.includes(want), `queue row shows ${want}`);
    await pkgRow.scrollIntoViewIfNeeded();
    await shot(page, '02-queue-new-package');
    ok('the admin is signed in and the queue lists the new package (v1, in review, 4 steps, 1 open issue)');

    await pkgRow.getByTestId('queue-link').click();
    await page.waitForURL(`${url}/review/${caseId}/1`);
    await visible(page.getByTestId('preview').getByTestId('case-card'));
    assert.equal(await page.getByTestId('review-title').innerText(), fixture.title);
    const header = await page.locator('.review-header').innerText();
    for (const want of ['v1', 'In review', '1 open issue', '2026-09-30', 'Origin pipeline', '4 steps']) assert.ok(header.includes(want), `header shows ${want}`);
    await visible(page.getByTestId('checks-ok'));
    await shot(page, '03-review-screen');
    ok('header: title, v1, status, as-of 2026-09-30, 1 open issue; checks report no errors');

    // Preview: the real dive screens inside the phone frame.
    const preview = page.getByTestId('preview');
    const phone = page.locator('.phone');
    assert.ok((await phone.innerText()).includes('Harbor Bridge'), 'the case card shows the title');
    await shot(phone, '04-preview-case-card');
    await preview.getByTestId('dive-next').click();
    await visible(preview.getByTestId('starting-facts'));
    const phoneText = async () => (await phone.innerText()).replace(/\s+/g, ' ');
    const factsText = await phoneText();
    for (const f of fixture.starting_facts) assert.ok(factsText.includes(f.text), `starting facts screen shows ${f.id}; got: ${factsText}`);
    await shot(phone, '05-preview-starting-facts');
    await preview.getByTestId('dive-next').click();
    await visible(preview.getByTestId('before-screen'));
    assert.ok((await phoneText()).includes(fixture.question.prompt), 'the before screen asks the question');
    const slider = preview.getByTestId('slider');
    await slider.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('PageUp');
    const beforeValue = Number((await preview.getByTestId('slider-value').innerText()).replace(/\D+/g, ''));
    await shot(phone, '06-preview-before');
    await preview.getByTestId('poll-commit').click();
    await preview.getByTestId('dive-next').click();
    await visible(preview.getByTestId('step-screen'));
    assert.ok((await phoneText()).includes(fixture.steps[0]!.headline), 'step 1 shows its headline');
    assert.equal(await preview.getByTestId('reveal').count(), 0, 'the crowd is hidden before the reader commits');
    await preview.getByTestId('slider').focus();
    for (let i = 0; i < 2; i++) await page.keyboard.press('PageDown');
    await shot(phone, '07-preview-step-1');
    await preview.getByTestId('poll-commit').click();
    await visible(preview.getByTestId('reveal'));
    const mirror = await preview.getByTestId('mirror').innerText();
    assert.match(mirror, new RegExp(`${beforeValue}`), 'the personal mirror starts from the before answer');
    await visible(preview.getByTestId('seeded-note'));
    await preview.getByTestId('reveal').scrollIntoViewIfNeeded();
    await shot(phone, '08-preview-step-1-reveal');
    await page.getByTestId('restart-preview').click();
    await visible(preview.getByTestId('case-card'));
    await preview.getByTestId('transparency-link').click();
    await visible(preview.getByTestId('transparency-page'));
    const about = (await phone.innerText()).replace(/\s+/g, ' ').toLowerCase();
    assert.ok(about.includes('how this dive was made') && about.includes(fixture.sources[0]!.title.toLowerCase()), `the transparency page lists the sources; got: ${about.slice(0, 600)}`);
    await shot(phone, '08b-preview-transparency');
    await preview.getByTestId('dive-back').first().click();
    await visible(preview.getByTestId('case-card'));
    ok(`preview (DiveFlow via react-native-web): case card -> starting facts -> before (${beforeValue}) -> step 1 commit -> reveal ("${mirror.replace(/\s+/g, ' ').trim()}", seeded crowd); hidden before commit; restart; "How this dive was made" opens the transparency page`);

    // Step list with sources, confidence, favors and flags.
    assert.equal(await page.locator('[data-testid^="step-card-"]').count(), 4);
    const s1 = page.getByTestId('step-card-s1');
    const s1Summary = await s1.locator('summary').innerText();
    for (const want of ['established', 'favors The council is responsible', 'high impact']) assert.ok(s1Summary.includes(want), `s1 summary shows ${want}`);
    const inspection = fixture.sources.find((x) => x.id === 'src-inspection')!;
    const s1Sources = await s1.locator('#f-steps-0-source_ids').innerText();
    // The chip leads with the source type and publisher (they decide reported vs established), then the title.
    assert.ok(
      s1Sources.includes(inspection.title) && s1Sources.toLowerCase().includes(inspection.type.replace('_', ' ')) && s1Sources.includes(inspection.publisher),
      `s1 lists its source with type and publisher; got: ${s1Sources}`,
    );
    // Section labels are styled in capitals, so compare case-insensitively.
    const s1Flags = (await s1.getByTestId('step-flags').innerText()).toLowerCase();
    for (const want of ['need attention', 'Red team', 'Lead with the rating, not the blame.', 'Hard questions', 'Did the council see the 2023 inspection?', 'Open issues', 'Wording of s1 still contested.']) {
      assert.ok(s1Flags.includes(want.toLowerCase()), `s1 flags show ${want}; got: ${s1Flags}`);
    }
    const s3Flags = await page.getByTestId('step-card-s3').getByTestId('step-flags').innerText();
    assert.match(s3Flags, /fact-checker[\s\S]*partially supported[\s\S]*Offer date unclear/i, `s3 shows the fact-checker's partial verdict; got: ${s3Flags}`);
    await shot(s1, '09-step-card-s1');
    ok('step list: 4 cards with sources, confidence, favors, impact; s1 shows red-team, hard-question and open-issue flags, s3 the fact-checker\'s partial verdict');

    const balance = page.getByTestId('balance-panel');
    const balanceText = (await balance.innerText()).toLowerCase();
    for (const want of ['The council is responsible', 'The council is not responsible', 'Order of the facts']) {
      assert.ok(balanceText.includes(want.toLowerCase()), `balance panel shows ${want}; got: ${balanceText}`);
    }
    await shot(balance, '10-balance-panel');
    ok('balance panel: steps per side and the order of the facts');

    const audit = page.getByTestId('audit-tabs');
    const tabChecks: [RegExp, string, string][] = [
      [/Research log/, '#panel-research', '4 log entries, 1 page snapshot'],
      [/Hard questions/, '#panel-questions', 'Did the council see the 2023 inspection?'],
      [/Bias reports/, '#panel-bias', 'Lead with the rating, not the blame.'],
      [/Fact-check/, '#panel-factcheck', 'State grants were offered'],
      [/Decisions/, '#panel-decisions', 'Submitted'],
    ];
    for (const [name, panel, want] of tabChecks) {
      await audit.getByRole('tab', { name }).click();
      await visible(page.locator(panel));
      const panelText = (await page.locator(panel).innerText()).toLowerCase();
      assert.ok(panelText.includes(want.toLowerCase()), `${panel} shows ${want}; got: ${panelText.slice(0, 400)}`);
      if (panel === '#panel-research') {
        // Each agent's log loads when its group is opened (the page does not ship the whole log).
        const firstRun = page.locator('#panel-research details').first();
        await firstRun.locator('summary').click();
        await visible(firstRun.getByText('Searched: “harbor bridge inspection 2023”'));
        assert.match(await firstRun.innerText(), /Searched: “harbor bridge inspection 2023”[\s\S]*read snapshot/);
        assert.match(await page.getByTestId('opened-table').innerText(), /opened/);
      }
      await shot(audit, `11-audit-${panel.slice(7)}`);
    }
    const snapPage = await context.newPage();
    await snapPage.goto(`${url}/snapshots/${snapshotId}`);
    assert.match(await snapPage.getByTestId('snapshot-text').innerText(), /rated poor in 2023/);
    await shot(snapPage, '11-audit-snapshot-page');
    await snapPage.close();
    ok('audit tabs: research log (queries, opened pages, snapshot link), hard questions, bias reports, fact-check table, decisions; the snapshot page shows the text the pipeline read');

    const actions = page.getByTestId('actions-panel');
    for (const id of ['action-publish', 'action-schedule']) assert.ok(await page.getByTestId(id).isEnabled(), `${id} enabled`);
    assert.ok(await page.getByTestId('action-edit-approve').isDisabled(), 'Edit then approve needs edits (else it would copy the version as admin_edit)');
    assert.ok(await page.getByTestId('action-save').isDisabled(), 'Save is disabled with no edits');
    const cautions = await page.getByTestId('approve-cautions').first().innerText();
    assert.match(cautions, /1 unaddressed high-severity red-team flag[\s\S]*1 blocking hard question still open[\s\S]*1 unresolved open issue \(1 high\)/, `approve shows what is unresolved; got: ${cautions}`);
    assert.match(await page.getByTestId('needs-attention').innerText(), /Step 1[\s\S]*red team: high loaded wording/);
    assert.ok(await page.getByTestId('action-request-changes').isDisabled(), 'Request changes needs notes');
    assert.ok(await page.getByTestId('action-reject').isDisabled(), 'Reject needs a reason');
    await shot(actions, '12-actions');
    ok('actions: Approve and publish, Approve and schedule (with cautions for unresolved review items), Request changes, Edit then approve, Save, Reject');

    await page.getByTestId('action-publish').click();
    await waitText(page, 'action-result', /Published v1/);
    await waitText(page, 'status-badge', /Published/);
    const v1AfterPublish = await getStaffVersion(admin, caseId, 1);
    assert.equal(v1AfterPublish?.status, 'published');
    assert.equal((await getStaffCase(admin, caseId))?.live_version, 1);
    await shot(page, '13-v1-published');
    pendingVersions.delete(1);
    ok('Approve and publish: v1 is published and live');
    const v1RawBefore = await rawStaffVersion(admin, caseId, 1);
    const v1PublicBefore = await rawPublished(slug, 1);

    step('3. Outside the UI: an anonymous reader plays the dive on v1');
    const played = await playDive(slug);
    assert.equal(played.version, 1);
    ok(`anon played v1 at reading pace through @sia/dive-engine/supabase: session ${played.sessionId.slice(0, 8)}, ${played.slots} answers, one fact flag, one fairness rating`);

    step('4. Browser: edit the live version inline, save (admin_edit draft), diff, approve and publish');
    await openReview(page, url, caseId, 1);
    assert.match(await page.getByTestId('edit-mode').innerText(), /saving creates a new draft/);
    assert.match(await page.getByTestId('step-card-s2').getByTestId('step-flags').innerText(), /Reader flags/i);
    // Triage: the admin marks the red team's flag on s1 addressed; it is saved with the edits.
    const s1Card = page.getByTestId('step-card-s1');
    const attentionBefore = await s1Card.getByTestId('step-flags').locator('h4').innerText();
    await s1Card.getByTestId('triage-rt-b1').getByRole('button', { name: 'Addressed…' }).click();
    await s1Card.getByTestId('triage-rt-b1-form').locator('textarea').fill('The headline now leads with the inspection rating.');
    await s1Card.getByTestId('triage-rt-b1-form').getByRole('button', { name: 'Addressed' }).click();
    await visible(page.getByTestId('savebar'));
    const attentionAfter = await s1Card.getByTestId('step-flags').locator('h4').innerText();
    assert.notEqual(attentionAfter, attentionBefore, `s1's attention count drops (${attentionBefore} -> ${attentionAfter})`);
    assert.match(await s1Card.getByTestId('red-team-b1').innerText(), /addressed[\s\S]*Resolution: The headline now leads/);
    const newHeadline = 'The council voted in 2022 and 2023 to delay repair funding.';
    await page.locator('#f-steps-1-headline').fill(newHeadline);
    await page.locator('#f-steps-2-confidence').selectOption('reported');
    await visible(page.getByTestId('savebar'));
    const expectedSummary = '2 steps changed (s2 headline, s3 confidence).';
    await waitText(page, 'diff-summary', /2 steps changed/);
    assert.equal(await page.getByTestId('diff-summary').innerText(), expectedSummary);
    assert.deepEqual(await diffItemIds(page), ['diff-steps-s2', 'diff-steps-s3']);
    assert.equal(await page.getByTestId('action-publish').count(), 0, 'a published version is never re-published');
    await shot(page, '14-live-v1-inline-edit');
    ok('live v1 edited inline (s2 headline, s3 confidence); the working-copy diff lists exactly those two changes');

    await page.getByTestId('action-save').click();
    await page.waitForURL(`${url}/review/${caseId}/2?notice=saved`);
    pendingVersions.add(2);
    await visible(page.getByTestId('preview').getByTestId('case-card'));
    await visible(page.getByTestId('page-notice'));
    assert.match(await page.getByTestId('status-badge').first().innerText(), /Draft/);
    assert.ok((await page.locator('.review-header').innerText()).includes('admin_edit'));
    const draft = await getStaffVersion(admin, caseId, 2);
    assert.equal(draft?.status, 'draft');
    assert.equal(draft?.origin, 'admin');
    assert.deepEqual(draft?.tags, ['admin_edit']);
    assert.equal(draft?.based_on_version, 1);
    assert.equal(draft?.parent_version, 1);
    assert.equal((await getStaffCase(admin, caseId))?.live_version, 1, 'saving a draft does not change the live version');
    const dbDiff = diffCases(v1AfterPublish!.doc, draft!.doc);
    assert.equal(summarizeDiff(dbDiff, draft!.doc), expectedSummary, 'the stored draft differs from v1 in exactly those two fields');
    assert.deepEqual(dbDiff.steps.filter((d) => d.status !== 'unchanged').map((d) => [d.id, d.changes.map((c) => c.path)]), [['s2', ['headline']], ['s3', ['confidence']]]);
    const b1 = draft!.doc.review.bias_reports.flatMap((r) => r.flags).find((f) => f.id === 'b1');
    assert.equal(b1?.status, 'addressed', 'the triage is saved in the draft’s review record');
    const editDecision = draft!.doc.review.decisions.filter((d) => d.action === 'admin_edit').at(-1);
    assert.match(editDecision?.notes ?? '', /Review items:[\s\S]*Red-team flag b1 .* marked addressed: The headline now leads/);
    ok('Save created draft v2 (status draft, origin admin, tags [admin_edit], based on v1, updates v1) with the red-team flag marked addressed and logged; v1 stays live');

    // The draft revises the live v1, so v1's readers' flags are shown (and can be marked reviewed) here.
    const s2Card = page.getByTestId('step-card-s2');
    assert.match(await s2Card.getByTestId('step-flags').innerText(), /Reader flags · readers of v1[\s\S]*1\s*open of 1/i);
    assert.match(await page.getByTestId('reader-signals').innerText(), /readers of v1/);
    await s2Card.getByTestId('mark-reader-flags-reviewed').click();
    await visible(s2Card.getByText(/Marked 1 reader flag/));
    const flagsLeft = await admin.from('fact_flags').select('resolved_at, resolved_by').eq('case_id', caseId).eq('case_version', 1).eq('step_id', 's2');
    if (flagsLeft.error) throw flagsLeft.error;
    assert.ok(flagsLeft.data.length === 1 && flagsLeft.data[0]!.resolved_at && flagsLeft.data[0]!.resolved_by === OWNER_EMAIL, 'the reader flag is marked reviewed by the owner');
    await waitText(page, 'reader-signals', /readers of v1/).catch(() => undefined);
    ok('the edit draft shows v1’s reader flags and fairness ratings (labelled “readers of v1”); “Mark reviewed” resolves the flag in the database');

    // Unsaved edits survive in-app navigation and a reload.
    const probeHeadline = 'Unsaved probe headline';
    await page.locator('#f-steps-0-headline').fill(probeHeadline);
    await visible(page.getByTestId('savebar'));
    dialogs = 'dismiss';
    const before = dialogLog.length;
    await page.locator('.review-header .kicker a').first().click();
    await sleep(500);
    dialogs = 'accept';
    assert.match(dialogLog.slice(before).join('\n'), /unsaved edits/i, 'leaving with unsaved edits asks first');
    assert.match(page.url(), new RegExp(`/review/${caseId}/2`), 'cancelling keeps the admin on the review screen');
    assert.equal(await page.locator('#f-steps-0-headline').inputValue(), probeHeadline);
    await sleep(800); // the local copy is written 0.4 s after the last edit
    await page.reload();
    await visible(page.getByTestId('restore-banner'));
    await page.getByTestId('restore-edits').click();
    assert.equal(await page.locator('#f-steps-0-headline').inputValue(), probeHeadline, 'the kept edits come back');
    await page.getByTestId('savebar').getByRole('button', { name: 'Discard edits' }).click();
    await page.getByTestId('savebar').waitFor({ state: 'detached' });
    ok('with unsaved edits, an in-app link asks first (cancel keeps the edits); after a reload the edits kept in this browser are offered and restored');

    await waitText(page, 'diff-summary', /2 steps changed/);
    assert.equal(await page.getByTestId('diff-summary').innerText(), expectedSummary);
    assert.deepEqual(await diffItemIds(page), ['diff-steps-s2', 'diff-steps-s3']);
    assert.equal(await page.locator('#diff').getByText('Case card and question').count(), 0, 'no case-level field changed');
    const d2 = page.getByTestId('diff-steps-s2');
    assert.equal(await d2.locator('del.d-del').first().innerText(), 'twice');
    assert.equal(await d2.locator('ins.d-ins').first().innerText(), 'in 2022 and 2023');
    const d3 = page.getByTestId('diff-steps-s3');
    assert.equal(await d3.locator('del.d-del').innerText(), 'established');
    assert.equal(await d3.locator('ins.d-ins').innerText(), 'reported');
    assert.match(await page.locator('#diff .diff-col-head').first().innerText(), /Live version v1/i);
    await shot(page.locator('#diff'), '15-draft-v2-diff-vs-live-v1');
    ok(`diff view on v2 against the live v1: "${expectedSummary}" with word-level highlights (twice -> in 2022 and 2023; established -> reported)`);

    await page.getByTestId('action-publish').click();
    await waitText(page, 'action-result', /Published v2/);
    await waitText(page, 'status-badge', /Published/);
    await page.getByTestId('page-notice').waitFor({ state: 'detached' });
    assert.ok(!page.url().includes('notice='), 'the "saved in this draft" notice is gone once the draft is published');
    await shot(page, '16-v2-published', true);
    pendingVersions.delete(2);
    ok('Approve and publish on the draft: v2 is published');

    step('5. Database: v2 is a new immutable version; v1 and its responses are untouched');
    const [v1, v2, c] = await Promise.all([getStaffVersion(admin, caseId, 1), getStaffVersion(admin, caseId, 2), getStaffCase(admin, caseId)]);
    assert.equal(c?.live_version, 2, 'live_version = 2');
    assert.equal(v2?.version, 2);
    assert.equal(v2?.status, 'published');
    assert.ok(v2?.tags.includes('admin_edit'), 'v2 is tagged admin_edit');
    assert.equal(v2?.origin, 'admin');
    assert.equal(v2?.parent_version, 1);
    assert.equal(v2?.doc.steps[1]?.headline, newHeadline);
    assert.equal(v2?.doc.steps[2]?.confidence, 'reported');
    ok('v2: published, origin admin, tags [admin_edit], parent_version 1, carries the two edits; cases.live_version = 2');

    assert.equal(v1?.status, 'published', 'v1 is still published');
    assert.equal(v1?.published_at, v1AfterPublish?.published_at);
    const v1RawAfter = await rawStaffVersion(admin, caseId, 1);
    assert.equal(v1RawAfter, v1RawBefore, 'v1 row (doc, status, published_at, tags) is byte-for-byte unchanged');
    assert.equal(v1?.doc.steps[1]?.headline, fixture.steps[1]!.headline);
    assert.equal(v1?.doc.steps[2]?.confidence, 'established');
    const tamper = await admin.from('case_versions').update({ doc: { ...v1!.doc, title: 'changed' } }).eq('case_id', caseId).eq('version', 1);
    assert.ok(tamper.error, 'an in-place edit of a published version is refused');
    ok(`v1 still published, byte-for-byte unchanged (sha256 ${sha(v1RawAfter).slice(0, 16)}…, ${v1RawAfter.length} bytes), and an in-place update is refused: "${tamper.error!.message.slice(0, 70)}…"`);

    const responses = await admin.from('responses').select('case_version, step_id, excluded').eq('session_id', played.sessionId);
    if (responses.error) throw responses.error;
    assert.equal(responses.data.length, played.slots);
    assert.ok(responses.data.every((r) => r.case_version === 1), 'every response stays on v1');
    assert.ok(responses.data.every((r) => r.excluded === false), 'no response fell under the reading-time floor');
    ok(`all ${responses.data.length} responses from the session still have case_version = 1`);

    const [crowd1, crowd2] = await Promise.all([adminFinalCrowd(admin, caseId, 1, false), adminFinalCrowd(admin, caseId, 2, false)]);
    assert.equal(crowd1.real_completions, 1);
    assert.equal(crowd1.n_real, 1);
    assert.equal(crowd2.real_completions, 0);
    assert.equal(crowd2.n_real, 0);
    const earlier = (await adminFinalCrowd(admin, caseId, 2)).version_note?.earlier_versions ?? [];
    assert.equal(earlier.find((e) => e.version === 1)?.completions, 1, "v2's version note counts the reader on v1");
    ok('admin_final_crowd: v1 counts the session (n_real 1, real_completions 1); v2 does not (0, 0); v2 notes 1 completion on v1');

    const anon = createAnonClient(API_URL, ANON_KEY);
    const [livePub, v1Pub] = await Promise.all([getPublishedCase(anon, slug), getPublishedCase(anon, slug, 1)]);
    assert.equal(livePub?.version, 2);
    assert.equal(livePub?.is_live, true);
    assert.equal(livePub?.doc.steps[1]?.headline, newHeadline);
    assert.ok(!('favors' in (livePub?.doc.steps[0] ?? {})), 'favors never reaches the public');
    assert.equal(v1Pub?.version, 1);
    assert.equal(v1Pub?.is_live, false);
    assert.equal(v1Pub?.doc.steps[1]?.headline, fixture.steps[1]!.headline);
    assert.equal(await rawPublished(slug, 1), v1PublicBefore.replace('"is_live":true', '"is_live":false'), 'the public v1 document is byte-for-byte unchanged');
    ok('anon get_published_case: v2 is live; v1 is still readable by version with its original content');

    step('6. Revisions, request changes, reject, schedule, and a non-admin account');
    // 6a. A scheduled re-research produces a revision package against the live v2.
    const v2Doc = v2!.doc;
    const updateJob = await adminRequestUpdate(admin, caseId);
    const v3Doc = revisionOf(v2Doc, 2, updateJob, [STEP_S5]);
    const v3 = await submitCasePackage(pipeline, { slug, doc: v3Doc, jobId: updateJob, basedOnVersion: 2, tags: ['update'] });
    pendingVersions.add(v3.version);
    await adminCancelJob(admin, updateJob);
    assert.equal(v3.version, 3);
    ok('pipeline submitted revision v3 against the live v2 (as_of 2026-10-08, new step s5, new source)');

    await page.goto(`${url}/`);
    await visible(page.getByTestId('queue-table'));
    const v3Row = queueRows(page, slug);
    assert.equal(await v3Row.count(), 1);
    assert.match(await v3Row.innerText(), /v3[\s\S]*updates v2/);
    await v3Row.getByTestId('queue-link').click();
    await page.waitForURL(`${url}/review/${caseId}/3`);
    await visible(page.getByTestId('preview').getByTestId('case-card'));
    const v3Summary = summarizeDiff(diffCases(v2Doc, (await getStaffVersion(admin, caseId, 3))!.doc), v3Doc);
    assert.equal(await page.getByTestId('diff-summary').innerText(), v3Summary);
    const notes = 'Add the 2019 budget vote as a step; it is the main fact for the council-responsible side.';
    await page.getByTestId('change-notes').fill(notes);
    await page.getByTestId('action-request-changes').click();
    await waitText(page, 'action-result', /Changes requested\. Revision job [0-9a-f]{8} is queued/);
    await waitText(page, 'status-badge', /Changes requested/);
    const jobPrefix = /Revision job ([0-9a-f]{8})/.exec(await page.getByTestId('action-result').innerText())![1]!;
    const decisions3 = await listReviewDecisions(admin, caseId, 3);
    assert.equal(decisions3[0]?.action, 'request_changes');
    assert.equal(decisions3[0]?.notes, notes);
    const revisionJobs = await admin.from('pipeline_jobs').select('id, kind, status, base_version, instructions').eq('case_id', caseId).eq('kind', 'revision');
    if (revisionJobs.error) throw revisionJobs.error;
    const revisionJob = revisionJobs.data.find((j) => (j.id as string).startsWith(jobPrefix));
    assert.ok(revisionJob, 'the revision job exists');
    jobsToCancel.add(revisionJob.id as string);
    assert.equal(revisionJob.status, 'queued');
    assert.equal(revisionJob.base_version, 3);
    assert.equal(revisionJob.instructions, notes);
    await shot(page, '17-v3-changes-requested');
    ok(`Request changes on v3: status changes_requested; revision job ${jobPrefix} queued with the notes as instructions`);

    await page.goto(`${url}/`);
    assert.ok((await page.getByTestId('jobs-table').innerText()).includes(notes), 'the queued job is listed with its instructions');
    ok('the queued revision job shows on the queue page with its instructions');

    // 6b. The pipeline answers the notes with a revision based on v3.
    const v4Doc = revisionOf(v2Doc, 2, revisionJob.id as string, [STEP_S5, STEP_S6]);
    const v4 = await submitCasePackage(pipeline, { slug, doc: v4Doc, jobId: revisionJob.id as string, basedOnVersion: 3, tags: ['revision'] });
    pendingVersions.add(v4.version);
    assert.equal(v4.version, 4);
    assert.equal((await getStaffVersion(admin, caseId, 3))?.status, 'archived', 'v3 is superseded by v4');
    pendingVersions.delete(3);
    ok('pipeline submitted revision v4 based on v3 using the job; v3 is superseded (archived)');

    await page.goto(`${url}/`);
    await visible(page.getByTestId('queue-table'));
    const v4Row = queueRows(page, slug);
    assert.equal(await v4Row.count(), 1, 'only v4 of this case waits in the queue');
    const v4RowText = await v4Row.innerText();
    for (const want of ['v4', 'updates v2', 'from v3', 'revision', 'In review']) assert.ok(v4RowText.includes(want), `queue row shows ${want}`);
    await v4Row.scrollIntoViewIfNeeded();
    await shot(page, '18-queue-revision-v4');
    ok('the revision v4 appears in the queue (updates v2, from v3)');

    await v4Row.getByTestId('queue-link').click();
    await page.waitForURL(`${url}/review/${caseId}/4`);
    await visible(page.getByTestId('preview').getByTestId('case-card'));
    const v4Stored = (await getStaffVersion(admin, caseId, 4))!.doc;
    const v3Stored = (await getStaffVersion(admin, caseId, 3))!.doc;
    const vsLive = summarizeDiff(diffCases(v2Doc, v4Stored), v4Stored);
    const vsBase = summarizeDiff(diffCases(v3Stored, v4Stored), v4Stored);
    assert.equal(vsLive, 'As-of date changed from 2026-09-30 to 2026-10-08. 2 steps added (s5, s6), 1 source added (src-news-2).');
    assert.equal(vsBase, '1 step added (s6).');
    assert.equal(await page.getByTestId('diff-summary').innerText(), vsLive);
    assert.deepEqual(await diffItemIds(page), ['diff-sources-src-news-2', 'diff-steps-s5', 'diff-steps-s6']);
    await shot(page.locator('#diff'), '19-v4-diff-vs-live-v2');
    const options = await page.getByTestId('compare-select').locator('option').allInnerTexts();
    assert.deepEqual(options, ['Live version v2', 'Base version v3']);
    await page.getByTestId('compare-select').selectOption('base');
    await waitText(page, 'diff-summary', /^1 step added \(s6\)\.$/);
    assert.deepEqual(await diffItemIds(page), ['diff-steps-s6']);
    await shot(page.locator('#diff'), '20-v4-diff-vs-base-v3');
    ok(`diff view on v4: against the live v2 "${vsLive}"; against the base v3 "${vsBase}"`);

    const reason = 'Step s6 needs a second source before it can run.';
    await page.getByTestId('reject-reason').fill(reason);
    await page.getByTestId('action-reject').click();
    await waitText(page, 'status-badge', /Rejected/);
    assert.equal((await getStaffVersion(admin, caseId, 4))?.status, 'rejected');
    pendingVersions.delete(4);
    const decisions4 = await listReviewDecisions(admin, caseId, 4);
    assert.equal(decisions4[0]?.action, 'reject');
    assert.equal(decisions4[0]?.notes, reason);
    await shot(page, '21-v4-rejected');
    ok('Reject with a reason: v4 is rejected and the reason is stored as a decision');

    // 6c. Another update package, approved for a set time.
    const updateJob2 = await adminRequestUpdate(admin, caseId);
    const v5 = await submitCasePackage(pipeline, { slug, doc: revisionOf(v2Doc, 2, updateJob2, [STEP_S5]), jobId: updateJob2, basedOnVersion: 2, tags: ['update'] });
    pendingVersions.add(v5.version);
    await adminCancelJob(admin, updateJob2);
    assert.equal(v5.version, 5);
    await openReview(page, url, caseId, 5);
    await page.waitForFunction(() => ((document.querySelector('[data-testid="schedule-at"]') as HTMLInputElement | null)?.value ?? '') !== '');
    const when = new Date(Date.now() + 2 * 86_400_000);
    when.setUTCHours(9, 30, 0, 0);
    const local = when.toISOString().slice(0, 16); // the browser runs in UTC
    await page.getByTestId('schedule-at').fill(local);
    await page.getByTestId('action-schedule').click();
    await waitText(page, 'action-result', /goes live at/);
    await waitText(page, 'status-badge', /scheduled/);
    const v5Row = await getStaffVersion(admin, caseId, 5);
    assert.equal(new Date(v5Row!.scheduled_publish_at!).toISOString(), when.toISOString());
    assert.equal(v5Row?.status, 'in_review', 'a scheduled version is not live until its time');
    assert.equal((await getStaffCase(admin, caseId))?.live_version, 2);
    await shot(page, '22-v5-scheduled');
    const expectedWhen = `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    await page.goto(`${url}/`);
    await visible(page.getByTestId('queue-table'));
    const v5QueueRow = queueRows(page, slug);
    assert.equal(await v5QueueRow.count(), 1);
    const v5Text = await v5QueueRow.innerText();
    assert.ok(v5Text.includes(expectedWhen), `queue shows the scheduled time ${expectedWhen}`);
    assert.match(await v5QueueRow.getByTestId('status-badge').innerText(), /In review · scheduled/);
    await v5QueueRow.scrollIntoViewIfNeeded();
    await shot(page, '23-queue-scheduled');
    ok(`Approve and schedule v5: stored for ${when.toISOString()}; the queue shows "${expectedWhen}"; v2 stays live`);

    // 6d. Final check that v1 is still untouched after all of that.
    assert.equal(await rawStaffVersion(admin, caseId, 1), v1RawBefore, 'v1 is still byte-for-byte unchanged');
    ok('v1 is still byte-for-byte unchanged after the revisions');

    // 6e. A signed-in account that is not the admin is refused.
    const other = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC' });
    const otherPage = await other.newPage();
    await signIn(otherPage, url, PIPELINE_EMAIL);
    await visible(otherPage.getByTestId('login-message'));
    assert.match(await otherPage.getByTestId('login-message').innerText(), /Not authorized/);
    await shot(otherPage, '24-non-admin-refused');
    await otherPage.goto(`${url}/review/${caseId}/2`);
    assert.match(otherPage.url(), /\/login\?next=/);
    assert.equal(await otherPage.getByTestId('queue-table').count(), 0);
    assert.equal((await other.cookies()).filter((ck) => ck.name.includes('auth-token')).length, 0, 'no session cookie is kept');
    await other.close();
    ok('the pipeline account is told "Not authorized", signed out, and cannot open a review page');

    assert.deepEqual(problems, [], `browser errors:\n${problems.join('\n')}`);
    ok('no browser errors or console errors in the admin session');
  } catch (e) {
    await page.screenshot({ path: join(SHOTS, 'zz-failure.png'), fullPage: true }).catch(() => undefined);
    if (problems.length) console.error(`browser problems:\n${problems.join('\n')}`);
    throw e;
  } finally {
    await cleanup();
    await browser.close();
    stop();
  }
  console.log(`\nPhase 3 E2E passed: ${checks} checks in ${Math.round((Date.now() - t0) / 1000)}s. Case ${slug} (${caseId}).`);
  console.log(`Screenshots (${shots.length}) in ${SHOTS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
