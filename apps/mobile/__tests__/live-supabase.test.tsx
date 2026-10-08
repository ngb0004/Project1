import http from 'node:http';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { createClient } from '@supabase/supabase-js';
import { slotsOf } from '@sia/dive-engine';
import { SupabaseDiveApi } from '@sia/dive-engine/supabase';
import { DiveFlow, TransparencyPage, steelmanId, testIds } from '@sia/dive-ui';

/**
 * Optional end-to-end check of the UI against a running Supabase stack. Skipped
 * unless DIVE_LIVE_SLUG names a published case (ideally with a seed profile):
 *
 *   DIVE_LIVE_SLUG=<slug> DIVE_LIVE_SUPABASE_URL=http://127.0.0.1:54321 \
 *   DIVE_LIVE_ANON_KEY=<anon key> npx jest live-supabase
 *
 * Each run starts one new session (random device id), which counts against the
 * per-network session rate limit; its answers come in faster than the
 * reading-time floor, so they are excluded from crowd numbers.
 */
const slug = process.env.DIVE_LIVE_SLUG;
const url = process.env.DIVE_LIVE_SUPABASE_URL;
const anonKey = process.env.DIVE_LIVE_ANON_KEY;

/** jest-expo stubs the global fetch, so the real API calls go over node:http here. */
function nodeFetch(
  input: string | URL | { url: string },
  init: { method?: string; headers?: unknown; body?: unknown } = {},
) {
  const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
  const headers: Record<string, string> = {};
  const given = init.headers as
    | { forEach?: (fn: (v: string, k: string) => void) => void }
    | Record<string, string>
    | undefined;
  if (given && typeof given.forEach === 'function') given.forEach((v: string, k: string) => (headers[k] = v));
  else if (given) Object.assign(headers, given);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: init.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage ?? '',
          headers: { get: (name: string) => (res.headers[name.toLowerCase()] as string | undefined) ?? null },
          text: async () => body,
          json: async () => JSON.parse(body),
        });
      });
    });
    req.on('error', reject);
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  });
}

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
const nudge = (action: 'increment' | 'decrement') =>
  fireEvent(screen.getByTestId(testIds.slider), 'accessibilityAction', { nativeEvent: { actionName: action } });

(slug && url && anonKey ? describe : describe.skip)('live Supabase', () => {
  const makeApi = () =>
    new SupabaseDiveApi(
      createClient(url!, anonKey!, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: nodeFetch as typeof fetch },
      }),
    );

  it('plays the published case through the real API', async () => {
    const api = makeApi();
    const loaded = await api.getCase(slug!);
    expect(loaded).not.toBeNull();
    const doc = loaded!.doc;
    const share = jest.fn(async () => ({ status: 'shared' as const }));
    await render(
      <DiveFlow
        api={api}
        slug={slug!}
        deviceId={`device-live-${Math.random().toString(36).slice(2)}-${Date.now()}`}
        shareBaseUrl="https://dive.test"
        services={{ openUrl: jest.fn(), share }}
      />,
    );
    await screen.findByTestId(testIds.caseCard);
    if (doc.content_warning) await press(testIds.contentWarningAck);
    await press(testIds.next);
    await screen.findByTestId(testIds.startingFacts, {}, { timeout: 5000 });
    await press(testIds.next);
    await nudge('increment');
    await press(testIds.pollCommit);
    await screen.findByTestId(testIds.lockedNote, {}, { timeout: 5000 });
    await press(testIds.next);

    for (const [i, step] of doc.steps.entries()) {
      await screen.findByText(step.headline);
      expect(screen.queryByTestId(testIds.reveal)).toBeNull();
      if (i === 0) {
        await press(testIds.flagLink);
        await press('flag-reason-unfair');
        await press(testIds.flagSubmit);
        await screen.findByTestId(testIds.flagThanks, {}, { timeout: 5000 });
        await press(testIds.flagCancel);
      }
      await nudge(i % 2 ? 'increment' : 'decrement');
      await press(testIds.pollCommit);
      const reveal = await screen.findByTestId(testIds.reveal, {}, { timeout: 5000 });
      expect(within(reveal).getByTestId(testIds.mirror)).toBeOnTheScreen();
      expect(
        within(reveal).queryByTestId(testIds.crowdChart) ?? within(reveal).getByTestId(testIds.crowdEmpty),
      ).toBeOnTheScreen();
      await press(testIds.next);
    }

    await screen.findByTestId(testIds.afterScreen);
    await press(testIds.pollCommit);
    await screen.findByTestId(testIds.lockedNote, {}, { timeout: 5000 });
    await press(testIds.next);
    await screen.findByTestId(testIds.finalReveal, {}, { timeout: 5000 });
    for (const side of doc.sides) expect(screen.getByTestId(steelmanId(side.id))).toBeOnTheScreen();
    await press(`fairness-side-${doc.sides[0]!.id}`);
    await press('fairness-rating-fair');
    await press(testIds.fairnessSubmit);
    await screen.findByTestId(testIds.fairnessThanks, {}, { timeout: 5000 });
    await press(testIds.next);
    expect(await screen.findByTestId(testIds.shareCard)).toBeOnTheScreen();
    expect(screen.queryByTestId(testIds.error)).toBeNull();
    expect(slotsOf(doc)).toHaveLength(doc.steps.length + 2);
  });

  it('shows the transparency page with sources and version history', async () => {
    const api = makeApi();
    await render(<TransparencyPage api={api} slug={slug!} openUrl={jest.fn()} />);
    const history = await screen.findByTestId(testIds.versionHistory, {}, { timeout: 5000 });
    expect(within(history).getByTestId('version-1')).toBeOnTheScreen();
    expect(screen.getByTestId(testIds.sources)).toBeOnTheScreen();
  });
});
