import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { SeedProfile, assertValidCase, type Case } from '@sia/case-schema';
import { adminPublish, adminSetSeedProfile, signInStaff, submitCasePackage, type Db } from '@sia/case-store';

/**
 * Local Supabase stack (`supabase start`). These are the public demo keys every
 * local stack ships with, the same ones supabase/tests/helpers.ts uses; override
 * with SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.
 */
export const API_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const PASSWORD = 'local-test-password-1';

export function serviceClient(): Db {
  return createClient(API_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Creates (once) and signs in the staff test account for a role, as supabase/tests/helpers.ts does. */
async function staffClient(role: 'admin' | 'pipeline'): Promise<Db> {
  const email = `${role}-test@sia.local`;
  const { error } = await serviceClient().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { app_role: role },
  });
  if (error && !/already/i.test(error.message)) throw error;
  return signInStaff(API_URL, ANON_KEY, { email, password: PASSWORD });
}

/** The full case documents in /cases/fixtures, admin-only fields included. */
export function loadFixtures(root: string): Case[] {
  const dir = join(root, 'cases/fixtures');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => assertValidCase(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

/** A seed profile built from the step ids alone, so every step has a seeded crowd. */
function seedProfileFor(doc: Case) {
  return SeedProfile.parse({
    sessions: 150,
    before_bins: [1, 1, 2, 3, 5, 6, 7, 5, 3, 2],
    steps: Object.fromEntries(
      doc.steps.map((s, i) => [s.id, { move_share: 0.5, mean_shift: i % 2 ? -12 : 8, spread: 6 }]),
    ),
    after: { move_share: 0.3, mean_shift: -3, spread: 4 },
    rng_seed: 7,
    note: 'End-to-end test seed.',
  });
}

export interface PublishedFixture {
  doc: Case;
  slug: string;
  caseId: string;
  version: number;
}

/**
 * Submits each fixture as a new package under a fresh slug (as the pipeline),
 * then sets a seed profile and publishes it (as the admin): the same import
 * path pipeline output takes.
 */
export async function publishFixtures(docs: Case[]): Promise<PublishedFixture[]> {
  const [admin, pipeline] = await Promise.all([staffClient('admin'), staffClient('pipeline')]);
  const out: PublishedFixture[] = [];
  for (const fixture of docs) {
    const doc = structuredClone(fixture);
    delete (doc as Partial<Case>).parent_version;
    const slug = `e2e-${randomUUID().slice(0, 8)}`;
    const ref = await submitCasePackage(pipeline, { slug, doc, tags: ['e2e'] });
    await adminSetSeedProfile(admin, ref.case_id, seedProfileFor(doc));
    const published = await adminPublish(admin, ref.case_id, ref.version, 'Published by the web end-to-end run.');
    out.push({ doc: fixture, slug, caseId: ref.case_id, version: published.version });
  }
  return out;
}
