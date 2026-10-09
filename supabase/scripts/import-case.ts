#!/usr/bin/env tsx
/**
 * Imports a hand-checked case JSON through the same path as pipeline output
 * (public.submit_case_package). The case lands in the review queue as
 * `in_review`; the owner approves it in the admin console. Nothing is published.
 *
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SIA_STAFF_EMAIL=... SIA_STAFF_PASSWORD=... \
 *   pnpm --filter @sia/supabase import-case ../cases/seed/cornell.json [--seed-profile ../cases/seed/cornell.seed-profile.json]
 *
 * Signs in as a staff account (pipeline or admin). A seed profile can only be
 * set by the admin account.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SeedProfile, validateCase } from '@sia/case-schema';
import { adminSetSeedProfile, signInStaff, submitCasePackage } from '@sia/case-store';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'seed-profile': { type: 'string' } },
});
const file = positionals[0];
if (!file) {
  console.error('usage: import-case <case.json> [--seed-profile <profile.json>]');
  process.exit(2);
}
const env = (k: string) => {
  const v = process.env[k];
  if (!v) {
    console.error(`${k} must be set`);
    process.exit(2);
  }
  return v;
};

const raw = JSON.parse(readFileSync(file, 'utf8'));
const result = validateCase(raw);
for (const w of result.warnings) console.warn(`warn  ${w.path} [${w.code}]: ${w.message}`);
if (!result.ok || !result.case) {
  for (const e of result.errors) console.error(`error ${e.path} [${e.code}]: ${e.message}`);
  process.exit(1);
}

const profile = values['seed-profile']
  ? SeedProfile.parse(JSON.parse(readFileSync(values['seed-profile'], 'utf8')))
  : null;

const db = await signInStaff(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
  email: env('SIA_STAFF_EMAIL'),
  password: env('SIA_STAFF_PASSWORD'),
});
const ref = await submitCasePackage(db, { slug: result.case.slug, doc: result.case, origin: 'import' });
console.log(`imported ${result.case.slug} as version ${ref.version} (in review), case ${ref.case_id}`);

if (profile) {
  const seeded = await adminSetSeedProfile(db, ref.case_id, profile);
  console.log(`seed profile saved (${profile.sessions} sessions; generated on publish). live=${seeded.live_version ?? 'none'}`);
}
