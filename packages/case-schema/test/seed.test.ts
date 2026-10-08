import { describe, expect, it } from 'vitest';
import { generateSeedSessions, seedWeight, SeedProfile } from '../src/index';

const profile = {
  sessions: 200,
  before_bins: [0, 0, 1, 1, 2, 3, 4, 4, 3, 2],
  steps: { s1: { move_share: 0.5, mean_shift: -10, spread: 5 }, s2: { move_share: 0.2, mean_shift: 8, spread: 3 } },
  after: { move_share: 0.1, mean_shift: -2, spread: 2 },
  fade_after_real_completions: 500,
  rng_seed: 7,
};

describe('seed profile', () => {
  it('generates deterministic, in-range sessions covering before, every step and after', () => {
    const a = generateSeedSessions(profile, ['s1', 's2', 's3']);
    const b = generateSeedSessions(profile, ['s1', 's2', 's3']);
    expect(a).toEqual(b);
    expect(a).toHaveLength(200);
    for (const s of a) {
      expect(s.answers.map((x) => x.step_id)).toEqual(['before', 's1', 's2', 's3', 'after']);
      for (const x of s.answers) {
        expect(Number.isInteger(x.value)).toBe(true);
        expect(x.value).toBeGreaterThanOrEqual(0);
        expect(x.value).toBeLessThanOrEqual(100);
      }
      // s3 has no shift entry, so nobody moves there
      expect(s.answers[3]!.value).toBe(s.answers[2]!.value);
    }
    const moved = a.filter((s) => s.answers[1]!.value !== s.answers[0]!.value).length;
    expect(moved).toBeGreaterThan(60);
    expect(moved).toBeLessThan(140);
    // empty bins 0-19 are never sampled
    expect(a.every((s) => s.answers[0]!.value >= 20)).toBe(true);
  });

  it('rejects a profile with no positive bins', () => {
    expect(SeedProfile.safeParse({ ...profile, before_bins: Array(10).fill(0) }).success).toBe(false);
  });

  it('fades linearly to zero at the threshold', () => {
    expect(seedWeight(0, 500)).toBe(1);
    expect(seedWeight(250, 500)).toBe(0.5);
    expect(seedWeight(500, 500)).toBe(0);
    expect(seedWeight(900, 500)).toBe(0);
  });
});
