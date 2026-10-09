import {
  CONFIDENCE_LEVELS,
  type BiasFlag,
  type Case,
  type Confidence,
  type FactCheckRow,
  type HardQuestion,
  type OpenIssue,
} from '@sia/case-schema';
import type { FairnessSideSignal, FlagsBySideRow, ReviewAlertRow, StepFlagSignal } from '@sia/case-store';
import { factCheckAck, isFactCheckAck } from './review-triage';

/**
 * Everything the review screen shows "on" a step: fact-checker rows that are
 * not a clean pass, red-team flags, hard questions that link the step, open
 * issues, and (for published versions) what readers flagged.
 */

export interface FactCheckFlag {
  row: FactCheckRow;
  /** The row's position in review.fact_check (stable key). */
  index: number;
  /** True for rows from the latest fact-check round. */
  latest: boolean;
  /** Set for rows about one of the step's depth layers. */
  layerId: string | null;
  /** The admin's note that the row was dealt with (a resolved admin open issue), if any. */
  ack?: OpenIssue;
}

export interface RedTeamFlag {
  sideId: string;
  round: number;
  flag: BiasFlag;
  /** Position in review.bias_reports and in that report's flags (for triage edits). */
  reportIndex: number;
  flagIndex: number;
}

/** A review item with its position in the review record's list (for triage edits). */
export type Indexed<T> = T & { readonly index: number };

export interface StepFlags {
  stepId: string;
  factCheck: FactCheckFlag[];
  redTeam: RedTeamFlag[];
  hardQuestions: Indexed<HardQuestion>[];
  openIssues: Indexed<OpenIssue>[];
  /** Reader flags on this step (published versions only). */
  userFlags: StepFlagSignal | null;
  /** Reader flags grouped by the flagger's own side ("unrated" when they did not rate fairness). */
  userFlagsBySide: { sideId: string; flags: number }[];
  alerts: ReviewAlertRow[];
  /** How many of the above still need the admin's attention. */
  attention: number;
}

export interface UserSignals {
  /** The published version these readers saw (this version, or the live version it revises). */
  version: number;
  flags: StepFlagSignal[];
  flagsBySide: FlagsBySideRow[];
  alerts: ReviewAlertRow[];
  /** "Was this fair to your side?" per side. */
  sides?: FairnessSideSignal[];
}

const RANK = Object.fromEntries(CONFIDENCE_LEVELS.map((c, i) => [c, i])) as Record<Confidence, number>;

/** Verdicts that are a clean pass. Everything else is shown on the step. */
const PASS = 'supported';
/** Verdicts that need the admin's attention when they come from the latest round. */
const FAILING = new Set(['unsupported', 'uncited', 'source_unavailable', 'partially_supported']);

/** True when the fact-checker changed (or wants to change) the row's confidence label. */
export function confidenceChanged(row: FactCheckRow): boolean {
  return row.confidence_after !== undefined && row.confidence_before !== undefined && row.confidence_after !== row.confidence_before;
}

/** Fact-check rows worth showing: anything but a plain pass with no confidence change. */
export function isNotableFactCheck(row: FactCheckRow): boolean {
  return row.verdict !== PASS || confidenceChanged(row);
}

/** Splits a fact-check target into what it points at. */
export function parseTarget(target: string): { kind: 'step' | 'fact' | 'layer' | 'side'; id: string; layerId: string | null } {
  if (target.startsWith('fact:')) return { kind: 'fact', id: target.slice(5), layerId: null };
  if (target.startsWith('side:')) return { kind: 'side', id: target.slice(5), layerId: null };
  if (target.startsWith('layer:')) {
    const rest = target.slice(6);
    const slash = rest.indexOf('/');
    return slash < 0
      ? { kind: 'layer', id: rest, layerId: null }
      : { kind: 'layer', id: rest.slice(0, slash), layerId: rest.slice(slash + 1) };
  }
  return { kind: 'step', id: target, layerId: null };
}

function emptyFlags(stepId: string): StepFlags {
  return {
    stepId,
    factCheck: [],
    redTeam: [],
    hardQuestions: [],
    openIssues: [],
    userFlags: null,
    userFlagsBySide: [],
    alerts: [],
    attention: 0,
  };
}

type FlagSource = Pick<Case, 'steps' | 'review'>;

/** Flags per step id, for every step of `doc` (steps with nothing on them get empty entries). */
export function collectStepFlags(doc: FlagSource, signals?: UserSignals | null): Map<string, StepFlags> {
  const out = new Map<string, StepFlags>();
  const steps = doc.steps ?? [];
  for (const s of steps) out.set(s.id, emptyFlags(s.id));
  const confidenceOf = new Map(steps.map((s) => [s.id, s.confidence]));
  const review = doc.review;
  const factCheck = review?.fact_check ?? [];
  const latestRound = Math.max(-1, ...factCheck.map((r) => r.round ?? 0));

  factCheck.forEach((row, index) => {
    const t = parseTarget(row.target);
    if (t.kind !== 'step' && t.kind !== 'layer') return;
    const entry = out.get(t.id);
    if (!entry || !isNotableFactCheck(row)) return;
    const latest = (row.round ?? 0) === latestRound;
    const ack = factCheckAck(doc, index);
    entry.factCheck.push({ row, index, latest, layerId: t.layerId, ...(ack ? { ack } : {}) });
    if (latest && !ack) {
      const current = confidenceOf.get(t.id);
      const downgradeMissing =
        t.kind === 'step' && current !== undefined && row.confidence_after !== undefined && RANK[row.confidence_after] > RANK[current];
      if (FAILING.has(row.verdict) || downgradeMissing) entry.attention++;
    }
  });

  (review?.bias_reports ?? []).forEach((report, reportIndex) => {
    (report.flags ?? []).forEach((flag, flagIndex) => {
      if (!flag.step_id) return;
      const entry = out.get(flag.step_id);
      if (!entry) return;
      entry.redTeam.push({ sideId: report.side_id, round: report.round, flag, reportIndex, flagIndex });
      if (flag.status === 'unaddressed') entry.attention++;
    });
  });

  (review?.hard_questions ?? []).forEach((q, index) => {
    for (const id of new Set(q.step_ids ?? [])) {
      const entry = out.get(id);
      if (!entry) continue;
      entry.hardQuestions.push({ ...q, index });
      if (q.status === 'open') entry.attention++;
    }
  });

  (review?.open_issues ?? []).forEach((issue, index) => {
    // The admin's fact-check notes are shown with the fact-check row itself.
    if (!issue.step_id || isFactCheckAck(issue)) return;
    const entry = out.get(issue.step_id);
    if (!entry) return;
    entry.openIssues.push({ ...issue, index });
    if (!issue.resolved) entry.attention++;
  });

  if (signals) {
    for (const f of signals.flags) {
      const entry = out.get(f.step_id);
      if (!entry) continue;
      entry.userFlags = f;
      if (f.open > 0) entry.attention++;
    }
    for (const r of signals.flagsBySide) {
      out.get(r.step_id)?.userFlagsBySide.push({ sideId: r.side_id, flags: r.flags });
    }
    for (const a of signals.alerts) {
      if (!a.step_id) continue;
      const entry = out.get(a.step_id);
      if (!entry) continue;
      entry.alerts.push(a);
      if (!a.resolved_at) entry.attention++;
    }
  }

  // Newest round first, then document order.
  for (const entry of out.values()) {
    entry.factCheck.sort((a, b) => (b.row.round ?? 0) - (a.row.round ?? 0) || a.index - b.index);
    entry.redTeam.sort((a, b) => b.round - a.round);
  }
  return out;
}

/** Notable fact-check rows about starting facts, by fact id. */
export function collectFactFlags(doc: Pick<Case, 'review'>): Map<string, FactCheckFlag[]> {
  const out = new Map<string, FactCheckFlag[]>();
  const rows = doc.review?.fact_check ?? [];
  const latestRound = Math.max(-1, ...rows.map((r) => r.round ?? 0));
  rows.forEach((row, index) => {
    const t = parseTarget(row.target);
    if (t.kind !== 'fact' || !isNotableFactCheck(row)) return;
    const list = out.get(t.id) ?? [];
    const ack = factCheckAck(doc, index);
    list.push({ row, index, latest: (row.round ?? 0) === latestRound, layerId: null, ...(ack ? { ack } : {}) });
    out.set(t.id, list);
  });
  return out;
}

/** Review items that are not tied to any current step (shown above the step list). */
export interface CaseLevelFlags {
  redTeam: RedTeamFlag[];
  hardQuestions: Indexed<HardQuestion>[];
  openIssues: Indexed<OpenIssue>[];
  /** Fact-check rows whose target is a side, or a step that no longer exists. */
  factCheck: FactCheckFlag[];
}

export function collectCaseLevelFlags(doc: FlagSource): CaseLevelFlags {
  const stepIds = new Set((doc.steps ?? []).map((s) => s.id));
  const review = doc.review;
  const rows = review?.fact_check ?? [];
  const latestRound = Math.max(-1, ...rows.map((r) => r.round ?? 0));
  const out: CaseLevelFlags = { redTeam: [], hardQuestions: [], openIssues: [], factCheck: [] };
  (review?.bias_reports ?? []).forEach((report, reportIndex) =>
    (report.flags ?? []).forEach((flag, flagIndex) => {
      if (!flag.step_id || !stepIds.has(flag.step_id)) {
        out.redTeam.push({ sideId: report.side_id, round: report.round, flag, reportIndex, flagIndex });
      }
    }),
  );
  (review?.hard_questions ?? []).forEach((q, index) => {
    if (!(q.step_ids ?? []).some((id) => stepIds.has(id))) out.hardQuestions.push({ ...q, index });
  });
  (review?.open_issues ?? []).forEach((o, index) => {
    if (isFactCheckAck(o)) return;
    if (!o.step_id || !stepIds.has(o.step_id)) out.openIssues.push({ ...o, index });
  });
  rows.forEach((row, index) => {
    const t = parseTarget(row.target);
    const orphan = (t.kind === 'step' || t.kind === 'layer') && !stepIds.has(t.id);
    if ((t.kind === 'side' || orphan) && isNotableFactCheck(row)) {
      const ack = factCheckAck(doc, index);
      out.factCheck.push({ row, index, latest: (row.round ?? 0) === latestRound, layerId: t.layerId, ...(ack ? { ack } : {}) });
    }
  });
  return out;
}

/** How many case-level items still need the admin (unaddressed flags, open questions and issues, failing rows). */
export function caseLevelAttention(c: CaseLevelFlags): number {
  return (
    c.redTeam.filter((r) => r.flag.status === 'unaddressed').length +
    c.hardQuestions.filter((q) => q.status === 'open').length +
    c.openIssues.filter((o) => !o.resolved).length +
    c.factCheck.filter((f) => f.latest && !f.ack && FAILING.has(f.row.verdict)).length
  );
}

/** Unresolved open issues in the review record (the header's count). The admin's own fact-check notes are not issues. */
export function openIssueCount(doc: Pick<Case, 'review'>): number {
  return (doc.review?.open_issues ?? []).filter((o) => !o.resolved && !isFactCheckAck(o)).length;
}

/** True for a latest-round fact-check verdict that fails the claim. */
export function isFailingVerdict(verdict: string): boolean {
  return FAILING.has(verdict) && verdict !== 'partially_supported';
}

/**
 * What is still unresolved in the review record, as plain-words cautions for
 * the approve actions. Approving stays possible (the spec blocks only on
 * schema errors and uncited steps); these make sure it is a conscious choice.
 */
export function publishCautions(doc: Pick<Case, 'review'>): string[] {
  const review = doc.review;
  if (!review) return [];
  const rows = review.fact_check ?? [];
  const latestRound = Math.max(-1, ...rows.map((r) => r.round ?? 0));
  const failing = rows.filter((r, i) => (r.round ?? 0) === latestRound && isFailingVerdict(r.verdict) && !factCheckAck(doc, i)).length;
  const highFlags = (review.bias_reports ?? []).flatMap((r) => r.flags ?? []).filter((f) => f.status === 'unaddressed' && f.severity === 'high').length;
  const blocking = (review.hard_questions ?? []).filter((q) => q.status === 'open' && q.blocking).length;
  const issues = (review.open_issues ?? []).filter((o) => !o.resolved && !isFactCheckAck(o));
  const highIssues = issues.filter((o) => o.severity === 'high').length;
  const out: string[] = [];
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (failing) out.push(`${n(failing, 'claim', 'claims')} the latest fact-check failed (unsupported, uncited or source unavailable)`);
  if (highFlags) out.push(`${n(highFlags, 'unaddressed high-severity red-team flag', 'unaddressed high-severity red-team flags')}`);
  if (blocking) out.push(`${n(blocking, 'blocking hard question', 'blocking hard questions')} still open`);
  if (issues.length) out.push(`${n(issues.length, 'unresolved open issue', 'unresolved open issues')}${highIssues ? ` (${highIssues} high)` : ''}`);
  return out;
}

/** Short reasons a step needs attention, for the "Needs attention" list at the top of the review screen. */
export function attentionReasons(flags: StepFlags, currentConfidence?: Confidence): string[] {
  const out: string[] = [];
  for (const f of flags.factCheck) {
    if (!f.latest || f.ack) continue;
    const downgrade =
      currentConfidence !== undefined && !f.layerId && f.row.confidence_after !== undefined && RANK[f.row.confidence_after] > RANK[currentConfidence];
    if (FAILING.has(f.row.verdict)) out.push(`fact-check: ${f.row.verdict.replace(/_/g, ' ')}${f.layerId ? ` (layer ${f.layerId})` : ''}`);
    else if (downgrade) out.push(`fact-check: downgrade to ${f.row.confidence_after} not applied`);
  }
  for (const r of flags.redTeam) if (r.flag.status === 'unaddressed') out.push(`red team: ${r.flag.severity} ${r.flag.kind.replace(/_/g, ' ')}`);
  for (const q of flags.hardQuestions) if (q.status === 'open') out.push(`hard question open${q.blocking ? ' (blocking)' : ''}`);
  for (const o of flags.openIssues) if (!o.resolved) out.push(`open issue (${o.severity})`);
  if (flags.userFlags && flags.userFlags.open > 0) out.push(`readers: ${flags.userFlags.open} open flag${flags.userFlags.open === 1 ? '' : 's'}`);
  for (const a of flags.alerts) if (!a.resolved_at) out.push(`${a.kind} alert`);
  return out;
}
