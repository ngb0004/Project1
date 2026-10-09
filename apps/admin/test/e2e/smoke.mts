/**
 * End-to-end smoke test of the review console against the local Supabase
 * stack and a running console (`next start --port 3100` or `next dev`).
 *
 *   ADMIN_URL=http://localhost:3100 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
 *     npx tsx test/e2e/smoke.mts
 *
 * Proves the phase 3 acceptance: an edit-then-approve creates a new immutable
 * version, and responses given to the old version stay attached to it.
 *
 * Test setup only: the service-role key below (the public local demo key) is
 * used to create the staff accounts, exactly like supabase/tests/helpers.ts.
 * The console itself never sees it.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium, type Locator, type Page } from 'playwright';
import { assertValidCase, type Case, type ReviewRecord } from '@sia/case-schema';
import {
  adminCancelJob,
  adminCreateCase,
  adminSetSeedProfile,
  adminSetUpdateCadence,
  createAnonClient,
  getStaffCase,
  getStaffVersion,
  listPipelineJobs,
  signInStaff,
  submitCasePackage,
  type Db,
} from '@sia/case-store';

const ADMIN_URL = (process.env.ADMIN_URL ?? 'http://localhost:3100').replace(/\/$/, '');
const API_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const PASSWORD = 'local-test-password-1';
const SHOTS = process.env.SMOKE_SCREENSHOTS ?? '';

const root = new URL('../../../../', import.meta.url);
const log = (msg: string) => console.log(`  ✓ ${msg}`);

// ---------------------------------------------------------------------------
// Setup (test only)
// ---------------------------------------------------------------------------

async function staff(role: 'admin' | 'pipeline'): Promise<{ db: Db; email: string }> {
  const email = `${role}-test@sia.local`;
  const svc = createClient(API_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await svc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, app_metadata: { app_role: role } });
  if (error && !/already/i.test(error.message)) throw error;
  return { db: await signInStaff(API_URL, ANON_KEY, { email, password: PASSWORD }), email };
}

function fixture(name: string): Case {
  return assertValidCase(JSON.parse(readFileSync(new URL(`cases/fixtures/${name}.json`, root), 'utf8')));
}

function review(jobId: string): ReviewRecord {
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

/** A package as the pipeline would submit it: research log, page snapshots, review record. */
async function seedPackage(admin: Db, pipeline: Db, slug: string) {
  const jobId = await adminCreateCase(admin, `E2E smoke ${slug}`);
  const doc = fixture('fixture-harbor-bridge');
  delete (doc as Partial<Case>).parent_version;
  doc.review = review(jobId);
  const src = doc.sources.find((s) => s.id === 'src-inspection')!;
  const text = `Inspection report (fixture). The deck was rated poor in 2023. ${slug}`;
  const snap = await pipeline
    .from('source_snapshots')
    .insert({ job_id: jobId, url: src.url, title: src.title, http_status: 200, content_type: 'text/html', sha256: createHash('sha256').update(text).digest('hex'), text_content: text })
    .select('id')
    .single();
  if (snap.error) throw snap.error;
  const rows = [
    { job_id: jobId, agent: 'records_researcher', round: 0, kind: 'query', query: 'harbor bridge inspection 2023' },
    { job_id: jobId, agent: 'records_researcher', round: 0, kind: 'open', url: src.url, title: src.title, snapshot_id: snap.data.id, http_status: 200 },
    { job_id: jobId, agent: 'records_researcher', round: 0, kind: 'claim', url: src.url, title: src.title, claims: [{ claim: 'The deck was rated poor in 2023.', quote: 'rated poor' }] },
    { job_id: jobId, agent: 'fact_checker', round: 1, kind: 'note', excerpt: 'Re-opened every cited source.' },
  ];
  const ins = await pipeline.from('research_log').insert(rows);
  if (ins.error) throw ins.error;
  const ref = await submitCasePackage(pipeline, { slug, doc, jobId });
  // No worker runs in this test; keep the queue clean for other suites.
  await adminCancelJob(admin, jobId);
  return { caseId: ref.case_id, version: ref.version, doc, snapshotId: snap.data.id as string };
}

const words = (s: string | undefined) => (s?.trim() ? s.trim().split(/\s+/).length : 0);

/** Plays one dive through the public API at reading pace, so it counts as a real completion. */
async function playAtReadingPace(caseId: string, version: number, doc: Case) {
  const anon = createAnonClient(API_URL, ANON_KEY);
  const start = await anon.rpc('start_session', { p_case_id: caseId, p_version: version, p_device_id: `smoke-${randomUUID()}` });
  if (start.error) throw start.error;
  const sessionId = start.data.session_id as string;
  const slots: [string, number][] = [
    ['before', doc.starting_facts.reduce((n, f) => n + words(f.text), 0) + words(doc.question.prompt)],
    ...doc.steps.map((s) => [s.id, words(s.headline) + words(s.body)] as [string, number]),
    ['after', 0],
  ];
  const values = [80, 70, 65, 55, 50, 45, 40];
  for (let i = 0; i < slots.length; i++) {
    const [slot, n] = slots[i]!;
    if (slot !== 'after') await new Promise((r) => setTimeout(r, Math.max(1700, (n / 15) * 1000 + 300)));
    const r = await anon.rpc('submit_response', { p_session_id: sessionId, p_step_id: slot, p_value: values[i] ?? 50 });
    if (r.error) throw r.error;
  }
  const flag = await anon.rpc('flag_fact', { p_session_id: sessionId, p_step_id: 's2', p_reason: 'cherry_picked', p_note: 'Leaves out the 2021 vote.' });
  if (flag.error) throw flag.error;
  const fair = await anon.rpc('rate_fairness', { p_session_id: sessionId, p_side_id: 'council-not-responsible', p_rating: 'somewhat_fair' });
  if (fair.error) throw fair.error;
  return sessionId;
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

const visible = (l: Locator, timeout = 20_000) => l.first().waitFor({ state: 'visible', timeout });

async function signIn(page: Page, email: string) {
  await page.goto(`${ADMIN_URL}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: name.endsWith('full') });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  const { db: admin, email: adminEmail } = await staff('admin');
  const { db: pipeline, email: pipelineEmail } = await staff('pipeline');
  const slug = `e2e-admin-${randomUUID().slice(0, 8)}`;
  const pkg = await seedPackage(admin, pipeline, slug);
  const { caseId } = pkg;
  await adminSetSeedProfile(admin, caseId, {
    sessions: 120,
    before_bins: [2, 3, 5, 8, 12, 14, 16, 16, 14, 10],
    steps: { s1: { agree: 3, unsure: 1, disagree: 1 }, s3: { agree: 1, unsure: 1, disagree: 3 } },
    fade_after_real_completions: 500,
    rng_seed: 7,
  });
  const second = await submitCasePackage(pipeline, { slug: `${slug}-b`, doc: (() => { const d = fixture('fixture-orchard-school'); delete (d as Partial<Case>).parent_version; return d; })() });
  console.log(`Seeded ${slug} (case ${caseId}, v${pkg.version}) and ${slug}-b`);

  const browser = await chromium.launch({ executablePath: process.env.SMOKE_CHROMIUM || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('dialog', (d) => void d.accept());
  let sessionPromise: Promise<string> | null = null;

  try {
    // 1. Signed out: everything goes to /login.
    await page.goto(`${ADMIN_URL}/`);
    assert.match(page.url(), /\/login/);
    await visible(page.getByRole('heading', { name: 'Sign in' }));
    log('/login renders and signed-out visitors are sent there');

    // 2. A staff account that is not the admin is refused and signed out.
    await signIn(page, pipelineEmail);
    await visible(page.getByTestId('login-message'));
    assert.match(await page.getByTestId('login-message').innerText(), /Not authorized/);
    await page.goto(`${ADMIN_URL}/`);
    assert.match(page.url(), /\/login/);
    log('a non-admin account sees "not authorized" and stays signed out');

    // 3. The admin sees the queue.
    await signIn(page, adminEmail);
    await page.waitForURL(`${ADMIN_URL}/`);
    await visible(page.getByTestId('queue-table'));
    const row = page.getByTestId('queue-table').locator('tr', { hasText: slug });
    assert.equal(await row.count(), 2, 'both seeded packages are in the queue');
    assert.match(await row.first().innerText(), /In review/);
    assert.equal(await page.getByTestId('signed-in-as').innerText(), adminEmail);
    await shot(page, '01-queue');
    log('the signed-in admin sees the queue with the new package');

    // 4. Review screen for the package.
    await page.goto(`${ADMIN_URL}/review/${caseId}/${pkg.version}`);
    await visible(page.getByTestId('review-title'));
    assert.equal(await page.getByTestId('review-title').innerText(), pkg.doc.title);
    assert.match(await page.getByTestId('status-badge').first().innerText(), /In review/);
    assert.match(await page.getByTestId('open-issue-count').innerText(), /1 open issue/);
    await visible(page.getByTestId('checks-ok'));
    assert.equal(await page.locator('[data-testid^="step-card-"]').count(), pkg.doc.steps.length);
    assert.match(await page.getByTestId('step-card-s1').getByTestId('step-flags').innerText(), /need attention/);
    await visible(page.getByTestId('balance-panel'));
    log('review screen: header, checks, step cards with flags, balance panel');

    // Preview: the real dive screens, with the seeded crowd in the reveal.
    const preview = page.getByTestId('preview');
    await visible(preview.getByTestId('case-card'));
    await preview.getByTestId('dive-next').click();
    await visible(preview.getByTestId('starting-facts'));
    await preview.getByTestId('dive-next').click();
    await visible(preview.getByTestId('before-screen'));
    await preview.getByTestId('poll-commit').click();
    await preview.getByTestId('dive-next').click();
    await visible(preview.getByTestId('step-screen'));
    assert.equal(await preview.getByTestId('reveal').count(), 0, 'crowd hidden before commit');
    await preview.getByTestId('poll-commit').click();
    await visible(preview.getByTestId('reveal'));
    await visible(preview.getByTestId('seeded-note'));
    await shot(page, '02-review-preview');
    await page.getByTestId('restart-preview').click();
    await visible(preview.getByTestId('case-card'));
    log('preview plays the dive (crowd hidden until commit, seeded reveal) and restarts');

    // Audit tabs.
    await page.getByRole('tab', { name: /Research log/ }).click();
    await visible(page.getByTestId('research-log'));
    assert.match(await page.getByTestId('research-log').innerText(), /Read snapshot/);
    await page.getByRole('tab', { name: /Fact-check/ }).click();
    await visible(page.getByTestId('fact-check-table'));
    await page.getByRole('tab', { name: /Decisions/ }).click();
    assert.match(await page.getByTestId('decisions-table').innerText(), /Submitted/);
    log('audit tabs: research log with snapshots, fact-check table, decisions');

    // Snapshot text.
    await page.goto(`${ADMIN_URL}/snapshots/${pkg.snapshotId}`);
    assert.match(await page.getByTestId('snapshot-text').innerText(), /rated poor in 2023/);
    log('snapshot page shows the text the pipeline read');

    // 5. Approve and publish v1.
    await page.goto(`${ADMIN_URL}/review/${caseId}/${pkg.version}`);
    await visible(page.getByTestId('action-publish'));
    await page.getByTestId('action-publish').click();
    await visible(page.getByTestId('action-result'));
    assert.match(await page.getByTestId('action-result').innerText(), /Published v1/);
    await page.waitForFunction(() => document.querySelector('[data-testid="status-badge"]')?.textContent?.includes('Published'));
    const v1Before = await getStaffVersion(admin, caseId, 1);
    assert.equal(v1Before?.status, 'published');
    log('Approve and publish made v1 live');

    // Readers answer v1 (in the background, at reading pace).
    sessionPromise = playAtReadingPace(caseId, 1, pkg.doc);

    // 6. The live version is edited inline; published content never changes, so edits go to a new draft.
    assert.equal(await page.getByTestId('action-publish').count(), 0);
    assert.match(await page.getByTestId('edit-mode').innerText(), /saving creates a new draft/);
    assert.equal(await page.locator('#f-steps-0-headline').getAttribute('readonly'), null);
    log('the live v1 is editable inline; saving would create an admin_edit draft');

    // 7. Inline edits, validated live.
    const edited = 'Inspectors rated the bridge deck "poor" in their 2023 report.';
    await page.locator('#f-steps-0-headline').fill(edited);
    await visible(page.getByTestId('savebar'));
    const s2Sources = page.locator('#f-steps-1-source_ids');
    await s2Sources.getByRole('button', { name: 'Remove source src-minutes' }).click();
    await visible(page.getByTestId('preview-errors'));
    assert.ok(await page.getByTestId('action-edit-approve').isDisabled(), 'publishing is blocked while a step has no source');
    assert.match(await page.getByTestId('issue-list').innerText(), /steps\.1\.source_ids/);
    await s2Sources.getByLabel('Cite a source (Sources)').selectOption('src-minutes');
    await visible(page.getByTestId('checks-ok'));
    assert.ok(!(await page.getByTestId('action-edit-approve').isDisabled()));
    await visible(page.getByTestId('diff-steps-s1'));
    assert.match(await page.getByTestId('diff-summary').innerText(), /s1/);
    await shot(page, '03-draft-edit');
    log('inline edit: errors block publishing and show in the preview; the diff shows the change');

    // 8. Edit then approve: saves the draft, publishes it.
    await page.getByTestId('edit-notes').fill('Plainer headline for s1.');
    await page.getByTestId('action-edit-approve').click();
    await page.waitForURL(/\/review\/[^/]+\/2\?notice=published/, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="status-badge"]')?.textContent?.includes('Published'));
    await visible(page.getByTestId('diff-steps-s1'));
    assert.doesNotMatch(await page.locator('.preview-bar').innerText(), /edited since/, 'the preview replays the published content');
    await shot(page, '04-published-v2-full');
    log('Edit then approve published v2');

    // 9. The acceptance check, in the database.
    const [v1, v2, c] = await Promise.all([getStaffVersion(admin, caseId, 1), getStaffVersion(admin, caseId, 2), getStaffCase(admin, caseId)]);
    assert.equal(c?.live_version, 2, 'v2 is live');
    assert.equal(v2?.status, 'published');
    assert.equal(v2?.origin, 'admin');
    assert.ok(v2?.tags.includes('admin_edit'));
    assert.equal(v2?.parent_version, 1);
    assert.equal(v2?.based_on_version, 1);
    assert.equal(v2?.doc.steps[0]?.headline, edited);
    assert.equal(v1?.status, 'published', 'v1 stays published (immutable), just not live');
    assert.equal(v1?.published_at, v1Before?.published_at);
    assert.equal(v1?.doc.steps[0]?.headline, pkg.doc.steps[0]?.headline, 'v1 content unchanged');
    const tamper = await admin.from('case_versions').update({ doc: { ...v1!.doc, title: 'changed' } }).eq('case_id', caseId).eq('version', 1);
    assert.ok(tamper.error, 'a published version cannot be edited in place');
    const sessionId = await sessionPromise;
    sessionPromise = null;
    const responses = await admin.from('responses').select('case_version, step_id, excluded').eq('session_id', sessionId);
    if (responses.error) throw responses.error;
    assert.equal(responses.data.length, pkg.doc.steps.length + 2);
    assert.ok(responses.data.every((r) => r.case_version === 1), 'every response stays on v1');
    log(`acceptance: v2 is a new immutable version; v1 is unchanged; ${responses.data.length} responses stay on v1`);

    // 10. Reader signals on the published v1 show on its steps.
    await page.goto(`${ADMIN_URL}/review/${caseId}/1`);
    assert.match(await page.getByTestId('step-card-s2').getByTestId('step-flags').innerText(), /reader flags/i);
    log('reader flags on the published v1 show on its step card');

    // 11. Case overview.
    await page.goto(`${ADMIN_URL}/cases/${caseId}?v=1`);
    await visible(page.getByTestId('versions-table'));
    assert.match(await page.getByTestId('version-row-2').innerText(), /Live/);
    assert.match(await page.locator('#crowd-h').innerText(), /v1/);
    const crowdText = await page.locator('section[aria-labelledby="crowd-h"]').innerText();
    assert.match(crowdText, /\b1\s*\nreal completions/i);
    await visible(page.getByTestId('seeded-flag'));
    await page.getByTestId('seed-toggle').click();
    await page.waitForURL(/seed=0/);
    assert.equal(await page.getByTestId('seeded-flag').count(), 0);
    await page.getByTestId('cadence-form').locator('select').selectOption('daily');
    await page.getByTestId('cadence-form').getByRole('button', { name: 'Save cadence' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="cadence-form"] [data-testid="form-message"]')?.textContent?.includes('1 day'));
    assert.equal(await page.getByTestId('cadence-form').locator('select').inputValue(), 'daily');
    await page.getByTestId('update-form').getByRole('button', { name: 'Re-research now' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="update-form"] [data-testid="form-message"]')?.textContent?.includes('Queued'));
    const seedBox = page.getByTestId('seed-form').locator('textarea');
    const profile = JSON.parse(await seedBox.inputValue());
    await seedBox.fill(JSON.stringify({ ...profile, sessions: 150 }, null, 2));
    await page.getByTestId('seed-form').getByRole('button', { name: 'Save seed profile' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="seed-form"] [data-testid="form-message"]')?.textContent?.includes('seeded sessions generated'));
    assert.equal(JSON.parse(await seedBox.inputValue()).sessions, 150, 'the editor keeps the saved profile');
    await seedBox.fill('{"sessions": "lots"}');
    assert.ok(await page.getByTestId('seed-form').getByRole('button', { name: 'Save seed profile' }).isDisabled());
    await shot(page, '05-case-full');
    log('case overview: versions, crowd with seeded flag and toggle, cadence, re-research, seed profile check');

    // 12. Schedule, unschedule, request changes, then reject, on the second package.
    await page.goto(`${ADMIN_URL}/review/${second.case_id}/${second.version}`);
    await page.waitForFunction(() => (document.querySelector('[data-testid="schedule-at"]') as HTMLInputElement | null)?.value !== '');
    await page.getByTestId('action-schedule').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="action-result"]')?.textContent?.includes('goes live at'));
    await page.waitForFunction(() => document.querySelector('[data-testid="status-badge"]')?.textContent?.includes('scheduled'));
    assert.ok((await getStaffVersion(admin, second.case_id, second.version))?.scheduled_publish_at, 'publish time stored');
    await page.getByRole('button', { name: 'Unschedule' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="action-result"]')?.textContent?.includes('Schedule cancelled'));
    assert.equal((await getStaffVersion(admin, second.case_id, second.version))?.scheduled_publish_at, null);
    await page.getByTestId('change-notes').fill('Add the 2019 budget vote as a step.');
    await page.getByTestId('action-request-changes').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="action-result"]')?.textContent?.includes('Changes requested'));
    await page.waitForFunction(() => document.querySelector('[data-testid="status-badge"]')?.textContent?.includes('Changes requested'));
    await page.getByTestId('reject-reason').fill('Superseded by a better brief.');
    await page.getByTestId('action-reject').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="status-badge"]')?.textContent?.includes('Rejected'));
    log('Approve and schedule, Unschedule, Request changes (revision job queued) and Reject (reason stored)');

    // 13. New case from a brief.
    await page.goto(`${ADMIN_URL}/`);
    await page.getByTestId('new-case-form').locator('input[name="brief"]').fill(`E2E brief ${slug}`);
    await page.getByTestId('new-case-form').getByRole('button', { name: 'Start research' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="new-case-form"] [data-testid="form-message"]')?.textContent?.includes('Queued'));
    log('a one-line brief queues a new-case job');

    // 14. Sign out.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/);
    log('sign out');

    assert.deepEqual(problems, [], `browser errors:\n${problems.join('\n')}`);
    log('no browser errors');
  } finally {
    if (sessionPromise) await sessionPromise.catch(() => undefined);
    // Turn scheduled re-research off and cancel every job this run queued, so pipeline suites see a clean queue.
    await adminSetUpdateCadence(admin, caseId, null).catch(() => undefined);
    const jobs = await listPipelineJobs(admin, { statuses: ['queued'], limit: 200 });
    for (const j of jobs) {
      const mine = j.case_id === caseId || j.case_id === second.case_id || j.brief === `E2E brief ${slug}`;
      if (mine) await adminCancelJob(admin, j.id).catch(() => undefined);
    }
    await browser.close();
  }
  console.log('Admin console smoke test passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
