import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminPublish,
  adminReject,
  adminRequestChanges,
  adminSaveEdit,
  adminSchedule,
  getPublishedCase,
  getStaffVersion,
  listQueue,
  submitCasePackage,
  type Db,
} from '@sia/case-store';
import { anonClient, playDive, pool, relaxAbuseFloor, sql, submitFixture, userClient } from './helpers';

let admin: Db;
let pipeline: Db;
const anon = anonClient();
const STEPS = ['s1', 's2', 's3', 's4'];

beforeAll(async () => {
  [admin, pipeline] = await Promise.all([userClient('admin'), userClient('pipeline')]);
  await relaxAbuseFloor();
});
afterAll(() => pool.end());

describe('edit then approve', () => {
  it('creates a new immutable version; old responses stay attached to the old version', async () => {
    const { case_id, slug, version: v1 } = await submitFixture(pipeline);
    await adminPublish(admin, case_id, v1);
    const original = (await getStaffVersion(admin, case_id, v1))!;

    const { sessionId } = await playDive(anon, case_id, v1, STEPS, [90, 85, 80, 75, 70, 75]);

    // Inline edits save a draft tagged admin_edit; repeated saves update the same draft.
    const edited = { ...original.doc, title: 'The Harbor Bridge Closure (corrected)' };
    const e1 = await adminSaveEdit(admin, case_id, v1, edited, 'Fix title');
    const e2 = await adminSaveEdit(admin, case_id, v1, { ...edited, open_questions: [...edited.open_questions, 'New question?'] });
    expect(e2.version).toBe(e1.version);
    expect(e1.parent_version).toBe(v1);
    const draft = (await getStaffVersion(admin, case_id, e1.version))!;
    expect(draft.status).toBe('draft');
    expect(draft.tags).toContain('admin_edit');
    expect(draft.doc.parent_version).toBe(v1);
    expect(draft.doc.open_questions).toContain('New question?');

    // The draft is not public until approved.
    expect((await getPublishedCase(anon, slug))!.version).toBe(v1);

    await adminPublish(admin, case_id, e1.version, 'Approved after edit');
    const live = (await getPublishedCase(anon, slug))!;
    expect(live.version).toBe(e1.version);
    expect(live.doc.title).toBe('The Harbor Bridge Closure (corrected)');

    // v1 is untouched and still published (readable for its own respondents).
    const old = (await getStaffVersion(admin, case_id, v1))!;
    expect(old.status).toBe('published');
    expect(old.doc).toEqual(original.doc);
    expect((await getPublishedCase(anon, slug, v1))!.doc.title).toBe(original.doc.title);

    // Responses stay with the version the user saw.
    const rows = await sql(`select distinct case_version from public.responses where session_id = $1`, [sessionId]);
    expect(rows).toEqual([{ case_version: v1 }]);
    const v1Crowd = await admin.rpc('admin_final_crowd', { p_case_id: case_id, p_version: v1 });
    expect(v1Crowd.data.n_real).toBe(1);
    const v2Crowd = await admin.rpc('admin_final_crowd', { p_case_id: case_id, p_version: e1.version });
    expect(v2Crowd.data.n_real).toBe(0);
    expect(v2Crowd.data.version_note.earlier_versions).toEqual([
      expect.objectContaining({ version: v1, completions: 1 }),
    ]);

    // The session started on v1 can still finish on v1 ... and a new device starts on v2.
    const { final } = await playDive(anon, case_id, e1.version, STEPS, [50, 50, 50, 50, 50, 50]);
    expect(final.version_note.earlier_versions[0].completions).toBe(1);
  });

  it('an admin edit of a pending pipeline version supersedes it when published', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    const doc = (await getStaffVersion(admin, case_id, version))!.doc;
    const e = await adminSaveEdit(admin, case_id, version, { ...doc, title: 'Tightened wording' });
    expect(e.parent_version).toBeNull();
    await adminPublish(admin, case_id, e.version);
    const base = (await getStaffVersion(admin, case_id, version))!;
    expect(base.status).toBe('archived');
    const decisions = await sql(`select action from public.review_decisions where case_id = $1 and version = $2 order by id`, [case_id, version]);
    expect(decisions.map((d) => d.action)).toEqual(['submitted', 'superseded']);
  });
});

describe('request changes, reject, schedule', () => {
  it('request changes queues a revision job with the notes; the revision supersedes the old version', async () => {
    const { case_id, slug, version } = await submitFixture(pipeline);
    const out = await adminRequestChanges(admin, case_id, version, 'Step 3 needs the state budget document.');
    const [job] = await sql(`select kind, base_version, instructions, status from public.pipeline_jobs where id = $1`, [out.job_id]);
    expect(job).toEqual({ kind: 'revision', base_version: version, instructions: 'Step 3 needs the state budget document.', status: 'queued' });
    expect((await getStaffVersion(admin, case_id, version))!.status).toBe('changes_requested');

    const doc = (await getStaffVersion(pipeline, case_id, version))!.doc;
    const rev = await submitCasePackage(pipeline, { slug, doc, basedOnVersion: version, jobId: out.job_id, tags: ['revision'] });
    expect((await getStaffVersion(admin, case_id, version))!.status).toBe('archived');
    const queue = await listQueue(admin);
    expect(queue.some((q) => q.case_id === case_id && q.version === rev.version && q.status === 'in_review')).toBe(true);
    expect(queue.some((q) => q.case_id === case_id && q.version === version)).toBe(false);
  });

  it('reject archives the package with its reason, and it stays final', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await adminReject(admin, case_id, version, 'Wrong framing of the question.');
    const v = (await getStaffVersion(admin, case_id, version))!;
    expect(v.status).toBe('rejected');
    expect(v.doc.review.decisions.at(-1)).toMatchObject({ action: 'reject', notes: 'Wrong framing of the question.' });
    const again = await admin.rpc('admin_publish', { p_case_id: case_id, p_version: version });
    expect(again.error?.message).toMatch(/final/);
  });

  it('approve and schedule publishes when the time comes (cron job)', async () => {
    const { case_id, slug, version } = await submitFixture(pipeline);
    await adminSchedule(admin, case_id, version, new Date(Date.now() + 2500), 'Go live tonight');
    expect(await getPublishedCase(anon, slug)).toBeNull();
    const queue = await listQueue(admin);
    expect(queue.find((q) => q.case_id === case_id)?.scheduled_publish_at).toBeTruthy();

    await new Promise((r) => setTimeout(r, 3000));
    // pg_cron may already have published it; running the job again is harmless.
    await sql(`select app.publish_due_versions()`);
    expect((await getPublishedCase(anon, slug))!.version).toBe(version);
    const actions = (await getStaffVersion(admin, case_id, version))!.doc.review.decisions.map((d) => d.action);
    expect(actions).toEqual(['submitted', 'approve_schedule', 'scheduled_publish']);
  });

  it('schedule refuses a time in the past', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await expect(adminSchedule(admin, case_id, version, new Date(Date.now() - 1000))).rejects.toThrow(/future/);
  });
});
