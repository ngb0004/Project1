import { describe, expect, it } from 'vitest';
import { assertValidCase, computeBalance, toBalanceSummary } from '../src/index';
import { loadFixture } from './helpers';

describe('computeBalance', () => {
  it('counts steps per side and reports strongest positions', () => {
    const c = assertValidCase(loadFixture('fixture-harbor-bridge'));
    const b = computeBalance(c);
    expect(b.sides.map((s) => [s.side_id, s.count])).toEqual([
      ['council-responsible', 2],
      ['council-not-responsible', 2],
    ]);
    expect(b.sides[0]!.strongest_orders).toEqual([1]);
    expect(b.sides[1]!.strongest_orders).toEqual([3]);
    expect(b.warnings).toEqual([]);
    const summary = toBalanceSummary(b);
    expect(summary.per_side).toEqual({ 'council-responsible': 2, 'council-not-responsible': 2 });
    expect(summary.order).toEqual(['council-responsible', 'council-responsible', 'council-not-responsible', 'council-not-responsible']);
  });

  it("warns when one side's best facts are bunched at the end", () => {
    const c = assertValidCase(loadFixture('fixture-orchard-school'));
    // Move the vendor side's only high-impact fact to the end and add another.
    c.steps[5]!.favors = 'vendor';
    c.steps[5]!.impact = 'high';
    c.steps[4]!.favors = 'vendor';
    c.steps[4]!.impact = 'high';
    c.steps[1]!.favors = 'district';
    const b = computeBalance(c);
    expect(b.warnings.some((w) => w.includes('bunched in the last third'))).toBe(true);
  });

  it('warns when a side has no steps', () => {
    const c = assertValidCase(loadFixture('fixture-orchard-school'));
    c.steps.forEach((s) => (s.favors = 'district'));
    const b = computeBalance(c);
    expect(b.warnings).toContain('No step favors "The vendor failed".');
  });
});
