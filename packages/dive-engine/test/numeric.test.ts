import { describe, expect, it } from 'vitest';
import { seedWeight } from '@sia/case-schema';
import { WeightedSum, ZERO, compare, div, int, ratio, round, seedWeightDec, seedWeightFromFloat, type Dec } from '../src/numeric';

const dec = (s: string): Dec => {
  const [i, f = ''] = s.split('.');
  return { v: BigInt(`${i}${f}`), s: f.length };
};

/** The values below were read from Postgres 17 (supabase/tests/parity.test.ts checks many more live). */
describe('numeric emulation', () => {
  it('rounds halves away from zero and never returns -0', () => {
    expect(round(dec('0.125'), 2)).toBe(0.13);
    expect(round(dec('-0.125'), 2)).toBe(-0.13);
    expect(round(dec('0.03125'), 4)).toBe(0.0313);
    expect(round(dec('0.00625'), 4)).toBe(0.0063);
    expect(round(dec('-2.345'), 2)).toBe(-2.35);
    expect(Object.is(round(dec('-0.001'), 2), 0)).toBe(true);
    expect(round(int(7), 4)).toBe(7);
  });

  it('divides at the result scale Postgres selects (at least 16 significant digits)', () => {
    expect(div(int(3), int(7))).toEqual(dec('0.42857142857142857143'));
    expect(div(int(0), int(500))).toEqual({ v: 0n, s: 20 });
    expect(div(int(1), int(20000))).toEqual(dec('0.000050000000000000000000'));
    expect(div(dec('270.14'), dec('5.71'))).toEqual(dec('47.3099824868651489'));
    expect(div(dec('0.00001'), int(3))).toEqual(dec('0.000003333333333333333333'));
  });

  it('reproduces the case where exact arithmetic and Postgres disagree', () => {
    // (165 + 184w) / (4 + 3w) with w = 1 - 3/7 is exactly 47.275, but Postgres's
    // w is cut at 20 places, so the quotient is 47.27499999999999999999.
    const w = seedWeightDec(3, 7);
    const num = { v: 165n * 10n ** 20n + 184n * w.v, s: 20 };
    const den = { v: 4n * 10n ** 20n + 3n * w.v, s: 20 };
    expect(div(num, den)).toEqual(dec('47.27499999999999999999'));
    expect(round(div(num, den), 2)).toBe(47.27);
  });

  it('computes seed weights like public.seed_weight(), including the literal 0 from greatest()', () => {
    expect(seedWeightDec(3, 7)).toEqual(dec('0.57142857142857142857'));
    expect(seedWeightDec(0, 500)).toEqual(dec('1.00000000000000000000'));
    expect(seedWeightDec(2, 2)).toEqual(ZERO);
    expect(seedWeightDec(9, 2)).toEqual(ZERO);
    expect(seedWeightDec(5, 0)).toEqual(ZERO);
  });

  it('recovers the database weight from the float seedWeight() returns', () => {
    for (const [real, threshold] of [
      [0, 1],
      [3, 7],
      [1, 3],
      [123, 500],
      [499, 500],
      [17, 99991],
      [1, 20000],
    ] as const) {
      expect(seedWeightFromFloat(seedWeight(real, threshold)), `${real}/${threshold}`).toEqual(
        // reduced fractions select the same scale here
        seedWeightDec(real, threshold),
      );
    }
    expect(seedWeightFromFloat(0)).toEqual(ZERO);
    expect(seedWeightFromFloat(1)).toEqual(seedWeightDec(0, 1));
  });

  it('sums like SQL: null over no rows, and a seeded product carries the weight scale', () => {
    const w = seedWeightDec(1, 4); // 0.75000000000000000000
    const sum = new WeightedSum();
    expect(sum.value(w)).toBeNull();
    sum.add(10, false);
    expect(sum.value(w)).toEqual(int(10));
    sum.add(0, true);
    expect(sum.value(w)).toEqual({ v: 10n * 10n ** 20n, s: 20 });
    sum.add(4, true);
    expect(round(sum.value(w)!, 2)).toBe(13);
    expect(ratio(sum.value(w), ZERO)).toBeNull();
    expect(ratio(null, int(1))).toBeNull();
    expect(compare(dec('1.50'), dec('1.5'))).toBe(0);
    expect(compare(dec('-1'), dec('0.1'))).toBe(-1);
  });
});
