/**
 * Web end-to-end run against the real local Supabase stack:
 *
 *   1. publishes every fixture in /cases/fixtures under a fresh slug with a seed
 *      profile (submitted as the pipeline, seeded and published as the admin);
 *   2. exports the web app pointed at the local stack and serves it with an SPA
 *      fallback;
 *   3. plays each case end to end in Chromium, checking that no crowd result
 *      reaches the screen (or the network) before its answer is committed,
 *      reloading mid-dive to check that it resumes with answers locked, and
 *      saving screenshots of the key screens;
 *   4. checks that /case/<slug> and /case/<slug>/about load directly.
 *
 *   pnpm --filter @sia/mobile e2e:web
 *
 * DIVE_E2E_SCREENSHOTS sets where screenshots go (default: a new temp dir).
 * DIVE_E2E_CHROMIUM sets a Chromium binary; otherwise Playwright finds its own
 * (PLAYWRIGHT_BROWSERS_PATH). Each run adds two published cases and two real
 * sessions to the local database.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { caseUrl, mirrorText, slotsOf } from '@sia/dive-engine';
import { steelmanId, testIds, versionRowId } from '@sia/dive-ui/testIds';
import { ANON_KEY, API_URL, loadFixtures, publishFixtures, serviceClient, type PublishedFixture } from './seed.mjs';
import { serveStatic } from './serve.mjs';

const APP_DIR = join(import.meta.dirname, '..');
const REPO_ROOT = join(APP_DIR, '../..');
const PHONE = { width: 390, height: 844 };
const TIMEOUT = 15_000;

/** Generic reveal copy that must never be on screen before a commit. */
const CROWD_TEXT = /Everyone who reached this fact|(readers|crowd) moved|held steady|moved everyone most/;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: APP_DIR, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

/**
 * Exports the web app with the local stack baked in. --clear matters: Metro
 * otherwise reuses transforms with older EXPO_PUBLIC_* values inlined.
 */
async function buildWeb(outDir: string) {
  await run('npx', ['expo', 'export', '--platform', 'web', '--output-dir', outDir, '--clear'], {
    ...process.env,
    CI: '1',
    EXPO_PUBLIC_SUPABASE_URL: API_URL,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
    EXPO_PUBLIC_DEMO_CASES_URL: '',
    EXPO_PUBLIC_SHARE_BASE_URL: '',
  });
  const jsDir = join(outDir, '_expo/static/js/web');
  const bundles = await Promise.all((await readdir(jsDir)).map((f) => readFile(join(jsDir, f), 'utf8')));
  assert.ok(
    bundles.some((js) => js.includes(API_URL)),
    `the web bundle does not point at ${API_URL}`,
  );
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

const visible = (l: Locator) => l.first().waitFor({ state: 'visible', timeout: TIMEOUT });

async function sliderValue(page: Page): Promise<number> {
  return Number(await page.getByTestId(testIds.sliderValue).innerText());
}

/** Nothing about the crowd, or the reader's own move, is on screen. */
async function assertNoCrowd(page: Page, where: string) {
  for (const id of [
    testIds.reveal,
    testIds.crowdChart,
    testIds.crowdSummary,
    testIds.mirror,
    testIds.finalReveal,
    testIds.finalChart,
  ]) {
    assert.equal(await page.getByTestId(id).count(), 0, `${where}: "${id}" is on screen before commit`);
  }
  assert.equal(await page.getByText(CROWD_TEXT).count(), 0, `${where}: crowd text is on screen before commit`);
}

/** Drags the slider thumb to a fraction of the track with the mouse, and checks where it landed. */
async function drag(page: Page, to: number) {
  const slider = page.getByTestId(testIds.slider);
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  assert.ok(box, 'slider has no box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to, y, { steps: 8 });
  await page.mouse.up();
  const value = await sliderValue(page);
  assert.ok(Math.abs(value - to * 100) <= 3, `dragged to ${to * 100} but the slider reads ${value}`);
}

/** Taps (clicks without moving) the slider track at a fraction of its width, and checks the value lands there. */
async function tap(page: Page, at: number) {
  const slider = page.getByTestId(testIds.slider);
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  assert.ok(box, 'slider has no box');
  await page.mouse.click(box.x + box.width * at, box.y + box.height / 2);
  const value = await sliderValue(page);
  assert.ok(Math.abs(value - at * 100) <= 4, `tapped at ${at * 100} but the slider reads ${value}`);
}

async function keys(page: Page, key: string, times: number) {
  await page.getByTestId(testIds.slider).focus();
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
}

/**
 * Screenshots the whole reading column: the page scrolls inside a ScrollView,
 * so the viewport is stretched to the content's height first.
 */
async function shot(page: Page, path: string, settleMs = 0, width = PHONE.width) {
  if (settleMs) await page.waitForTimeout(settleMs);
  const height = await page.evaluate(() => {
    let h = document.documentElement.scrollHeight;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        h = Math.max(h, el.getBoundingClientRect().top + el.scrollHeight);
      }
    }
    return Math.ceil(h);
  });
  await page.setViewportSize({ width, height: Math.min(Math.max(height, PHONE.height), 5000) });
  await page.waitForTimeout(150);
  await page.screenshot({ path });
  await page.setViewportSize(PHONE);
}

/** Page errors and console errors, which fail the run. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

interface RpcCall {
  name: string;
  slot: string | null;
}

/** Every dive RPC the page sends, in order (recorded synchronously at request time). */
function watchRpc(page: Page): RpcCall[] {
  const calls: RpcCall[] = [];
  page.on('request', (req) => {
    const m = /\/rest\/v1\/rpc\/(\w+)/.exec(req.url());
    if (!m || req.method() !== 'POST') return;
    const body = (req.postDataJSON() ?? {}) as { p_step_id?: string };
    calls.push({ name: m[1]!, slot: body.p_step_id ?? null });
  });
  return calls;
}

const isRpc = (name: string) => (r: { url(): string; request(): { method(): string } }) =>
  r.url().endsWith(`/rest/v1/rpc/${name}`) && r.request().method() === 'POST';

// ---------------------------------------------------------------------------
// One dive, end to end
// ---------------------------------------------------------------------------

interface PlayResult {
  sessionId: string;
  answers: { step_id: string; value: number }[];
  screenshots: string[];
}

async function playCase(browser: Browser, base: string, f: PublishedFixture, shotsDir: string): Promise<PlayResult> {
  const { doc } = f;
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = watchErrors(page);
  const rpc = watchRpc(page);
  // Mid-dive the page asks before unloading (see useLeaveGuard); the reload below accepts.
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.type());
    void d.accept();
  });
  const id = (t: string) => page.getByTestId(t);
  const screenshots: string[] = [];
  const capture = async (name: string, settleMs = 0, width = PHONE.width) => {
    const path = join(shotsDir, `${doc.slug}-${name}.png`);
    await shot(page, path, settleMs, width);
    screenshots.push(path);
  };
  const answers: { step_id: string; value: number }[] = [];

  try {
    // Case card, opened by its deep link.
    await page.goto(`${base}/case/${f.slug}`);
    await visible(id(testIds.caseCard));
    await visible(page.getByText(doc.title, { exact: true }));
    await visible(page.getByText(doc.question.prompt, { exact: true }));
    await assertNoCrowd(page, 'case card');
    if (doc.content_warning) {
      await visible(page.getByText(doc.content_warning, { exact: true }));
      assert.equal(await id(testIds.next).getAttribute('aria-disabled'), 'true', 'Begin is enabled before the warning');
      assert.equal(await id(testIds.contentWarningAck).getAttribute('aria-checked'), 'false');
      await id(testIds.contentWarningAck).click();
      assert.equal(await id(testIds.contentWarningAck).getAttribute('aria-checked'), 'true');
    } else {
      assert.equal(await id(testIds.contentWarning).count(), 0);
    }
    await capture('01-case-card');

    const [started] = await Promise.all([page.waitForResponse(isRpc('start_session')), id(testIds.next).click()]);
    const session = (await started.json()) as { session_id: string; resumed: boolean };
    assert.equal(session.resumed, false, 'a fresh browser should start a new session');

    // Starting facts.
    await visible(id(testIds.startingFacts));
    for (const fact of doc.starting_facts) await visible(page.getByText(fact.text, { exact: true }));
    await assertNoCrowd(page, 'starting facts');
    await id(testIds.next).click();

    // Before: locked once committed.
    await visible(id(testIds.beforeScreen));
    await assertNoCrowd(page, 'before');
    await keys(page, 'Home', 1);
    await keys(page, 'PageUp', 7);
    const before = await sliderValue(page);
    assert.equal(before, 70);
    await id(testIds.pollCommit).click();
    await visible(id(testIds.lockedNote));
    assert.equal(await id(testIds.pollCommit).count(), 0);
    assert.equal(await id(testIds.slider).getAttribute('aria-disabled'), 'true');
    assert.match((await id(testIds.slider).getAttribute('aria-valuetext')) ?? '', /locked$/);
    assert.ok(
      await page.evaluate(() => document.activeElement?.textContent?.startsWith('Locked at') ?? false),
      'focus did not move to the locked note',
    );
    await keys(page, 'ArrowLeft', 3);
    assert.equal(await sliderValue(page), before, 'the Before answer changed after commit');
    answers.push({ step_id: 'before', value: before });
    await id(testIds.next).click();

    let previous = before;
    for (const [i, step] of doc.steps.entries()) {
      const where = `step ${i + 1} (${step.id})`;
      await visible(id(testIds.stepScreen));
      await visible(page.getByText(step.headline, { exact: true }));
      await visible(page.getByText(`Fact ${i + 1} of ${doc.steps.length}`, { exact: true }));
      assert.equal(await sliderValue(page), previous, `${where}: slider not pre-filled with the last answer`);

      if (i === 0) {
        // Back to Before: still locked at the committed value.
        await id(testIds.back).click();
        await visible(id(testIds.beforeScreen));
        assert.equal(await sliderValue(page), before);
        assert.equal(await id(testIds.pollCommit).count(), 0);
        await keys(page, 'ArrowRight', 2);
        assert.equal(await sliderValue(page), before, 'the Before answer changed on the way back');
        await id(testIds.next).click();
        await visible(page.getByText(step.headline, { exact: true }));
      }

      if (step.depth.length > 0) {
        assert.equal(await id(testIds.goDeeper).getAttribute('aria-expanded'), 'false');
        await id(testIds.goDeeper).click();
        assert.equal(await id(testIds.goDeeper).getAttribute('aria-expanded'), 'true');
      }
      await assertNoCrowd(page, where);
      if (i === 0) await capture('02-step-before-commit');

      if (i === 0) await tap(page, 0.25);
      if (i % 2 === 0) await drag(page, i % 4 === 0 ? 0.62 : 0.4);
      else await keys(page, 'ArrowLeft', 6);
      const value = await sliderValue(page);
      await assertNoCrowd(page, where);
      assert.ok(
        !rpc.some((c) => c.slot === step.id),
        `${where}: the crowd for this step was requested before commit`,
      );

      const [submitted] = await Promise.all([
        page.waitForResponse(isRpc('submit_response')),
        id(testIds.pollCommit).click(),
      ]);
      const reveal = (await submitted.json()) as { step_id: string; value: number; crowd: { n_seed: number } };
      assert.equal(reveal.step_id, step.id);
      assert.equal(reveal.value, value);
      assert.ok(reveal.crowd.n_seed > 0, `${where}: the crowd has no seeded rows`);

      const shown = id(testIds.reveal);
      await visible(shown);
      await visible(shown.getByTestId(testIds.crowdChart));
      await visible(shown.getByTestId(testIds.seededNote));
      assert.equal(await shown.getByTestId(testIds.mirror).innerText(), mirrorText(previous, value));
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent ?? ''),
        mirrorText(previous, value),
        `${where}: focus did not move to the reveal`,
      );
      if (i === 0) await capture('03-step-after-commit', 1200);

      answers.push({ step_id: step.id, value });
      previous = value;

      if (i === 0 && doc.steps.length > 1) {
        // Reload mid-dive: the page asks first, then the dive resumes at the next
        // fact on the same session, with nothing about that fact's crowd shown.
        await page.reload();
        assert.ok(dialogs.includes('beforeunload'), 'reloading mid-dive did not ask first');
        await visible(id(testIds.caseCard));
        await assertNoCrowd(page, 'case card after reload');
        if (doc.content_warning) await id(testIds.contentWarningAck).click();
        const [again] = await Promise.all([page.waitForResponse(isRpc('start_session')), id(testIds.next).click()]);
        const resumed = (await again.json()) as { session_id: string; resumed: boolean; answers: unknown[] };
        assert.equal(resumed.resumed, true, 'the reload did not resume the session');
        assert.equal(resumed.session_id, session.session_id);
        assert.deepEqual(resumed.answers, answers);
        await visible(id(testIds.notice));
        await visible(page.getByText(`Fact 2 of ${doc.steps.length}`, { exact: true }));
        continue;
      }
      await id(testIds.next).click();
    }

    // After.
    await visible(id(testIds.afterScreen));
    assert.equal(await sliderValue(page), previous);
    await assertNoCrowd(page, 'after');
    await keys(page, 'ArrowLeft', 5);
    const after = await sliderValue(page);
    await id(testIds.pollCommit).click();
    await visible(id(testIds.lockedNote));
    answers.push({ step_id: 'after', value: after });
    await id(testIds.next).click();

    // Final reveal.
    const final = id(testIds.finalReveal);
    await visible(final);
    await visible(final.getByTestId(testIds.finalChart));
    await visible(final.getByTestId(testIds.seededNote));
    assert.equal(await final.getByTestId(testIds.mirror).innerText(), mirrorText(before, after));
    const headlines = doc.steps.map((s) => s.headline);
    for (const top of [testIds.topStepYou, testIds.topStepCrowd]) {
      const text = await id(top).innerText();
      assert.ok(
        headlines.some((h) => text.includes(h)),
        `${top} names no step: ${JSON.stringify(text)}`,
      );
    }
    for (const q of doc.open_questions) await visible(page.getByText(q, { exact: true }));
    for (const side of doc.sides) await visible(id(steelmanId(side.id)));
    await capture('04-final-reveal', 1500);
    await id(testIds.next).click();

    // Share card.
    const card = id(testIds.shareCard);
    await visible(card);
    const cardText = await card.innerText();
    for (const part of [`I started at ${before}.`, `I ended at ${after}.`, caseUrl(base, f.slug), doc.title]) {
      assert.ok(cardText.includes(part), `share card is missing ${JSON.stringify(part)}`);
    }
    await capture('05-share-screen', 300);
    // On a 320px phone the card scales down to fit the column instead of overflowing it.
    await page.setViewportSize({ width: 320, height: PHONE.height });
    await page.waitForTimeout(150);
    const narrow = await card.boundingBox();
    assert.ok(narrow && narrow.x >= 0 && narrow.x + narrow.width <= 320, `share card overflows 320px: ${JSON.stringify(narrow)}`);
    assert.ok(Math.abs(narrow.height / narrow.width - 425 / 340) < 0.02, 'share card lost its proportions');
    await capture('05b-share-screen-320', 300, 320);
    const cardPath = join(shotsDir, `${doc.slug}-06-share-card.png`);
    await card.screenshot({ path: cardPath });
    screenshots.push(cardPath);

    // Sharing: headless Chromium on Linux has no Web Share, so the app copies the
    // link and offers the captured card as a PNG download.
    await id(testIds.shareButton).click();
    await visible(id(testIds.shareStatus));
    if ((await id(testIds.shareDownload).count()) > 0) {
      const [download] = await Promise.all([page.waitForEvent('download'), id(testIds.shareDownload).click()]);
      const pngPath = join(shotsDir, `${doc.slug}-07-share-card-download.png`);
      await download.saveAs(pngPath);
      const png = await readFile(pngPath);
      assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'not a PNG');
      assert.ok(png.length > 5_000, 'share card PNG is suspiciously small');
      screenshots.push(pngPath);
    }

    // The network told the same story: one session (started, then resumed after
    // the reload), one submit per slot, in order, and never a reveal fetched for
    // a slot that had not been answered.
    assert.deepEqual(
      rpc.filter((c) => c.name === 'submit_response').map((c) => c.slot),
      slotsOf(doc),
    );
    assert.equal(rpc.filter((c) => c.name === 'get_reveal').length, 0);
    assert.equal(rpc.filter((c) => c.name === 'start_session').length, doc.steps.length > 1 ? 2 : 1);
    assert.deepEqual(errors, [], 'the page logged errors');
    return { sessionId: session.session_id, answers, screenshots };
  } catch (e) {
    await page.screenshot({ path: join(shotsDir, `${doc.slug}-FAILED.png`) }).catch(() => undefined);
    if (errors.length) console.error(errors.join('\n'));
    throw e;
  } finally {
    await context.close();
  }
}

/** Deep links load directly in a fresh browser; the transparency page lists sources and versions. */
async function checkDeepLinks(browser: Browser, base: string, f: PublishedFixture, shotsDir: string) {
  const { doc } = f;
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = watchErrors(page);
  const id = (t: string) => page.getByTestId(t);
  try {
    await page.goto(`${base}/case/${f.slug}`);
    await visible(id(testIds.caseCard));
    await visible(page.getByText(doc.title, { exact: true }));
    await assertNoCrowd(page, 'deep link');

    await page.goto(`${base}/case/${f.slug}/about`);
    await visible(id(testIds.transparency));
    const history = id(testIds.versionHistory);
    await visible(history);
    await visible(history.getByTestId(versionRowId(f.version)));
    for (const s of doc.sources) await visible(page.getByText(s.title, { exact: true }));
    const path = join(shotsDir, `${doc.slug}-08-about.png`);
    await shot(page, path);

    await page.goto(`${base}/case/${f.slug}-missing`);
    await visible(id(testIds.notFound));
    assert.deepEqual(errors, [], 'the page logged errors');
    return path;
  } finally {
    await context.close();
  }
}

/** The answers on screen are the ones stored for the session, in order. */
async function checkStored(result: PlayResult) {
  const { data, error } = await serviceClient()
    .from('responses')
    .select('step_id, value')
    .eq('session_id', result.sessionId)
    .order('step_index');
  if (error) throw error;
  assert.deepEqual(data, result.answers);
}

// ---------------------------------------------------------------------------

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'dive-e2e-'));
  const shotsDir = process.env.DIVE_E2E_SCREENSHOTS ?? join(work, 'screenshots');
  await mkdir(shotsDir, { recursive: true });

  const fixtures = loadFixtures(REPO_ROOT);
  assert.ok(fixtures.length >= 2, 'expected at least two fixture cases');
  const published = await publishFixtures(fixtures);
  for (const f of published) console.log(`published ${f.doc.slug} as /case/${f.slug} (v${f.version})`);

  const distDir = join(work, 'web');
  await buildWeb(distDir);
  const server = await serveStatic(distDir);
  const browser = await chromium.launch({ executablePath: process.env.DIVE_E2E_CHROMIUM || undefined });
  const summary: Record<string, unknown>[] = [];
  try {
    const home = await browser.newPage({ viewport: PHONE });
    await home.goto(`${server.url}/`);
    await visible(home.getByTestId('home'));
    await home.close();

    for (const f of published) {
      const result = await playCase(browser, server.url, f, shotsDir);
      await checkStored(result);
      const about = await checkDeepLinks(browser, server.url, f, shotsDir);
      summary.push({
        fixture: f.doc.slug,
        slug: f.slug,
        steps: f.doc.steps.length,
        answers: result.answers.map((a) => a.value),
        screenshots: [...result.screenshots, about],
      });
      console.log(`played ${f.doc.slug}: ${f.doc.steps.length} steps, answers ${result.answers.map((a) => a.value).join(' → ')}`);
    }
    assert.ok(new Set(published.map((f) => f.doc.steps.length)).size > 1, 'the cases should differ in step count');
  } finally {
    await browser.close();
    await server.close();
    // Keep the temp dir only when the screenshots live in it.
    await rm(process.env.DIVE_E2E_SCREENSHOTS ? work : distDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ok: true, screenshots: shotsDir, cases: summary }, null, 2));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
