import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toPublicCase, type Case } from '@sia/case-schema';
import { adminPublish, adminSaveEdit, getPublishedCase, getStaffVersion, type Db } from '@sia/case-store';
import {
  anonClient,
  freshSlug,
  loadFixture,
  pool,
  serviceClient,
  sql,
  submitFixture,
  userClient,
} from './helpers';

let admin: Db;
let pipeline: Db;
let plainUser: Db;
const anon = anonClient();

beforeAll(async () => {
  [admin, pipeline, plainUser] = await Promise.all([userClient('admin'), userClient('pipeline'), userClient('none')]);
});
afterAll(() => pool.end());

describe('phase 1 acceptance: the public client cannot read a draft', () => {
  it('hides in-review and draft versions from anon and plain signed-in users', async () => {
    const { case_id, slug, version } = await submitFixture(pipeline);

    for (const client of [anon, plainUser]) {
      const direct = await client.from('case_versions').select('case_id, version, status, public_doc').eq('case_id', case_id);
      expect(direct.error).toBeNull();
      expect(direct.data).toEqual([]);

      expect(await getPublishedCase(client, slug)).toBeNull();
      expect(await getPublishedCase(client, slug, version)).toBeNull();

      const staffView = await client.from('staff_case_versions').select('case_id').eq('case_id', case_id);
      expect(staffView.data ?? []).toEqual([]);

      const cases = await client.from('cases').select('id, slug').eq('id', case_id);
      expect(cases.data).toEqual([]);

      const live = await client.rpc('list_live_cases');
      expect((live.data as any[]).some((r) => r.case_id === case_id)).toBe(false);
    }

    // Staff can see it.
    const staff = await getStaffVersion(admin, case_id, version);
    expect(staff?.status).toBe('in_review');
  });

  it('never lets the public read the full document, even when published', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await adminPublish(admin, case_id, version);
    for (const client of [anon, plainUser]) {
      const res = await client.from('case_versions').select('doc').eq('case_id', case_id);
      expect(res.error?.message).toMatch(/permission denied/);
    }
  });

  it('blocks direct writes from the public', async () => {
    const { case_id } = await submitFixture(pipeline);
    const doc = loadFixture('fixture-harbor-bridge');
    const ins = await anon.from('case_versions').insert({ case_id, status: 'draft', origin: 'pipeline', doc });
    expect(ins.error).not.toBeNull();
    const cases = await anon.from('cases').insert({ slug: freshSlug() });
    expect(cases.error).not.toBeNull();
    const resp = await anon.from('responses').insert({ session_id: crypto.randomUUID(), case_id, case_version: 1, step_id: 'before', step_index: 0, value: 5 });
    expect(resp.error).not.toBeNull();
    const userIns = await plainUser.from('case_versions').insert({ case_id, status: 'draft', origin: 'pipeline', doc });
    expect(userIns.error).not.toBeNull();
  });
});

describe('only an admin can publish', () => {
  it('the pipeline cannot insert a published version', async () => {
    const { case_id } = await submitFixture(pipeline);
    const res = await pipeline
      .from('case_versions')
      .insert({ case_id, status: 'published', origin: 'pipeline', doc: loadFixture('fixture-harbor-bridge') });
    expect(res.error).not.toBeNull();
  });

  it('the pipeline cannot flip its own draft or review version to published', async () => {
    const { case_id } = await submitFixture(pipeline);
    // A draft the pipeline owns
    const draft = await pipeline
      .from('case_versions')
      .insert({ case_id, status: 'draft', origin: 'pipeline', doc: loadFixture('fixture-harbor-bridge') });
    expect(draft.error).toBeNull();
    const [{ version: draftVersion }] = await sql(
      `select max(version) as version from public.case_versions where case_id = $1`,
      [case_id],
    );
    const upd = await pipeline
      .from('case_versions')
      .update({ status: 'published' })
      .eq('case_id', case_id)
      .eq('version', draftVersion);
    expect(upd.error?.message).toMatch(/row-level security|only an admin/);

    // The in-review version is not even updatable by the pipeline.
    const upd2 = await pipeline.from('case_versions').update({ status: 'published' }).eq('case_id', case_id).eq('version', 1);
    expect(upd2.error).toBeNull();
    const [row] = await sql(`select status from public.case_versions where case_id = $1 and version = 1`, [case_id]);
    expect(row.status).toBe('in_review');
  });

  it('the pipeline cannot call the admin publish action', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    const res = await pipeline.rpc('admin_publish', { p_case_id: case_id, p_version: version });
    expect(res.error?.message).toMatch(/admin only/);
    const anonRes = await anon.rpc('admin_publish', { p_case_id: case_id, p_version: version });
    expect(anonRes.error).not.toBeNull();
  });

  it('even the service role cannot publish without an admin', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    const res = await serviceClient().from('case_versions').update({ status: 'published' }).eq('case_id', case_id).eq('version', version);
    expect(res.error?.message).toMatch(/only an admin action can publish/);
  });

  it('a signed-in non-staff user cannot publish', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    const res = await plainUser.rpc('admin_publish', { p_case_id: case_id, p_version: version });
    expect(res.error?.message).toMatch(/admin only/);
  });

  it('the admin publishes; the public then sees exactly the client projection', async () => {
    const { case_id, slug, version } = await submitFixture(pipeline);
    const out = await adminPublish(admin, case_id, version, 'Looks right.');
    expect(out.live_version).toBe(version);

    const pub = await getPublishedCase(anon, slug);
    expect(pub?.version).toBe(version);
    expect(pub?.is_live).toBe(true);
    const text = JSON.stringify(pub?.doc);
    for (const k of ['"favors"', '"impact"', '"evidence"', '"review"', '"status"']) expect(text).not.toContain(k);

    // SQL projection == TypeScript projection
    const staff = await getStaffVersion(admin, case_id, version);
    expect(pub?.doc).toEqual(toPublicCase(staff!.doc));

    const decisions = staff!.doc.review.decisions;
    expect(decisions.at(-1)).toMatchObject({ action: 'approve_publish', version, notes: 'Looks right.' });
    expect(decisions.at(-1)?.actor).toBe('admin-test@sia.local');
  });
});

describe('published versions are immutable', () => {
  it('rejects updates and deletes of a published version, from any role', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await adminPublish(admin, case_id, version);
    const doc = (await getStaffVersion(admin, case_id, version))!.doc;
    const edited = { ...doc, title: 'Changed in place' };

    const upd = await admin.from('case_versions').update({ doc: edited }).eq('case_id', case_id).eq('version', version);
    expect(upd.error?.message).toMatch(/immutable/);
    const back = await admin.from('case_versions').update({ status: 'in_review' }).eq('case_id', case_id).eq('version', version);
    expect(back.error?.message).toMatch(/immutable/);
    const del = await admin.from('case_versions').delete().eq('case_id', case_id).eq('version', version);
    expect(del.error).toBeNull(); // RLS: admins may only delete drafts, so nothing matches
    const svcDel = await serviceClient().from('case_versions').delete().eq('case_id', case_id).eq('version', version);
    expect(svcDel.error?.message).toMatch(/immutable/);
    await expect(sql(`update public.case_versions set doc = doc || '{"title":"x"}' where case_id = $1 and version = $2`, [case_id, version])).rejects.toThrow(/immutable/);

    const after = (await getStaffVersion(admin, case_id, version))!;
    expect(after.doc.title).toBe(doc.title);
    expect(after.status).toBe('published');
  });

  it('never lets the live pointer move except through publish', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    await adminPublish(admin, case_id, version);
    const res = await admin.from('cases').update({ live_version: null }).eq('id', case_id);
    expect(res.error).not.toBeNull();
  });
});

describe('publishing is blocked by structural errors and stale revisions', () => {
  it('refuses to publish a version with a zero-source step', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    const doc = (await getStaffVersion(admin, case_id, version))!.doc as any;
    doc.steps[0].source_ids = [];
    // Bypass the TypeScript validator to prove the database blocks it on its own.
    const saved = await admin.rpc('admin_save_edit', { p_case_id: case_id, p_base_version: version, p_doc: doc });
    expect(saved.error).toBeNull();
    const res = await admin.rpc('admin_publish', { p_case_id: case_id, p_version: saved.data.version });
    expect(res.error?.message).toMatch(/zero sources/);
  });

  it('the TypeScript store refuses to save an uncited step at all', async () => {
    const { case_id, version } = await submitFixture(pipeline);
    const doc = (await getStaffVersion(admin, case_id, version))!.doc;
    doc.steps[0]!.source_ids = [];
    await expect(adminSaveEdit(admin, case_id, version, doc)).rejects.toThrow(/at least one/);
  });

  it('refuses to publish a revision whose parent is no longer the live version', async () => {
    const { case_id, slug, version: v1 } = await submitFixture(pipeline);
    await adminPublish(admin, case_id, v1);
    const doc = (await getStaffVersion(admin, case_id, v1))!.doc;

    // A pipeline revision against v1 ...
    const { submitCasePackage } = await import('@sia/case-store');
    const rev = await submitCasePackage(pipeline, { slug, doc: { ...doc, parent_version: v1, title: 'Revision A' }, basedOnVersion: v1 });
    // ... and an admin edit of v1 that goes live first.
    const edit = await adminSaveEdit(admin, case_id, v1, { ...doc, title: 'Admin fix' });
    await adminPublish(admin, case_id, edit.version);

    const stale = await admin.rpc('admin_publish', { p_case_id: case_id, p_version: rev.version });
    expect(stale.error?.message).toMatch(/stale revision/);
  });
});

describe('review decisions are append-only', () => {
  it('cannot be changed or removed', async () => {
    const { case_id } = await submitFixture(pipeline);
    const rows = await sql(`select id from public.review_decisions where case_id = $1`, [case_id]);
    expect(rows.length).toBe(1);
    await expect(sql(`update public.review_decisions set notes = 'x' where id = $1`, [rows[0].id])).rejects.toThrow(/append-only/);
    await expect(sql(`delete from public.review_decisions where id = $1`, [rows[0].id])).rejects.toThrow(/append-only/);
  });
});

export type { Case };
