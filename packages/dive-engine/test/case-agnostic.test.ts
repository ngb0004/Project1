import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CASE_STATUSES, CHECK_VERDICTS, CONFIDENCE_LEVELS, SOURCE_TYPES, TAKE_LENSES } from '@sia/case-schema';
import { FIXTURES, loadFixture, stringsOf } from './helpers';

/**
 * The engine has zero case-specific code: no case names, facts or copy. This
 * checks that no distinctive string from either fixture case appears anywhere
 * in src/ (schema vocabulary such as confidence levels is not case content).
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const VOCABULARY = new Set<string>([
  ...CONFIDENCE_LEVELS,
  ...SOURCE_TYPES,
  ...CASE_STATUSES,
  'document',
  'quote',
  'timeline',
  'context',
  'slider',
  // generic answer words: the fact-vote buttons, and the usual slider labels
  'agree',
  'disagree',
  'not sure',
  ...TAKE_LENSES,
  ...CHECK_VERDICTS,
]);

/** Whole-token match, so an id like "base-1" does not match inside "base-10000". */
const contains = (text: string, s: string) =>
  new RegExp(`(?<![a-z0-9_-])${s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_-])`).test(text);

describe('the engine is case-agnostic', () => {
  const sources = readdirSync(SRC)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(SRC, f), 'utf8').toLowerCase() }));

  it('has source files to check', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(FIXTURES)('src/ contains no string from %s', (name) => {
    const distinctive = [...stringsOf(loadFixture(name))].filter((s) => s.length >= 6 && !VOCABULARY.has(s.toLowerCase()));
    expect(distinctive.length).toBeGreaterThan(20);
    for (const { file, text } of sources) {
      for (const s of distinctive) expect(contains(text, s), `${file} contains "${s}"`).toBe(false);
    }
  });
});
