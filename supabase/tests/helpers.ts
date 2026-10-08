import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { assertValidCase, type Case } from '@sia/case-schema';
import { createAnonClient, signInStaff, submitCasePackage, type Db } from '@sia/case-store';

/**
 * Test environment for the local Supabase stack (`supabase start`). The keys
 * below are the public demo keys every local Supabase stack ships with; they are
 * not secrets. Override with SUPABASE_URL / SUPABASE_ANON_KEY /
 * SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL to test elsewhere.
 */
export const API_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
export const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
export const DB_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadFixture(name: string): Case {
  return assertValidCase(JSON.parse(readFileSync(join(root, 'cases/fixtures', `${name}.json`), 'utf8')));
}

export const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });

export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}

export function serviceClient(): SupabaseClient {
  return createClient(API_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const PASSWORD = 'local-test-password-1';

/** Creates (once) and signs in a user with the given app_role ('' for a plain signed-in user). */
export async function userClient(role: 'admin' | 'pipeline' | 'none'): Promise<Db> {
  const email = `${role}-test@sia.local`;
  const svc = serviceClient();
  const { error } = await svc.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: role === 'none' ? {} : { app_role: role },
  });
  if (error && !/already/i.test(error.message)) throw error;
  return signInStaff(API_URL, ANON_KEY, { email, password: PASSWORD });
}

export function anonClient(): Db {
  return createAnonClient(API_URL, ANON_KEY);
}

export function freshSlug(prefix = 'test'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function deviceId(): string {
  return `device-${randomUUID()}`;
}

/** Submits a fixture as a new case package (as the pipeline) and returns its ids. */
export async function submitFixture(pipeline: Db, name = 'fixture-harbor-bridge', slug = freshSlug()) {
  const doc = loadFixture(name);
  delete (doc as Partial<Case>).parent_version;
  const ref = await submitCasePackage(pipeline, { slug, doc });
  return { ...ref, slug };
}

/** Makes the reading-time floor and rate limits irrelevant for tests that answer instantly. */
export async function relaxAbuseFloor() {
  await sql(`update app.settings set value = '1000000000' where key in ('floor.words_per_second', 'rate.sessions_per_hour', 'rate.responses_per_minute', 'rate.signals_per_hour')`);
  await sql(`update app.settings set value = '0' where key = 'floor.min_step_seconds'`);
}

export async function restoreAbuseFloor() {
  await sql(`update app.settings set value = '15' where key = 'floor.words_per_second'`);
  await sql(`update app.settings set value = '1.5' where key = 'floor.min_step_seconds'`);
  await sql(`update app.settings set value = '30' where key = 'rate.sessions_per_hour'`);
  await sql(`update app.settings set value = '120' where key = 'rate.responses_per_minute'`);
  await sql(`update app.settings set value = '60' where key = 'rate.signals_per_hour'`);
}

/** Plays a whole dive for one anonymous device and returns the session id and the final reveal. */
export async function playDive(anon: Db, caseId: string, version: number, stepIds: string[], values: number[]) {
  const start = await anon.rpc('start_session', { p_case_id: caseId, p_version: version, p_device_id: deviceId() });
  if (start.error) throw start.error;
  const sessionId = start.data.session_id as string;
  const slots = ['before', ...stepIds, 'after'];
  let last: any;
  for (let i = 0; i < slots.length; i++) {
    const r = await anon.rpc('submit_response', { p_session_id: sessionId, p_step_id: slots[i], p_value: values[i] });
    if (r.error) throw r.error;
    last = r.data;
  }
  return { sessionId, final: last };
}
