import {
  CONFIDENCE_LEVELS,
  Confidence as ConfidenceSchema,
  DEFAULT_MICRO_POLL_PROMPT,
  type Case,
  type CaseInput,
  type Confidence,
  type Source,
} from './schema';
import { maxConfidenceFor } from './validate';

const RANK: Record<Confidence, number> = Object.fromEntries(
  CONFIDENCE_LEVELS.map((c, i) => [c, i]),
) as Record<Confidence, number>;

/** The weaker (later in the list) of two confidence labels. */
export function weakerConfidence(a: Confidence, b: Confidence): Confidence {
  return (RANK[a] ?? Infinity) >= (RANK[b] ?? Infinity) ? a : b;
}

export interface NormalizeChange {
  path: string;
  change: string;
}

/**
 * Mechanical fixes the editor applies before validation:
 * - steps sorted by `order` and renumbered 1..n
 * - `established` downgraded to `reported` where only news/analysis sources are cited
 * - missing micro-poll filled with the default prompt
 *
 * Returns a new object; the input is not mutated.
 */
export function normalizeCase<T extends Case | CaseInput>(input: T): { case: T; changes: NormalizeChange[] } {
  const c = structuredClone(input) as Case;
  const changes: NormalizeChange[] = [];
  const sources = new Map<string, Source>((c.sources ?? []).map((s) => [s.id, s]));
  const cited = (ids: string[]) => ids.map((id) => sources.get(id)).filter((s): s is Source => !!s);

  const isConfidence = (v: unknown): v is Confidence => ConfidenceSchema.safeParse(v).success;

  if (Array.isArray(c.steps)) {
    // Sort and renumber only when every step has a usable order; otherwise leave
    // the steps alone so the validator reports the problem instead of guessing.
    const orders = c.steps.map((s) => s.order);
    const sortable = orders.every((o) => Number.isInteger(o)) && new Set(orders).size === orders.length;
    if (sortable) {
      const before = c.steps.map((s) => s.id).join(',');
      c.steps.sort((a, b) => a.order - b.order);
      if (c.steps.map((s) => s.id).join(',') !== before) changes.push({ path: 'steps', change: 'sorted by order' });
    }
    c.steps.forEach((s, i) => {
      if (sortable && s.order !== i + 1) {
        changes.push({ path: `steps.${i}.order`, change: `renumbered ${s.order} -> ${i + 1}` });
        s.order = i + 1;
      }
      if (!s.micro_poll) {
        s.micro_poll = { prompt: DEFAULT_MICRO_POLL_PROMPT, re_ask_slider: true };
        changes.push({ path: `steps.${i}.micro_poll`, change: 'added default micro-poll' });
      }
      // Never invent a label: a missing or invalid confidence is left for the validator to report.
      if (!isConfidence(s.confidence)) return;
      const cap = maxConfidenceFor(cited(s.source_ids ?? []));
      const next = weakerConfidence(s.confidence, cap);
      if (next !== s.confidence) {
        changes.push({ path: `steps.${i}.confidence`, change: `${s.confidence} -> ${next} (secondary sources only)` });
        s.confidence = next;
      }
    });
  }
  (c.starting_facts ?? []).forEach((f, i) => {
    if (!isConfidence(f.confidence)) return;
    const cap = maxConfidenceFor(cited(f.source_ids ?? []));
    const next = weakerConfidence(f.confidence, cap);
    if (next !== f.confidence) {
      changes.push({ path: `starting_facts.${i}.confidence`, change: `${f.confidence} -> ${next} (secondary sources only)` });
      f.confidence = next;
    }
  });
  return { case: c as unknown as T, changes };
}
