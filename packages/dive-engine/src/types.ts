import type { FactFlag, FairnessRating, PublicCase } from '@sia/case-schema';

/**
 * Wire types for the dive API. They mirror the JSON returned by the database
 * functions in supabase/migrations/20261008000002_crowd.sql exactly; the local
 * (in-memory) API returns the same shapes.
 */

export type SlotKey = string; // 'before' | 'after' | step id

/** Share of the crowd in each 10-point bin (0-9, 10-19, ..., 90-100). Sums to 1. */
export type Histogram = number[];

export interface ShiftBuckets {
  /** moved 15+ points toward the left label */
  left_big: number;
  /** moved 1-14 points toward the left label */
  left: number;
  /** did not move */
  none: number;
  /** moved 1-14 points toward the right label */
  right: number;
  /** moved 15+ points toward the right label */
  right_big: number;
}

/** How everyone who reached a step moved there. Shares are 0..1. */
export interface StepCrowd {
  step_id: string;
  n_real: number;
  n_seed: number;
  /** Weight each seeded row carries right now (fades from 1 to 0). */
  seed_weight: number;
  /** Share of the weighted crowd that is seeded. > 0 means the UI must say so. */
  seeded_share: number;
  histogram: Histogram | null;
  previous_histogram: Histogram | null;
  mean_value: number | null;
  mean_previous: number | null;
  mean_delta: number | null;
  moved_share: number | null;
  shift: ShiftBuckets | null;
}

export interface FinalStepStat {
  step_id: string;
  mean_delta: number | null;
  mean_abs_delta: number | null;
  moved_share: number;
}

export interface FinalCrowd {
  n_real: number;
  n_seed: number;
  seed_weight: number;
  seeded_share: number;
  before_histogram: Histogram | null;
  after_histogram: Histogram | null;
  mean_before: number | null;
  mean_after: number | null;
  steps: FinalStepStat[];
  /** The step that moved the crowd most (largest mean absolute change). */
  top_step_id: string | null;
}

export interface VersionNote {
  version: number;
  published_at: string | null;
  parent_version: number | null;
  /** Earlier published versions and how many people completed each. */
  earlier_versions: { version: number; published_at: string | null; completions: number }[];
}

export interface SessionPath {
  answers: { step_id: SlotKey; value: number }[];
  /** The step that moved this user most, or null if nothing moved them. */
  top_step_id: string | null;
}

export interface BeforeReveal {
  step_id: 'before';
  value: number;
  locked: boolean;
}

export interface StepReveal {
  step_id: string;
  value: number;
  previous_value: number;
  locked: boolean;
  crowd: StepCrowd;
  version_note: VersionNote;
}

export interface FinalReveal {
  step_id: 'after';
  value: number;
  previous_value: number;
  locked: boolean;
  you: SessionPath;
  crowd: FinalCrowd;
  version_note: VersionNote;
}

export type Reveal = BeforeReveal | StepReveal | FinalReveal;

export const isFinalReveal = (r: Reveal): r is FinalReveal => r.step_id === 'after';
export const isBeforeReveal = (r: Reveal): r is BeforeReveal => r.step_id === 'before';
export const isStepReveal = (r: Reveal): r is StepReveal => !isFinalReveal(r) && !isBeforeReveal(r);

export interface SessionStart {
  session_id: string;
  case_id: string;
  case_version: number;
  resumed: boolean;
  completed: boolean;
  /** Answers already locked for this device, in order. */
  answers: { step_id: SlotKey; value: number }[];
}

export interface LiveCaseSummary {
  case_id: string;
  slug: string;
  version: number;
  title: string;
  as_of: string;
  published_at: string;
  content_warning: string | null;
  step_count: number;
}

export interface LoadedCase {
  case_id: string;
  slug: string;
  version: number;
  published_at: string;
  is_live: boolean;
  doc: PublicCase;
}

export interface CaseHistory {
  case_id: string;
  slug: string;
  live_version: number | null;
  versions: {
    version: number;
    title: string;
    as_of: string;
    status: string;
    published_at: string | null;
    parent_version: number | null;
    completions: number;
  }[];
}

export type FlagReason = FactFlag['reason'];
export type FairnessValue = FairnessRating['rating'];

/** Error codes the UI can act on. */
export type DiveErrorCode = 'not_found' | 'out_of_order' | 'rate_limited' | 'gone' | 'forbidden' | 'invalid' | 'network';

export class DiveApiError extends Error {
  constructor(
    public readonly code: DiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DiveApiError';
  }
}

/**
 * Everything the dive app needs from a backend. Implemented by the Supabase
 * adapter (production) and the in-memory LocalDiveApi (tests, demos, admin preview).
 *
 * Contract: the crowd result for a slot is only ever returned by `submit` (after the
 * answer is committed) or by `getReveal` for a slot this session already answered.
 */
export interface DiveApi {
  listLiveCases(): Promise<LiveCaseSummary[]>;
  /** The live version by default, or a specific published version. Null if not published. */
  getCase(slug: string, version?: number): Promise<LoadedCase | null>;
  startSession(caseId: string, version: number, deviceId: string): Promise<SessionStart>;
  /** Commits an answer. Repeat calls return the locked value unchanged. */
  submit(sessionId: string, slot: SlotKey, value: number): Promise<Reveal>;
  /** Re-fetches the reveal of an answered slot. Rejects for unanswered slots. */
  getReveal(sessionId: string, slot: SlotKey): Promise<Reveal>;
  flagFact(sessionId: string, stepId: string, reason: FlagReason, note?: string): Promise<void>;
  rateFairness(sessionId: string, sideId: string, rating: FairnessValue): Promise<void>;
  getHistory(slug: string): Promise<CaseHistory | null>;
}
