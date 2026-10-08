import { NEUTRAL, type BalanceSummary, type Case, type Impact } from './schema';

export interface BalanceStep {
  step_id: string;
  order: number;
  favors: string | null;
  impact: Impact;
  /** 0 for the first step, 1 for the last. */
  position: number;
}

export interface SideBalance {
  side_id: string;
  label: string;
  count: number;
  /** Orders (1-based) of this side's strongest facts. */
  strongest_orders: number[];
  /** Mean position (0..1) of this side's strongest facts, or null if none. */
  strongest_mean_position: number | null;
}

export interface BalanceReport {
  steps: BalanceStep[];
  sides: SideBalance[];
  neutral: number;
  untagged: number;
  warnings: string[];
}

const IMPACT_RANK: Record<Impact, number> = { low: 0, medium: 1, high: 2 };

/**
 * Balance of the fact order: steps per side and where each side's strongest
 * facts fall. Warns when one side's best facts are bunched at the end.
 *
 * "Strongest" means the side's highest-impact steps (impact defaults to medium).
 */
export function computeBalance(c: Pick<Case, 'steps' | 'sides'>): BalanceReport {
  const n = c.steps.length;
  const steps: BalanceStep[] = c.steps.map((s, i) => ({
    step_id: s.id,
    order: s.order,
    favors: s.favors ?? null,
    impact: s.impact ?? 'medium',
    position: n <= 1 ? 0 : i / (n - 1),
  }));

  const sides: SideBalance[] = c.sides.map((side) => {
    const mine = steps.filter((s) => s.favors === side.id);
    const top = mine.length ? Math.max(...mine.map((s) => IMPACT_RANK[s.impact])) : -1;
    const strongest = mine.filter((s) => IMPACT_RANK[s.impact] === top);
    const mean = strongest.length
      ? strongest.reduce((a, s) => a + s.position, 0) / strongest.length
      : null;
    return {
      side_id: side.id,
      label: side.label,
      count: mine.length,
      strongest_orders: strongest.map((s) => s.order),
      strongest_mean_position: mean,
    };
  });

  const warnings: string[] = [];
  const lastThird = (p: number) => p > 2 / 3;

  for (const s of sides) {
    if (s.count === 0) {
      warnings.push(`No step favors "${s.label}".`);
      continue;
    }
    const strong = steps.filter((st) => s.strongest_orders.includes(st.order));
    if (n >= 3 && strong.length >= 2 && strong.every((st) => lastThird(st.position))) {
      warnings.push(`All of "${s.label}"'s strongest facts are bunched in the last third of the dive.`);
    } else if (n >= 3 && strong.length === 1 && steps.length > 0 && strong[0]!.order === n) {
      warnings.push(`"${s.label}"'s strongest fact is the final step, where it carries extra weight.`);
    }
  }

  const counts = sides.map((s) => s.count);
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  if (min > 0 && max >= 2 * min && max - min >= 2) {
    const big = sides.find((s) => s.count === max)!;
    const small = sides.find((s) => s.count === min)!;
    warnings.push(`"${big.label}" has ${max} steps in its favor; "${small.label}" has ${min}.`);
  }

  return {
    steps,
    sides,
    neutral: steps.filter((s) => s.favors === NEUTRAL).length,
    untagged: steps.filter((s) => s.favors === null).length,
    warnings,
  };
}

/** The compact form stored in `review.balance` of a package. */
export function toBalanceSummary(report: BalanceReport): BalanceSummary {
  return {
    per_side: Object.fromEntries(report.sides.map((s) => [s.side_id, s.count])),
    neutral: report.neutral,
    untagged: report.untagged,
    order: report.steps.map((s) => s.favors ?? 'untagged'),
    warnings: report.warnings,
  };
}
