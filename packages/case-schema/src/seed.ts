import { z } from 'zod';
import { AFTER, BEFORE, LocalId, type StepKey } from './schema';

/**
 * Seeded crowd data. v1 has no real crowd yet, so the admin writes a seed
 * profile per case: a Before distribution plus a per-step shift. Seeded rows are
 * stored with `is_seed = true` and fade out as real completions arrive.
 */

export const SeedShift = z
  .object({
    /** Share of seeded sessions that move at this step (0..1). */
    move_share: z.number().min(0).max(1),
    /** Average change among those who move, in slider points. Negative moves toward the left label. */
    mean_shift: z.number().min(-100).max(100),
    /** Standard deviation of the change among those who move. */
    spread: z.number().min(0).max(50),
  })
  .strict();
export type SeedShift = z.infer<typeof SeedShift>;

export const SeedProfile = z
  .object({
    /** Number of seeded sessions to generate per published version. */
    sessions: z.number().int().min(0).max(5000),
    /** Relative weights for the Before answer in ten 10-point bins (0-9, 10-19, ..., 90-100). */
    before_bins: z
      .array(z.number().min(0))
      .length(10)
      .refine((b) => b.some((x) => x > 0), 'at least one bin must be positive'),
    /** Per-step shift, keyed by step id. Steps without an entry do not move seeded sessions. */
    steps: z.record(LocalId, SeedShift).default({}),
    /** Change at the After question relative to the last step. */
    after: SeedShift.optional(),
    /** Seeds fade out linearly and are gone once this many real completions exist. */
    fade_after_real_completions: z.number().int().min(1).default(500),
    /** Deterministic generator seed. */
    rng_seed: z.number().int().default(1),
    /** Where the admin's estimate came from. Shown in the admin console. */
    note: z.string().max(2000).optional(),
  })
  .strict();
export type SeedProfile = z.infer<typeof SeedProfile>;
export type SeedProfileInput = z.input<typeof SeedProfile>;

export interface SeedAnswer {
  step_id: StepKey;
  value: number;
}
export interface SeedSession {
  index: number;
  answers: SeedAnswer[];
}

/** mulberry32: small, fast, deterministic PRNG. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: () => number): number {
  // Box-Muller
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

function sampleBefore(bins: number[], rng: () => number): number {
  const total = bins.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < bins.length; i++) {
    r -= bins[i]!;
    if (r <= 0) {
      const lo = i * 10;
      const hi = i === 9 ? 100 : i * 10 + 9;
      return clamp(lo + rng() * (hi - lo));
    }
  }
  return 50;
}

function applyShift(value: number, shift: SeedShift | undefined, rng: () => number): number {
  if (!shift || rng() >= shift.move_share) return value;
  return clamp(value + shift.mean_shift + normal(rng) * shift.spread);
}

/**
 * Generates seeded sessions for a case version. Deterministic for a given
 * profile and step list, so regenerating after an edit is reproducible.
 */
export function generateSeedSessions(
  profileInput: SeedProfileInput,
  stepIds: readonly string[],
): SeedSession[] {
  const profile = SeedProfile.parse(profileInput);
  const rng = createRng(profile.rng_seed);
  const sessions: SeedSession[] = [];
  for (let i = 0; i < profile.sessions; i++) {
    let value = sampleBefore(profile.before_bins, rng);
    const answers: SeedAnswer[] = [{ step_id: BEFORE, value }];
    for (const id of stepIds) {
      value = applyShift(value, Object.hasOwn(profile.steps, id) ? profile.steps[id] : undefined, rng);
      answers.push({ step_id: id, value });
    }
    value = applyShift(value, profile.after, rng);
    answers.push({ step_id: AFTER, value });
    sessions.push({ index: i, answers });
  }
  return sessions;
}

/**
 * How much seeded rows count in aggregates: 1 with no real completions, falling
 * linearly to 0 at the admin's threshold. Mirrored by `public.seed_weight()` in SQL.
 */
export function seedWeight(realCompletions: number, threshold: number): number {
  if (threshold <= 0) return 0;
  return Math.max(0, 1 - realCompletions / threshold);
}
