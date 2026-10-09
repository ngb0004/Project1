import type { BiasFlag, Case, FactCheckRow, HardQuestion, OpenIssue } from '@sia/case-schema';
import { setAt, type Doc } from './working-copy';

/**
 * The admin's triage of the pipeline's review items, recorded in the working
 * copy's review record and saved with the next admin_edit draft (the database
 * stores the whole document, and the decision log gets a plain-words summary):
 *
 * - a red-team flag marked addressed or won't fix, with a resolution;
 * - a hard question marked answered or not applicable, with a resolution;
 * - an open issue marked resolved (the note is appended to its description);
 * - a failing fact-check row marked addressed. Fact-check rows have no status
 *   field, so the acknowledgment is a resolved open issue from the admin
 *   (`ack-fc-<row index>`), which keeps the fact-checker's row untouched.
 */

const RESOLUTION_MAX = 2000;
const DESCRIPTION_MAX = 2000;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export type FlagStatus = BiasFlag['status'];
export type QuestionStatus = HardQuestion['status'];

export function setBiasFlagStatus(doc: Doc, reportIndex: number, flagIndex: number, status: FlagStatus, resolution?: string): Doc {
  const flag = doc.review?.bias_reports?.[reportIndex]?.flags?.[flagIndex];
  if (!flag) return doc;
  const next: BiasFlag = { ...flag, status };
  const note = resolution?.trim();
  if (note) next.resolution = clip(note, RESOLUTION_MAX);
  return setAt(doc, ['review', 'bias_reports', reportIndex, 'flags', flagIndex], next);
}

export function setHardQuestionStatus(doc: Doc, index: number, status: QuestionStatus, resolution?: string): Doc {
  const q = doc.review?.hard_questions?.[index];
  if (!q) return doc;
  const next: HardQuestion = { ...q, status };
  const note = resolution?.trim();
  if (note) next.resolution = clip(note, RESOLUTION_MAX);
  return setAt(doc, ['review', 'hard_questions', index], next);
}

export const RESOLVED_NOTE_PREFIX = '\n\nResolved by the admin: ';

export function setOpenIssueResolved(doc: Doc, index: number, resolved: boolean, note?: string): Doc {
  const issue = doc.review?.open_issues?.[index];
  if (!issue) return doc;
  let description = issue.description;
  const cut = description.indexOf(RESOLVED_NOTE_PREFIX);
  if (cut >= 0) description = description.slice(0, cut);
  const text = note?.trim();
  if (resolved && text) description = clip(`${description}${RESOLVED_NOTE_PREFIX}${text}`, DESCRIPTION_MAX);
  return setAt(doc, ['review', 'open_issues', index], { ...issue, resolved, description });
}

// ---------------------------------------------------------------------------
// Fact-check acknowledgments
// ---------------------------------------------------------------------------

export const factCheckAckId = (rowIndex: number) => `ack-fc-${rowIndex}`;

export function isFactCheckAck(issue: Pick<OpenIssue, 'id' | 'source'>): boolean {
  return issue.source === 'admin' && /^ack-fc-\d+$/.test(issue.id);
}

/** The admin's acknowledgment of fact-check row `rowIndex`, if any. */
export function factCheckAck(doc: Pick<Case, 'review'>, rowIndex: number): OpenIssue | undefined {
  const id = factCheckAckId(rowIndex);
  return doc.review?.open_issues?.find((o) => o.id === id && o.source === 'admin');
}

/** The note part of an acknowledgment's description. */
export function ackNote(issue: OpenIssue): string {
  const i = issue.description.indexOf(': ');
  return i >= 0 ? issue.description.slice(i + 2) : issue.description;
}

function describeRow(row: FactCheckRow): string {
  return `Admin addressed the fact-check (round ${row.round ?? 0}, ${row.verdict.replace(/_/g, ' ')}) on ${row.target}`;
}

export function acknowledgeFactCheck(doc: Doc, rowIndex: number, note: string, stepId?: string): Doc {
  const row = doc.review?.fact_check?.[rowIndex];
  const text = note.trim();
  if (!row || !text) return doc;
  const issues = doc.review.open_issues ?? [];
  const ack: OpenIssue = {
    id: factCheckAckId(rowIndex),
    source: 'admin',
    severity: row.verdict === 'partially_supported' ? 'medium' : 'high',
    description: clip(`${describeRow(row)}: ${text}`, DESCRIPTION_MAX),
    resolved: true,
  };
  if (stepId) ack.step_id = stepId;
  const at = issues.findIndex((o) => o.id === ack.id && o.source === 'admin');
  return at >= 0 ? setAt(doc, ['review', 'open_issues', at], ack) : setAt(doc, ['review', 'open_issues'], [...issues, ack]);
}

export function unacknowledgeFactCheck(doc: Doc, rowIndex: number): Doc {
  const id = factCheckAckId(rowIndex);
  const issues = doc.review?.open_issues ?? [];
  if (!issues.some((o) => o.id === id && o.source === 'admin')) return doc;
  return setAt(doc, ['review', 'open_issues'], issues.filter((o) => !(o.id === id && o.source === 'admin')));
}

// ---------------------------------------------------------------------------
// What changed, for the decision log
// ---------------------------------------------------------------------------

const label = (s: string) => s.replace(/_/g, ' ');

/**
 * Plain-words lines for the admin's triage since `saved`, e.g. `Red-team flag
 * b1 (as Council responsible) marked addressed: Reworded the headline.`
 * Reference renames are not listed: the content diff already shows them.
 */
export function describeTriage(saved: Pick<Case, 'review' | 'sides'>, working: Pick<Case, 'review' | 'sides'>): string[] {
  const out: string[] = [];
  const side = (id: string | undefined) => (id ? (working.sides ?? []).find((s) => s.id === id)?.label || id : 'any side');
  const before = saved.review;
  const after = working.review;
  if (!after) return out;

  (after.bias_reports ?? []).forEach((r, i) =>
    (r.flags ?? []).forEach((f, j) => {
      const old = before?.bias_reports?.[i]?.flags?.[j];
      if (!old || (old.status === f.status && old.resolution === f.resolution)) return;
      out.push(`Red-team flag ${f.id} (as ${side(r.side_id)}) marked ${label(f.status)}${f.resolution && f.resolution !== old.resolution ? `: ${f.resolution}` : '.'}`);
    }),
  );
  (after.hard_questions ?? []).forEach((q, i) => {
    const old = before?.hard_questions?.[i];
    if (!old || (old.status === q.status && old.resolution === q.resolution)) return;
    out.push(`Hard question ${q.id} marked ${label(q.status)}${q.resolution && q.resolution !== old.resolution ? `: ${q.resolution}` : '.'}`);
  });
  const oldIssues = new Map((before?.open_issues ?? []).map((o) => [`${o.source}:${o.id}`, o]));
  const newKeys = new Set((after.open_issues ?? []).map((o) => `${o.source}:${o.id}`));
  for (const o of after.open_issues ?? []) {
    const old = oldIssues.get(`${o.source}:${o.id}`);
    if (isFactCheckAck(o)) {
      if (!old || old.description !== o.description) out.push(`${o.description}.`.replace(/\.\.$/, '.'));
      continue;
    }
    if (!old || (old.resolved === o.resolved && old.description === o.description)) continue;
    const cut = o.description.indexOf(RESOLVED_NOTE_PREFIX);
    const note = cut >= 0 ? o.description.slice(cut + RESOLVED_NOTE_PREFIX.length) : '';
    out.push(`Open issue ${o.id} marked ${o.resolved ? 'resolved' : 'unresolved'}${o.resolved && note ? `: ${note}` : '.'}`);
  }
  for (const [key, o] of oldIssues) {
    if (isFactCheckAck(o) && !newKeys.has(key)) out.push(`Withdrew the admin's note on fact-check ${o.id.slice(7)}.`);
  }
  return out;
}

/** Decision notes: what the admin typed, then the triage summary, within the review record's limit. */
export function combineNotes(typed: string, triage: string[], max = 7000): string | undefined {
  const parts: string[] = [];
  const t = typed.trim();
  if (t) parts.push(t);
  if (triage.length) parts.push(`Review items:\n${triage.map((l) => `- ${l}`).join('\n')}`);
  const text = parts.join('\n\n');
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
