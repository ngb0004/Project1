/**
 * Regression tests for the phase 1 adversarial review (migration 20261008000006).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminPublish,
  adminSaveEdit,
  adminSchedule,
  adminSetSeedProfile,
  getStaffVersion,
  submitCasePackage,
  type Db,
} from '@sia/case-store';
import { caseJsonSchema, generateSeedSessions, seedProfileJsonSchema, toPublicCase } from '@sia/case-schema';
import {
  anonClient,
  API_URL,
  ANON_KEY,
  deviceId,
  freshSlug,
  loadFixture,
  playDive,
  pool,
  relaxAbuseFloor,
  restoreAbuseFloor,
  sql,
  submitFixture,
  userClient,
} from './helpers';
import { createAnonClient } from '@sia/case-store';

let admin: Db;
let pipeline: Db;
let plainUser: Db;
const anon = anonClient();
const STEPS = ['s1', 's2', 's3', 's4'];

beforeAll(async () => {
  [admin, pipeline, plainUser] = await Promise.all([userClient('admin'), userClient('pipeline'), userClient('none')]);
  await relaxAbuseFloor();
});
afterAll(async () => {
  await restoreAbuseFloor();
  await pool.end();
});

const statusOf = async (caseId: string, version: number) =>
  (await sql(`select status from public.case_versions where case_id = $1 and version = $2`, [caseId, version]))[0]?.status;

describe('only an admin decision puts a version live', () => {
  it('the pipeline cannot set a publish time on insert or update', async () => {
    const { case_id } = await submitFixture(pipeline);
    const doc = loadFixture('fixture-harbor-bridge');
    const past = new Date(Date.now() - 60_000).toISOString();
    const ins = await pipeline.from('case_versions').insert({ case_id, status: 'in_review', origin: 'pipeline', doc, scheduled_publish_at: past });
    expect(ins.error).not.toBeNull();

    const draft = await pipeline.from('case_versions').insert({ case_id, status: 'draft', origin: 'pipeline', doc });
    expect(draft.error).toBeNull();
    const [{ v }] = await sql(`select max(version) as v from public.case_versions where case_id = $1`, [case_id]);
    const upd = await pipeline.from('case_versions').update({ scheduled_publish_at: past }).eq('case_id', case_id).eq('version', v);
    expect(upd.error).not.toBeNull();
    const [row] = await sql(`select scheduled_publish_at from public.case_versions where case_id = $1 and version = $2`, [case_id, v]);
    expect(row.scheduled_publish_at).toBeNull();
  });

  it('the cron job refuses a due version without a matching approval, and logs why', async () => {
    const { case_id, slug, version } = await submitFixture(pipeline);
    // Even a trusted write of a publish time is not an approval.
    await sql(`update public.case_versions set scheduled_publish_at = now() - interval '1 minute' where case_id = $1 and version = $2`, [case_id, version]);
    await sql(`select app.publish_due_versions()`);
    expect(await statusOf(case_id, version)).toBe('in_review');
    const pub = await anon.rpc('get_published_case', { p_slug: slug, p_version: null });
    expect(pub.data).toEqual([]);
    const [d] = await sql(`select action, notes from public.review_decisions where case_id = $1 and version = $2 order by id desc limit 1`, [case_id, version]);
    expect(d).toMatchObject({ action: 'unschedule' });
    expect(d.notes).toMatch(/no admin approval/);
  });

  it('an approval covers the content approved: editing an approved admin draft cancels the schedule', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    const doc = (await getStaffVersion(admin, case_id, version))!.doc;
    const edit = await adminSaveEdit(admin, case_id, version, { ...doc, title: 'Edit A' });
    await adminSchedule(admin, case_id, edit.version, new Date(Date.now() + 3600_000));
    await adminSaveEdit(admin, case_id, version, { ...doc, title: 'Edit B' });
    const row = (await getStaffVersion(admin, case_id, edit.version))!;
    expect(row.scheduled_publish_at).toBeNull();
    const actions = await sql(`select action from public.review_decisions where case_id = $1 and version = $2 order by id`, [case_id, edit.version]);
    expect(actions.map((a) => a.action)).toContain('unschedule');
  });

  it('the pipeline cannot touch a scheduled or admin-owned version', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    const doc = (await getStaffVersion(admin, case_id, version))!.doc;
    const edit = await adminSaveEdit(admin, case_id, version, { ...doc, title: 'Admin wording' });
    await adminSchedule(admin, case_id, edit.version, new Date(Date.now() + 3600_000));
    const res = await pipeline.from('case_versions').update({ doc: { ...doc, title: 'Swapped by pipeline' } }).eq('case_id', case_id).eq('version', edit.version);
    expect(res.error).toBeNull(); // RLS: no visible row to update
    expect((await getStaffVersion(admin, case_id, edit.version))!.doc.title).toBe('Admin wording');
  });

  it('the pipeline cannot forge an admin_edit draft, and admin_save_edit never continues a pipeline draft', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    const doc = loadFixture('fixture-harbor-bridge');
    const forged = await pipeline.from('case_versions').insert({ case_id, status: 'draft', origin: 'pipeline', doc, tags: ['admin_edit'], based_on_version: version });
    expect(forged.error?.message).toMatch(/admin_edit_origin/);
    const edit = await adminSaveEdit(admin, case_id, version, { ...doc, title: 'Mine' });
    const row = (await getStaffVersion(admin, case_id, edit.version))!;
    expect(row.origin).toBe('admin');
  });

  it('a pipeline package cannot archive versions the admin did not send back', async () => {
    const { case_id, slug, version } = await submitFixture(pipeline);
    const doc = (await getStaffVersion(pipeline, case_id, version))!.doc;
    await submitCasePackage(pipeline, { slug, doc, basedOnVersion: version });
    expect(await statusOf(case_id, version)).toBe('in_review');
    const edit = await adminSaveEdit(admin, case_id, version, { ...doc, title: 'Admin draft' });
    await submitCasePackage(pipeline, { slug, doc, basedOnVersion: edit.version });
    expect(await statusOf(case_id, edit.version)).toBe('draft');
  });

  it('status changes and in-place edits outside the review actions are refused, even for the admin', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    const direct = await admin.from('case_versions').update({ status: 'published' }).eq('case_id', case_id).eq('version', version);
    expect(direct.error?.message).toMatch(/review actions/);
    const doc = (await getStaffVersion(admin, case_id, version))!.doc;
    const inPlace = await admin.from('case_versions').update({ doc: { ...doc, title: 'Edited in place' } }).eq('case_id', case_id).eq('version', version);
    expect(inPlace.error?.message).toMatch(/edits create a new version/);
  });
});

describe('publishing enforces the full schema', () => {
  it('blocks a missing title, an unknown key, and a news-only "established" step', async () => {
    const cases: [string, (d: any) => void, RegExp][] = [
      ['no title', (d) => delete d.title, /title/],
      ['unknown key', (d) => (d.steps[0].secret = 'x'), /secret|additional/i],
      ['overstated confidence', (d) => (d.steps[3].confidence = 'established'), /only news or analysis/],
    ];
    for (const [, mutate, msg] of cases) {
      const { case_id, version } = await submitFixture(pipeline);
      const doc = structuredClone((await getStaffVersion(admin, case_id, version))!.doc) as any;
      mutate(doc);
      const saved = await admin.rpc('admin_save_edit', { p_case_id: case_id, p_base_version: version, p_doc: doc });
      expect(saved.error).toBeNull();
      const res = await admin.rpc('admin_publish', { p_case_id: case_id, p_version: saved.data.version });
      expect(res.error?.message).toMatch(/not publishable/);
      expect(res.error?.message).toMatch(msg);
    }
  });

  it('the database schemas match the Zod schemas (regenerate a migration when Zod changes)', async () => {
    const rows = await sql(`select name, schema from app.json_schemas order by name`);
    const db = Object.fromEntries(rows.map((r) => [r.name, r.schema]));
    expect(db.case).toEqual(caseJsonSchema());
    expect(db.seed_profile).toEqual(seedProfileJsonSchema());
  });
});

describe('public projection is an allowlist', () => {
  it('drops unknown keys at every level and matches toPublicCase for valid documents', async () => {
    for (const name of ['fixture-harbor-bridge', 'fixture-orchard-school']) {
      const doc = loadFixture(name);
      const [{ p }] = await sql(`select public.case_public_projection($1::jsonb) as p`, [JSON.stringify(doc)]);
      expect(p).toEqual(JSON.parse(JSON.stringify(toPublicCase(doc))));
    }
    const doc: any = loadFixture('fixture-orchard-school');
    doc.secret = 1;
    doc.question.secret = 1;
    doc.question.scale.secret = 1;
    doc.starting_facts[0].secret = 1;
    doc.steps[1].secret = 1;
    doc.steps[1].depth[0].secret = 1;
    doc.steps[1].micro_poll.secret = 1;
    doc.sides[0].secret = 1;
    doc.sources[0].secret = 1;
    const [{ p }] = await sql(`select public.case_public_projection($1::jsonb) as p`, [JSON.stringify(doc)]);
    expect(JSON.stringify(p)).not.toMatch(/secret|favors|impact|evidence|review/);
  });
});

describe('rate limits key on the platform IP, not a spoofable header', () => {
  it('rotating X-Forwarded-For does not get around the session limit', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await adminPublish(admin, case_id, version);
    await sql(`update app.settings set value = '2' where key = 'rate.sessions_per_hour'`);
    await sql(`delete from app.rate_counters where bucket like 'sessions:%'`);
    try {
      const results = [];
      for (let i = 0; i < 3; i++) {
        const spoofing = createAnonClient(API_URL, ANON_KEY, { 'x-forwarded-for': `203.0.113.${i + 1}` });
        results.push(await spoofing.rpc('start_session', { p_case_id: case_id, p_version: version, p_device_id: deviceId() }));
      }
      expect(results[2]!.error?.message).toMatch(/too many/);
    } finally {
      await relaxAbuseFloor();
    }
  });
});

describe('internal functions and logs', () => {
  it('API roles cannot execute internal helpers', async () => {
    const rows = await sql(`
      select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon_x,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_x
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname in ('setting_num', 'session_path', 'hash_text', 'generate_seed_responses', 'reveal')`);
    expect(rows.length).toBe(5);
    for (const r of rows) expect([r.proname, r.anon_x, r.auth_x]).toEqual([r.proname, false, false]);
  });

  it('the admin can read the decision log; the public cannot', async () => {
    const { case_id } = await submitFixture(pipeline);
    const a = await admin.from('review_decisions').select('action').eq('case_id', case_id);
    expect(a.data?.map((d) => d.action)).toEqual(['submitted']);
    expect((await plainUser.from('review_decisions').select('action').eq('case_id', case_id)).data ?? []).toEqual([]);
    expect((await anon.from('review_decisions').select('action')).error).not.toBeNull();
  });

  it('submitted and superseded decisions are mirrored into the document', async () => {
    const { case_id, slug, version } = await submitFixture(pipeline);
    const doc = (await getStaffVersion(admin, case_id, version))!.doc;
    expect(doc.review.decisions.map((d) => d.action)).toEqual(['submitted']);
    const { adminRequestChanges } = await import('@sia/case-store');
    await adminRequestChanges(admin, case_id, version, 'Tighten step 2.');
    await submitCasePackage(pipeline, { slug, doc, basedOnVersion: version });
    const old = (await getStaffVersion(admin, case_id, version))!.doc;
    expect(old.review.decisions.map((d) => d.action)).toEqual(['submitted', 'request_changes', 'superseded']);
  });
});

describe('seeds', () => {
  it('rejects malformed profiles before they can break a live dive', async () => {
    const { case_id } = await submitFixture(pipeline);
    for (const bad of [
      { sessions: 10, before_bins: [1, 1] },
      { sessions: 10, before_bins: Array(10).fill(0) },
      { sessions: 10, before_bins: Array(10).fill(1), steps: { s1: { move_share: 'lots', mean_shift: 0, spread: 0 } } },
      { sessions: 10.5, before_bins: Array(10).fill(1), fade_after_real_completions: 500, rng_seed: 1 },
    ]) {
      const res = await admin.rpc('admin_set_seed_profile', { p_case_id: case_id, p_profile: bad });
      expect(res.error?.message).toMatch(/invalid seed profile/);
    }
  });

  it('produces exactly the TypeScript generator output, including negative seeds', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await adminPublish(admin, case_id, version);
    const profile = {
      sessions: 40,
      before_bins: [0, 1, 0, 2, 3, 0, 1, 4, 2, 1],
      steps: { s1: { move_share: 0.7, mean_shift: -11.5, spread: 6 }, s3: { move_share: 0.3, mean_shift: 9, spread: 2.5 } },
      after: { move_share: 0.2, mean_shift: 3, spread: 1 },
      rng_seed: -123456789,
    };
    await adminSetSeedProfile(admin, case_id, profile);
    const rows = await sql(
      `select s.device_hash, r.step_id, r.value from public.responses r join public.sessions s on s.id = r.session_id
       where r.case_id = $1 and r.case_version = $2 and r.is_seed order by split_part(s.device_hash, ':', 2)::int, r.step_index`,
      [case_id, version],
    );
    const fromDb = new Map<string, number[]>();
    for (const r of rows) {
      const k = r.device_hash.split(':')[1];
      fromDb.set(k, [...(fromDb.get(k) ?? []), r.value]);
    }
    const ts = generateSeedSessions(profile, STEPS);
    expect(fromDb.size).toBe(40);
    for (const s of ts) expect(fromDb.get(String(s.index + 1))).toEqual(s.answers.map((a) => a.value));
  });

  it('a large profile seeds quickly inside the publish', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await adminSetSeedProfile(admin, case_id, { sessions: 5000, before_bins: Array(10).fill(1), steps: { s1: { move_share: 0.5, mean_shift: 5, spread: 5 } } });
    const t0 = Date.now();
    await adminPublish(admin, case_id, version);
    expect(Date.now() - t0).toBeLessThan(15_000);
    const [{ n }] = await sql(`select count(*)::int as n from public.sessions where case_id = $1 and is_seed`, [case_id]);
    expect(n).toBe(5000);
  });
});

describe('user signals', () => {
  it('flags require having reached the step; excluded sessions do not count toward alerts', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await adminPublish(admin, case_id, version);
    const s = await anon.rpc('start_session', { p_case_id: case_id, p_version: version, p_device_id: deviceId() });
    const early = await anon.rpc('flag_fact', { p_session_id: s.data.session_id, p_step_id: 's3', p_reason: 'unfair' });
    expect(early.error?.message).toMatch(/reach this step/);

    await sql(`update app.settings set value = '2' where key = 'flags.alert_min'`);
    try {
      for (let i = 0; i < 2; i++) {
        const { sessionId } = await playDive(anon, case_id, version, STEPS, [50, 50, 50, 50, 50, 50]);
        await sql(`update public.sessions set excluded = true where id = $1`, [sessionId]);
        await anon.rpc('flag_fact', { p_session_id: sessionId, p_step_id: 's1', p_reason: 'unfair' });
      }
      const alerts = await sql(`select * from public.review_alerts where case_id = $1 and kind = 'flags'`, [case_id]);
      expect(alerts).toEqual([]);
    } finally {
      await sql(`update app.settings set value = '20' where key = 'flags.alert_min'`);
    }
  });

  it('a resolved fairness alert does not reopen on the next single rating', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await adminPublish(admin, case_id, version);
    await sql(`update public.cases set fairness_min_ratings = 2, fairness_unfair_threshold = 0.5 where id = $1`, [case_id]);
    for (let i = 0; i < 2; i++) {
      const { sessionId } = await playDive(anon, case_id, version, STEPS, [50, 50, 50, 50, 50, 50]);
      await anon.rpc('rate_fairness', { p_session_id: sessionId, p_side_id: 'council-responsible', p_rating: 'unfair' });
    }
    const [alert] = await sql(`select id from public.review_alerts where case_id = $1 and kind = 'fairness'`, [case_id]);
    const resolved = await admin.from('review_alerts').update({ resolved_at: new Date().toISOString(), resolved_by: 'owner' }).eq('id', alert.id);
    expect(resolved.error).toBeNull();
    const { sessionId } = await playDive(anon, case_id, version, STEPS, [50, 50, 50, 50, 50, 50]);
    await anon.rpc('rate_fairness', { p_session_id: sessionId, p_side_id: 'council-responsible', p_rating: 'unfair' });
    const open = await sql(`select id from public.review_alerts where case_id = $1 and kind = 'fairness' and resolved_at is null`, [case_id]);
    expect(open).toEqual([]);
  });
});

export { freshSlug };

describe('seeds fade case-wide', () => {
  it('a version published after the case reached its real crowd gets no seeds', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await adminSetSeedProfile(admin, case_id, { sessions: 20, before_bins: Array(10).fill(1), fade_after_real_completions: 2 });
    await adminPublish(admin, case_id, version);
    for (let i = 0; i < 2; i++) await playDive(anon, case_id, version, STEPS, [50, 50, 50, 50, 50, 50]);
    const doc = (await getStaffVersion(admin, case_id, version))!.doc;
    const edit = await adminSaveEdit(admin, case_id, version, { ...doc, title: 'Updated' });
    await adminPublish(admin, case_id, edit.version);
    const [{ n }] = await sql(`select count(*)::int as n from public.sessions where case_id = $1 and case_version = $2 and is_seed`, [case_id, edit.version]);
    expect(n).toBe(0);
    const crowd = await admin.rpc('admin_final_crowd', { p_case_id: case_id, p_version: edit.version });
    expect(crowd.data).toMatchObject({ n_real: 0, n_seed: 0, seed_weight: 0, before_histogram: null, top_step_id: null });
    expect(crowd.data.version_note.earlier_versions).toEqual([expect.objectContaining({ version, completions: 2 })]);
  });
});
