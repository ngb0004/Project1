import type { z } from 'zod';
import {
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
  | 'as_of_future';

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

const pathOf = (p: ReadonlyArray<PropertyKey>) => p.map(String).join('.');

function mapZodIssue(issue: z.core.$ZodIssue): Issue {
  const path = pathOf(issue.path);
  const last = issue.path[issue.path.length - 1];
  const parent = issue.path[0];
  if (last === 'source_ids' && issue.code === 'too_small') {
    if (parent === 'steps') {
      return { path, code: 'step_uncited', message: 'Step has no sources. Every step must cite at least one.' };
    }
    if (parent === 'starting_facts') {
      return { path, code: 'fact_uncited', message: 'Starting fact has no sources. Every fact must cite at least one.' };
    }
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

  // Sides
  const sideIds = new Set<string>();
  c.sides.forEach((s, i) => {
    if (sideIds.has(s.id)) err(`sides.${i}.id`, 'duplicate_id', `Duplicate side id "${s.id}".`);
    if (s.id === NEUTRAL) err(`sides.${i}.id`, 'schema', `"${NEUTRAL}" is reserved and cannot be a side id.`);
    sideIds.add(s.id);
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
    for (const w of findJudgingWords(f.text)) warn(`${p}.text`, 'judging_word', `Judging word "${w}" in user-facing copy.`);
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
    for (const field of ['headline', 'body'] as const) {
      for (const w of findJudgingWords(s[field])) warn(`${p}.${field}`, 'judging_word', `Judging word "${w}" in user-facing copy.`);
    }

    s.depth.forEach((layer, j) => {
      const lp = `${p}.depth.${j}`;
      const key = `${s.id}/${layer.id}`;
      if (layerIds.has(key)) err(`${lp}.id`, 'duplicate_id', `Duplicate layer id "${layer.id}" in step "${s.id}".`);
      layerIds.add(key);
      switch (layer.kind) {
        case 'document':
        case 'quote':
          checkCites(`${lp}.source_id`, [layer.source_id]);
          break;
        case 'context':
          checkCites(`${lp}.source_ids`, layer.source_ids);
          for (const w of findJudgingWords(layer.body)) warn(`${lp}.body`, 'judging_word', `Judging word "${w}" in user-facing copy.`);
          break;
        case 'timeline':
          layer.entries.forEach((e, k) => checkCites(`${lp}.entries.${k}.source_ids`, e.source_ids));
          break;
      }
    });
  });

  // Questions and copy
  for (const field of ['prompt'] as const) {
    for (const w of findJudgingWords(c.question[field])) warn(`question.${field}`, 'judging_word', `Judging word "${w}" in user-facing copy.`);
  }
  if (c.open_questions.length === 0) warn('open_questions', 'no_open_questions', 'No open questions listed for the end of the dive.');

  // Versions
  if (c.parent_version !== undefined && c.parent_version >= c.version) {
    err('parent_version', 'parent_version', `parent_version (${c.parent_version}) must be lower than version (${c.version}).`);
  }

  // Review record references (the admin console renders these against steps)
  c.review.hard_questions.forEach((q, i) => {
    if (q.side_id && !sideIds.has(q.side_id)) err(`review.hard_questions.${i}.side_id`, 'unknown_side', `Unknown side "${q.side_id}".`);
  });
  c.review.bias_reports.forEach((r, i) => {
    if (!sideIds.has(r.side_id)) err(`review.bias_reports.${i}.side_id`, 'unknown_side', `Unknown side "${r.side_id}".`);
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
