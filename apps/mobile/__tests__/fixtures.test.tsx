import { within } from '@testing-library/react-native';
import { toPublicCase } from '@sia/case-schema';
import { shareHeadline, slotsOf } from '@sia/dive-engine';
import { createFakeApi } from './fakeApi';
import { loadFixtures, playThrough } from './playThrough';

/**
 * Phase 2 acceptance: two different case files play through the same code.
 * The fixtures differ in step count, side count, content warning, poll wording
 * and depth-layer kinds; nothing below knows which one it is playing.
 */
const fixtures = loadFixtures().map(toPublicCase);

it('has two different fixture cases to play', () => {
  expect(fixtures.length).toBeGreaterThanOrEqual(2);
  expect(new Set(fixtures.map((d) => d.steps.length)).size).toBeGreaterThan(1);
  expect(new Set(fixtures.map((d) => d.sides.length)).size).toBeGreaterThan(1);
});

describe.each(fixtures.map((d) => [d.slug, d] as const))('%s', (_slug, doc) => {
  it('plays the full flow from the case record alone', async () => {
    const api = createFakeApi([doc]);
    const { card } = await playThrough(api, doc);

    const submits = api.calls.filter((c) => c.method === 'submit');
    const before = submits[0]!.args[2] as number;
    const after = submits[submits.length - 1]!.args[2] as number;
    expect(within(card).getByText(shareHeadline(before, after).replace('. ', '.\n'))).toBeOnTheScreen();
    expect(submits.map((c) => c.args[1])).toEqual(slotsOf(doc));
    expect(api.calls.some((c) => c.method === 'getReveal')).toBe(false);
  });
});
