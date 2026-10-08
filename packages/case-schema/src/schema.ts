import { z } from 'zod';

/**
 * The case document schema. This file is the single source of truth for the
 * dive app, the admin console, the agent pipeline and the database import path.
 *
 * Field names follow the build spec (snake_case) because the document is stored
 * as-is in Postgres (jsonb) and shipped as-is to clients.
 */

export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Ids for steps, sources, sides, facts and layers: short, lowercase, url-safe. */
export const LocalId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'ids must be lowercase letters, digits, "-" or "_"')
  .max(64);

export const Slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase words joined by "-"')
  .max(80);

const isRealDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** Calendar date, `YYYY-MM-DD`. */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a date like 2026-10-07')
  .refine(isRealDate, 'not a real calendar date');

/** A date that may be partial when the exact day is unknown: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
export const PartialIsoDate = z
  .string()
  .regex(/^\d{4}(-(0[1-9]|1[0-2])(-\d{2})?)?$/, 'expected YYYY, YYYY-MM or YYYY-MM-DD')
  .refine((s) => s.length !== 10 || isRealDate(s), 'not a real calendar date');

/** ISO-8601 timestamp with timezone. */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Non-empty, trimmed user-facing text with a length cap. */
export const Text = (max: number) => z.string().trim().min(1).max(max);

export const HttpUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048);

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const CASE_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'rejected',
  'published',
  'archived',
] as const;
export const CaseStatus = z.enum(CASE_STATUSES);
export type CaseStatus = z.infer<typeof CaseStatus>;

export const CONFIDENCE_LEVELS = ['established', 'reported', 'disputed', 'alleged'] as const;
export const Confidence = z.enum(CONFIDENCE_LEVELS);
export type Confidence = z.infer<typeof Confidence>;

export const SOURCE_TYPES = ['court_record', 'official', 'primary', 'news', 'analysis'] as const;
export const SourceType = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceType>;

/** Source types that on their own can only support `reported` (or weaker), never `established`. */
export const SECONDARY_SOURCE_TYPES: readonly SourceType[] = ['news', 'analysis'];

export const IMPACT_LEVELS = ['low', 'medium', 'high'] as const;
export const Impact = z.enum(IMPACT_LEVELS);
export type Impact = z.infer<typeof Impact>;

export const NEUTRAL = 'neutral' as const;

// ---------------------------------------------------------------------------
// Sources and evidence
// ---------------------------------------------------------------------------

export const Source = z
  .object({
    id: LocalId,
    title: Text(300),
    publisher: Text(200),
    url: HttpUrl,
    date: PartialIsoDate,
    type: SourceType,
    accessed_at: IsoDateTime,
    quote_excerpt: Text(1200).optional(),
  })
  .strict();
export type Source = z.infer<typeof Source>;

/** A verbatim quote from a fetched source that supports a claim. Admin-only. */
export const Evidence = z
  .object({
    source_id: LocalId,
    quote: Text(1500),
  })
  .strict();
export type Evidence = z.infer<typeof Evidence>;

// ---------------------------------------------------------------------------
// Facts, depth layers, steps
// ---------------------------------------------------------------------------

/** One line of the agreed baseline shown before the Before question. */
export const Fact = z
  .object({
    id: LocalId,
    text: Text(400),
    source_ids: z.array(LocalId).min(1, 'every fact must cite at least one source'),
    confidence: Confidence,
    /** Admin-only supporting quotes. */
    evidence: z.array(Evidence).optional(),
  })
  .strict();
export type Fact = z.infer<typeof Fact>;

const DocumentLayer = z
  .object({
    kind: z.literal('document'),
    id: LocalId,
    title: Text(200),
    summary: Text(1200),
    source_id: LocalId,
  })
  .strict();

const QuoteLayer = z
  .object({
    kind: z.literal('quote'),
    id: LocalId,
    text: Text(1200),
    speaker: Text(200),
    context: Text(400).optional(),
    source_id: LocalId,
  })
  .strict();

const TimelineEntry = z
  .object({
    date: PartialIsoDate,
    text: Text(400),
    source_ids: z.array(LocalId).min(1, 'every timeline entry must cite a source'),
  })
  .strict();

const TimelineLayer = z
  .object({
    kind: z.literal('timeline'),
    id: LocalId,
    title: Text(200),
    entries: z.array(TimelineEntry).min(1),
  })
  .strict();

const ContextLayer = z
  .object({
    kind: z.literal('context'),
    id: LocalId,
    title: Text(200),
    body: Text(1500),
    source_ids: z.array(LocalId).min(1, 'every context layer must cite a source'),
  })
  .strict();

/** Tap-to-go-deeper material behind a step: documents, quotes, timeline, context. */
export const Layer = z.discriminatedUnion('kind', [
  DocumentLayer,
  QuoteLayer,
  TimelineLayer,
  ContextLayer,
]);
export type Layer = z.infer<typeof Layer>;
export type LayerKind = Layer['kind'];

export const DEFAULT_MICRO_POLL_PROMPT = 'Does this change your position?';

export const MicroPoll = z
  .object({
    prompt: Text(200),
    re_ask_slider: z.literal(true),
  })
  .strict();
export type MicroPoll = z.infer<typeof MicroPoll>;

export const Step = z
  .object({
    id: LocalId,
    order: z.number().int().min(1),
    /** One-line fact for the spine. */
    headline: Text(160),
    /** 2-4 sentences. */
    body: Text(1000),
    depth: z.array(Layer).default([]),
    /** Admin-only: which side this fact favors. Never reaches the client. */
    favors: LocalId.optional(),
    /** Admin-only: how much this fact is expected to move people. Drives the balance panel. */
    impact: Impact.optional(),
    source_ids: z.array(LocalId).min(1, 'every step must cite at least one source'),
    confidence: Confidence,
    /** Admin-only supporting quotes, re-checked by the fact-checker. */
    evidence: z.array(Evidence).optional(),
    micro_poll: MicroPoll,
  })
  .strict();
export type Step = z.infer<typeof Step>;

// ---------------------------------------------------------------------------
// Question and sides
// ---------------------------------------------------------------------------

export const SliderScale = z
  .object({
    type: z.literal('slider'),
    min: z.literal(0),
    max: z.literal(100),
    left_label: Text(80),
    right_label: Text(80),
  })
  .strict();

export const Question = z
  .object({
    prompt: Text(240),
    scale: SliderScale,
  })
  .strict();
export type Question = z.infer<typeof Question>;

export const Side = z
  .object({
    id: LocalId,
    label: Text(80),
    /** Strongest case for this side, in its own words. */
    steelman: Text(2000),
  })
  .strict();
export type Side = z.infer<typeof Side>;

// ---------------------------------------------------------------------------
// Review record (agent reports + admin decisions). Never reaches the client.
// ---------------------------------------------------------------------------

export const PIPELINE_AGENTS = [
  'scoper',
  'researcher',
  'records_researcher',
  'drafter',
  'hard_questions',
  'red_team',
  'fact_checker',
  'editor',
] as const;
export const PipelineAgent = z.enum(PIPELINE_AGENTS);
export type PipelineAgent = z.infer<typeof PipelineAgent>;

export const Severity = z.enum(['low', 'medium', 'high']);
export type Severity = z.infer<typeof Severity>;

export const AgentReport = z
  .object({
    agent: PipelineAgent,
    /** e.g. the side a researcher or red team worked for. */
    scope: z.string().max(64).optional(),
    round: z.number().int().min(0),
    at: IsoDateTime,
    summary: z.string().max(4000),
  })
  .strict();
export type AgentReport = z.infer<typeof AgentReport>;

export const HardQuestion = z
  .object({
    id: LocalId,
    /** The side whose skeptic would ask this. */
    side_id: LocalId.optional(),
    question: Text(600),
    blocking: z.boolean(),
    status: z.enum(['answered', 'open', 'not_applicable']),
    resolution: z.string().max(2000).optional(),
    step_ids: z.array(LocalId).default([]),
    round: z.number().int().min(0).default(0),
  })
  .strict();
export type HardQuestion = z.infer<typeof HardQuestion>;

export const BIAS_FLAG_KINDS = [
  'cherry_picking',
  'loaded_wording',
  'order_effect',
  'missing_exculpatory_fact',
  'missing_damning_fact',
  'other',
] as const;

export const BiasFlag = z
  .object({
    id: LocalId,
    step_id: LocalId.optional(),
    kind: z.enum(BIAS_FLAG_KINDS),
    severity: Severity,
    note: Text(2000),
    status: z.enum(['addressed', 'unaddressed', 'wont_fix']),
    resolution: z.string().max(2000).optional(),
  })
  .strict();
export type BiasFlag = z.infer<typeof BiasFlag>;

export const BiasReport = z
  .object({
    side_id: LocalId,
    round: z.number().int().min(0),
    summary: z.string().max(4000).default(''),
    flags: z.array(BiasFlag).default([]),
  })
  .strict();
export type BiasReport = z.infer<typeof BiasReport>;

export const FACT_CHECK_VERDICTS = [
  'supported',
  'partially_supported',
  'unsupported',
  'source_unavailable',
  'uncited',
] as const;
export const FactCheckVerdict = z.enum(FACT_CHECK_VERDICTS);
export type FactCheckVerdict = z.infer<typeof FactCheckVerdict>;

export const FactCheckRow = z
  .object({
    /** Step id, or `fact:<id>` for a starting fact, or `layer:<step>/<layer>`. */
    target: z.string().min(1).max(160),
    claim: Text(2000),
    source_id: LocalId.optional(),
    verdict: FactCheckVerdict,
    quote: z.string().max(1500).optional(),
    note: z.string().max(2000).optional(),
    confidence_before: Confidence.optional(),
    confidence_after: Confidence.optional(),
    round: z.number().int().min(0).default(0),
  })
  .strict();
export type FactCheckRow = z.infer<typeof FactCheckRow>;

export const BalanceSummary = z
  .object({
    per_side: z.record(z.string(), z.number().int().min(0)),
    neutral: z.number().int().min(0),
    untagged: z.number().int().min(0),
    order: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();
export type BalanceSummary = z.infer<typeof BalanceSummary>;

export const OPEN_ISSUE_SOURCES = [
  'pipeline',
  'hard_questions',
  'red_team',
  'fact_checker',
  'editor',
  'validator',
  'admin',
  'user_flags',
  'fairness',
] as const;

export const OpenIssue = z
  .object({
    id: LocalId,
    source: z.enum(OPEN_ISSUE_SOURCES),
    severity: Severity,
    description: Text(2000),
    step_id: LocalId.optional(),
    resolved: z.boolean().default(false),
  })
  .strict();
export type OpenIssue = z.infer<typeof OpenIssue>;

export const DECISION_ACTIONS = [
  'submitted',
  'approve_publish',
  'approve_schedule',
  'request_changes',
  'admin_edit',
  'reject',
  'archive',
  'superseded',
  'scheduled_publish',
  'unschedule',
] as const;
export const DecisionAction = z.enum(DECISION_ACTIONS);
export type DecisionAction = z.infer<typeof DecisionAction>;

export const Decision = z
  .object({
    action: DecisionAction,
    actor: z.string().min(1).max(200),
    at: IsoDateTime,
    version: z.number().int().min(1),
    notes: z.string().max(8000).optional(),
    scheduled_for: IsoDateTime.optional(),
  })
  .strict();
export type Decision = z.infer<typeof Decision>;

export const ReviewRecord = z
  .object({
    pipeline_run_id: z.string().max(100).optional(),
    rounds: z.number().int().min(0).optional(),
    agent_reports: z.array(AgentReport).default([]),
    hard_questions: z.array(HardQuestion).default([]),
    bias_reports: z.array(BiasReport).default([]),
    fact_check: z.array(FactCheckRow).default([]),
    balance: BalanceSummary.optional(),
    open_issues: z.array(OpenIssue).default([]),
    decisions: z.array(Decision).default([]),
  })
  .strict();
export type ReviewRecord = z.infer<typeof ReviewRecord>;

// ---------------------------------------------------------------------------
// Case
// ---------------------------------------------------------------------------

export const Case = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
    /** Stable case identity across versions (uuid in the database). */
    id: z.string().min(1).max(64),
    slug: Slug,
    title: Text(160),
    status: CaseStatus,
    /** Immutable once published. */
    version: z.number().int().min(1),
    /** The version this revision updates. */
    parent_version: z.number().int().min(1).optional(),
    /** Facts current as of this date. */
    as_of: IsoDate,
    /** Shown before the dive starts. */
    content_warning: Text(400).optional(),
    /** The ONE position everyone is measured on. */
    question: Question,
    /** The agreed, no-spin baseline shown first. */
    starting_facts: z.array(Fact).min(1),
    /** Ordered; identical for every user. */
    steps: z.array(Step).min(1),
    /** Strongest case for each side, in its own words. */
    sides: z.array(Side).min(2),
    /** What is still unknown, shown at the end. */
    open_questions: z.array(Text(400)).default([]),
    sources: z.array(Source).min(1),
    review: ReviewRecord.default(() => ReviewRecord.parse({})),
  })
  .strict();
export type Case = z.infer<typeof Case>;
/** The shape accepted before defaults are applied (e.g. raw pipeline JSON). */
export type CaseInput = z.input<typeof Case>;

// ---------------------------------------------------------------------------
// Responses and user signals
// ---------------------------------------------------------------------------

export const BEFORE = 'before' as const;
export const AFTER = 'after' as const;
export const StepKey = z.union([z.literal(BEFORE), z.literal(AFTER), LocalId]);
export type StepKey = z.infer<typeof StepKey>;

export const SliderValue = z.number().int().min(0).max(100);

export const Response = z
  .object({
    session_id: z.uuid(),
    case_id: z.string().min(1),
    case_version: z.number().int().min(1),
    step_id: StepKey,
    value: SliderValue,
    created_at: IsoDateTime,
  })
  .strict();
export type Response = z.infer<typeof Response>;

export const FLAG_REASONS = ['unfair', 'cherry_picked', 'inaccurate', 'other'] as const;
export const FactFlag = z
  .object({
    session_id: z.uuid(),
    case_id: z.string().min(1),
    case_version: z.number().int().min(1),
    step_id: LocalId,
    reason: z.enum(FLAG_REASONS),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();
export type FactFlag = z.infer<typeof FactFlag>;

export const FAIRNESS_RATINGS = ['fair', 'somewhat_fair', 'unfair'] as const;
export const FairnessRating = z
  .object({
    session_id: z.uuid(),
    case_id: z.string().min(1),
    case_version: z.number().int().min(1),
    side_id: LocalId,
    rating: z.enum(FAIRNESS_RATINGS),
  })
  .strict();
export type FairnessRating = z.infer<typeof FairnessRating>;
