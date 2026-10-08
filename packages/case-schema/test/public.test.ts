import { describe, expect, it } from 'vitest';
import { assertValidCase, PublicCase, toPublicCase } from '../src/index';
import { FIXTURES, loadFixture } from './helpers';

describe('toPublicCase', () => {
  it.each(FIXTURES)('strips every admin-only field from %s', (name) => {
    const c = assertValidCase(loadFixture(name));
    c.review.open_issues.push({ id: 'x', source: 'admin', severity: 'low', description: 'secret', resolved: false });
    c.starting_facts[0]!.evidence = [{ source_id: c.starting_facts[0]!.source_ids[0]!, quote: 'q' }];
    const pub = toPublicCase(c);
    const text = JSON.stringify(pub);
    for (const key of ['"favors"', '"impact"', '"evidence"', '"review"', '"status"']) {
      expect(text).not.toContain(key);
    }
    expect(PublicCase.safeParse(pub).success).toBe(true);
    expect(pub.steps.map((s) => s.id)).toEqual(c.steps.map((s) => s.id));
  });

  it('PublicCase rejects a document that still carries favors', () => {
    const c = assertValidCase(loadFixture('fixture-harbor-bridge'));
    const leaky = { ...toPublicCase(c), steps: c.steps };
    expect(PublicCase.safeParse(leaky).success).toBe(false);
  });
});
