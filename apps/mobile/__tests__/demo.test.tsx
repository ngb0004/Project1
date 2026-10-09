import { screen, within } from '@testing-library/react-native';
import { toPublicCase } from '@sia/case-schema';
import { testIds } from '@sia/dive-ui';
import { loadDemoApi } from '@/lib/demo';
import { loadFixtures, playThrough } from './playThrough';

/**
 * Demo mode: a JSON array of { doc, seedProfile? } fetched at runtime and played
 * in memory by LocalDiveApi, with seeded crowd numbers flagged as seeded. The
 * docs are public projections: anything fetched lands on the device, so admin
 * fields must never be in the file in the first place.
 */
const fixtures = loadFixtures();
const seedProfile = (stepIds: string[]) => ({
  sessions: 120,
  before_bins: [1, 1, 2, 3, 5, 6, 7, 5, 3, 2],
  steps: Object.fromEntries(stepIds.map((id, i) => [id, i % 2 ? { agree: 1, unsure: 1, disagree: 3 } : { agree: 3, unsure: 1, disagree: 1 }])),
});

const serve = (entries: unknown) => {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => entries })) as unknown as typeof fetch;
};

beforeEach(() => {
  serve(fixtures.map((doc) => ({ doc: toPublicCase(doc), seedProfile: seedProfile(doc.steps.map((s) => s.id)) })));
});

it('plays public projections', async () => {
  const api = await loadDemoApi('https://demo.test/cases.json');
  const live = await api.listLiveCases();
  expect(live.map((c) => c.slug).sort()).toEqual(fixtures.map((d) => d.slug).sort());
  for (const doc of fixtures) {
    const loaded = await api.getCase(doc.slug);
    expect(loaded?.doc).toEqual(toPublicCase(doc));
    expect(JSON.stringify(loaded?.doc)).not.toMatch(/"(favors|impact|evidence|review|status)"/);
  }
});

it('rejects a full case document instead of stripping it on the device', async () => {
  serve([{ doc: fixtures[0] }]);
  await expect(loadDemoApi('https://demo.test/cases.json')).rejects.toThrow(
    new RegExp(`Demo case ${fixtures[0]!.slug} is not a public projection`),
  );
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
