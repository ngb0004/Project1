#!/usr/bin/env tsx
/**
 * Validates every case JSON file under the given directories.
 * Usage: validate-case <dir-or-file>...
 * Files named `*.seed-profile.json` are validated as seed profiles.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SeedProfile, validateCase } from '../src/index';

function walk(p: string): string[] {
  if (statSync(p).isFile()) return [p];
  return readdirSync(p).flatMap((f) => (f === 'node_modules' ? [] : walk(join(p, f))));
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: validate-case <dir-or-file>...');
  process.exit(2);
}

let failed = 0;
for (const file of targets.flatMap(walk).filter((f) => f.endsWith('.json'))) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (file.endsWith('.seed-profile.json')) {
    const r = SeedProfile.safeParse(json);
    console.log(`${r.success ? 'ok  ' : 'FAIL'} ${file}`);
    if (!r.success) {
      failed++;
      for (const i of r.error.issues) console.log(`     error ${i.path.join('.')}: ${i.message}`);
    }
    continue;
  }
  if (!('steps' in json)) continue; // not a case document (e.g. a package manifest)
  const r = validateCase(json);
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${file} (${r.warnings.length} warning(s))`);
  for (const e of r.errors) console.log(`     error ${e.path} [${e.code}]: ${e.message}`);
  for (const w of r.warnings) console.log(`     warn  ${w.path} [${w.code}]: ${w.message}`);
  if (!r.ok) failed++;
}
process.exit(failed ? 1 : 0);
