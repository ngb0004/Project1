import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPublish, adminSaveEdit, adminSetSeedProfile, getStaffVersion, type Db } from '@sia/case-store';
import {
  anonClient,
  deviceId,
  playDive,
  pool,
  relaxAbuseFloor,
  restoreAbuseFloor,
  sql,
  submitFixture,
  userClient,
} from './helpers';

let admin: Db;
let pipeline: Db;
const anon = anonClient();
const STEPS = ['s1', 's2', 's3', 's4'];

beforeAll(async () => {
  [admin, pipeline] = await Promise.all([userClient('admin'), userClient('pipeline')]);
  await relaxAbuseFloor();
});
afterAll(async () => {
  await restoreAbuseFloor();
  await pool.end();
});

async function publishedFixture() {
  const ref = await submitFixture(pipeline);
  await adminPublish(admin, ref.case_id, ref.version);
  return ref;
}

describe('sessions', () => {
  it('requires a published version', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    const r = await anon.rpc('start_session', { p_case_id: case_id, p_version: version, p_device_id: deviceId() });
    expect(r.error?.message).toMatch(/not published/);
  });

  it('gives one session per device per version and resumes it with locked answers', async () => {
    const { case_id, version } = await publishedFixture();
    const dev = deviceId();
    const a = await anon.rpc('start_session', { p_case_id: case_id, p_version: version, p_device_id: dev });
    expect(a.data.resumed).toBe(false);
    await anon.rpc('submit_response', { p_session_id: a.data.session_id, p_step_id: 'before', p_value: 90 });
    const b = await anon.rpc('start_session', { p_case_id: case_id, p_version: version, p_device_id: dev });
    expect(b.data.session_id).toBe(a.data.session_id);
    expect(b.data.resumed).toBe(true);
    expect(b.data.answers).toEqual([{ step_id: 'before', value: 90 }]);
  });
});

describe('answers', () => {
  it('locks the Before answer: a second submit cannot change it', async () => {
    const { case_id, version } = await publishedFixture();
    const s = await anon.rpc('start_session', { p_case_id: case_id, p_version: version, p_device_id: deviceId() });
    const first = await anon.rpc('submit_response', { p_session_id: s.data.session_id, p_step_id: 'before', p_value: 90 });
    expect(first.data).toMatchObject({ step_id: 'before', value: 90, locked: false });
    expect(first.data.crowd).toBeUndefined();
    const again = await anon.rpc('submit_response', { p_session_id: s.data.session_id, p_step_id: 'before', p_value: 10 });
    expect(again.data).toMatchObject({ value: 90, locked: true });
    const [row] = await sql(`select count(*)::int as n from public.responses where session_id = $1`, [s.data.session_id]);
    expect(row.n).toBe(1);
  });

  it('enforces the fixed order of the dive', async () => {
    const { case_id, version } = await publishedFixture();
    const s = await anon.rpc('start_session', { p_case_id: case_id, p_version: version, p_device_id: deviceId() });
    const skip = await anon.rpc('submit_response', { p_session_id: s.data.session_id, p_step_id: 's1', p_value: 50 });
    expect(skip.error?.message).toMatch(/earlier steps first/);
    const unknown = await anon.rpc('submit_response', { p_session_id: s.data.session_id, p_step_id: 'nope', p_value: 50 });
    expect(unknown.error?.message).toMatch(/unknown step/);
    const bad = await anon.rpc('submit_response', { p_session_id: s.data.session_id, p_step_id: 'before', p_value: 101 });
    expect(bad.error).not.toBeNull();
  });
});

describe('the crowd result stays hidden until the user commits', () => {
  it('get_reveal refuses a step the session has not answered; submit returns it after commit', async () => {
    const { case_id, version } = await publishedFixture();
    await playDive(anon, case_id, version, STEPS, [80, 70, 70, 60, 60, 55]);

    const s = await anon.rpc('start_session', { p_case_id: case_id, p_version: version, p_device_id: deviceId() });
    await anon.rpc('submit_response', { p_session_id: s.data.session_id, p_step_id: 'before', p_value: 50 });
    const peek = await anon.rpc('get_reveal', { p_session_id: s.data.session_id, p_step_id: 's1' });
    expect(peek.error?.message).toMatch(/commit an answer/);

    const commit = await anon.rpc('submit_response', { p_session_id: s.data.session_id, p_step_id: 's1', p_value: 40 });
    expect(commit.data).toMatchObject({ step_id: 's1', value: 40, previous_value: 50, locked: false });
    expect(commit.data.crowd.n_real).toBe(2);
    expect(commit.data.crowd.histogram).toHaveLength(10);
    expect(commit.data.crowd.shift).toBeTruthy();

    const later = await anon.rpc('get_reveal', { p_session_id: s.data.session_id, p_step_id: 's1' });
    expect(later.data.crowd.n_real).toBe(2);
  });

  it('there is no public path to raw responses or aggregates', async () => {
    const { case_id, version } = await publishedFixture();
    const raw = await anon.from('responses').select('*').eq('case_id', case_id);
    expect(raw.error?.message ?? '').toMatch(/permission denied/);
    const agg = await anon.rpc('admin_step_crowd', { p_case_id: case_id, p_version: version, p_step_id: 's1' });
    expect(agg.error).not.toBeNull();
  });
});

describe('final reveal', () => {
  it('returns before/after distributions, the step that moved the crowd most, and the user path', async () => {
    const { case_id, version } = await publishedFixture();
    await playDive(anon, case_id, version, STEPS, [90, 90, 90, 40, 40, 40]); // s3 moves -50
    const { final } = await playDive(anon, case_id, version, STEPS, [95, 70, 70, 70, 70, 70]); // s1 moves -25
    expect(final.step_id).toBe('after');
    expect(final.you.top_step_id).toBe('s1');
    expect(final.you.answers.map((a: any) => a.value)).toEqual([95, 70, 70, 70, 70, 70]);
    expect(final.crowd.n_real).toBe(2);
    expect(final.crowd.top_step_id).toBe('s3');
    expect(final.crowd.before_histogram[9]).toBe(1);
    expect(final.crowd.mean_after).toBe(55);
    expect(final.crowd.steps.map((s: any) => s.step_id)).toEqual(STEPS);
  });
});

describe('seeded crowd data', () => {
  it('stores seeds apart from real rows, flags the seeded share, honors include_seed, and fades out', async () => {
    const { case_id, version } = await publishedFixture();
    const profile = {
      sessions: 50,
      before_bins: [0, 0, 0, 0, 0, 1, 1, 2, 3, 3],
      steps: { s1: { move_share: 0.6, mean_shift: -12, spread: 4 } },
      fade_after_real_completions: 2,
      rng_seed: 3,
    };
    const res = await adminSetSeedProfile(admin, case_id, profile);
    expect(res.seeded_sessions).toBe(50);
    const [{ n }] = await sql(`select count(*)::int as n from public.responses where case_id = $1 and is_seed`, [case_id]);
    expect(n).toBe(50 * 6);

    const crowd = await admin.rpc('admin_step_crowd', { p_case_id: case_id, p_version: version, p_step_id: 's1' });
    expect(crowd.data).toMatchObject({ n_real: 0, n_seed: 50, seed_weight: 1, seeded_share: 1 });
    expect(crowd.data.mean_delta).toBeLessThan(0);

    const noSeed = await admin.rpc('admin_step_crowd', { p_case_id: case_id, p_version: version, p_step_id: 's1', p_include_seed: false });
    expect(noSeed.data.seed_weight).toBe(0);
    expect(noSeed.data.histogram).toBeNull();

    await playDive(anon, case_id, version, STEPS, [50, 50, 50, 50, 50, 50]);
    const half = await admin.rpc('admin_final_crowd', { p_case_id: case_id, p_version: version });
    expect(half.data.seed_weight).toBe(0.5);
    expect(half.data.seeded_share).toBeGreaterThan(0.9);

    await playDive(anon, case_id, version, STEPS, [50, 50, 50, 50, 50, 50]);
    const faded = await admin.rpc('admin_final_crowd', { p_case_id: case_id, p_version: version });
    expect(faded.data.seed_weight).toBe(0);
    expect(faded.data.seeded_share).toBe(0);
    expect(faded.data.real_completions).toBe(2);
  });

  it('generates seeds for each new version when it is published', async () => {
    const { case_id, version } = await publishedFixture();
    await adminSetSeedProfile(admin, case_id, { sessions: 10, before_bins: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] });
    const doc = (await getStaffVersion(admin, case_id, version))!.doc;
    const edit = await adminSaveEdit(admin, case_id, version, { ...doc, title: 'Edited title' });
    await adminPublish(admin, case_id, edit.version);
    const rows = await sql(
      `select case_version, count(*)::int as n from public.sessions where case_id = $1 and is_seed group by 1 order by 1`,
      [case_id],
    );
    expect(rows).toEqual([
      { case_version: version, n: 10 },
      { case_version: edit.version, n: 10 },
    ]);
  });
});

describe('abuse floor', () => {
  it('excludes a session that finishes faster than the reading-time floor', async () => {
    const { case_id, version } = await publishedFixture();
    // Restore only the reading-time floor; the rate limits stay relaxed for this suite.
    await sql(`update app.settings set value = '15' where key = 'floor.words_per_second'`);
    await sql(`update app.settings set value = '1.5' where key = 'floor.min_step_seconds'`);
    try {
      const { sessionId, final } = await playDive(anon, case_id, version, STEPS, [10, 20, 30, 40, 50, 60]);
      const [s] = await sql(`select excluded, excluded_reason from public.sessions where id = $1`, [sessionId]);
      expect(s.excluded).toBe(true);
      expect(s.excluded_reason).toMatch(/reading-time floor/);
      expect(final.crowd.n_real).toBe(0);
    } finally {
      await relaxAbuseFloor();
    }
  });

  it('rate-limits new sessions per network', async () => {
    const { case_id, version } = await publishedFixture();
    await sql(`update app.settings set value = '2' where key = 'rate.sessions_per_hour'`);
    await sql(`delete from app.rate_counters where bucket like 'sessions:%'`);
    try {
      const results = [];
      for (let i = 0; i < 3; i++) {
        results.push(await anon.rpc('start_session', { p_case_id: case_id, p_version: version, p_device_id: deviceId() }));
      }
      expect(results[0]!.error).toBeNull();
      expect(results[1]!.error).toBeNull();
      expect(results[2]!.error?.message).toMatch(/too many/);
    } finally {
      await relaxAbuseFloor();
    }
  });
});

describe('user signals', () => {
  it('records fact flags and sends a case back into review when one side rates it unfair', async () => {
    const { case_id, version } = await publishedFixture();
    await sql(`update public.cases set fairness_min_ratings = 2, fairness_unfair_threshold = 0.5 where id = $1`, [case_id]);

    const a = await playDive(anon, case_id, version, STEPS, [50, 50, 50, 50, 50, 50]);
    const flag = await anon.rpc('flag_fact', { p_session_id: a.sessionId, p_step_id: 's2', p_reason: 'cherry_picked', p_note: 'Leaves out the 2023 vote.' });
    expect(flag.error).toBeNull();
    const badFlag = await anon.rpc('flag_fact', { p_session_id: a.sessionId, p_step_id: 'before', p_reason: 'unfair' });
    expect(badFlag.error).not.toBeNull();

    // A session that has not finished cannot rate fairness.
    const unfinished = await anon.rpc('start_session', { p_case_id: case_id, p_version: version, p_device_id: deviceId() });
    const early = await anon.rpc('rate_fairness', { p_session_id: unfinished.data.session_id, p_side_id: 'council-responsible', p_rating: 'unfair' });
    expect(early.error?.message).toMatch(/finish the dive/);

    const b = await playDive(anon, case_id, version, STEPS, [50, 50, 50, 50, 50, 50]);
    for (const sid of [a.sessionId, b.sessionId]) {
      const r = await anon.rpc('rate_fairness', { p_session_id: sid, p_side_id: 'council-not-responsible', p_rating: 'unfair' });
      expect(r.error).toBeNull();
    }
    const signals = await admin.rpc('admin_fairness_signals', { p_case_id: case_id, p_version: version });
    expect(signals.data.sides).toEqual([
      expect.objectContaining({ side_id: 'council-not-responsible', ratings: 2, unfair: 2, unfair_share: 1 }),
    ]);
    expect(signals.data.flags[0]).toMatchObject({ step_id: 's2', total: 1, notes: ['Leaves out the 2023 vote.'] });
    expect(signals.data.alerts).toHaveLength(1);
    expect(signals.data.alerts[0]).toMatchObject({ kind: 'fairness', side_id: 'council-not-responsible' });

    const jobs = await sql(`select kind, base_version, instructions from public.pipeline_jobs where case_id = $1`, [case_id]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'revision', base_version: version });
  });
});
