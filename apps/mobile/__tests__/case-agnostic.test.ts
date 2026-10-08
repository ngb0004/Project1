import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CASE_STATUSES, CONFIDENCE_LEVELS, DEFAULT_MICRO_POLL_PROMPT, SOURCE_TYPES } from '@sia/case-schema';
import { loadFixtures } from './playThrough';

/**
 * The app and the dive screens have zero case-specific code: no distinctive
 * string from either fixture case appears in apps/mobile/src or
 * packages/dive-ui/src (packages/dive-engine checks its own src/ the same way).
 */
const ROOT = join(__dirname, '../../..');
const DIRS = ['apps/mobile/src', 'packages/dive-ui/src'];
const VOCABULARY = new Set<string>([
  ...CONFIDENCE_LEVELS,
  ...SOURCE_TYPES,
  ...CASE_STATUSES,
  'document',
  'quote',
  'timeline',
  'context',
  'slider',
  DEFAULT_MICRO_POLL_PROMPT,
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

function stringsOf(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsOf(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsOf(v, out));
  return out;
}

/** Whole-token match, so an id like "base-1" does not match inside "base-10000". */
const contains = (text: string, s: string) =>
  new RegExp(`(?<![a-z0-9_-])${s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_-])`).test(text);

const sources = DIRS.flatMap((d) => files(join(ROOT, d))).map((path) => ({
  file: relative(ROOT, path),
  text: readFileSync(path, 'utf8').toLowerCase(),
}));

it('has source files to check', () => {
  expect(sources.length).toBeGreaterThan(20);
});

it.each(loadFixtures().map((d) => [d.slug, d] as const))('no string from %s appears in the source', (_slug, doc) => {
  const distinctive = [...stringsOf(doc)].filter((s) => s.length >= 6 && !VOCABULARY.has(s));
  expect(distinctive.length).toBeGreaterThan(20);
  const found = sources.flatMap(({ file, text }) =>
    distinctive.filter((s) => contains(text, s)).map((s) => `${file}: "${s}"`),
  );
  expect(found).toEqual([]);
});
