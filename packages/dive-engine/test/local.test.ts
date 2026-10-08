import { describe, expect, it } from 'vitest';
import { generateSeedSessions, type PublicCase, type SeedProfileInput } from '@sia/case-schema';
import { LocalDiveApi, computeFinalCrowd, computeStepCrowd, type CrowdRow } from '../src/local';
import { DiveApiError, isFinalReveal, isStepReveal, type DiveErrorCode, type Reveal } from '../src/types';
import { clock, deviceId, loadFixture } from './helpers';

const harbor = loadFixture('fixture-harbor-bridge');
const orchard = loadFixture('fixture-orchard-school');
const slotsOf = (doc: PublicCase) => ['before', ...doc.steps.map((s) => s.id), 'after'];

async function rejects(p: Promise<unknown>, code: DiveErrorCode, message?: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DiveApiError);
  expect((err as DiveApiError).code).toBe(code);
  if (message) expect((err as DiveApiError).message).toMatch(message);
}

/** Plays a whole dive for a new device and returns the session id and the last reveal. */
async function play(api: LocalDiveApi, doc: PublicCase, values: number[], device = deviceId()) {
  const s = await api.startSession(doc.id, doc.version, device);
  let last: Reveal | undefined;
  for (const [i, slot] of slotsOf(doc).entries()) last = await api.submit(s.session_id, slot, values[i]!);
  return { sessionId: s.session_id, last: last! };
}

// ---------------------------------------------------------------------------
// Crowd math (hand-computed; supabase/tests/parity.test.ts checks it against SQL)
// ---------------------------------------------------------------------------

describe('computeStepCrowd / computeFinalCrowd', () => {
  // slots: before, a, b, after
  const rows: CrowdRow[] = [
    { session_id: 'r1', is_seed: false, excluded: false, values: [80, 60, 60, 55] }, // a -20, b 0
    { session_id: 'r2', is_seed: false, excluded: false, values: [50, 55, 70, 70] }, // a +5,  b +15
    { session_id: 'r3', is_seed: false, excluded: false, values: [100, 100, 90] }, // unfinished: a 0, b -10
    { session_id: 'r4', is_seed: false, excluded: true, values: [0, 100, 100, 100] }, // excluded: counts nowhere
    { session_id: 's1', is_seed: true, excluded: false, values: [20, 5, 5, 5] }, // a -15, b 0
    { session_id: 's2', is_seed: true, excluded: false, values: [40, 41] }, // unfinished: a +1
  ];

  it('pairs each answer with the previous slot and weighs seeds by the seed weight', () => {
    // a: weights 1, 1, 1, 0.5, 0.5 -> total 4
    expect(computeStepCrowd(rows, 'a', 1, 0.5)).toEqual({
      step_id: 'a',
      n_real: 3,
      n_seed: 2,
      seed_weight: 0.5,
      seeded_share: 0.25,
      histogram: [0.125, 0, 0, 0, 0.125, 0.25, 0.25, 0, 0, 0.25],
      previous_histogram: [0, 0, 0.125, 0, 0.125, 0.25, 0, 0, 0.25, 0.25],
      mean_value: 59.5,
      mean_previous: 65,
      mean_delta: -5.5,
      moved_share: 0.75,
      shift: { left_big: 0.375, left: 0, none: 0.25, right: 0.375, right_big: 0 },
    });
  });

  it('rounds shares to 4 places and means to 2', () => {
    // b: weights 1, 1, 1, 0.5 -> total 3.5
    expect(computeStepCrowd(rows, 'b', 2, 0.5)).toMatchObject({
      n_real: 3,
      n_seed: 1,
      seeded_share: 0.1429,
      mean_value: 63.57,
      mean_previous: 62.14,
      mean_delta: 1.43,
      moved_share: 0.5714,
      shift: { left_big: 0, left: 0.2857, none: 0.4286, right: 0, right_big: 0.2857 },
      histogram: [0.1429, 0, 0, 0, 0, 0, 0.2857, 0.2857, 0, 0.2857],
    });
  });

  it('puts 100 in the last bin and splits shifts at 15 points', () => {
    const edge: CrowdRow[] = [
      [0, 15],
      [100, 86],
      [50, 50],
      [10, 9],
      [99, 100],
    ].map((values, i) => ({ session_id: `e${i}`, is_seed: false, excluded: false, values }));
    expect(computeStepCrowd(edge, 'x', 1, 1)).toMatchObject({
      histogram: [0.2, 0.2, 0, 0, 0, 0.2, 0, 0, 0.2, 0.2],
      shift: { left_big: 0, left: 0.4, none: 0.2, right: 0.2, right_big: 0.2 },
    });
  });

  it('returns nulls, not zeros, when nobody (or only weightless seeds) reached the step', () => {
    const empty = {
      n_real: 0,
      histogram: null,
      previous_histogram: null,
      mean_value: null,
      mean_previous: null,
      mean_delta: null,
      moved_share: null,
      shift: null,
      seeded_share: 0,
    };
    expect(computeStepCrowd([], 'a', 1, 1)).toEqual({ step_id: 'a', n_seed: 0, seed_weight: 1, ...empty });
    const seedsOnly = rows.filter((r) => r.is_seed);
    // Weightless seeds (faded or left out) are not counted at all.
    expect(computeStepCrowd(seedsOnly, 'a', 1, 0)).toEqual({ step_id: 'a', n_seed: 0, seed_weight: 0, ...empty });
  });

  it('final crowd: completed sessions only, before/after distributions, and the step that moved it most', () => {
    // done: r1, r2, s1 (weights 1, 1, 0.5 -> total 2.5)
    expect(computeFinalCrowd(rows, ['a', 'b'], 0.5)).toEqual({
      n_real: 2,
      n_seed: 1,
      seed_weight: 0.5,
      seeded_share: 0.2,
      before_histogram: [0, 0, 0.2, 0, 0, 0.4, 0, 0, 0.4, 0],
      after_histogram: [0.2, 0, 0, 0, 0, 0.4, 0, 0.4, 0, 0],
      mean_before: 56,
      mean_after: 51,
      steps: [
        { step_id: 'a', mean_delta: -9, mean_abs_delta: 13, moved_share: 1 },
        { step_id: 'b', mean_delta: 6, mean_abs_delta: 6, moved_share: 0.4 },
      ],
      top_step_id: 'a',
    });
  });

  it('final crowd: ties go to the earlier step; with no completions there is no crowd to show', () => {
    const tie: CrowdRow[] = [{ session_id: 't', is_seed: false, excluded: false, values: [50, 50, 40, 40, 50, 50] }];
    expect(computeFinalCrowd(tie, ['a', 'b', 'c', 'd'], 1).top_step_id).toBe('b');
    expect(computeFinalCrowd([], ['a', 'b'], 1)).toEqual({
      n_real: 0,
      n_seed: 0,
      seed_weight: 1,
      seeded_share: 0,
      before_histogram: null,
      after_histogram: null,
      mean_before: null,
      mean_after: null,
      steps: [
        { step_id: 'a', mean_delta: null, mean_abs_delta: null, moved_share: 0 },
        { step_id: 'b', mean_delta: null, mean_abs_delta: null, moved_share: 0 },
      ],
      top_step_id: null,
    });
  });
});

// ---------------------------------------------------------------------------
// LocalDiveApi
// ---------------------------------------------------------------------------

describe('cases', () => {
  const api = new LocalDiveApi({
    cases: [
      { doc: harbor, publishedAt: '2026-10-01T00:00:00.000Z' },
      { doc: orchard, publishedAt: '2026-10-05T00:00:00.000Z' },
    ],
  });

  it('lists live cases, newest first, with fields from the record', async () => {
    expect(await api.listLiveCases()).toEqual([
      {
        case_id: orchard.id,
        slug: orchard.slug,
        version: orchard.version,
        title: orchard.title,
        as_of: orchard.as_of,
        published_at: '2026-10-05T00:00:00.000Z',
        content_warning: orchard.content_warning,
        step_count: 6,
      },
      {
        case_id: harbor.id,
        slug: harbor.slug,
        version: harbor.version,
        title: harbor.title,
        as_of: harbor.as_of,
        published_at: '2026-10-01T00:00:00.000Z',
        content_warning: null,
        step_count: 4,
      },
    ]);
  });

  it('serves a case by slug, and null for anything not published', async () => {
    const c = await api.getCase(harbor.slug);
    expect(c).toMatchObject({ case_id: harbor.id, slug: harbor.slug, version: harbor.version, is_live: true });
    expect(c!.doc).toEqual(harbor);
    expect(await api.getCase(harbor.slug, harbor.version + 1)).toBeNull();
    expect(await api.getCase('no-such-case')).toBeNull();
  });

  it('hands out copies, so callers cannot change the record', async () => {
    const c = await api.getCase(harbor.slug);
    c!.doc.title = 'changed';
    expect((await api.getCase(harbor.slug))!.doc.title).toBe(harbor.title);
  });

  it('never serves admin-only fields, even if they were passed in', async () => {
    const leaky = JSON.parse(JSON.stringify(harbor));
    leaky.status = 'published';
    leaky.review = { decisions: [] };
    leaky.steps[0].favors = 'council-responsible';
    leaky.steps[0].impact = 'high';
    leaky.steps[0].evidence = [{ source_id: 'x', quote: 'q' }];
    leaky.starting_facts[0].evidence = [{ source_id: 'x', quote: 'q' }];
    const c = await new LocalDiveApi({ cases: [{ doc: leaky }] }).getCase(harbor.slug);
    expect(c!.doc).toEqual(harbor);
  });

  it('rejects ambiguous input', () => {
    expect(() => new LocalDiveApi({ cases: [{ doc: harbor }, { doc: harbor }] })).toThrow(DiveApiError);
    expect(() => new LocalDiveApi({ cases: [{ doc: harbor }, { doc: orchard, caseId: harbor.id, version: 9 }] })).toThrow(/two slugs/);
  });
});

describe('versions', () => {
  const v2doc: PublicCase = { ...harbor, version: 2, parent_version: 1, title: `${harbor.title} (v2)` };
  const make = () =>
    new LocalDiveApi({
      cases: [
        { doc: harbor, publishedAt: '2026-10-01T00:00:00.000Z' },
        { doc: v2doc, publishedAt: '2026-10-12T00:00:00.000Z' },
      ],
    });

  it('serves the latest published version as live and keeps the earlier one playable', async () => {
    const api = make();
    expect((await api.getCase(harbor.slug))!).toMatchObject({ version: 2, is_live: true });
    expect((await api.getCase(harbor.slug, 1))!).toMatchObject({ version: 1, is_live: false });
    expect(await api.listLiveCases()).toHaveLength(1);
  });

  it('keeps responses per version and notes how many people saw the earlier one', async () => {
    const api = make();
    await play(api, harbor, [50, 50, 50, 50, 50, 50]);
    await play(api, harbor, [60, 60, 60, 60, 60, 60]);
    const { last } = await play(api, v2doc, [70, 70, 70, 70, 70, 70]);
    if (!isFinalReveal(last)) throw new Error('expected the final reveal');
    expect(last.crowd.n_real).toBe(1);
    expect(last.version_note).toEqual({
      version: 2,
      published_at: '2026-10-12T00:00:00.000Z',
      parent_version: 1,
      earlier_versions: [{ version: 1, published_at: '2026-10-01T00:00:00.000Z', completions: 2 }],
    });
    expect(await api.getHistory(harbor.slug)).toEqual({
      case_id: harbor.id,
      slug: harbor.slug,
      live_version: 2,
      versions: [
        { version: 2, title: v2doc.title, as_of: harbor.as_of, status: 'published', published_at: '2026-10-12T00:00:00.000Z', parent_version: 1, completions: 1 },
        { version: 1, title: harbor.title, as_of: harbor.as_of, status: 'published', published_at: '2026-10-01T00:00:00.000Z', parent_version: null, completions: 2 },
      ],
    });
    expect(await api.getHistory('no-such-case')).toBeNull();
  });
});

describe('sessions', () => {
  it('gives one session per device per version and resumes it with the locked answers', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: harbor }] });
    const dev = deviceId();
    const a = await api.startSession(harbor.id, harbor.version, dev);
    expect(a).toMatchObject({ case_id: harbor.id, case_version: harbor.version, resumed: false, completed: false, answers: [] });
    await api.submit(a.session_id, 'before', 90);
    await api.submit(a.session_id, harbor.steps[0]!.id, 80);
    const b = await api.startSession(harbor.id, harbor.version, dev);
    expect(b).toMatchObject({ session_id: a.session_id, resumed: true, completed: false });
    expect(b.answers).toEqual([
      { step_id: 'before', value: 90 },
      { step_id: harbor.steps[0]!.id, value: 80 },
    ]);
    const other = await api.startSession(harbor.id, harbor.version, deviceId());
    expect(other.session_id).not.toBe(a.session_id);
  });

  it('reports a finished session as completed', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: harbor }] });
    const dev = deviceId();
    await play(api, harbor, [1, 2, 3, 4, 5, 6], dev);
    expect(await api.startSession(harbor.id, harbor.version, dev)).toMatchObject({ resumed: true, completed: true });
  });

  it('rejects bad device ids and unpublished versions', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: harbor }] });
    await rejects(api.startSession(harbor.id, harbor.version, 'short'), 'invalid', /device id/);
    await rejects(api.startSession(harbor.id, harbor.version, 'x'.repeat(201)), 'invalid');
    await rejects(api.startSession(harbor.id, 99, deviceId()), 'not_found', /not published/);
    await rejects(api.startSession('nope', 1, deviceId()), 'not_found');
  });
});

describe('answers', () => {
  const api = new LocalDiveApi({ cases: [{ doc: harbor }] });
  const [s1, s2] = harbor.steps.map((s) => s.id);

  it('locks every committed answer: a repeat submit returns the stored value unchanged', async () => {
    const { session_id } = await api.startSession(harbor.id, harbor.version, deviceId());
    expect(await api.submit(session_id, 'before', 90)).toEqual({ step_id: 'before', value: 90, locked: false });
    expect(await api.submit(session_id, 'before', 10)).toEqual({ step_id: 'before', value: 90, locked: true });
    // even a value that would be invalid gets the locked answer back
    expect(await api.submit(session_id, 'before', 500)).toMatchObject({ value: 90, locked: true });
    const first = await api.submit(session_id, s1!, 70);
    const again = await api.submit(session_id, s1!, 20);
    expect(again).toMatchObject({ step_id: s1, value: 70, previous_value: 90, locked: true });
    expect(isStepReveal(first) && first.locked).toBe(false);
  });

  it('enforces the fixed order of the dive', async () => {
    const { session_id } = await api.startSession(harbor.id, harbor.version, deviceId());
    await rejects(api.submit(session_id, s1!, 50), 'out_of_order', /expected slot 0, got 1/);
    await rejects(api.submit(session_id, 'after', 50), 'out_of_order');
    await api.submit(session_id, 'before', 50);
    await rejects(api.submit(session_id, s2!, 50), 'out_of_order', /expected slot 1, got 2/);
    await rejects(api.submit(session_id, 'nope', 50), 'not_found', /unknown step nope/);
  });

  it('accepts whole numbers from 0 to 100 only', async () => {
    const { session_id } = await api.startSession(harbor.id, harbor.version, deviceId());
    for (const bad of [-1, 101, 50.5, Number.NaN]) {
      await rejects(api.submit(session_id, 'before', bad), 'invalid', /between 0 and 100/);
    }
    expect(await api.submit(session_id, 'before', 0)).toMatchObject({ value: 0 });
    expect(await api.submit(session_id, s1!, 100)).toMatchObject({ value: 100 });
  });

  it('refuses unknown sessions', async () => {
    await rejects(api.submit('nope', 'before', 1), 'not_found', /unknown session/);
    await rejects(api.getReveal('nope', 'before'), 'not_found');
    await rejects(api.flagFact('nope', s1!, 'unfair'), 'not_found');
    await rejects(api.rateFairness('nope', harbor.sides[0]!.id, 'fair'), 'not_found');
  });
});

describe('reveals', () => {
  it('only exist for committed slots: getReveal refuses anything unanswered', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: harbor }] });
    await play(api, harbor, [80, 70, 70, 60, 60, 55]);
    const { session_id } = await api.startSession(harbor.id, harbor.version, deviceId());
    const s1 = harbor.steps[0]!.id;
    await rejects(api.getReveal(session_id, 'before'), 'forbidden', /commit an answer/);
    await api.submit(session_id, 'before', 50);
    await rejects(api.getReveal(session_id, s1), 'forbidden');
    await rejects(api.getReveal(session_id, 'after'), 'forbidden');
    await rejects(api.getReveal(session_id, 'nope'), 'forbidden');

    const commit = await api.submit(session_id, s1, 40);
    if (!isStepReveal(commit)) throw new Error('expected a step reveal');
    expect(commit).toMatchObject({ step_id: s1, value: 40, previous_value: 50, locked: false });
    expect(commit.crowd).toMatchObject({ step_id: s1, n_real: 2, n_seed: 0, seeded_share: 0 });
    expect(commit.crowd.histogram).toHaveLength(10);
    expect(commit.version_note).toMatchObject({ version: harbor.version, earlier_versions: [] });
    expect(await api.getReveal(session_id, s1)).toEqual({ ...commit, locked: true });
  });

  it('the Before reveal carries no crowd', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: harbor }] });
    const { session_id } = await api.startSession(harbor.id, harbor.version, deviceId());
    expect(await api.submit(session_id, 'before', 50)).toEqual({ step_id: 'before', value: 50, locked: false });
  });

  it('the final reveal has the user path, the step that moved them most, and the crowd', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: harbor }] });
    const [a, , c] = harbor.steps.map((s) => s.id);
    await play(api, harbor, [90, 90, 90, 40, 40, 40]); // c moves the crowd -50
    const { last } = await play(api, harbor, [95, 70, 70, 70, 70, 70]); // a moves this user -25
    if (!isFinalReveal(last)) throw new Error('expected the final reveal');
    expect(last).toMatchObject({ step_id: 'after', value: 70, previous_value: 70, locked: false });
    expect(last.you.top_step_id).toBe(a);
    expect(last.you.answers.map((x) => x.value)).toEqual([95, 70, 70, 70, 70, 70]);
    expect(last.crowd).toMatchObject({ n_real: 2, n_seed: 0, top_step_id: c, mean_after: 55 });
    expect(last.crowd.before_histogram![9]).toBe(1);
    expect(last.crowd.steps.map((s) => s.step_id)).toEqual(harbor.steps.map((s) => s.id));
  });

  it('a user who never moved has no top step', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: harbor }] });
    const { last } = await play(api, harbor, [60, 60, 60, 60, 60, 60]);
    expect(isFinalReveal(last) && last.you.top_step_id).toBeNull();
  });
});

describe('seeded crowd data', () => {
  const profile = (fade: number): SeedProfileInput => ({
    sessions: 40,
    before_bins: [0, 0, 1, 1, 2, 3, 3, 2, 1, 1],
    steps: { [orchard.steps[0]!.id]: { move_share: 0.6, mean_shift: -12, spread: 4 } },
    after: { move_share: 0.2, mean_shift: 5, spread: 2 },
    fade_after_real_completions: fade,
    rng_seed: 3,
  });

  it('seeds every version from the profile, flags the seeded share, and fades out with real completions', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: orchard, seedProfile: profile(2) }] });
    const first = orchard.steps[0]!.id;
    expect(api.stepCrowd(orchard.id, orchard.version, first)).toMatchObject({ n_real: 0, n_seed: 40, seed_weight: 1, seeded_share: 1 });
    expect(api.stepCrowd(orchard.id, orchard.version, first).mean_delta).toBeLessThan(0);
    expect(api.stepCrowd(orchard.id, orchard.version, first, false)).toMatchObject({ seed_weight: 0, histogram: null });

    const values = slotsOf(orchard).map(() => 50);
    const one = await play(api, orchard, values);
    expect(isFinalReveal(one.last) && one.last.crowd).toMatchObject({ n_real: 1, n_seed: 40, seed_weight: 0.5 });
    expect(isFinalReveal(one.last) && one.last.crowd.seeded_share).toBeGreaterThan(0.9);

    const two = await play(api, orchard, values);
    // Faded seeds no longer count at all.
    expect(isFinalReveal(two.last) && two.last.crowd).toMatchObject({ n_real: 2, n_seed: 0, seed_weight: 0, seeded_share: 0 });
  });

  it('uses the shared generator, so seeded numbers are reproducible', () => {
    const api = new LocalDiveApi({ cases: [{ doc: orchard, seedProfile: profile(500) }] });
    const stepIds = orchard.steps.map((s) => s.id);
    const rows: CrowdRow[] = generateSeedSessions(profile(500), stepIds).map((s) => ({
      session_id: String(s.index),
      is_seed: true,
      excluded: false,
      values: s.answers.map((a) => a.value),
    }));
    stepIds.forEach((id, i) => expect(api.stepCrowd(orchard.id, orchard.version, id)).toEqual(computeStepCrowd(rows, id, i + 1, 1)));
    expect(api.finalCrowd(orchard.id, orchard.version)).toEqual(computeFinalCrowd(rows, stepIds, 1));
  });

  it('defaults the fade threshold to 500 real completions', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: harbor }] });
    await play(api, harbor, [50, 50, 50, 50, 50, 50]);
    expect(api.finalCrowd(harbor.id, harbor.version).seed_weight).toBe(0.998);
  });

  it('seeded sessions cannot be used as sessions', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: orchard, seedProfile: profile(500) }] });
    // seeded sessions take the first ids
    await rejects(api.submit('00000000-0000-4000-8000-000000000001', 'before', 50), 'not_found');
    const { session_id } = await api.startSession(orchard.id, orchard.version, deviceId());
    expect(session_id).toBe('00000000-0000-4000-8000-000000000029'); // 41st id
  });
});

describe('user signals', () => {
  it('records one flag per step, normalizing the note, and only for real steps', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: harbor }], now: clock() });
    const { session_id } = await api.startSession(harbor.id, harbor.version, deviceId());
    const step = harbor.steps[1]!.id;
    await rejects(api.flagFact(session_id, 'before', 'unfair'), 'not_found', /unknown step/);
    await rejects(api.flagFact(session_id, 'nope', 'unfair'), 'not_found');
    await rejects(api.flagFact(session_id, step, 'rude' as never), 'invalid', /unknown reason/);

    await api.flagFact(session_id, step, 'cherry_picked', '  Leaves out the vote.  ');
    await api.flagFact(session_id, harbor.steps[0]!.id, 'other', '   ');
    await api.flagFact(session_id, step, 'inaccurate', 'x'.repeat(1200));
    const { flags } = api.signals();
    expect(flags).toHaveLength(2);
    expect(flags.find((f) => f.step_id === harbor.steps[0]!.id)).toMatchObject({ reason: 'other', note: null });
    expect(flags.find((f) => f.step_id === step)).toMatchObject({
      session_id,
      case_id: harbor.id,
      case_version: harbor.version,
      reason: 'inaccurate',
      note: 'x'.repeat(1000),
    });
  });

  it('asks "Was this fair to your side?" only after the dive is finished', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: orchard }] });
    const side = orchard.sides[2]!.id;
    const { session_id } = await api.startSession(orchard.id, orchard.version, deviceId());
    await rejects(api.rateFairness(session_id, side, 'unfair'), 'out_of_order', /finish the dive/);

    const done = await play(api, orchard, slotsOf(orchard).map(() => 40));
    await rejects(api.rateFairness(done.sessionId, 'nope', 'fair'), 'not_found', /unknown side/);
    await rejects(api.rateFairness(done.sessionId, side, 'meh' as never), 'invalid', /unknown rating/);
    await api.rateFairness(done.sessionId, side, 'unfair');
    await api.rateFairness(done.sessionId, side, 'somewhat_fair');
    expect(api.signals().ratings).toEqual([
      expect.objectContaining({ session_id: done.sessionId, side_id: side, rating: 'somewhat_fair' }),
    ]);
  });
});

describe('crowd semantics after the phase 1 review', () => {
  it('names no top step when nobody moved', () => {
    const still: CrowdRow[] = [
      { session_id: 'x', is_seed: false, excluded: false, values: [40, 40, 40, 40] },
      { session_id: 'y', is_seed: false, excluded: false, values: [60, 60, 60, 60] },
    ];
    expect(computeFinalCrowd(still, ['a', 'b'], 1).top_step_id).toBeNull();
  });

  it('fades seeds by real completions across every version of the case', async () => {
    const seedProfile: SeedProfileInput = { sessions: 10, before_bins: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], fade_after_real_completions: 2 };
    const v2 = { ...orchard, version: orchard.version + 1 };
    const api = new LocalDiveApi({ cases: [{ doc: orchard, seedProfile }, { doc: v2, seedProfile }] });
    const values = slotsOf(orchard).map(() => 50);
    // Two real completions on the first version reach the case's threshold ...
    const first = await api.startSession(orchard.id, orchard.version, 'device-a-0000000000');
    const second = await api.startSession(orchard.id, orchard.version, 'device-b-0000000000');
    for (const s of [first, second]) for (const [i, slot] of slotsOf(orchard).entries()) await api.submit(s.session_id, slot, values[i]!);
    // ... so the newer version's seeds are gone too.
    expect(api.finalCrowd(orchard.id, v2.version)).toMatchObject({ seed_weight: 0, n_seed: 0, before_histogram: null });
  });
});
