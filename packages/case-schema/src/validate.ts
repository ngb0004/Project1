import type { z } from 'zod';
import {
  CONFIDENCE_LEVELS,
  Case,
  NEUTRAL,
  SECONDARY_SOURCE_TYPES,
  type Confidence,
  type Source,
} from './schema';
import { countSentences, findJudgingWords } from './style';

export type IssueCode =
  | 'schema'
  | 'step_uncited'
  | 'fact_uncited'
  | 'layer_uncited'
  | 'unknown_reference'
  | 'unknown_source'
  | 'duplicate_id'
  | 'step_order'
  | 'overstated_confidence'
  | 'unknown_side'
  | 'evidence_not_cited'
  | 'parent_version'
  | 'empty_case'
  // warnings
  | 'judging_word'
  | 'body_length'
  | 'unused_source'
  | 'missing_favors'
  | 'missing_impact'
  | 'no_open_questions'
  | 'as_of_future'
  | 'review_mismatch';

export interface Issue {
  /** Dotted path into the case document, e.g. `steps.2.source_ids`. */
  path: string;
  code: IssueCode;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  /** The parsed case (with defaults applied) when the input matches the schema. */
  case?: Case;
  errors: Issue[];
  warnings: Issue[];
}

export interface ValidateOptions {
  /** Reference time for date sanity checks. Defaults to now. */
  now?: Date;
}

export class CaseValidationError extends Error {
  constructor(public readonly errors: Issue[]) {
    super(`Invalid case: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'CaseValidationError';
  }
}

const CONFIDENCE_RANK = Object.fromEntries(CONFIDENCE_LEVELS.map((c, i) => [c, i])) as Record<Confidence, number>;

const pathOf = (p: ReadonlyArray<PropertyKey>) => p.map(String).join('.');

function mapZodIssue(issue: z.core.$ZodIssue): Issue {
  const path = pathOf(issue.path);
  const p = issue.path;
  const last = p[p.length - 1];
  // A missing source_ids array is as uncited as an empty one.
  const uncited = last === 'source_ids' && (issue.code === 'too_small' || issue.code === 'invalid_type');
  if (uncited && p.length === 3 && p[0] === 'steps') {
    return { path, code: 'step_uncited', message: 'Step has no sources. Every step must cite at least one.' };
  }
  if (uncited && p.length === 3 && p[0] === 'starting_facts') {
    return { path, code: 'fact_uncited', message: 'Starting fact has no sources. Every fact must cite at least one.' };
  }
  if (uncited && p[0] === 'steps' && p[2] === 'depth') {
    return { path, code: 'layer_uncited', message: 'Depth layer has no sources. Every layer must cite at least one.' };
  }
  return { path, code: 'schema', message: issue.message };
}

/** Validates an unknown value as a case document: schema first, then cross-field rules. */
export function validateCase(input: unknown, opts: ValidateOptions = {}): ValidationResult {
  const parsed = Case.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(mapZodIssue), warnings: [] };
  }
  const { errors, warnings } = checkCaseRules(parsed.data, opts);
  return { ok: errors.length === 0, case: parsed.data, errors, warnings };
}

/** Parses and validates, throwing `CaseValidationError` on any error. */
export function assertValidCase(input: unknown, opts: ValidateOptions = {}): Case {
  const result = validateCase(input, opts);
  if (!result.ok || !result.case) throw new CaseValidationError(result.errors);
  return result.case;
}

/** The weakest confidence a citation set can support. */
export function maxConfidenceFor(sources: Source[]): Confidence {
  if (sources.length > 0 && sources.every((s) => SECONDARY_SOURCE_TYPES.includes(s.type))) {
    return 'reported';
  }
  return 'established';
}

/** Cross-field rules that the Zod schema alone cannot express. */
export function checkCaseRules(c: Case, opts: ValidateOptions = {}): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (path: string, code: IssueCode, message: string) => errors.push({ path, code, message });
  const warn = (path: string, code: IssueCode, message: string) => warnings.push({ path, code, message });

  const sourcesById = new Map<string, Source>();
  c.sources.forEach((s, i) => {
    if (sourcesById.has(s.id)) err(`sources.${i}.id`, 'duplicate_id', `Duplicate source id "${s.id}".`);
    sourcesById.set(s.id, s);
  });
  const used = new Set<string>();

  const checkCites = (path: string, ids: string[]) => {
    ids.forEach((id, j) => {
      used.add(id);
      if (!sourcesById.has(id)) err(`${path}.${j}`, 'unknown_source', `Cites unknown source "${id}".`);
    });
  };

  const checkConfidence = (path: string, ids: string[], confidence: Confidence) => {
    const cited = ids.map((id) => sourcesById.get(id)).filter((s): s is Source => !!s);
    if (confidence === 'established' && maxConfidenceFor(cited) !== 'established') {
      err(
        `${path}.confidence`,
        'overstated_confidence',
        'Only news or analysis sources are cited, so this must be labeled "reported", not "established".',
      );
    }
  };

  const checkEvidence = (path: string, ids: string[], evidence: { source_id: string }[] | undefined) => {
    (evidence ?? []).forEach((e, j) => {
      if (!ids.includes(e.source_id)) {
        err(`${path}.evidence.${j}.source_id`, 'evidence_not_cited', `Evidence quotes source "${e.source_id}", which this item does not cite.`);
      }
    });
  };

  const lint = (path: string, text: string | undefined) => {
    if (!text) return;
    for (const w of findJudgingWords(text)) warn(path, 'judging_word', `Judging word "${w}" in user-facing copy.`);
  };
  lint('title', c.title);
  lint('content_warning', c.content_warning);
  lint('question.scale.left_label', c.question.scale.left_label);
  lint('question.scale.right_label', c.question.scale.right_label);
  c.open_questions.forEach((q, i) => lint(`open_questions.${i}`, q));

  // Sides
  const sideIds = new Set<string>();
  c.sides.forEach((s, i) => {
    if (sideIds.has(s.id)) err(`sides.${i}.id`, 'duplicate_id', `Duplicate side id "${s.id}".`);
    if (s.id === NEUTRAL) err(`sides.${i}.id`, 'schema', `"${NEUTRAL}" is reserved and cannot be a side id.`);
    sideIds.add(s.id);
    lint(`sides.${i}.label`, s.label);
  });

  // Starting facts
  const factIds = new Set<string>();
  c.starting_facts.forEach((f, i) => {
    const p = `starting_facts.${i}`;
    if (factIds.has(f.id)) err(`${p}.id`, 'duplicate_id', `Duplicate fact id "${f.id}".`);
    factIds.add(f.id);
    checkCites(`${p}.source_ids`, f.source_ids);
    checkConfidence(p, f.source_ids, f.confidence);
    checkEvidence(p, f.source_ids, f.evidence);
    lint(`${p}.text`, f.text);
  });

  // Steps
  const stepIds = new Set<string>();
  const layerIds = new Set<string>();
  c.steps.forEach((s, i) => {
    const p = `steps.${i}`;
    if (stepIds.has(s.id)) err(`${p}.id`, 'duplicate_id', `Duplicate step id "${s.id}".`);
    if (s.id === 'before' || s.id === 'after') err(`${p}.id`, 'schema', `"${s.id}" is reserved and cannot be a step id.`);
    stepIds.add(s.id);
    if (s.order !== i + 1) {
      err(`${p}.order`, 'step_order', `Steps must be listed in order 1..n; position ${i + 1} has order ${s.order}.`);
    }
    checkCites(`${p}.source_ids`, s.source_ids);
    checkConfidence(p, s.source_ids, s.confidence);
    checkEvidence(p, s.source_ids, s.evidence);

    if (s.favors === undefined) {
      warn(`${p}.favors`, 'missing_favors', 'No "favors" tag, so this step is left out of the balance check.');
    } else if (s.favors !== NEUTRAL && !sideIds.has(s.favors)) {
      err(`${p}.favors`, 'unknown_side', `"favors" names unknown side "${s.favors}".`);
    }
    if (s.impact === undefined) warn(`${p}.impact`, 'missing_impact', 'No "impact" tag; the balance panel treats it as medium.');

    const n = countSentences(s.body);
    if (n < 2 || n > 4) warn(`${p}.body`, 'body_length', `Body has about ${n} sentence(s); house style is 2-4.`);
    lint(`${p}.headline`, s.headline);
    lint(`${p}.body`, s.body);
    lint(`${p}.micro_poll.prompt`, s.micro_poll.prompt);

    s.depth.forEach((layer, j) => {
      const lp = `${p}.depth.${j}`;
      const key = `${s.id}/${layer.id}`;
      if (layerIds.has(key)) err(`${lp}.id`, 'duplicate_id', `Duplicate layer id "${layer.id}" in step "${s.id}".`);
      layerIds.add(key);
      switch (layer.kind) {
        case 'document':
          checkCites(`${lp}.source_id`, [layer.source_id]);
          lint(`${lp}.title`, layer.title);
          lint(`${lp}.summary`, layer.summary);
          break;
        case 'quote':
          // The quote itself is reported speech; only its framing is linted.
          checkCites(`${lp}.source_id`, [layer.source_id]);
          lint(`${lp}.context`, layer.context);
          break;
        case 'context':
          checkCites(`${lp}.source_ids`, layer.source_ids);
          lint(`${lp}.title`, layer.title);
          lint(`${lp}.body`, layer.body);
          break;
        case 'timeline':
          lint(`${lp}.title`, layer.title);
          layer.entries.forEach((e, k) => {
            checkCites(`${lp}.entries.${k}.source_ids`, e.source_ids);
            lint(`${lp}.entries.${k}.text`, e.text);
          });
          break;
      }
    });
  });

  lint('question.prompt', c.question.prompt);
  if (c.open_questions.length === 0) warn('open_questions', 'no_open_questions', 'No open questions listed for the end of the dive.');

  // Versions
  if (c.parent_version !== undefined && c.parent_version >= c.version) {
    err('parent_version', 'parent_version', `parent_version (${c.parent_version}) must be lower than version (${c.version}).`);
  }

  // Review record references (the admin console renders these against steps)
  c.review.hard_questions.forEach((q, i) => {
    if (q.side_id && !sideIds.has(q.side_id)) err(`review.hard_questions.${i}.side_id`, 'unknown_side', `Unknown side "${q.side_id}".`);
  });
  c.review.hard_questions.forEach((q, i) =>
    q.step_ids.forEach((id, j) => {
      if (!stepIds.has(id)) warn(`review.hard_questions.${i}.step_ids.${j}`, 'unknown_reference', `Refers to unknown step "${id}".`);
    }),
  );
  c.review.bias_reports.forEach((r, i) => {
    if (!sideIds.has(r.side_id)) err(`review.bias_reports.${i}.side_id`, 'unknown_side', `Unknown side "${r.side_id}".`);
    r.flags.forEach((f, j) => {
      if (f.step_id && !stepIds.has(f.step_id)) warn(`review.bias_reports.${i}.flags.${j}.step_id`, 'unknown_reference', `Refers to unknown step "${f.step_id}".`);
    });
  });
  c.review.open_issues.forEach((o, i) => {
    if (o.step_id && !stepIds.has(o.step_id)) warn(`review.open_issues.${i}.step_id`, 'unknown_reference', `Refers to unknown step "${o.step_id}".`);
  });

  // The latest fact-check round must agree with the labels the dive ships with.
  const confidenceOf = (target: string): Confidence | undefined => {
    if (target.startsWith('fact:')) return c.starting_facts.find((f) => f.id === target.slice(5))?.confidence;
    return c.steps.find((s) => s.id === target)?.confidence;
  };
  const latestRound = Math.max(-1, ...c.review.fact_check.map((r) => r.round));
  c.review.fact_check.forEach((row, i) => {
    const rp = `review.fact_check.${i}`;
    if (row.source_id && !sourcesById.has(row.source_id)) warn(`${rp}.source_id`, 'unknown_reference', `Refers to unknown source "${row.source_id}".`);
    const isLayer = row.target.startsWith('layer:');
    const known = isLayer
      ? c.steps.some((s) => s.depth.some((l) => `layer:${s.id}/${l.id}` === row.target))
      : row.target.startsWith('side:')
        ? sideIds.has(row.target.slice(5))
        : confidenceOf(row.target) !== undefined;
    if (!known) warn(`${rp}.target`, 'unknown_reference', `Fact-check row refers to unknown target "${row.target}".`);
    if (row.round !== latestRound) return;
    if (row.verdict === 'unsupported' || row.verdict === 'uncited' || row.verdict === 'source_unavailable') {
      warn(`${rp}.verdict`, 'review_mismatch', `The latest fact-check marks "${row.target}" as ${row.verdict}.`);
    }
    const current = confidenceOf(row.target);
    if (current && row.confidence_after && CONFIDENCE_RANK[row.confidence_after] > CONFIDENCE_RANK[current]) {
      warn(`${rp}.confidence_after`, 'review_mismatch', `The fact-checker downgraded "${row.target}" to ${row.confidence_after}, but it is labeled ${current}.`);
    }
  });

  // Dates
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  if (c.as_of > today) warn('as_of', 'as_of_future', `as_of (${c.as_of}) is in the future.`);

  // Unused sources
  c.sources.forEach((s, i) => {
    if (!used.has(s.id)) warn(`sources.${i}`, 'unused_source', `Source "${s.id}" is not cited anywhere.`);
  });

  return { errors, warnings };
}

/** Publishing is blocked by any error. Warnings are shown but do not block. */
export function isPublishable(input: unknown): boolean {
  return validateCase(input).ok;
}
