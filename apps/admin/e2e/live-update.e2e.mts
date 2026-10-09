/**
 * Phase 5 acceptance in the browser: "a scheduled re-research job produces a
 * revision package against a live case. Done when a revision appears in the
 * queue as a diff, and the live case is unchanged until it is approved."
 *
 *   pnpm --filter @sia/admin e2e:live-update
 *
 * Outside the UI: the pipeline worker (scripted agents, no model calls) turns a
 * brief into a case, the admin publishes it and sets a re-research cadence, the
 * cadence is forced due, the pg_cron function app.enqueue_due_updates() queues
 * an update job, and the worker runs it with a scripted new development.
 * In the browser (a production build of the console, anon key only): the
 * update is in the queue, its review screen shows the update summary and the
 * diff against the live version, the public still gets the old version, and
 * Approve and publish moves the live version.
 *
 * Environment (all optional): E2E_SCREENSHOTS (default <tmp>/sia-live-update-e2e),
 * E2E_PORT (default 3211), E2E_SKIP_BUILD=1, ADMIN_URL, SUPABASE_URL / SUPABASE_ANON_KEY.
 *
 * TEST SETUP ONLY: the staff test accounts and the forced cadence come from
 * supabase/tests/helpers (local demo service key and a direct database
 * connection). The console process never sees either.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { diffCases, summarizeDiff } from '@sia/case-schema';
import { adminCreateCase, adminPublish, adminSetUpdateCadence, getPublishedCase, getStaffCase, getStaffVersion, type Db } from '@sia/case-store';
import { ANON_KEY, API_URL, anonClient, pool, sql, userClient, withQueueLock } from '../../../supabase/tests/helpers';
import { FakeRunner } from '../../../services/pipeline/src/runner/fake';
import { claimJobById, runWorker } from '../../../services/pipeline/src/worker';
import { SIDE_A, SIDE_B, URLS, cleanScripts, fakeFetcher, researcherScript, scoperScript } from '../../../services/pipeline/test/helpers';

const ADMIN_DIR = fileURLToPath(new URL('../', import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 3211);
const SHOTS = process.env.E2E_SCREENSHOTS ?? join(tmpdir(), 'sia-live-update-e2e');
const ADMIN_EMAIL = 'admin-test@sia.local'; // created by supabase/tests/helpers userClient('admin')
const ADMIN_PASSWORD = 'local-test-password-1';
const WORKER = 'e2e-live-update-worker';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

let checks = 0;
const ok = (msg: string) => {
  checks++;
  console.log(`  ✓ ${msg}`);
};
const step = (title: string) => console.log(`\n${title}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    console.log('next build (production) …');
    const build = spawnSync(process.execPath, [nextBin, 'build'], { cwd: ADMIN_DIR, env: consoleEnv(), stdio: 'inherit' });
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

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const t0 = Date.now();
  const anon = anonClient();
  const slug = `e2e-p5-${randomUUID().slice(0, 8)}`;
  let admin: Db | undefined;
  let caseId: string | undefined;
  let stopConsole = () => {};
  try {
    step('1. Outside the UI: a live case, a cadence, a scheduled update job, the worker');
    const [a, pipeline] = await Promise.all([userClient('admin'), userClient('pipeline')]);
    admin = a;
    const created = await withQueueLock(async () => {
      const jobId = await adminCreateCase(admin!, `E2E phase 5: ${slug}`);
      const [o] = await runWorker(
        { db: pipeline, runner: new FakeRunner(cleanScripts({ scoper: scoperScript(slug) })), claim: claimJobById(jobId), workerId: WORKER, fetcher: fakeFetcher(), asOf: '2026-10-01' },
        { once: true },
      );
      return o!;
    });
    assert.equal(created.status, 'succeeded');
    caseId = created.result!.case_id as string;
    await adminPublish(admin, caseId, 1);
    const publicBefore = await getPublishedCase(anon, slug);
    assert.equal(publicBefore?.version, 1);
    ok(`the worker researched "${slug}" (scripted agents); the admin published v1`);

    await adminSetUpdateCadence(admin, caseId, '1 day');
    const update = await withQueueLock(async () => {
      await sql(`update public.cases set next_update_at = now() - interval '1 minute' where id = $1`, [caseId]);
      await sql(`select app.enqueue_due_updates()`);
      const jobs = await sql<{ id: string; created_by: string }>(
        `select id, created_by from public.pipeline_jobs where case_id = $1 and kind = 'update' and status = 'queued'`,
        [caseId],
      );
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.created_by, 'system:schedule');
      const scripts = cleanScripts({
        [`researcher#${SIDE_A.id}`]: researcherScript([]),
        [`researcher#${SIDE_B.id}`]: researcherScript([]),
        records_researcher: researcherScript([
          {
            url: URLS.audit,
            quote: 'moved $400,000 of water repair funds to road paving in 2025',
            text: 'An audit released on October 5, 2026 found $400,000 of water repair funds went to road paving.',
            type: 'news',
            favors: SIDE_A.id,
            impact: 'high',
            date: '2026-10-05',
          },
        ]),
      });
      const [o] = await runWorker(
        { db: pipeline, runner: new FakeRunner(scripts), claim: claimJobById(jobs[0]!.id), workerId: WORKER, fetcher: fakeFetcher(), asOf: '2026-10-09' },
        { once: true },
      );
      return o!;
    });
    assert.equal(update.status, 'succeeded');
    assert.equal(update.result!.version, 2);
    const v2 = (await getStaffVersion(admin, caseId, 2))!;
    assert.equal(v2.status, 'in_review');
    assert.equal(v2.parent_version, 1);
    assert.deepEqual(v2.tags, ['update']);
    ok('cadence 1 day, forced due; app.enqueue_due_updates() queued one update job; the worker submitted v2 (in review, updates v1, tagged update)');

    step('2. Browser: the update is in the queue, as a diff against the live version');
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
      assert.equal(await row.count(), 1);
      const rowText = await row.innerText();
      for (const want of ['v2', 'updates v1', 'update', 'In review']) assert.ok(rowText.includes(want), `queue row shows "${want}"; got: ${rowText}`);
      await row.scrollIntoViewIfNeeded();
      await shot(page, '01-queue-update');
      ok(`the queue lists v2: ${rowText.replace(/\s+/g, ' ').trim()}`);

      await row.getByTestId('queue-link').click();
      await page.waitForURL(`${url}/review/${caseId}/2`);
      await page.getByTestId('preview').getByTestId('case-card').first().waitFor({ state: 'visible', timeout: 30_000 });
      const live = (await getStaffVersion(admin, caseId, 1))!.doc;
      const expected = summarizeDiff(diffCases(live, v2.doc), v2.doc);
      assert.equal(await page.getByTestId('diff-summary').innerText(), expected);
      const items = (await page.locator('#diff [data-testid^="diff-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))).filter((id) =>
        /^diff-(steps|sources|startingFacts|sides)-/.test(id),
      );
      const addedStep = v2.doc.steps.find((s) => !live.steps.some((l) => l.id === s.id))!;
      assert.ok(items.includes(`diff-steps-${addedStep.id}`), `the diff shows the added step; got ${items.join(', ')}`);
      assert.equal(items.filter((i) => i.startsWith('diff-steps-')).length, 1, 'only the new step differs');
      const summary = await page.getByTestId('update-summary').innerText();
      assert.match(summary, /What changed against the live version: As-of date changed from 2026-10-01 to 2026-10-09\. 1 step added/);
      assert.match(summary, /An audit released on October 5, 2026/);
      await shot(page, '02-review-update-diff');
      ok(`review screen: diff against live v1 "${expected}", and the update summary says why`);

      const pub = await getPublishedCase(anon, slug);
      assert.equal(pub?.version, 1);
      assert.deepEqual(pub?.doc, publicBefore?.doc);
      ok('the public still gets v1, unchanged');

      step('3. Browser: approve and publish moves the live version');
      await page.getByTestId('action-publish').click();
      await page.waitForFunction(() => /Published v2/.test(document.querySelector('[data-testid="action-result"]')?.textContent ?? ''), null, { timeout: 30_000 });
      assert.equal((await getStaffCase(admin, caseId))?.live_version, 2);
      const after = await getPublishedCase(anon, slug);
      assert.equal(after?.version, 2);
      assert.ok(after?.doc.steps.some((s) => s.id === addedStep.id));
      assert.deepEqual((await getPublishedCase(anon, slug, 1))?.doc, publicBefore?.doc);
      await shot(page, '03-update-published');
      ok('Approve and publish: v2 is live for the public; v1 is still readable as it was');

      await page.goto(`${url}/cases/${caseId}`);
      const updates = await page.locator('#updates-h').locator('xpath=ancestor::section').innerText();
      assert.match(updates, /Currently: Daily/);
      assert.match(updates, /update of v1/);
      await shot(page, '04-case-live-updates');
      ok('the case page shows the cadence and the update job');
      assert.deepEqual(problems, []);
    } catch (e) {
      const pages = browser.contexts().flatMap((c) => c.pages());
      if (pages[0]) await shot(pages[0], 'zz-failure').catch(() => undefined);
      throw e;
    } finally {
      await browser.close();
    }
    console.log(`\n${checks} checks passed in ${Math.round((Date.now() - t0) / 1000)}s; screenshots in ${SHOTS}`);
  } finally {
    stopConsole();
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
