/**
 * Just enough of Postgres `numeric` to reproduce the crowd aggregates digit for
 * digit: exact sums and products, division at the result scale Postgres picks,
 * and round() with halves away from zero. Floating point is not enough: with a
 * seed weight like 1 - 3/7 the database lands on 47.27499999999999999999 and
 * rounds to 47.27, where exact arithmetic would give 47.28.
 *
 * A Dec is the value v / 10^s, with s the numeric's display scale.
 */

export interface Dec {
  v: bigint;
  s: number;
}

const pow10 = (n: number) => 10n ** BigInt(n);

export const ZERO: Dec = { v: 0n, s: 0 };

export function int(n: number): Dec {
  return { v: BigInt(n), s: 0 };
}

const at = (a: Dec, s: number) => a.v * pow10(s - a.s);

export function sub(a: Dec, b: Dec): Dec {
  const s = Math.max(a.s, b.s);
  return { v: at(a, s) - at(b, s), s };
}

export function compare(a: Dec, b: Dec): number {
  const d = sub(a, b).v;
  return d === 0n ? 0 : d < 0n ? -1 : 1;
}

/** Integer division rounded half away from zero. */
function divRound(n: bigint, d: bigint): bigint {
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n;
  return negative ? -q : q;
}

/** Weight and value of the leading non-zero base-10000 digit group, as Postgres stores a numeric. */
function leadingGroup(a: Dec): [weight: number, digit: number] {
  if (a.v === 0n) return [0, 0];
  const digits = (a.v < 0n ? -a.v : a.v).toString();
  const top = digits.length - a.s - 1; // power of ten of the leading digit
  const weight = Math.floor(top / 4);
  const len = top - 4 * weight + 1; // digits from the leading one down to the group's last place
  return [weight, Number(digits.slice(0, len).padEnd(len, '0'))];
}

/** numeric_div(): select_div_scale() keeps at least 16 significant digits, then rounds. */
export function div(a: Dec, b: Dec): Dec {
  const [w1, d1] = leadingGroup(a);
  const [w2, d2] = leadingGroup(b);
  const qweight = w1 - w2 - (d1 <= d2 ? 1 : 0);
  const s = Math.min(Math.max(16 - qweight * 4, a.s, b.s, 0), 1000);
  return { v: divRound(a.v * pow10(b.s + s), b.v * pow10(a.s)), s };
}

/** round(numeric, dp) as a JS number (the value JSON.parse reads from the database's output). */
export function round(a: Dec, dp: number): number {
  const v = a.s <= dp ? a.v * pow10(dp - a.s) : divRound(a.v, pow10(a.s - dp));
  return Number(v) / 10 ** dp;
}

/** public.seed_weight() inside app.seed_weight_for(): greatest(0, 1 - real::numeric / threshold). */
export function seedWeightDec(realCompletions: number, threshold: number): Dec {
  if (threshold <= 0) return ZERO;
  const w = sub(int(1), div(int(realCompletions), int(threshold)));
  return w.v > 0n ? w : ZERO; // greatest() keeps its first argument, the literal 0, on a tie
}

/** The simplest fraction p/q (q <= 1e6) within 1e-13 of x, from its continued fraction. */
function fraction(x: number): [number, number] | null {
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let y = x;
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(y);
    [h0, h1] = [h1, a * h1 + h0];
    [k0, k1] = [k1, a * k1 + k0];
    if (k1 > 1e6) return null;
    if (Math.abs(x - h1 / k1) <= 1e-13) return [h1, k1];
    y = 1 / (y - a);
  }
  return null;
}

/**
 * A seed weight given as a float (1 - real / threshold), recomputed the way the
 * database computes it. Falls back to 20 decimal places for weights that do not
 * come from a threshold below a million.
 */
export function seedWeightFromFloat(w: number): Dec {
  if (!(w > 0)) return ZERO;
  if (w >= 1) return seedWeightDec(0, 1);
  const f = fraction(1 - w);
  if (f) return seedWeightDec(f[0], f[1]);
  return { v: BigInt(w.toFixed(20).replace('.', '')), s: 20 };
}

/**
 * Σ wt·x over a set of rows, where real rows weigh 1 and seeded rows weigh the
 * seed weight. Kept as two exact integer parts so the weight can be applied in
 * numeric at the end. Like SQL's sum(), it is null over no rows.
 */
export class WeightedSum {
  private real = 0;
  private seeded = 0;
  private rows = 0;
  private seedRows = 0;

  add(x: number, isSeed: boolean): void {
    this.rows += 1;
    if (isSeed) {
      this.seedRows += 1;
      this.seeded += x;
    } else {
      this.real += x;
    }
  }

  value(w: Dec): Dec | null {
    if (this.rows === 0) return null;
    // A product carries the weight's scale into the sum, even when it adds zero.
    if (this.seedRows === 0) return int(this.real);
    return { v: BigInt(this.real) * pow10(w.s) + w.v * BigInt(this.seeded), s: w.s };
  }
}

/** a / nullif(b, 0), null-propagating. */
export function ratio(a: Dec | null, b: Dec | null): Dec | null {
  if (a === null || b === null || b.v === 0n) return null;
  return div(a, b);
}

export const roundOrNull = (a: Dec | null, dp: number): number | null => (a === null ? null : round(a, dp));
