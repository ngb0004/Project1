import type { Case, Issue, ValidationResult } from '@sia/case-schema';
import { parseTarget } from './step-flags';
import { getAt, parsePath } from './working-copy';

/**
 * Validation issues as the review screen shows them: plain messages, one per
 * problem, with paths that name what the admin sees ("Step 8 › Body") and
 * jump targets for issues that live in the review record.
 */

type DocLike = Pick<Case, 'steps' | 'starting_facts' | 'sides' | 'sources' | 'review'>;

const FIELD_LABEL: Record<string, string> = {
  as_of: 'Facts current as of',
  content_warning: 'Content warning',
  prompt: 'Prompt',
  left_label: 'Slider left label',
  right_label: 'Slider right label',
  source_ids: 'Sources',
  source_id: 'Source',
  micro_poll: 'Micro-poll',
  quote_excerpt: 'Quote excerpt',
  accessed_at: 'Accessed at',
  url: 'URL',
  favors: 'Favors',
  open_questions: 'Open questions',
  starting_facts: 'Starting facts',
  steelman: 'Steelman',
  step_ids: 'Steps',
  side_id: 'Side',
  confidence_after: 'Confidence after',
  parent_version: 'Parent version',
};

const titleCase = (k: string) => FIELD_LABEL[k] ?? k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');

/** "steps.7.body" -> "Step 8 › Body"; "sources.13.url" -> "Source src-extra-7 › URL". */
export function issueLabel(path: string, doc: Partial<DocLike>): string {
  if (!path) return 'Whole case';
  const parts = parsePath(path);
  const out: string[] = [];
  let cur: unknown = doc;
  for (let i = 0; i < parts.length; i++) {
    const k = parts[i]!;
    const next = parts[i + 1];
    const container = k;
    const list = (cur as Record<string, unknown> | undefined)?.[container as string];
    if (typeof k === 'string' && typeof next === 'number') {
      const item = Array.isArray(list) ? (list[next] as Record<string, unknown> | undefined) : undefined;
      const id = typeof item?.id === 'string' && item.id ? item.id : null;
      switch (k) {
        case 'steps':
          out.push(`Step ${next + 1}`);
          break;
        case 'starting_facts':
          out.push(`Starting fact ${next + 1}`);
          break;
        case 'sources':
          out.push(id ? `Source ${id}` : `Source ${next + 1}`);
          break;
        case 'sides':
          out.push(`Side ${typeof item?.label === 'string' && item.label ? item.label : (id ?? next + 1)}`);
          break;
        case 'depth':
          out.push(`Go deeper layer ${next + 1}`);
          break;
        case 'entries':
          out.push(`Entry ${next + 1}`);
          break;
        case 'evidence':
          out.push(`Evidence quote ${next + 1}`);
          break;
        case 'open_questions':
          out.push(`Open question ${next + 1}`);
          break;
        case 'source_ids':
          out.push(`Source ${next + 1}`);
          break;
        case 'fact_check':
          out.push(`Fact-check row ${next + 1}`);
          break;
        case 'hard_questions':
          out.push(`Hard question ${id ?? next + 1}`);
          break;
        case 'bias_reports':
          out.push(`Red-team report ${next + 1}`);
          break;
        case 'flags':
          out.push(`Flag ${id ?? next + 1}`);
          break;
        case 'open_issues':
          out.push(`Open issue ${id ?? next + 1}`);
          break;
        default:
          out.push(`${titleCase(k)} ${next + 1}`);
      }
      cur = item;
      i++;
      continue;
    }
    if (k === 'review') {
      out.push('Review record');
      cur = (cur as Record<string, unknown> | undefined)?.review;
      continue;
    }
    if (k === 'question' && i === 0) {
      out.push('Question');
      cur = (cur as Record<string, unknown> | undefined)?.question;
      continue;
    }
    if (k === 'scale') {
      cur = (cur as Record<string, unknown> | undefined)?.scale;
      continue;
    }
    out.push(typeof k === 'number' ? String(k + 1) : titleCase(k));
    cur = (cur as Record<string, unknown> | undefined)?.[k as string];
  }
  return out.join(' › ');
}

/** Zod's default messages, in plain words. */
export function humanMessage(message: string): string {
  if (/^Too small: expected string to have >=1 characters?$/.test(message)) return 'Required.';
  let m = /^Too small: expected array to have >=(\d+) items?$/.exec(message);
  if (m) return `Add at least ${m[1]}.`;
  m = /^Too big: expected string to have <=(\d+) characters?$/.exec(message);
  if (m) return `Too long: keep it to ${m[1]} characters.`;
  if (/Invalid ISO datetime/i.test(message)) return 'Use a date and time like 2026-10-08T12:00:00Z.';
  if (/^Invalid URL$/i.test(message)) return 'Use a full web address, starting with https://.';
  if (/^Invalid input: expected string, received undefined$/.test(message)) return 'Required.';
  return message;
}

function humanizeList(issues: Issue[], doc: unknown): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  const emptyPaths = new Set<string>();
  for (const i of issues) {
    const message = humanMessage(i.message);
    const key = `${i.path}\u0000${message}`;
    if (seen.has(key)) continue;
    // An empty field gets one message ("Required."), not every rule it fails.
    const value = i.path ? getAt(doc, parsePath(i.path)) : undefined;
    const empty = typeof value === 'string' && value.trim() === '';
    if (empty && emptyPaths.has(i.path)) continue;
    seen.add(key);
    if (empty) emptyPaths.add(i.path);
    out.push({ ...i, message: empty && i.code === 'schema' ? 'Required.' : message });
  }
  return out;
}

export function humanizeValidation<T extends Pick<ValidationResult, 'errors' | 'warnings'>>(v: T, doc: unknown): T {
  return { ...v, errors: humanizeList(v.errors, doc), warnings: humanizeList(v.warnings, doc) };
}

/** DOM id of the "Flags on the whole case" block, where orphaned review items are listed. */
export const CASE_FLAGS_ID = 'case-flags';

/**
 * The document path whose field shows an issue. Review-record issues point at
 * what they are about: a fact-check row at its step, fact, layer or side; a
 * hard question or red-team flag at its step (or the case-level flags).
 */
export function issueTargetPath(path: string, doc: Partial<DocLike>): string {
  if (!path.startsWith('review.')) return path;
  const parts = parsePath(path);
  const list = parts[1];
  const index = parts[2];
  const review = doc.review;
  if (!review || typeof index !== 'number') return CASE_FLAGS_ID;
  const steps = doc.steps ?? [];
  const stepPath = (id: string | undefined) => {
    const i = id ? steps.findIndex((s) => s.id === id) : -1;
    return i >= 0 ? `steps.${i}` : CASE_FLAGS_ID;
  };
  if (list === 'fact_check') {
    const row = review.fact_check?.[index];
    if (!row) return CASE_FLAGS_ID;
    const t = parseTarget(row.target);
    if (t.kind === 'fact') {
      const i = (doc.starting_facts ?? []).findIndex((f) => f.id === t.id);
      return i >= 0 ? `starting_facts.${i}` : CASE_FLAGS_ID;
    }
    if (t.kind === 'side') {
      const i = (doc.sides ?? []).findIndex((s) => s.id === t.id);
      return i >= 0 ? `sides.${i}` : 'sides';
    }
    const sp = stepPath(t.id);
    if (sp === CASE_FLAGS_ID || !t.layerId) return sp;
    const step = steps.find((s) => s.id === t.id);
    const li = (step?.depth ?? []).findIndex((l) => l.id === t.layerId);
    return li >= 0 ? `${sp}.depth.${li}` : sp;
  }
  if (list === 'hard_questions') {
    if (parts[3] === 'side_id') return 'sides';
    const q = review.hard_questions?.[index];
    const j = parts[3] === 'step_ids' && typeof parts[4] === 'number' ? parts[4] : 0;
    return stepPath(q?.step_ids?.[j]);
  }
  if (list === 'bias_reports') {
    if (parts[3] === 'side_id') return 'sides';
    const f = parts[3] === 'flags' && typeof parts[4] === 'number' ? review.bias_reports?.[index]?.flags?.[parts[4]] : undefined;
    return stepPath(f?.step_id);
  }
  if (list === 'open_issues') return stepPath(review.open_issues?.[index]?.step_id);
  return CASE_FLAGS_ID;
}

/** True for warnings about the review record's verdicts (fact-check failures, missing downgrades). */
export function isReviewMismatch(i: Issue): boolean {
  return i.code === 'review_mismatch';
}
