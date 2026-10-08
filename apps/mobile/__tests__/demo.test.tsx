import { screen, within } from '@testing-library/react-native';
import { toPublicCase } from '@sia/case-schema';
import { testIds } from '@sia/dive-ui';
import { loadDemoApi } from '@/lib/demo';
import { loadFixtures, playThrough } from './playThrough';

/**
 * Demo mode: a JSON array of { doc, seedProfile? } fetched at runtime and played
 * in memory by LocalDiveApi, with seeded crowd numbers flagged as seeded.
 */
const fixtures = loadFixtures();
const seedProfile = (stepIds: string[]) => ({
  sessions: 120,
  before_bins: [1, 1, 2, 3, 5, 6, 7, 5, 3, 2],
  steps: Object.fromEntries(stepIds.map((id, i) => [id, { move_share: 0.5, mean_shift: i % 2 ? -10 : 8, spread: 5 }])),
});

beforeEach(() => {
  const entries = fixtures.map((doc) => ({ doc, seedProfile: seedProfile(doc.steps.map((s) => s.id)) }));
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => entries })) as unknown as typeof fetch;
});

it('loads full case documents but never hands admin-only fields to the UI', async () => {
  const api = await loadDemoApi('https://demo.test/cases.json');
  const live = await api.listLiveCases();
  expect(live.map((c) => c.slug).sort()).toEqual(fixtures.map((d) => d.slug).sort());
  for (const doc of fixtures) {
    const loaded = await api.getCase(doc.slug);
    expect(loaded?.doc).toEqual(toPublicCase(doc));
    expect(JSON.stringify(loaded?.doc)).not.toMatch(/"(favors|impact|evidence|review|status)"/);
  }
});

it.each(fixtures.map((d) => [d.slug, d] as const))('plays %s with seeded crowd data', async (_slug, doc) => {
  const api = await loadDemoApi('https://demo.test/cases.json');
  await playThrough(api, toPublicCase(doc));
  await screen.findByTestId(testIds.shareCard);
  expect(within(screen.getByTestId(testIds.shareCard)).getByText('Crowd includes seeded estimates.')).toBeOnTheScreen();
});

it('rejects a demo file that is not an array', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
  await expect(loadDemoApi('https://demo.test/cases.json')).rejects.toThrow(/JSON array/);
});
