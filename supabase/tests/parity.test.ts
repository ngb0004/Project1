import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPublish, adminSetSeedProfile, type Db } from '@sia/case-store';
import { createRng, seedWeight } from '@sia/case-schema';
import { computeFinalCrowd, computeStepCrowd, type CrowdRow } from '../../packages/dive-engine/src/local';
import { div, int, round, seedWeightDec, type Dec } from '../../packages/dive-engine/src/numeric';
import { pool, sql, submitFixture, userClient } from './helpers';

/**
 * The in-memory dive API (LocalDiveApi) must report exactly the crowd numbers
 * the database does. These tests write deterministic sessions straight into a
 * fresh published case and compare computeStepCrowd / computeFinalCrowd with
 * app.step_crowd / app.final_crowd for every step, with and without seeds.
 * The engine's emulation of Postgres numeric (division scale and rounding) is
 * checked against the database digit for digit first.
 *
 * Rows are inserted directly (no RPCs), so rate limits and the reading-time
 * floor play no part and app.settings is never touched. Response-level
 * exclusion (one answer under the reading-time floor) is not modeled by
 * CrowdRow, so only whole-session exclusion is covered here.
 */

let admin: Db;
let pipeline: Db;

beforeAll(async () => {
  [admin, pipeline] = await Promise.all([userClient('admin'), userClient('pipeline')]);
});
afterAll(() => pool.end());

type Fixture = 'fixture-harbor-bridge' | 'fixture-orchard-school';

interface Version {
  caseId: string;
  version: number;
  stepIds: string[];
  threshold: number;
}

/** A fresh published case whose seed weight fades out after `threshold` real completions. */
async function freshVersion(fixture: Fixture, threshold = 500): Promise<Version> {
  const ref = await submitFixture(pipeline, fixture);
  await adminPublish(admin, ref.case_id, ref.version);
  // No generated seeds (sessions: 0): the tests write their own seeded rows.
  await adminSetSeedProfile(admin, ref.case_id, {
    sessions: 0,
    before_bins: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    fade_after_real_completions: threshold,
  });
  const [row] = await sql<{ doc: { steps: { id: string }[] } }>(
    `select public_doc as doc from public.case_versions where case_id = $1 and version = $2`,
    [ref.case_id, ref.version],
  );
  return { caseId: ref.case_id, version: ref.version, stepIds: row!.doc.steps.map((s) => s.id), threshold };
}

interface Planned {
  is_seed?: boolean;
  excluded?: boolean;
  /** Answers by slot index: 0 = before, 1..n steps, n+1 = after. A prefix; stop early for an unfinished dive. */
  values: number[];
}

/** Writes sessions and responses as postgres and returns the same data as CrowdRows. */
async function insert(v: Version, planned: Planned[]): Promise<CrowdRow[]> {
  const slots = ['before', ...v.stepIds, 'after'];
  const rows: CrowdRow[] = planned.map((p) => ({
    session_id: randomUUID(),
    is_seed: p.is_seed ?? false,
    excluded: p.excluded ?? false,
    values: p.values,
  }));
  const r = { sid: [] as string[], step: [] as string[], idx: [] as number[], val: [] as number[], seed: [] as boolean[] };
  planned.forEach((p, n) => {
    p.values.forEach((value, i) => {
      r.sid.push(rows[n]!.session_id);
      r.step.push(slots[i]!);
      r.idx.push(i);
      r.val.push(value);
      r.seed.push(rows[n]!.is_seed);
    });
  });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into public.sessions (id, case_id, case_version, device_hash, is_seed, completed_at, excluded, started_at)
       select id, $1, $2, 'parity:' || id::text, s, case when c then now() end, e, now() - interval '1 hour'
       from unnest($3::uuid[], $4::bool[], $5::bool[], $6::bool[]) as t(id, s, c, e)`,
      [
        v.caseId,
        v.version,
        rows.map((x) => x.session_id),
        rows.map((x) => x.is_seed),
        rows.map((x) => x.values.length === slots.length),
        rows.map((x) => x.excluded),
      ],
    );
    await client.query(
      `insert into public.responses (session_id, case_id, case_version, step_id, step_index, value, is_seed)
       select sid, $1, $2, step, idx, val, s
       from unnest($3::uuid[], $4::text[], $5::int[], $6::int[], $7::bool[]) as t(sid, step, idx, val, s)`,
      [v.caseId, v.version, r.sid, r.step, r.idx, r.val, r.seed],
    );
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
  return rows;
}

function localSeedWeight(v: Version, rows: CrowdRow[], includeSeed: boolean): number {
  if (!includeSeed) return 0;
  const real = rows.filter((r) => !r.is_seed && !r.excluded && r.values.length === v.stepIds.length + 2).length;
  return seedWeight(real, v.threshold);
}

/** Asserts parity for every step and the final reveal; returns the SQL results for extra checks. */
async function expectParity(v: Version, rows: CrowdRow[], includeSeed: boolean) {
  const w = localSeedWeight(v, rows, includeSeed);
  const steps = [];
  for (const [i, stepId] of v.stepIds.entries()) {
    const [{ c }] = await sql(`select app.step_crowd($1, $2, $3, $4) as c`, [v.caseId, v.version, stepId, includeSeed]);
    expect(computeStepCrowd(rows, stepId, i + 1, w), `step ${stepId}, include_seed ${includeSeed}`).toEqual(c);
    steps.push(c);
  }
  const [{ c: final }] = await sql(`select app.final_crowd($1, $2, $3) as c`, [v.caseId, v.version, includeSeed]);
  expect(computeFinalCrowd(rows, v.stepIds, w), `final, include_seed ${includeSeed}`).toEqual(final);
  return { steps, final };
}

const flat = (n: number, value: number) => Array<number>(n).fill(value);

/** Postgres's text form of a numeric. */
function text(d: Dec): string {
  const neg = d.v < 0n;
  const digits = (neg ? -d.v : d.v).toString().padStart(d.s + 1, '0');
  const body = d.s === 0 ? digits : `${digits.slice(0, -d.s)}.${digits.slice(-d.s)}`;
  return neg ? `-${body}` : body;
}

describe('numeric emulation matches Postgres', () => {
  it('division scale, rounding and seed weights, digit for digit', async () => {
    const rng = createRng(5);
    const pick = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
    const cases: { expr: string; local: string | number }[] = [];
    for (let i = 0; i < 300; i++) {
      const [r, t] = [pick(0, 40), pick(1, 60000)];
      const w = seedWeightDec(r, t);
      // (a + b*w) / (c + d*w): the shape of every weighted aggregate
      const [a, b, c, d] = [pick(-500, 5000), pick(0, 900), pick(1, 50), pick(1, 40)];
      const scaled = (n: number) => BigInt(n) * 10n ** BigInt(w.s);
      const q = div({ v: scaled(a) + BigInt(b) * w.v, s: w.s }, { v: scaled(c) + BigInt(d) * w.v, s: w.s });
      const sw = `greatest(0, 1 - ${r}::numeric / ${t})`;
      const expr = `(${a} + ${b} * ${sw}) / (${c} + ${d} * ${sw})`;
      cases.push(
        { expr: sw, local: text(w) },
        { expr, local: text(q) },
        { expr: `round(${expr}, 2)`, local: round(q, 2) },
        { expr: `round(${expr}, 4)`, local: round(q, 4) },
        { expr: `${a}::numeric / ${d * 7}`, local: text(div(int(a), int(d * 7))) },
      );
    }
    // The expressions are built from integers above, so inlining them is safe.
    const values = cases.map((c, i) => `(${i}, (${c.expr})::text)`).join(',\n');
    const rows = await sql<{ v: string }>(`select v from (values ${values}) as t(i, v) order by i`);
    cases.forEach((c, i) => {
      const db = rows[i]!.v;
      // round() keeps trailing zeros in its text form; JSON readers see the number.
      if (typeof c.local === 'number') expect(c.local, c.expr).toBe(Number(db));
      else expect(c.local, c.expr).toBe(db);
    });
  });
});

describe('LocalDiveApi crowd math matches the database', () => {
  it('an empty version', async () => {
    const v = await freshVersion('fixture-harbor-bridge');
    const { steps, final } = await expectParity(v, [], true);
    expect(steps[0].histogram).toBeNull();
    expect(final.top_step_id).toBeNull();
  });

  it('hand-built edge cases: shift buckets, bin edges, unfinished and excluded sessions, fractional seed weight', async () => {
    // harbor-bridge: slots are before, s1..s4, after (indexes 0..5)
    const v = await freshVersion('fixture-harbor-bridge', 7);
    const rows = await insert(v, [
      // real, completed (3 real completions -> seed weight 1 - 3/7)
      { values: [50, 35, 36, 50, 49, 49] }, // -15, +1, +14, -1, 0
      { values: [100, 86, 100, 100, 85, 85] }, // -14, +14, 0, -15, 0
      { values: [0, 15, 9, 10, 99, 100] }, // +15, -6, +1, +89, +1
      // real, unfinished: counts at the steps it answered, never in the final crowd
      { values: [60, 60, 20] },
      { values: [40] },
      // real, completed but excluded (reading-time floor): counts nowhere
      { excluded: true, values: [10, 90, 90, 90, 90, 90] },
      // seeded, completed
      { is_seed: true, values: [70, 70, 55, 55, 55, 60] },
      { is_seed: true, values: [20, 34, 34, 20, 20, 20] },
      { is_seed: true, values: [95, 95, 95, 95, 95, 95] },
      // seeded, unfinished
      { is_seed: true, values: [30, 45] },
    ]);
    const { steps, final } = await expectParity(v, rows, true);
    expect(steps[0].seed_weight).toBe(0.5714);
    expect(steps[0].n_real).toBe(4);
    expect(steps[0].n_seed).toBe(4);
    expect(final.n_real).toBe(3);
    expect(final.n_seed).toBe(3);
    await expectParity(v, rows, false);
  });

  it('rounds halves away from zero exactly as Postgres numeric does', async () => {
    const v = await freshVersion('fixture-harbor-bridge');
    const planned: Planned[] = Array.from({ length: 160 }, () => ({ values: flat(6, 50) }));
    planned[0]!.values = [50, 51, 51, 51, 51, 51]; // s1: 1/160 moved = 0.00625 -> 0.0063; mean_delta 0.00625 -> 0.01
    for (const i of [1, 2, 3, 4]) planned[i]!.values = [50, 50, 49, 49, 49, 49]; // s2: mean_delta -4/160 = -0.025 -> -0.03
    planned[5]!.values = [50, 50, 50, 30, 30, 30]; // s3: mean_delta -20/160 = -0.125 -> -0.13
    const rows = await insert(v, planned);
    const { steps, final } = await expectParity(v, rows, true);
    expect(steps[0].moved_share).toBe(0.0063);
    expect(steps[1].mean_delta).toBe(-0.03);
    expect(steps[2].mean_delta).toBe(-0.13);
    expect(final.top_step_id).toBe('s3');
  });

  it('ties for the step that moved the crowd most go to the earlier step', async () => {
    const v = await freshVersion('fixture-harbor-bridge');
    const rows = await insert(v, [
      { values: [50, 50, 40, 40, 50, 50] }, // s2 -10, s4 +10
      { values: [70, 70, 75, 75, 70, 70] }, // s2 +5, s4 -5
    ]);
    const { final } = await expectParity(v, rows, true);
    expect(final.top_step_id).toBe('s2');
  });

  it('nobody moved: every step ties at zero', async () => {
    const v = await freshVersion('fixture-harbor-bridge');
    const rows = await insert(v, [{ values: flat(6, 40) }, { values: flat(6, 60) }]);
    const { final } = await expectParity(v, rows, true);
    expect(final.top_step_id).toBe('s1');
  });

  it('seeds that have fully faded (or are left out) still count in n_seed with zero weight', async () => {
    const v = await freshVersion('fixture-harbor-bridge', 2);
    const seeds: Planned[] = [
      { is_seed: true, values: [10, 30, 30, 30, 30, 30] },
      { is_seed: true, values: [90, 80, 80, 80, 80, 80] },
    ];
    const seedRows = await insert(v, seeds);
    // Seeds only, include_seed false: rows exist but carry no weight.
    const left = await expectParity(v, seedRows, false);
    expect(left.steps[0]).toMatchObject({ n_seed: 2, histogram: null, mean_delta: null, shift: null });
    expect(left.final.steps[0]).toMatchObject({ mean_delta: null, moved_share: 0 });

    // Two real completions reach the threshold of 2: seed weight 0.
    const real = await insert(v, [{ values: [50, 55, 55, 55, 55, 55] }, { values: [20, 20, 20, 20, 20, 25] }]);
    const rows = [...seedRows, ...real];
    const { steps } = await expectParity(v, rows, true);
    expect(steps[0]).toMatchObject({ seed_weight: 0, seeded_share: 0, n_seed: 2, n_real: 2 });
  });

  for (const [fixture, rngSeed] of [
    ['fixture-orchard-school', 11],
    ['fixture-orchard-school', 29],
    ['fixture-harbor-bridge', 47],
  ] as const) {
    it(`a generated mix of real and seeded sessions (${fixture}, rng ${rngSeed})`, async () => {
      const rng = createRng(rngSeed);
      const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
      const v = await freshVersion(fixture, 200);
      const slots = v.stepIds.length + 2;
      const planned: Planned[] = Array.from({ length: 120 }, () => {
        let value = rng() < 0.15 ? (rng() < 0.5 ? 0 : 100) : int(0, 100);
        const values = [value];
        const answered = rng() < 0.75 ? slots : int(1, slots - 1);
        for (let i = 1; i < answered; i++) {
          const r = rng();
          if (r < 0.4) value = Math.max(0, Math.min(100, value + int(-30, 30)));
          else if (r < 0.5) value = int(0, 100);
          values.push(value);
        }
        return { is_seed: rng() < 0.4, excluded: rng() < 0.08, values };
      });
      const rows = await insert(v, planned);
      const { steps, final } = await expectParity(v, rows, true);
      expect(steps.every((s) => s.n_real > 0 && s.n_seed > 0)).toBe(true);
      expect(final.seed_weight).toBeGreaterThan(0);
      expect(final.seed_weight).toBeLessThan(1);
      await expectParity(v, rows, false);
    });
  }
});
