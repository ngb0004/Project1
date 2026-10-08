import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidCase, toPublicCase, type PublicCase } from '@sia/case-schema';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

export const FIXTURES = ['fixture-harbor-bridge', 'fixture-orchard-school'] as const;
export type FixtureName = (typeof FIXTURES)[number];

/** A fixture case as the dive app receives it: validated, then projected to its public form. */
export function loadFixture(name: FixtureName): PublicCase {
  const raw = JSON.parse(readFileSync(join(root, 'cases/fixtures', `${name}.json`), 'utf8'));
  return toPublicCase(assertValidCase(raw));
}

/** Every string value anywhere in a JSON document. */
export function stringsOf(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsOf(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsOf(v, out));
  return out;
}

let device = 0;
/** A device id long enough for start_session (16+ characters). */
export function deviceId(): string {
  device += 1;
  return `test-device-${String(device).padStart(8, '0')}`;
}

/** A fixed clock that moves forward a minute per call. */
export function clock(start = Date.UTC(2026, 9, 8, 12)): () => number {
  let t = start;
  return () => (t += 60_000);
}
