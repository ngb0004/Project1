import {
  Case as CaseSchema,
  computeBalance,
  deepEqual,
  diffCases,
  normalizeCase,
  toBalanceSummary,
  validateCase,
  weakerConfidence,
  type AgentReport,
  type BiasFlag,
  type BiasReport,
  type Case,
  type FactCheckRow,
  type HardQuestion,
  type OpenIssue,
  type ReviewRecord,
} from '@sia/case-schema';
import drafterSpec, { type DrafterInput, type DrafterOutput, type ResearchGapRef, type Resolution, type ResolutionAction } from './agents/drafter';
import editorSpec, { type EditorInput, type EditorOutput } from './agents/editor';
import factCheckerSpec, { factCheckTargets, type FactCheckItem, type FactCheckerInput, type FactCheckerOutput } from './agents/factChecker';
import hardQuestionsSpec, { type HardQuestionItem, type HardQuestionsInput, type HardQuestionsOutput } from './agents/hardQuestions';
import recordsResearcherSpec from './agents/recordsResearcher';
import redTeamSpec, { type RedTeamFlag, type RedTeamInput, type RedTeamOutput } from './agents/redTeam';
import researcherSpec, { type ResearchClaim, type ResearchOutput, type ResearcherInput } from './agents/researcher';
import scoperSpec, {
  MAX_MUST_ANSWER,
  developmentItem,
  outlineFromCase,
  statusItem,
  updateDevelopmentsItem,
  type Outline,
  type OutlineSide,
  type ScoperInput,
} from './agents/scoper';
import { judgingWordReport, type Critiques, type DraftCase, type Gap, type GapInput, type OpenedSourceRef, type SourceSnapshotRef } from './agents/shared';
import { bestSnapshot, describeDrift, quotesBySource, sourceDrift, type ArchivedSnapshot } from './archive';
import type { AgentContext, AgentSpec } from './agents/types';
import { checkCitations, failureKey, type CitationFailure } from './factcheck';
import type { LogSummary } from './research/log';
import type { SourceStore } from './research/store';
import { MIN_QUOTE_CHARS, matchQuote, normalizeForMatch, urlKey } from './research/text';
import { ResearchTools } from './research/tools';
import { AgentRunError, type AgentRunResult, type AgentRunner } from './runner/types';
import {
  changesBeyondAsOf,
  describeScreening,
  developmentDate,
  knownFactsOf,
  screenDevelopments,
  updateSummaryText,
  type ScreenedDevelopments,
} from './update';

export { isAfter } from './update';

/**
 * The research pipeline: scoper -> researchers (one per side, plus the records
 * researcher) -> drafter -> critic loop -> editor -> package.
 *
 * Loop rules (at most `maxRounds`, default 3): each round runs the
 * hard-questions agent, one red team per side (a fresh call that sees only the
 * draft JSON), the fact-checker and the deterministic citation check in
 * parallel. The loop stops when there are no blocking gaps, no high-severity
 * red-team flags, no fact-check failures and no validator errors. Otherwise the
 * gaps go back to the researchers and the drafter revises. Anything still
 * unresolved after the last round becomes an open issue for the admin.
 */

export type PipelineRequest =
  | { kind: 'new_case'; brief: string }
  | { kind: 'revision'; base: Case; instructions: string }
  /**
   * A live update. `pending` is the pipeline's update package already waiting
   * for review on top of `live`, if there is one: the update then builds on it
   * (researching only what is new since its as-of date) and replaces it in the
   * queue, so the admin always reviews one current package against `live`.
   */
  | { kind: 'update'; live: Case; pending?: Case };

export interface PipelineAgents {
  scoper: AgentSpec<ScoperInput, Outline>;
  researcher: AgentSpec<ResearcherInput, ResearchOutput>;
  recordsResearcher: AgentSpec<ResearcherInput, ResearchOutput>;
  drafter: AgentSpec<DrafterInput, DrafterOutput>;
  hardQuestions: AgentSpec<HardQuestionsInput, HardQuestionsOutput>;
  redTeam: AgentSpec<RedTeamInput, RedTeamOutput>;
  factChecker: AgentSpec<FactCheckerInput, FactCheckerOutput>;
  editor: AgentSpec<EditorInput, EditorOutput>;
}

export const DEFAULT_AGENTS: PipelineAgents = {
  scoper: scoperSpec,
  researcher: researcherSpec,
  recordsResearcher: recordsResearcherSpec,
  drafter: drafterSpec,
  hardQuestions: hardQuestionsSpec,
  redTeam: redTeamSpec,
  factChecker: factCheckerSpec,
  editor: editorSpec,
};

export const MAX_ROUNDS = 3;
export const RECORDS_SCOPE = 'records';
/** The research-log name for steps the orchestrator takes itself (re-opening base sources, loop decisions). */
export const PIPELINE_LOG_AGENT = 'pipeline';

export interface PipelineDeps {
  runner: AgentRunner;
  store: SourceStore;
  /** The job id when a worker runs it. */
  runId: string;
  /** Facts are current as of this date (default: today, UTC). */
  asOf?: string;
  agents?: PipelineAgents;
  maxRounds?: number;
  /** Spend cap for the whole run, in USD. */
  budgetUsd?: number;
  /**
   * Revisions and updates: snapshots earlier jobs took of the base version's
   * sources (see src/archive.ts). They back the facts the run leaves unchanged
   * when a page has changed since it was cited.
   */
  archive?: ArchivedSnapshot[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Called with the run's total spend whenever it grows (the worker records it with each heartbeat). */
  onSpend?: (totalUsd: number) => void;
}

export interface OpenedSourceSummary {
  snapshot_id: string;
  url: string;
  final_url: string;
  title: string;
  http_status: number;
  sha256: string;
  fetched_at: string;
  chars: number;
}

export interface ResearchLogDigest extends LogSummary {
  opened: OpenedSourceSummary[];
}

/** What a live update package is, for the worker's job result and the review record. */
export interface UpdateInfo {
  live_version: number;
  /** The version the draft started from (the live version, or the update package it replaces). */
  base_version: number;
  /** Developments are dated after this date (the base version's as-of date). */
  since: string;
  developments: { id: string; text: string; url: string; publisher: string; date: string | null }[];
  /** The plain update summary also recorded as the editor's `update` report in the review record. */
  summary: string;
}

export interface PipelinePackage {
  kind: 'package';
  runId: string;
  request: PipelineRequest['kind'];
  /** Set for live updates. */
  update?: UpdateInfo;
  /** The case with its review record, ready for submit_case_package. */
  case: Case;
  review: ReviewRecord;
  outline: Outline;
  researchLog: ResearchLogDigest;
  costUsd: number;
  rounds: number;
  /** True when the loop ended with nothing blocking. */
  clean: boolean;
  /** True when the editor's version was rejected and the last valid draft was used. */
  editorFallback: boolean;
}

export interface NoChangesResult {
  kind: 'no_changes';
  runId: string;
  /** Why nothing was submitted, in plain words (also written to the research log). */
  summary: string;
  /** The version the update researched against, and the date developments had to come after. */
  baseVersion?: number;
  since?: string;
  researchLog: ResearchLogDigest;
  costUsd: number;
}

export type PipelineResult = PipelinePackage | NoChangesResult;

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly costUsd = 0,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

/**
 * The model service refused the account (usage or rate limit, authentication).
 * Every later call would fail the same way, so the run stops at once rather
 * than submit a package whose critics, revisions or editor never ran.
 */
export class ServiceUnavailableError extends PipelineError {
  constructor(message: string, costUsd = 0) {
    super(message, costUsd);
    this.name = 'ServiceUnavailableError';
  }
}

export class BudgetExhaustedError extends Error {
  constructor(spent: number, budget: number) {
    super(`the run budget of $${budget.toFixed(2)} is used up ($${spent.toFixed(2)} spent)`);
    this.name = 'BudgetExhaustedError';
  }
}

export async function runCasePipeline(request: PipelineRequest, deps: PipelineDeps): Promise<PipelineResult> {
  return new PipelineRun(deps).execute(request);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAILING_VERDICTS = new Set<FactCheckRow['verdict']>(['unsupported', 'uncited', 'source_unavailable']);

/** Note prefix of the failing rows the orchestrator adds for item-and-source pairs the fact-checker did not check. */
export const NOT_CHECKED = 'Not checked:';
/** Note prefix of rows from the fact-check of the editor's changes. */
export const FINAL_CHECK = 'Final check after the editor:';

const isNotChecked = (row: Pick<FactCheckItem, 'note'>) => !!row.note?.startsWith(NOT_CHECKED);
const pairKey = (target: string, sourceId: string | undefined) => `${target}\u0000${sourceId ?? ''}`;

const STOP_WORDS = new Set(
  'that this with from have were said says will would there their they them about after before into than then when which while also been being does what because according over under more most such only some other these those where whose could should said told'.split(
    ' ',
  ),
);

/** Content words of a text (numbers, and words of four or more letters that are not stop words), cut to five-letter stems. */
function contentStems(text: string): string[] {
  const words = normalizeForMatch(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => /\d/.test(w) || (w.length >= 4 && !STOP_WORDS.has(w))).map((w) => w.slice(0, 5)))];
}

/**
 * Whether a fact-check row's claim is about the item's own text (a step's
 * headline and body, a fact's text), rather than a detail only an extra
 * citation or a layer supports. Short claims count as about the item.
 */
export function claimConcernsText(claim: string, itemText: string): boolean {
  const claimWords = contentStems(claim);
  if (claimWords.length < 3) return true;
  const item = new Set(contentStems(itemText));
  return claimWords.filter((w) => item.has(w)).length / claimWords.length >= 0.4;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** A valid local id from any string. */
export function toLocalId(raw: string, fallback = 'x'): string {
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64);
  return id || fallback;
}

/** Every source id a draft cites anywhere. */
function citedSourceIds(c: DraftCase): Set<string> {
  const ids = new Set<string>();
  const add = (xs: string[] | undefined) => xs?.forEach((x) => ids.add(x));
  for (const f of c.starting_facts) {
    add(f.source_ids);
    f.evidence?.forEach((e) => ids.add(e.source_id));
  }
  for (const s of c.steps) {
    add(s.source_ids);
    s.evidence?.forEach((e) => ids.add(e.source_id));
    for (const l of s.depth) {
      if (l.kind === 'document' || l.kind === 'quote') ids.add(l.source_id);
      else if (l.kind === 'context') add(l.source_ids);
      else l.entries.forEach((e) => add(e.source_ids));
    }
  }
  return ids;
}

/** The step a review target (`s3`, `fact:f1`, `layer:s3/q1`) belongs to, if it is in the case. */
function stepIdOf(target: string, c: Pick<Case, 'steps'>): string | undefined {
  const id = target.startsWith('layer:') ? target.slice(6).split('/')[0] : target;
  return id && c.steps.some((s) => s.id === id) ? id : undefined;
}

interface ResolutionRecord {
  action: ResolutionAction;
  text: string;
}

interface QuestionRecord {
  item: HardQuestionItem;
  firstRound: number;
  lastRound: number;
  drafterResolution?: ResolutionRecord;
}

interface FlagRecord {
  flag: RedTeamFlag;
  drafterResolution?: ResolutionRecord;
  /** The next round's red team (shown this flag) raised it again. */
  reraised?: boolean;
}

interface RoundCritique {
  round: number;
  hard?: HardQuestionsOutput;
  redTeams: { side: OutlineSide; out?: RedTeamOutput; flags: FlagRecord[] }[];
  factRows: FactCheckItem[];
  citations: CitationFailure[];
  validationErrors: string[];
  failedCritics: string[];
  /** Downgrades not applied: the row's claim is not in the item's headline and body (see applyDowngrades). */
  skippedDowngrades: FactCheckItem[];
}

/** What the fact-check of the editor's changes found (see finalCheck). */
interface FinalCheck {
  /** Items the editor changed after the last critic round. */
  edited: string[];
  /** True when the fact-checker re-checked them. */
  ran: boolean;
  /** Edited items the final check found supported. */
  passed: Set<string>;
  /** Edited items put back as the last checked draft had them (or removed when new), with why. */
  reverted: Map<string, string>;
  rows: FactCheckItem[];
  skippedDowngrades: FactCheckItem[];
}

/** An open issue while the review is assembled: the fact-check target it came from, if any. */
type DraftIssue = Omit<OpenIssue, 'id'> & { target?: string };

interface Blocking {
  questions: HardQuestionItem[];
  gaps: Gap[];
  flags: { side: OutlineSide; flag: RedTeamFlag }[];
  factRows: FactCheckItem[];
  citations: CitationFailure[];
  validationErrors: string[];
  failedCritics: string[];
}

const blockingCount = (b: Blocking) =>
  b.questions.length + b.gaps.length + b.flags.length + b.factRows.length + b.citations.length + b.validationErrors.length + b.failedCritics.length;

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

class PipelineRun {
  private readonly agents: PipelineAgents;
  private readonly asOf: string;
  private readonly maxRounds: number;
  private readonly budget: number;
  private cost = 0;
  private readonly reports: AgentReport[] = [];
  private claims: ResearchClaim[] = [];
  private readonly issues: DraftIssue[] = [];
  private outline!: Outline;
  private base: Case | undefined;
  /** Live updates: the live version, the screened research, and the drafter's resolutions by ref. */
  private live: Case | undefined;
  private screening: ScreenedDevelopments | undefined;
  private readonly resolutions = new Map<string, string>();
  /** Researcher calls that failed, as "scope: message". */
  private readonly researchFailures: string[] = [];
  /** What each researcher (by scope) last reported it could not find or verify. */
  private readonly researchGaps = new Map<string, Gap[]>();
  /** The last draft's research_gaps: facts the drafter needed and no claim supplied. */
  private drafterGaps: string[] = [];
  /** The editor's resolutions by ref (flag ids, question ids, fact_check:<target>). */
  private readonly editorResolutions = new Map<string, ResolutionRecord>();

  constructor(private readonly deps: PipelineDeps) {
    this.agents = deps.agents ?? DEFAULT_AGENTS;
    this.asOf = deps.asOf ?? todayUtc();
    // The spec's loop stops at 3 rounds: a larger or non-numeric setting falls back to that.
    const rounds = deps.maxRounds;
    this.maxRounds = rounds !== undefined && Number.isFinite(rounds) ? Math.min(MAX_ROUNDS, Math.max(1, Math.floor(rounds))) : MAX_ROUNDS;
    this.budget = deps.budgetUsd ?? Infinity;
  }

  private get store(): SourceStore {
    return this.deps.store;
  }

  private progress(message: string) {
    this.deps.onProgress?.(message);
  }

  private addCost(usd: number) {
    if (!(usd > 0)) return;
    this.cost += usd;
    this.deps.onSpend?.(this.cost);
  }

  private async note(text: string, round: number, scope: string | null = null) {
    await this.store.log.append({ agent: PIPELINE_LOG_AGENT, scope, round, kind: 'note', excerpt: text });
  }

  // -------------------------------------------------------------------------
  // Agent calls
  // -------------------------------------------------------------------------

  /**
   * Kept back for the editor and the fact-check of its changes, so a loop that
   * runs long still ends with the house-style pass and nothing unchecked:
   * 15% of the run budget, at most $6.
   */
  private get reserveUsd(): number {
    return Number.isFinite(this.budget) ? Math.min(this.budget * 0.15, 6) : 0;
  }

  /** What is left to spend, minus the editor's reserve unless `useReserve`. */
  private budgetLeft(useReserve = false): number {
    return this.budget - this.cost - (useReserve ? 0 : this.reserveUsd);
  }

  private callBudget(share: number, useReserve = false): number | undefined {
    if (!Number.isFinite(this.budget)) return undefined;
    const left = this.budgetLeft(useReserve);
    if (left < 0.05) throw new BudgetExhaustedError(this.cost, this.budget);
    return left / Math.max(1, share);
  }

  /**
   * Runs one agent call with tools bound to its name, scope and round, retries
   * once on a bad answer, writes a research-log note for every call (success or
   * failure) and records an agent report.
   */
  private async call<I, O>(
    spec: AgentSpec<I, O>,
    input: I,
    round: number,
    opts: { scope?: string; share?: number; useReserve?: boolean; summarize: (o: O) => string; onTools?: (tools: ResearchTools) => void },
  ): Promise<O> {
    const ctx: AgentContext = { runId: this.deps.runId, asOf: this.asOf, round, ...(opts.scope ? { scope: opts.scope } : {}) };
    const tools = new ResearchTools(this.store, { agent: spec.name, scope: opts.scope ?? null, round }, spec.tools);
    opts.onTools?.(tools);
    const label = `${spec.name}${opts.scope ? ` (${opts.scope})` : ''}, round ${round}`;
    for (let attempt = 1; ; attempt++) {
      this.deps.signal?.throwIfAborted();
      const maxBudgetUsd = this.callBudget(opts.share ?? 1, opts.useReserve);
      this.progress(`${label}: started${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      let r: AgentRunResult<O>;
      try {
        r = await this.deps.runner.run(spec, input, ctx, tools, {
          ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
          ...(this.deps.signal ? { signal: this.deps.signal } : {}),
        });
      } catch (e) {
        const err = e as Error;
        this.addCost(e instanceof AgentRunError ? e.costUsd : 0);
        await tools.note(`Agent call failed: ${label}, attempt ${attempt}: ${err.message}`).catch(() => {});
        this.progress(`${label}: failed (${err.message})`);
        if (e instanceof AgentRunError && e.reason === 'unavailable') {
          throw new ServiceUnavailableError(`the model service is unavailable (${label}): ${err.message}`, this.cost);
        }
        const retryable = e instanceof AgentRunError && (e.reason === 'output' || e.reason === 'execution');
        if (attempt >= 2 || !retryable || this.deps.signal?.aborted) throw e;
        continue;
      }
      this.addCost(r.costUsd);
      const summary = clip(opts.summarize(r.output), 4000);
      this.reports.push({
        agent: spec.name,
        ...(opts.scope ? { scope: opts.scope.slice(0, 64) } : {}),
        round,
        at: new Date().toISOString(),
        summary,
      });
      await tools.note(
        `Agent call finished: ${label}. ${r.turns} turns, $${r.costUsd.toFixed(4)}; ` +
          `${tools.queries.length} searches, ${tools.opens.length} pages opened (${tools.opens.filter((o) => o.ok).length} usable), ` +
          `${tools.reads.size} snapshots read, ${tools.claims.length} claims logged. ${summary}`,
      );
      // Which stored pages a reading agent (drafter, red team, fact-checker) went back to, for the audit trail.
      if (tools.reads.size) await tools.note(`Snapshots read by ${label}: ${[...tools.reads].join(', ')}.`);
      this.progress(`${label}: done ($${r.costUsd.toFixed(2)}, ${r.turns} turns)`);
      return r.output;
    }
  }

  // -------------------------------------------------------------------------
  // Research
  // -------------------------------------------------------------------------

  private async research(
    round: number,
    jobs: { side?: OutlineSide; gaps?: GapInput[] }[],
    update?: { sinceAsOf: string; knownFacts: string[]; openQuestions: string[] },
  ) {
    const toolsOf = new Map<number, ResearchTools>();
    const results = await Promise.allSettled(
      jobs.map((job, i) => {
        const scope = job.side?.id ?? RECORDS_SCOPE;
        const spec = job.side ? this.agents.researcher : this.agents.recordsResearcher;
        const input: ResearcherInput = {
          outline: this.outline,
          ...(job.side ? { side: job.side } : {}),
          ...(job.gaps?.length ? { gaps: job.gaps } : {}),
          ...(update
            ? { sinceAsOf: update.sinceAsOf, known_facts: update.knownFacts, ...(update.openQuestions.length ? { open_questions: update.openQuestions } : {}) }
            : {}),
        };
        return this.call(spec, input, round, {
          scope,
          share: jobs.length,
          summarize: (o) => `${o.claims.length} claims, ${o.gaps.length} gaps. ${o.summary}`,
          onTools: (t) => toolsOf.set(i, t),
        }).then((out) => ({ scope, out }));
      }),
    );
    const fresh: ResearchClaim[] = [];
    let failures = 0;
    for (const [i, r] of results.entries()) {
      const scope = jobs[i]!.side?.id ?? RECORDS_SCOPE;
      if (r.status === 'rejected') {
        failures++;
        const msg = (r.reason as Error).message;
        if (r.reason instanceof BudgetExhaustedError || r.reason instanceof PipelineError) throw r.reason;
        this.researchFailures.push(`${scope} (round ${round}): ${msg}`);
        const salvaged = this.salvageClaims(toolsOf.get(i), scope, round);
        this.issues.push({
          source: 'pipeline',
          severity: 'high',
          description: clip(
            `Research for "${scope}" failed in round ${round}: ${msg}` +
              (salvaged.length ? ` ${salvaged.length} claim(s) it had logged were kept with conservative labels (news, reported, neutral).` : ''),
            2000,
          ),
          resolved: false,
        });
        if (salvaged.length) {
          await this.note(`Kept ${salvaged.length} claim(s) that the failed ${scope} researcher logged before it stopped.`, round, scope);
          fresh.push(...(await this.acceptClaims(salvaged, scope, round, toolsOf.get(i))));
        }
        continue;
      }
      this.researchGaps.set(scope, r.value.out.gaps);
      fresh.push(...(await this.acceptClaims(r.value.out.claims, scope, round, toolsOf.get(i))));
    }
    if (failures === jobs.length && jobs.length > 0 && round === 0) {
      throw new PipelineError(`every researcher failed in round ${round}`, this.cost);
    }
    this.claims.push(...fresh);
    return fresh;
  }

  /**
   * A researcher that stops early (turn or spend limit) loses its answer, but the
   * claims it logged with log_claim were already checked against their snapshots.
   * They are kept with conservative labels: news, reported, neutral, medium; the
   * drafter and the fact-checker re-label them from the sources.
   */
  private salvageClaims(tools: ResearchTools | undefined, scope: string, round: number): ResearchClaim[] {
    return (tools?.claims ?? []).map((c, n) => {
      const snap = this.store.get(c.snapshot_id);
      const host = (() => {
        try {
          return new URL(c.url).hostname.replace(/^www\./, '');
        } catch {
          return 'unknown';
        }
      })();
      return {
        id: toLocalId(`${scope}-r${round}-logged-${n + 1}`),
        text: clip(c.text, 600),
        quote: clip(c.quote, 1500),
        snapshot_id: c.snapshot_id,
        url: c.url,
        source_title: clip(snap?.title || host, 300),
        publisher: clip(host, 200),
        source_date: null,
        source_type: 'news',
        event_date: null,
        confidence: 'reported',
        favors: 'neutral',
        impact: 'medium',
      };
    });
  }

  /**
   * Keeps only claims whose quote appears in a snapshot taken in this run, fixes
   * a claim's URL to the page that snapshot came from, and makes ids unique.
   *
   * Every accepted claim is in the research log: a claim the researcher returned
   * without calling log_claim gets its `claim` row here (marked as logged by the
   * pipeline), and one note per call records the claim set the drafter receives
   * (ids, favors, confidence, source type, impact), so the admin can trace any
   * fact back to its claim.
   */
  private async acceptClaims(claims: ResearchClaim[], scope: string, round: number, tools?: ResearchTools): Promise<ResearchClaim[]> {
    const taken = new Set(this.claims.map((c) => c.id));
    const out: ResearchClaim[] = [];
    const dropped: string[] = [];
    for (const c of claims) {
      const snap = this.store.get(c.snapshot_id);
      if (!snap || snap.archivedFrom) {
        dropped.push(`${c.id}: snapshot ${c.snapshot_id} was not taken in this run`);
        continue;
      }
      const m = matchQuote(c.quote, snap.text);
      if (!m.ok) {
        dropped.push(`${c.id}: quote ${m.reason === 'too_short' ? 'too short to verify' : 'not found in its snapshot'}`);
        continue;
      }
      let url = c.url;
      if (urlKey(url) !== urlKey(snap.url) && urlKey(url) !== urlKey(snap.finalUrl)) url = snap.url;
      // A claim can only favor a side of this case, or no side.
      const favors = c.favors === 'neutral' || this.outline.sides.some((s) => s.id === c.favors) ? c.favors : 'neutral';
      let id = c.id;
      for (let n = 2; taken.has(id); n++) id = toLocalId(`${c.id}-${n}`);
      taken.add(id);
      out.push({ ...c, id, url, favors });
    }
    if (dropped.length) {
      await this.note(`Dropped ${dropped.length} claim(s) from ${scope} that could not be verified against this run's snapshots: ${dropped.join('; ')}`, round, scope);
    }
    if (out.length) {
      const agent = tools?.caller.agent ?? (scope === RECORDS_SCOPE ? this.agents.recordsResearcher.name : this.agents.researcher.name);
      const logged = (c: ResearchClaim) =>
        (tools?.claims ?? []).some((l) => l.snapshot_id === c.snapshot_id && normalizeForMatch(l.quote) === normalizeForMatch(c.quote));
      const unlogged = out.filter((c) => !logged(c));
      for (const c of unlogged) {
        const snap = this.store.get(c.snapshot_id);
        await this.store.log.append({
          agent,
          scope,
          round,
          kind: 'claim',
          url: c.url,
          title: snap?.title || c.source_title,
          snapshot_id: c.snapshot_id,
          excerpt: c.quote,
          claims: [{ id: c.id, text: c.text, quote: c.quote, logged_by: 'pipeline', why: 'returned by the researcher without a log_claim call' }],
        });
      }
      await this.store.log.append({
        agent: PIPELINE_LOG_AGENT,
        scope,
        round,
        kind: 'note',
        excerpt: clip(
          `Accepted ${out.length} claim(s) from ${scope} for the drafter: ${out.map((c) => c.id).join(', ')}.` +
            (unlogged.length ? ` ${unlogged.length} of them had no log_claim entry; the pipeline logged them (${unlogged.map((c) => c.id).join(', ')}).` : ''),
          4000,
        ),
        claims: out.map((c) => ({
          id: c.id,
          text: c.text,
          quote: c.quote,
          snapshot_id: c.snapshot_id,
          url: c.url,
          publisher: c.publisher,
          source_type: c.source_type,
          source_date: c.source_date,
          event_date: c.event_date,
          favors: c.favors,
          confidence: c.confidence,
          impact: c.impact,
        })),
      });
    }
    return out;
  }

  /** Every researcher's last reported gaps, for the drafter, the hard-questions agent and the admin. */
  private researchGapRefs(): ResearchGapRef[] {
    return [...this.researchGaps].flatMap(([scope, gaps]) =>
      gaps.map((g) => ({ scope, description: g.description, blocking: g.blocking, ...(g.search_hint ? { search_hint: g.search_hint } : {}) })),
    );
  }

  private openedRefs(): OpenedSourceRef[] {
    return this.store.opened().map((s) => ({ snapshot_id: s.id, url: s.url, final_url: s.finalUrl, title: s.title, fetched_at: s.fetchedAt }));
  }

  /** Each cited source with the snapshot the critics should read: one that still has every passage the draft quotes. */
  private sourceRefs(c: DraftCase): SourceSnapshotRef[] {
    const quotes = quotesBySource(c);
    return c.sources.map((s) => ({ source_id: s.id, snapshot_id: bestSnapshot(this.store, s.url, quotes.get(s.id) ?? [])?.id ?? null, url: s.url }));
  }

  /** Revisions and updates cite the base version's sources: open each again so it counts as opened in this run. */
  private async reopenBaseSources(base: Case) {
    const urls = [...new Map(base.sources.map((s) => [urlKey(s.url), s.url])).values()];
    const results = await Promise.all(urls.map((u) => this.store.open(u, PIPELINE_LOG_AGENT, 'base_sources', 0)));
    const failed = results.filter((r) => !r.ok);
    await this.note(
      `Re-opened ${urls.length} source(s) of version ${base.version}: ${urls.length - failed.length} usable` +
        (failed.length ? `; not usable: ${failed.map((f) => `${f.url} (${f.error})`).join('; ')}` : '.'),
      0,
      'base_sources',
    );
    // A page that no longer says what the case quotes (a paywall, an edit, a removal) does not make the
    // unchanged facts wrong: they are checked against the archived snapshot, and the admin is told.
    for (const d of sourceDrift(base, this.store)) {
      const text = describeDrift(d, base.version);
      await this.note(text, 0, 'base_sources');
      this.issues.push({ source: 'pipeline', severity: 'medium', description: clip(text, 2000), resolved: false });
    }
  }

  /** Loads the base version's archived snapshots into the store, before anything is opened. */
  private async loadArchive(base: Case) {
    const records = this.deps.archive ?? [];
    if (!records.length) return;
    const n = this.store.archive(records);
    const jobs = [...new Set(records.map((r) => r.job_id.slice(0, 8)))];
    await this.note(
      `Loaded ${n} archived snapshot(s) of version ${base.version}'s sources (from job(s) ${jobs.join(', ')}): evidence for the facts this run ` +
        'leaves unchanged if a page has changed since it was cited. They are not counted as opened in this run.',
      0,
      'base_sources',
    );
  }

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  /** Identity fields, access times and mechanical fixes the pipeline owns, whatever the drafter wrote. */
  private prepare(raw: DraftCase): DraftCase {
    const c = structuredClone(raw);
    if (this.base) {
      c.id = this.base.id;
      c.slug = this.base.slug;
      c.version = this.base.version + 1;
      // An update always updates the live version, even when it builds on the update package in review.
      const parent = this.live ? this.live.version : this.base.status === 'published' ? this.base.version : this.base.parent_version;
      if (parent !== undefined) c.parent_version = parent;
      else delete c.parent_version;
    } else {
      c.slug = this.outline.slug;
      c.id = this.outline.slug;
      c.version = 1;
      delete c.parent_version;
    }
    c.status = 'draft';
    c.as_of = this.asOf;
    // A source the base version already lists keeps its access time (the run re-opened it to check it, and the
    // diff should not show every source as changed); a new source gets the fetch time of its snapshot.
    const baseSources = new Map((this.base?.sources ?? []).map((s) => [s.id, s]));
    for (const s of c.sources) {
      const prev = baseSources.get(s.id);
      if (prev && urlKey(prev.url) === urlKey(s.url) && this.store.findByUrl(s.url)) {
        s.accessed_at = prev.accessed_at;
        continue;
      }
      const snap = this.store.findByUrl(s.url);
      if (snap) s.accessed_at = snap.fetchedAt;
    }
    const cited = citedSourceIds(c);
    if (c.sources.some((s) => !cited.has(s.id)) && c.sources.some((s) => cited.has(s.id))) {
      c.sources = c.sources.filter((s) => cited.has(s.id));
    }
    return normalizeCase(c).case;
  }

  private validation(c: DraftCase): { ok: boolean; errors: string[] } {
    const r = validateCase(c);
    const errors = r.errors.map((e) => `${e.path || '(root)'}: ${e.message}`);
    const want = this.outline.sides.map((s) => s.id).sort().join(',');
    const have = c.sides.map((s) => s.id).sort().join(',');
    if (want !== have) errors.push(`sides: use exactly the outline's side ids (${want}); the draft has (${have}).`);
    return { ok: errors.length === 0, errors };
  }

  /**
   * Applies the fact-checker's confidence downgrades (never upgrades) to the
   * draft. A row sets an item's label only when its claim is about the item's
   * own text (a step's headline and body, a fact's text): a row about a detail
   * that only an extra citation supports does not relabel the whole step. Such
   * rows come back as `skipped`, for an open issue that asks the admin to check
   * the label and the citation.
   */
  private applyDowngrades(c: DraftCase, rows: FactCheckItem[]): { changes: string[]; skipped: FactCheckItem[] } {
    const changes: string[] = [];
    const skipped: FactCheckItem[] = [];
    for (const row of rows) {
      if (!row.confidence_after || isNotChecked(row)) continue;
      const fact = row.target.startsWith('fact:') ? c.starting_facts.find((f) => `fact:${f.id}` === row.target) : undefined;
      const step = fact ? undefined : c.steps.find((s) => s.id === row.target);
      const item = fact ?? step;
      if (!item) continue;
      const next = weakerConfidence(item.confidence, row.confidence_after);
      if (next === item.confidence) continue;
      const text = fact ? fact.text : `${step!.headline} ${step!.body}`;
      if (!claimConcernsText(row.claim, text)) {
        skipped.push(row);
        continue;
      }
      changes.push(`${row.target}: ${item.confidence} -> ${next}`);
      item.confidence = next;
    }
    return { changes, skipped };
  }

  // -------------------------------------------------------------------------
  // Fact-check coverage
  // -------------------------------------------------------------------------

  /**
   * The item-and-source pairs a fact-check pass left unchecked, as failing rows:
   * a checklist item and cited source with no row; a "supported" (or partly
   * supported) row when no snapshot of that source was read in the pass; or one
   * whose quoted passage is not in the source. Pairs with a failing row are
   * already failures and are not repeated.
   */
  private coverageGaps(draft: DraftCase, rows: FactCheckItem[], reads: Set<string>, only?: string[]): FactCheckItem[] {
    const sources = new Map(draft.sources.map((s) => [s.id, s]));
    const byPair = new Map<string, FactCheckItem[]>();
    for (const r of rows) {
      if (!r.source_id || isNotChecked(r)) continue;
      const k = pairKey(r.target, r.source_id);
      byPair.set(k, [...(byPair.get(k) ?? []), r]);
    }
    const gaps: FactCheckItem[] = [];
    for (const t of factCheckTargets(draft)) {
      if (only && !only.includes(t.target)) continue;
      for (const sid of new Set(t.source_ids)) {
        const src = sources.get(sid);
        if (!src) continue; // the deterministic check fails a source that is not in the list
        const found = byPair.get(pairKey(t.target, sid)) ?? [];
        if (found.some((r) => FAILING_VERDICTS.has(r.verdict))) continue;
        const snaps = this.store.findAllByUrl(src.url);
        let why: string | undefined;
        if (!found.length) why = `the fact-checker returned no row for this item against "${sid}"`;
        else if (!snaps.some((x) => reads.has(x.id))) why = `the fact-checker marked this item ${found[0]!.verdict.replace('_', ' ')} against "${sid}" without reading that source`;
        else {
          const quoted = found.filter((r) => r.quote && normalizeForMatch(r.quote).length >= MIN_QUOTE_CHARS);
          if (quoted.length && !quoted.some((r) => snaps.some((x) => matchQuote(r.quote!, x.text).ok))) {
            why = `the passage the fact-checker quoted from "${sid}" is not in that source`;
          }
        }
        if (!why) continue;
        gaps.push({
          target: t.target,
          claim: clip(t.text.trim() || t.target, 2000),
          source_id: sid,
          verdict: 'uncited',
          note: clip(`${NOT_CHECKED} ${why}, so nothing confirms the source supports it.`, 2000),
          ...(t.confidence ? { confidence_before: t.confidence } : {}),
        });
      }
    }
    return gaps;
  }

  /**
   * One fact-check pass with its coverage enforced. Pairs the pass left
   * unchecked (see coverageGaps) get one follow-up call on just those items;
   * whatever is still unchecked becomes a failing "not checked" row, which
   * blocks the loop and reaches the admin like any other failure.
   */
  private async factCheck(
    draft: DraftCase,
    round: number,
    opts: { share: number; only?: string[]; focus?: string; useReserve?: boolean },
  ): Promise<FactCheckItem[]> {
    const sources = this.sourceRefs(draft);
    const used: ResearchTools[] = [];
    const reads = () => new Set(used.flatMap((t) => [...t.reads, ...t.opens.flatMap((o) => (o.snapshot ? [o.snapshot.id] : []))]));
    const summarize = (o: FactCheckerOutput) => {
      const by = new Map<string, number>();
      for (const r of o.rows) by.set(r.verdict, (by.get(r.verdict) ?? 0) + 1);
      return `${o.rows.length} rows: ${[...by].map(([v, n]) => `${n} ${v}`).join(', ') || 'none'}.`;
    };
    const input = (only?: string[], focus?: string): FactCheckerInput => ({ draft, sources, ...(only ? { only } : {}), ...(focus ? { focus } : {}) });
    const first = await this.call(this.agents.factChecker, input(opts.only, opts.focus), round, {
      share: opts.share,
      ...(opts.useReserve ? { useReserve: true } : {}),
      summarize,
      onTools: (t) => used.push(t),
    });
    let rows = first.rows;
    let gaps = this.coverageGaps(draft, rows, reads(), opts.only);
    if (gaps.length) {
      const targets = [...new Set(gaps.map((g) => g.target))];
      const pairs = gaps.map((g) => `${g.target} against ${g.source_id}`);
      await this.note(`The fact-checker left ${gaps.length} item-and-source pair(s) unchecked in round ${round} (${clip(pairs.join('; '), 1500)}); asking it to check them.`, round);
      try {
        const again = await this.call(
          this.agents.factChecker,
          input(targets, `not yet checked against every cited source: ${clip(pairs.join('; '), 1500)}`),
          round,
          { share: Math.max(1, opts.share), ...(opts.useReserve ? { useReserve: true } : {}), summarize, onTools: (t) => used.push(t) },
        );
        const redone = new Set(again.rows.filter((r) => r.source_id).map((r) => pairKey(r.target, r.source_id)));
        rows = [...rows.filter((r) => !(r.source_id && redone.has(pairKey(r.target, r.source_id)))), ...again.rows];
        gaps = this.coverageGaps(draft, rows, reads(), opts.only);
      } catch (e) {
        if (e instanceof PipelineError || this.deps.signal?.aborted) throw e;
        await this.note(`The follow-up fact-check failed (${(e as Error).message}); ${gaps.length} pair(s) stay unchecked and count as failures.`, round);
      }
      if (gaps.length) await this.note(`${gaps.length} item-and-source pair(s) remain unchecked after the follow-up and count as failures.`, round);
    }
    return [...rows, ...gaps];
  }

  // -------------------------------------------------------------------------
  // The critic loop
  // -------------------------------------------------------------------------

  private async critique(draft: DraftCase, round: number, previousQuestions: HardQuestion[], previous?: RoundCritique): Promise<RoundCritique> {
    const sides = this.outline.sides;
    // Spend caps for the parallel critics, as shares of what is left: the fact-checker reads every cited
    // source and gets the largest share; the hard-questions agent has no tools and gets the smallest.
    const weight = { hard: 0.5, fact: 3, red: 1 };
    const total = weight.hard + weight.fact + weight.red * sides.length;
    const share = (w: number) => total / w;
    const failed: string[] = [];
    const settle = async <T>(name: string, p: Promise<T>): Promise<T | undefined> => {
      try {
        return await p;
      } catch (e) {
        if (e instanceof BudgetExhaustedError || e instanceof PipelineError) throw e;
        failed.push(`${name}: ${(e as Error).message}`);
        return undefined;
      }
    };
    const sources = this.sourceRefs(draft);
    const [hard, fc, ...reds] = await Promise.all([
      settle(
        'hard_questions',
        this.call(
          this.agents.hardQuestions,
          {
            draft,
            must_answer: this.outline.must_answer,
            ...(previousQuestions.length ? { previous: previousQuestions } : {}),
            ...(this.researchGapRefs().length ? { research_gaps: this.researchGapRefs() } : {}),
          },
          round,
          {
            share: share(weight.hard),
            summarize: (o) =>
              `${o.questions.length} questions (${o.questions.filter((q) => q.blocking && q.status === 'open').length} blocking and open), ` +
              `${o.gaps.length} gaps (${o.gaps.filter((g) => g.blocking).length} blocking). Most moving fact: ${o.most_moving_fact}`,
          },
        ),
      ),
      settle('fact_checker', this.factCheck(draft, round, { share: share(weight.fact) })),
      // Each red team is a fresh call that sees the draft JSON, the snapshot list and its own flags on the
      // previous draft (to re-raise those that still apply), nothing else: never the drafter's reasoning.
      ...sides.map((side) =>
        settle(
          `red_team (${side.id})`,
          this.call(this.agents.redTeam, { draft: structuredClone(draft), side, sources, ...this.previousFlags(previous, side) }, round, {
            scope: side.id,
            share: share(weight.red),
            summarize: (o) => `${o.flags.length} flags (${o.flags.filter((f) => f.severity === 'high').length} high). ${o.summary}`,
          }),
        ),
      ),
    ]);
    const validation = this.validation(draft);
    return {
      round,
      ...(hard ? { hard } : {}),
      redTeams: sides.map((side, i) => {
        const out = reds[i] as RedTeamOutput | undefined;
        return { side, ...(out ? { out } : {}), flags: (out?.flags ?? []).map((flag) => ({ flag })) };
      }),
      factRows: (fc as FactCheckItem[] | undefined) ?? [],
      citations: checkCitations(draft, this.store),
      validationErrors: validation.errors,
      failedCritics: failed,
      skippedDowngrades: [],
    };
  }

  /** A red team's own flags on the previous draft (without anyone's resolution), for it to re-raise or drop. */
  private previousFlags(previous: RoundCritique | undefined, side: OutlineSide): { previous_flags?: RedTeamFlag[] } {
    const flags = previous?.redTeams.find((t) => t.side.id === side.id)?.flags.map((f) => f.flag) ?? [];
    return flags.length ? { previous_flags: flags } : {};
  }

  private blocking(r: RoundCritique): Blocking {
    return {
      questions: r.hard?.questions.filter((q) => q.blocking && q.status === 'open') ?? [],
      gaps: r.hard?.gaps.filter((g) => g.blocking) ?? [],
      flags: r.redTeams.flatMap((t) => t.flags.filter((f) => f.flag.severity === 'high').map((f) => ({ side: t.side, flag: f.flag }))),
      factRows: r.factRows.filter((row) => FAILING_VERDICTS.has(row.verdict)),
      citations: r.citations,
      validationErrors: r.validationErrors,
      failedCritics: r.failedCritics,
    };
  }

  /** Sends what needs new facts back to the researchers: per side when the item names one, else to the records researcher. */
  private routeGaps(b: Blocking, r: RoundCritique): { side?: OutlineSide; gaps: GapInput[] }[] {
    const bySide = new Map<string, GapInput[]>();
    const push = (sideId: string | undefined, g: GapInput) => {
      const key = sideId && this.outline.sides.some((s) => s.id === sideId) ? sideId : RECORDS_SCOPE;
      bySide.set(key, [...(bySide.get(key) ?? []), g]);
    };
    for (const g of b.gaps) push(g.side_id, g);
    const gapIds = new Set(b.gaps.map((g) => g.id));
    for (const q of b.questions) {
      if (gapIds.has(q.id)) continue;
      push(q.side_id, { id: q.id, description: q.question, ...(q.side_id ? { side_id: q.side_id } : {}), blocking: true });
    }
    for (const { side, flag } of b.flags) {
      if (flag.kind === 'missing_exculpatory_fact' || flag.kind === 'missing_damning_fact') {
        push(side.id, { id: flag.id, description: flag.note, side_id: side.id, blocking: true });
      }
    }
    const unsupported = [...b.factRows, ...b.citations].filter((x) => x.verdict !== 'uncited').slice(0, 10);
    for (const x of unsupported) {
      push(undefined, {
        id: toLocalId(`fc-${x.target}`),
        description: `Find a source that supports, or corrects: "${x.claim}" (${x.verdict}${x.note ? `: ${x.note}` : ''})`,
        blocking: true,
      });
    }
    // A research round is running anyway: the researchers that run also get the open non-blocking questions
    // and gaps that belong to them, and their own earlier gaps, so nothing is left unasked (at most 6 each).
    if (bySide.size) {
      const extra = new Map<string, GapInput[]>();
      const add = (sideId: string | undefined, g: GapInput) => {
        const key = sideId && this.outline.sides.some((s) => s.id === sideId) ? sideId : RECORDS_SCOPE;
        if (!bySide.has(key)) return;
        const list = extra.get(key) ?? [];
        if (list.length < 6) extra.set(key, [...list, g]);
      };
      const taken = new Set([...bySide.values()].flat().map((g) => g.id).filter(Boolean));
      for (const g of r.hard?.gaps.filter((x) => !x.blocking) ?? []) if (!taken.has(g.id)) add(g.side_id, { ...g, blocking: false });
      for (const q of r.hard?.questions.filter((x) => !x.blocking && x.status === 'open') ?? []) {
        if (!taken.has(q.id)) add(q.side_id, { id: q.id, description: q.question, ...(q.side_id ? { side_id: q.side_id } : {}), blocking: false });
      }
      for (const [scope, gaps] of this.researchGaps) {
        for (const g of gaps) if (!taken.has(g.id)) add(scope === RECORDS_SCOPE ? undefined : scope, { ...g, description: `Not found in the last search: ${g.description}` });
      }
      for (const [key, gaps] of extra) bySide.set(key, [...bySide.get(key)!, ...gaps]);
    }
    return [...bySide].map(([key, gaps]) => {
      const side = this.outline.sides.find((s) => s.id === key);
      return { ...(side ? { side } : {}), gaps };
    });
  }

  /** What the critics said, for the drafter's revision and the editor. Red-team flags carry no drafter reasoning. */
  private critiquesFor(r: RoundCritique): Critiques {
    return {
      hard_questions: r.hard?.questions.map((q) => ({ ...q, round: r.round })) ?? [],
      gaps: r.hard?.gaps ?? [],
      bias_reports: r.redTeams.filter((t) => t.out).map((t) => ({ side_id: t.side.id, summary: t.out!.summary, flags: t.out!.flags })),
      // Rows for pairs the fact-checker did not check give the drafter and editor nothing to fix; they still block.
      fact_check: [
        ...r.factRows.filter((row) => row.verdict !== 'supported' && !isNotChecked(row)),
        ...r.citations.map((f) => ({ ...f, note: `Deterministic check: ${f.note}` })),
      ],
      notes: [...r.validationErrors.map((e) => `Validator: ${e}`), ...r.failedCritics.map((f) => `Critic failed: ${f}`)],
    };
  }

  // -------------------------------------------------------------------------
  // Main flow
  // -------------------------------------------------------------------------

  async execute(request: PipelineRequest): Promise<PipelineResult> {
    try {
      return await this.executeInner(request);
    } catch (e) {
      if (e instanceof PipelineError) throw e;
      throw new PipelineError((e as Error).message, this.cost);
    }
  }

  private digest(): ResearchLogDigest {
    return {
      ...this.store.log.summary(),
      opened: this.store.opened().map((s) => ({
        snapshot_id: s.id,
        url: s.url,
        final_url: s.finalUrl,
        title: s.title,
        http_status: s.status,
        sha256: s.sha256,
        fetched_at: s.fetchedAt,
        chars: s.text.length,
      })),
    };
  }

  private async executeInner(request: PipelineRequest): Promise<PipelineResult> {
    // 1. Scope (or take the outline from the existing case).
    if (request.kind === 'new_case') {
      this.outline = await this.call(this.agents.scoper, { brief: request.brief }, 0, {
        summarize: (o) =>
          `Question: ${o.question.prompt} Sides: ${o.sides.map((s) => s.label).join(' / ')}. ${o.must_answer.length} must-answer items; ` +
          `content warning: ${o.content_warning ?? 'none'}.`,
      });
      // Every new case must say where the story stands on the as-of date, so a draft cannot stop at an older stage.
      const status = statusItem(this.asOf);
      if (!this.outline.must_answer.includes(status)) {
        this.outline = { ...this.outline, must_answer: [...this.outline.must_answer.slice(0, MAX_MUST_ANSWER - 1), status] };
      }
      // A scoper that could not open one usable page could not identify the case: the researchers would only
      // spend the budget guessing. Stop here and say so.
      if (this.store.opened().length === 0) {
        await this.note('The scoper opened no usable source, so the brief could not be tied to a public case; stopping before research.', 0);
        throw new PipelineError(
          `the brief could not be identified: the scoper opened no usable source (its outline: "${clip(this.outline.title, 160)}")`,
          this.cost,
        );
      }
    } else if (request.kind === 'revision') {
      this.base = request.base;
      this.outline = outlineFromCase(this.base, { instructions: request.instructions });
      await this.loadArchive(this.base);
    } else {
      // A live update starts from the live version, or from the update package already in review on top of it.
      this.live = request.live;
      this.base = request.pending ?? request.live;
      this.outline = outlineFromCase(this.base, { sinceAsOf: this.base.as_of });
      await this.loadArchive(this.base);
    }

    // 2. Research: one researcher per side plus the records researcher, in parallel.
    const researchStart = this.cost;
    const allJobs = (gaps?: GapInput[]) => [...this.outline.sides.map((side) => ({ side, ...(gaps ? { gaps } : {}) })), { ...(gaps ? { gaps } : {}) }];
    if (request.kind === 'new_case') {
      await this.research(0, allJobs());
    } else if (request.kind === 'revision') {
      await this.reopenBaseSources(request.base);
      const notes = request.instructions.trim();
      await this.research(0, allJobs(notes ? [{ id: 'admin', description: `The admin asked for these changes: ${notes}`, blocking: true }] : undefined));
    } else {
      const noChanges = await this.researchUpdate(request.live, this.base!);
      if (noChanges) return noChanges;
    }
    if (this.claims.length === 0 && request.kind === 'new_case') {
      throw new PipelineError('the researchers returned no verifiable claims', this.cost);
    }

    // One researcher's share of the first research pass: about what a targeted round costs per gap owner.
    const researchPerJob = (this.cost - researchStart) / (this.outline.sides.length + 1);

    // 3. First draft.
    const draftStart = this.cost;
    const first = await this.call(
      this.agents.drafter,
      {
        outline: this.outline,
        claims: this.claims,
        opened: this.openedRefs(),
        ...(this.base ? { base: this.base } : {}),
        ...(request.kind === 'revision' ? { instructions: request.instructions } : {}),
        ...this.updateInput(),
        ...(this.researchGapRefs().length ? { research_gaps: this.researchGapRefs() } : {}),
      },
      0,
      { summarize: (o) => this.draftSummary(o) },
    );
    for (const r of first.resolutions) this.resolutions.set(r.ref, r.resolution);
    this.drafterGaps = first.research_gaps;
    let draft = this.prepare(first.case);
    let lastValid: DraftCase | undefined = this.validation(draft).ok ? draft : undefined;
    // What the last research-and-redraft pass cost, to judge whether another round is affordable.
    let redraftCost = this.cost - draftStart + researchPerJob;

    // 4. The critic loop.
    const questions = new Map<string, QuestionRecord>();
    const rounds: RoundCritique[] = [];
    let clean = false;
    let budgetStop = false;
    for (let round = 1; round <= this.maxRounds; round++) {
      const critiqueStart = this.cost;
      let r: RoundCritique;
      try {
        const previous = [...questions.values()].map((q) => this.questionForReview(q));
        r = await this.critique(draft, round, previous, rounds[rounds.length - 1]);
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError)) throw e;
        budgetStop = true;
        await this.note(`Stopped before the critics of round ${round}: ${e.message}.`, round);
        break;
      }
      // A flag of the previous round that this round's red team (shown it) raised again is still open.
      const prev = rounds[rounds.length - 1];
      for (const t of prev?.redTeams ?? []) {
        const now = r.redTeams.find((x) => x.side.id === t.side.id);
        if (!now?.out) continue;
        const ids = new Set(now.flags.map((f) => f.flag.id));
        for (const f of t.flags) f.reraised = ids.has(f.flag.id);
      }
      rounds.push(r);
      for (const q of r.hard?.questions ?? []) {
        const prev = questions.get(q.id);
        questions.set(q.id, { item: q, firstRound: prev?.firstRound ?? round, lastRound: round, ...(prev?.drafterResolution ? { drafterResolution: prev.drafterResolution } : {}) });
      }
      const downgrades = this.applyDowngrades(draft, r.factRows);
      r.skippedDowngrades = downgrades.skipped;
      if (downgrades.changes.length) await this.note(`Applied the fact-checker's confidence downgrades: ${downgrades.changes.join('; ')}`, round);
      if (downgrades.skipped.length) {
        await this.note(
          `Did not apply ${downgrades.skipped.length} downgrade(s) whose claim is not in the item's headline and body: ` +
            downgrades.skipped.map((x) => `${x.target} [${x.source_id ?? '-'}] -> ${x.confidence_after}`).join('; '),
          round,
        );
      }

      const b = this.blocking(r);
      const n = blockingCount(b);
      if (n === 0) {
        clean = true;
        await this.note(`Round ${round}: nothing blocking; leaving the loop.`, round);
        break;
      }
      await this.note(
        `Round ${round}: ${b.questions.length} blocking questions, ${b.gaps.length} blocking gaps, ${b.flags.length} high red-team flags, ` +
          `${b.factRows.length} fact-check failures, ${b.citations.length} citation failures, ${b.validationErrors.length} validator errors, ` +
          `${b.failedCritics.length} failed critics.${round < this.maxRounds ? ' Looping back to research and the drafter.' : ' Round limit reached.'}`,
        round,
      );
      if (round === this.maxRounds) break;

      // Another round (research, redraft, critics) costs about what the last ones did. Rather than
      // run out half way and leave a draft nobody checked, stop here with this round's findings.
      const nextRound = redraftCost + (this.cost - critiqueStart);
      if (Number.isFinite(this.budget) && this.budgetLeft() < nextRound) {
        budgetStop = true;
        await this.note(
          `Stopped after round ${round}: another round would cost about $${nextRound.toFixed(2)} and $${Math.max(0, this.budgetLeft()).toFixed(2)} is left ` +
            `($${this.reserveUsd.toFixed(2)} more is kept for the editor).`,
          round,
        );
        break;
      }

      try {
        const redraftStart = this.cost;
        const jobs = this.routeGaps(b, r);
        if (jobs.length) await this.research(round, jobs);
        const revised = await this.call(
          this.agents.drafter,
          {
            outline: this.outline,
            claims: this.claims,
            opened: this.openedRefs(),
            previous: draft,
            critique: this.critiquesFor(r),
            ...(request.kind === 'revision' ? { instructions: request.instructions } : {}),
            ...this.updateInput(),
            ...(this.researchGapRefs().length ? { research_gaps: this.researchGapRefs() } : {}),
          },
          round,
          { summarize: (o) => this.draftSummary(o) },
        );
        redraftCost = this.cost - redraftStart;
        this.recordResolutions(revised.resolutions, r, questions);
        for (const x of revised.resolutions) this.resolutions.set(x.ref, x.resolution);
        this.drafterGaps = revised.research_gaps;
        draft = this.prepare(revised.case);
        if (this.validation(draft).ok) lastValid = draft;
      } catch (e) {
        if (this.deps.signal?.aborted || e instanceof PipelineError) throw e;
        if (e instanceof BudgetExhaustedError) {
          budgetStop = true;
          await this.note(`Stopped in round ${round}: ${e.message}.`, round);
          break;
        }
        // The current draft still stands; what this round found goes to the admin.
        const msg = (e as Error).message;
        await this.note(`The revision in round ${round} failed (${msg}); keeping the round ${round} draft.`, round);
        this.issues.push({
          source: 'pipeline',
          severity: 'high',
          description: clip(`The drafter's revision in round ${round} failed (${msg}), so the loop stopped and the round ${round} findings are unresolved.`, 2000),
          resolved: false,
        });
        break;
      }
    }
    if (budgetStop) {
      this.issues.push({
        source: 'pipeline',
        severity: 'high',
        description: `The run budget ($${this.budget.toFixed(2)}) did not cover another round after ${rounds.length} critic round(s); the loop stopped before its checks passed.`,
        resolved: false,
      });
    }
    const last = rounds[rounds.length - 1];

    // 5. Editor, then the same checks again; fall back to the last valid draft if the editor broke something.
    const openBefore = clean || !last ? [] : this.unresolvedIssues(last, draft);
    let final = draft;
    let editorFallback = false;
    let finalCheck: (FinalCheck & { case: DraftCase }) | undefined;
    const draftFailures = new Set(checkCitations(draft, this.store).map(failureKey));
    const editRound = Math.max(rounds.length, 0);
    try {
      const edited = await this.call(
        this.agents.editor,
        {
          draft,
          critiques: last ? this.critiquesFor(last) : {},
          openIssues: [...this.issues, ...openBefore].map(({ target: _t, ...o }: DraftIssue, i) => ({ id: `oi-${i + 1}`, ...o })),
          ...(this.live ? { unchanged: this.unchangedItems(draft) } : {}),
          newCase: request.kind === 'new_case',
        },
        editRound,
        { useReserve: true, summarize: (o) => o.notes.join(' ') || 'No changes.' },
      );
      for (const x of edited.resolutions) this.editorResolutions.set(x.ref, { action: x.action, text: x.resolution });
      let candidate = this.prepare(edited.case);
      // The question is the measure every reader's answer is compared on: only a new case's editor may reword it.
      if (request.kind !== 'new_case' && !deepEqual(candidate.question, draft.question)) {
        candidate.question = structuredClone(draft.question);
        await this.note('The editor changed the question of an existing case; the change was undone.', editRound);
      }
      let v = this.validation(candidate);
      let newFailures = checkCitations(candidate, this.store).filter((f) => !draftFailures.has(failureKey(f)));
      if (v.ok && newFailures.length === 0) {
        // Nothing the editor wrote ships unchecked: its changes are fact-checked again, and a failing change is reverted.
        finalCheck = await this.finalCheck(draft, candidate, editRound);
        candidate = finalCheck.case;
        v = this.validation(candidate);
        newFailures = checkCitations(candidate, this.store).filter((f) => !draftFailures.has(failureKey(f)));
      }
      if (v.ok && newFailures.length === 0) {
        final = candidate;
      } else {
        editorFallback = true;
        const why = [...v.errors.slice(0, 5), ...newFailures.slice(0, 5).map((f) => `${f.target}: ${f.note}`)].join('; ');
        await this.note(`The editor's version was rejected (${why}); using the last valid draft.`, editRound);
        this.issues.push({
          source: 'editor',
          severity: 'medium',
          description: clip(`The editor's version failed the final checks (${why}), so the package uses the last valid draft without the editor's changes.`, 2000),
          resolved: false,
        });
      }
    } catch (e) {
      if (e instanceof PipelineError || this.deps.signal?.aborted) throw e;
      editorFallback = true;
      await this.note(`The editor failed (${(e as Error).message}); using the last valid draft.`, editRound);
      this.issues.push({
        source: 'editor',
        severity: 'medium',
        description: clip(`The editor did not finish (${(e as Error).message}), so the package uses the last valid draft without house-style edits.`, 2000),
        resolved: false,
      });
    }
    if (final === draft && !this.validation(draft).ok) {
      if (!lastValid) throw new PipelineError('no draft passed schema validation', this.cost);
      final = lastValid;
      editorFallback = true;
    }
    if (editorFallback) finalCheck = undefined;

    // Sources must be opened before they are cited: a source with no snapshot (never opened in this run, and
    // not archived from the version being revised) leaves the package with everything that cites it.
    final = await this.dropUnopenedSources(final, editRound);
    // House style is checked on the text that ships, not only shown to the editor.
    this.houseStyleIssues(final);
    if (rounds.length === 0) {
      this.issues.push({
        source: 'pipeline',
        severity: 'high',
        description: 'No critic round ran (no hard questions, red teams or fact-check by the agents): only the deterministic citation check has seen this draft.',
        resolved: false,
      });
    }

    // 6. A live update that ends up changing nothing but its as-of date is not worth a review; otherwise its
    // plain update summary (what changed against the live version, and why) goes into the review record.
    let update: UpdateInfo | undefined;
    if (this.live && this.base && this.screening) {
      const since = this.screening.since;
      if (!changesBeyondAsOf(diffCases(this.base, final as unknown as Case))) {
        const why = this.screening.material
          .slice(0, 5)
          .map((c) => `"${clip(c.text, 160)}"${this.resolutions.get(c.id) ? ` (drafter: ${clip(this.resolutions.get(c.id)!, 200)})` : ''}`)
          .join('; ');
        const summary =
          `No material change to version ${this.base.version}: the researchers found ${this.screening.material.length} development(s) since ${since}, ` +
          `but the reviewed draft changes nothing beyond its as-of date, so no package was submitted. Developments: ${why}.`;
        await this.note(summary, editRound);
        return { kind: 'no_changes', runId: this.deps.runId, summary, baseVersion: this.base.version, since, researchLog: this.digest(), costUsd: this.cost };
      }
      const text = updateSummaryText({
        live: this.live,
        base: this.base,
        since,
        final,
        developments: this.screening.material,
        screening: this.screening,
        resolutions: this.resolutions,
      });
      this.reports.push({ agent: 'editor', scope: 'update', round: editRound, at: new Date().toISOString(), summary: text });
      await this.note(`Update summary for the admin:\n${text}`, editRound);
      update = {
        live_version: this.live.version,
        base_version: this.base.version,
        since,
        developments: this.screening.material.map((c) => ({ id: c.id, text: c.text, url: c.url, publisher: c.publisher, date: developmentDate(c, since) })),
        summary: text,
      };
    }

    // 7. Review record and package.
    const finalFailures = checkCitations(final, this.store);
    const unopened = finalFailures.filter((f) => {
      if (f.verdict !== 'source_unavailable') return false;
      const src = final.sources.find((x) => x.id === f.source_id);
      return !src || !this.isBaseSource(src.url);
    });
    if (unopened.length) {
      throw new PipelineError(`the package still cites sources never opened in this run: ${unopened.map((f) => `${f.target} (${f.note})`).join('; ')}`, this.cost);
    }
    // Only the editor's own version gets the "edited after the finding" note; a fallback is not the editor's text.
    const review = this.assembleReview(final, rounds, questions, clean, finalFailures, editorFallback ? final : draft, finalCheck);
    const doc = { ...final, status: 'in_review' as const, review };
    const checked = validateCase(doc);
    if (!checked.ok || !checked.case) {
      throw new PipelineError(`the assembled package does not validate: ${checked.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, this.cost);
    }
    await this.note(
      `Package ready: ${checked.case.steps.length} steps, ${checked.case.sources.length} sources, ${rounds.length} critic round(s), ` +
        `${review.open_issues.length} open issue(s), $${this.cost.toFixed(2)} spent.`,
      editRound,
    );
    return {
      kind: 'package',
      runId: this.deps.runId,
      request: request.kind,
      ...(update ? { update } : {}),
      case: checked.case,
      review: checked.case.review,
      outline: this.outline,
      researchLog: this.digest(),
      costUsd: this.cost,
      rounds: rounds.length,
      clean,
      editorFallback,
    };
  }

  /**
   * Live update research: every researcher looks only for developments after the
   * base version's as-of date. The verified claims are screened (dated after it,
   * not low impact, not already in the base version). With nothing left the run
   * ends here as `no_changes`, with the reason in the research log, unless a
   * researcher failed: then "nothing new" is not known, and the run fails.
   */
  private async researchUpdate(live: Case, base: Case): Promise<NoChangesResult | undefined> {
    const since = base.as_of;
    const allJobs = [...this.outline.sides.map((side) => ({ side })), {}];
    const fresh = await this.research(0, allJobs, { sinceAsOf: since, knownFacts: knownFactsOf(base), openQuestions: base.open_questions });
    this.deps.signal?.throwIfAborted();
    const screening = screenDevelopments(fresh, since, base);
    this.screening = screening;
    const found = describeScreening(screening, base.version);
    const onTop = base.version !== live.version ? `, the update waiting for review on top of live version ${live.version}` : '';
    if (screening.material.length === 0) {
      if (this.researchFailures.length) {
        const why =
          `Research for the update was incomplete (${this.researchFailures.join('; ')}), and the other researchers found no new development ` +
          `since ${since} (${found}). An incomplete search cannot show that nothing is new, so the job fails and the next run tries again.`;
        await this.note(why, 0);
        throw new PipelineError(why, this.cost);
      }
      const summary = `No material developments since ${since} (version ${base.version}${onTop}): ${found}. Nothing was drafted or submitted.`;
      await this.note(summary, 0);
      return { kind: 'no_changes', runId: this.deps.runId, summary, baseVersion: base.version, since, researchLog: this.digest(), costUsd: this.cost };
    }
    // A copy: claims that later rounds research for the critics' gaps are added to `this.claims`, not to the developments.
    this.claims = [...screening.material];
    // Must-answer: each development the researchers found, then the generic update items (minus the
    // placeholder for "what has happened"), then what the base run answered. Never the open questions.
    const devItems = screening.material
      .slice(0, 8)
      .map((c) => developmentItem(since, { text: c.text, publisher: c.publisher, date: developmentDate(c, since) }));
    const placeholder = updateDevelopmentsItem(since);
    const rest = this.outline.must_answer.filter((m) => m !== placeholder);
    this.outline = {
      ...this.outline,
      must_answer: [...devItems, ...(screening.material.length > devItems.length ? [placeholder] : []), ...rest].slice(0, MAX_MUST_ANSWER),
    };
    await this.note(
      `${screening.material.length} new development(s) since ${since} (${found}); drafting a revision of version ${base.version}${onTop}. ` +
        `Developments: ${screening.material.map((c) => `${c.id} (${developmentDate(c, since) ?? 'undated'})`).join(', ')}.`,
      0,
    );
    await this.reopenBaseSources(base);
    return undefined;
  }

  /** Live updates: the steps and starting facts of a draft that are exactly as in the live version (order aside). */
  private unchangedItems(draft: DraftCase): string[] {
    const live = this.live;
    if (!live) return [];
    const steps = new Map(live.steps.map((s) => [s.id, { ...s, order: 0 }]));
    const facts = new Map(live.starting_facts.map((f) => [f.id, f]));
    return [
      ...draft.starting_facts.filter((f) => facts.has(f.id) && deepEqual(f, facts.get(f.id))).map((f) => `fact:${f.id}`),
      ...draft.steps.filter((s) => steps.has(s.id) && deepEqual({ ...s, order: 0 }, steps.get(s.id))).map((s) => s.id),
    ];
  }

  /** The drafter's live-update context, in every round of an update run. */
  private updateInput(): { update?: DrafterInput['update'] } {
    if (!this.live || !this.base || !this.screening) return {};
    return {
      update: {
        live_version: this.live.version,
        base_version: this.base.version,
        since: this.screening.since,
        developments: this.screening.material.map((c) => c.id),
        used_step_ids: this.base.steps.map((s) => s.id),
      },
    };
  }

  // -------------------------------------------------------------------------
  // After the editor
  // -------------------------------------------------------------------------

  /**
   * What the editor changed in each checkable item, against the last critiqued
   * draft: starting facts and steps whose text, sources or evidence differ (or
   * that are new), depth layers that differ (or are new), and steelmen. A
   * changed label, order or `favors` alone is not a content change.
   */
  private editedTargets(draft: DraftCase, candidate: DraftCase): string[] {
    const key = (x: unknown) => JSON.stringify(x ?? null);
    const out: string[] = [];
    const facts = new Map(draft.starting_facts.map((f) => [f.id, f]));
    for (const f of candidate.starting_facts) {
      const d = facts.get(f.id);
      if (!d || key([f.text, f.source_ids, f.evidence]) !== key([d.text, d.source_ids, d.evidence])) out.push(`fact:${f.id}`);
    }
    const steps = new Map(draft.steps.map((x) => [x.id, x]));
    for (const st of candidate.steps) {
      const d = steps.get(st.id);
      if (!d || key([st.headline, st.body, st.source_ids, st.evidence]) !== key([d.headline, d.body, d.source_ids, d.evidence])) out.push(st.id);
      const layers = new Map((d?.depth ?? []).map((l) => [l.id, l]));
      for (const l of st.depth) if (key(l) !== key(layers.get(l.id))) out.push(`layer:${st.id}/${l.id}`);
    }
    const sides = new Map(draft.sides.map((x) => [x.id, x]));
    for (const side of candidate.sides) if (sides.get(side.id)?.steelman !== side.steelman) out.push(`side:${side.id}`);
    return out;
  }

  /**
   * The fact-check of the editor's version. The editor works after the last
   * critic round, so:
   * - it may not raise a confidence label above what the critiqued draft has
   *   (that label already carries the fact-checker's downgrades);
   * - every item it changed is fact-checked again (with the same coverage rule);
   *   an item that fails is put back as the critiqued draft had it (or removed,
   *   when the editor added it), and the admin is told;
   * - when that check cannot run (budget, failure), each changed item becomes an
   *   open issue saying it was not re-checked.
   */
  private async finalCheck(draft: DraftCase, editorCase: DraftCase, round: number): Promise<FinalCheck & { case: DraftCase }> {
    const candidate = structuredClone(editorCase);
    // 1. No upgrades.
    const clamped: string[] = [];
    const clamp = (target: string, item: { confidence: DraftCase['steps'][number]['confidence'] }, before: DraftCase['steps'][number]['confidence'] | undefined) => {
      if (!before) return;
      const next = weakerConfidence(item.confidence, before);
      if (next !== item.confidence) {
        clamped.push(`${target}: ${item.confidence} -> ${next}`);
        item.confidence = next;
      }
    };
    for (const f of candidate.starting_facts) clamp(`fact:${f.id}`, f, draft.starting_facts.find((x) => x.id === f.id)?.confidence);
    for (const st of candidate.steps) clamp(st.id, st, draft.steps.find((x) => x.id === st.id)?.confidence);
    if (clamped.length) await this.note(`The editor raised confidence labels the fact-check had set; kept the fact-checked labels: ${clamped.join('; ')}.`, round);

    const result: FinalCheck & { case: DraftCase } = {
      case: candidate,
      edited: this.editedTargets(draft, candidate),
      ran: false,
      passed: new Set(),
      reverted: new Map(),
      rows: [],
      skippedDowngrades: [],
    };
    if (!result.edited.length) return result;

    // 2. Re-check what changed.
    let rows: FactCheckItem[];
    try {
      rows = await this.factCheck(candidate, round, {
        share: 1,
        useReserve: true,
        only: result.edited,
        focus: 'the editor changed these items after the last fact-check',
      });
    } catch (e) {
      if (e instanceof PipelineError || this.deps.signal?.aborted) throw e;
      const msg = (e as Error).message;
      await this.note(`The fact-check of the editor's changes did not run (${msg}); ${result.edited.length} changed item(s) go to the admin unchecked.`, round);
      for (const t of result.edited) {
        const step = stepIdOf(t, candidate);
        this.issues.push({
          source: 'editor',
          severity: 'medium',
          description: clip(`The editor changed ${t} after the last fact-check, and the fact-check of its changes did not run (${msg}): check this item against its sources.`, 2000),
          ...(step ? { step_id: step } : {}),
          resolved: false,
          target: t,
        });
      }
      return result;
    }
    result.ran = true;
    result.rows = rows.map((r) => ({ ...r, note: clip(`${FINAL_CHECK} ${r.note ?? ''}`.trim(), 2000) }));

    // 3. Keep what passed, put back what failed.
    const citationFailures = checkCitations(candidate, this.store);
    for (const t of result.edited) {
      const bad = [
        ...rows.filter((r) => r.target === t && FAILING_VERDICTS.has(r.verdict)).map((r) => `${r.verdict}${r.note ? `: ${r.note}` : ''}`),
        ...citationFailures.filter((f) => f.target === t).map((f) => `${f.verdict}: ${f.note}`),
      ];
      if (bad.length) result.reverted.set(t, clip(bad.join(' / '), 600));
      else result.passed.add(t);
    }
    for (const [t, why] of result.reverted) this.revertItem(candidate, draft, t, why, round);
    const downgrades = this.applyDowngrades(
      candidate,
      rows.filter((r) => result.passed.has(r.target)),
    );
    result.skippedDowngrades = downgrades.skipped;
    if (downgrades.changes.length) await this.note(`Applied the final fact-check's downgrades: ${downgrades.changes.join('; ')}`, round);
    await this.note(
      `Fact-checked the editor's changes: ${result.passed.size} of ${result.edited.length} changed item(s) supported` +
        (result.reverted.size ? `; put back ${[...result.reverted.keys()].join(', ')} as the last checked draft had them.` : '.'),
      round,
    );
    result.case = result.reverted.size ? this.prepare(candidate) : candidate;
    return result;
  }

  /** Puts one item of the editor's version back as the critiqued draft had it (removing it when the editor added it). */
  private revertItem(candidate: DraftCase, draft: DraftCase, target: string, why: string, round: number) {
    const restoreSources = (ids: string[]) => {
      for (const id of ids) {
        if (candidate.sources.some((x) => x.id === id)) continue;
        const src = draft.sources.find((x) => x.id === id);
        if (src) candidate.sources.push(structuredClone(src));
      }
    };
    const citedBy = (item: Partial<Pick<DraftCase, 'starting_facts' | 'steps'>>) =>
      [...citedSourceIds({ starting_facts: [], steps: [], ...item } as unknown as DraftCase)];
    let what: string;
    if (target.startsWith('fact:')) {
      const id = target.slice(5);
      const before = draft.starting_facts.find((f) => f.id === id);
      const at = candidate.starting_facts.findIndex((f) => f.id === id);
      if (before && at >= 0) {
        candidate.starting_facts[at] = structuredClone(before);
        restoreSources(citedBy({ starting_facts: [before] }));
        what = 'put back as the last fact-checked draft had it';
      } else {
        candidate.starting_facts = candidate.starting_facts.filter((f) => f.id !== id);
        what = 'removed (the editor added it)';
      }
    } else if (target.startsWith('layer:')) {
      const [stepId, layerId] = target.slice(6).split('/');
      const st = candidate.steps.find((x) => x.id === stepId);
      if (!st) return;
      const before = draft.steps.find((x) => x.id === stepId)?.depth.find((l) => l.id === layerId);
      const at = st.depth.findIndex((l) => l.id === layerId);
      if (at < 0) return;
      if (before) {
        st.depth[at] = structuredClone(before);
        restoreSources(citedBy({ steps: [{ ...st, source_ids: [], evidence: [], depth: [before] }] }));
        what = 'put back as the last fact-checked draft had it';
      } else {
        st.depth.splice(at, 1);
        what = 'removed (the editor added it)';
      }
    } else if (target.startsWith('side:')) {
      const id = target.slice(5);
      const before = draft.sides.find((x) => x.id === id);
      const side = candidate.sides.find((x) => x.id === id);
      if (!before || !side) return;
      side.steelman = before.steelman;
      what = 'put back as the last fact-checked draft had it';
    } else {
      const before = draft.steps.find((x) => x.id === target);
      const at = candidate.steps.findIndex((x) => x.id === target);
      if (at < 0) return;
      if (before) {
        candidate.steps[at] = { ...structuredClone(before), order: candidate.steps[at]!.order };
        restoreSources(citedBy({ steps: [before] }));
        what = 'put back as the last fact-checked draft had it';
      } else {
        candidate.steps.splice(at, 1);
        candidate.steps.forEach((x, i) => (x.order = i + 1));
        what = 'removed (the editor added it)';
      }
    }
    const step = stepIdOf(target, candidate);
    this.issues.push({
      source: 'editor',
      severity: 'medium',
      description: clip(`The editor's change to ${target} failed the fact-check of its changes (${why}), so it was ${what}.`, 2000),
      ...(step ? { step_id: step } : {}),
      resolved: false,
      target,
    });
    void this.note(`Reverted the editor's change to ${target}: ${why}`, round).catch(() => {});
  }

  /**
   * Removes every source that has no snapshot in the store (never opened in
   * this run, and not archived from the version being revised), with its
   * citations, evidence and depth layers. A step or starting fact left with no
   * source is removed too. Each removal is a high open issue; a case that no
   * longer validates fails the run rather than ship.
   */
  private async dropUnopenedSources(c: DraftCase, round: number): Promise<DraftCase> {
    // A source the version being revised already cites was opened by the job that cited it: when it cannot be
    // re-opened now (and no archived snapshot was loaded) its citations stay, as failures the admin sees.
    const ghosts = new Map(c.sources.filter((x) => this.store.findAllByUrl(x.url).length === 0 && !this.isBaseSource(x.url)).map((x) => [x.id, x]));
    if (!ghosts.size) return c;
    const out = structuredClone(c);
    const keep = (ids: string[] | undefined) => (ids ?? []).filter((id) => !ghosts.has(id));
    const removed: string[] = [];
    out.starting_facts = out.starting_facts.filter((f) => {
      f.source_ids = keep(f.source_ids);
      f.evidence = f.evidence?.filter((e) => !ghosts.has(e.source_id));
      if (f.source_ids.length) return true;
      removed.push(`fact:${f.id} ("${clip(f.text, 120)}")`);
      return false;
    });
    out.steps = out.steps.filter((st) => {
      st.source_ids = keep(st.source_ids);
      st.evidence = st.evidence?.filter((e) => !ghosts.has(e.source_id));
      st.depth = st.depth.flatMap((l): DraftCase['steps'][number]['depth'] => {
        if (l.kind === 'document' || l.kind === 'quote') return ghosts.has(l.source_id) ? [] : [l];
        if (l.kind === 'context') {
          const ids = keep(l.source_ids);
          return ids.length ? [{ ...l, source_ids: ids }] : [];
        }
        const entries = l.entries.map((e) => ({ ...e, source_ids: keep(e.source_ids) })).filter((e) => e.source_ids.length);
        return entries.length ? [{ ...l, entries }] : [];
      });
      if (st.source_ids.length) return true;
      removed.push(`${st.id} ("${clip(st.headline, 120)}")`);
      return false;
    });
    out.steps.forEach((st, i) => (st.order = i + 1));
    out.sources = out.sources.filter((x) => !ghosts.has(x.id));
    const list = [...ghosts.values()].map((g) => `${g.id} (${g.url})`).join('; ');
    await this.note(`Removed ${ghosts.size} source(s) that were cited but never opened: ${list}.${removed.length ? ` Items left with no source were removed: ${removed.join('; ')}.` : ''}`, round);
    for (const g of ghosts.values()) {
      this.issues.push({
        source: 'fact_checker',
        severity: 'high',
        description: clip(`Source "${g.id}" (${g.url}) was cited but never opened in this run, so it and every citation, evidence quote and layer that relied on it were removed from the package.`, 2000),
        resolved: false,
      });
    }
    for (const r of removed) {
      this.issues.push({
        source: 'fact_checker',
        severity: 'high',
        description: clip(`Removed ${r}: it cited only sources that were never opened in this run.`, 2000),
        resolved: false,
      });
    }
    const v = this.validation(out);
    if (!v.ok) {
      throw new PipelineError(
        `the draft cites sources that were never opened (${list}), and without them it is not a valid case: ${v.errors.slice(0, 5).join('; ')}`,
        this.cost,
      );
    }
    return out;
  }

  /** Whether the version being revised or updated cites this URL. */
  private isBaseSource(url: string): boolean {
    return (this.base?.sources ?? []).some((s) => urlKey(s.url) === urlKey(url));
  }

  /** A medium open issue for each user-facing text that still uses a judging word (house style). */
  private houseStyleIssues(c: DraftCase) {
    for (const { path, words } of judgingWordReport(c)) {
      const m = /^steps\.(\d+)\./.exec(path);
      const step = m ? c.steps[Number(m[1])]?.id : undefined;
      this.issues.push({
        source: 'editor',
        severity: 'medium',
        description: clip(`House style: ${path} still uses judging word(s) ${words.map((w) => `"${w}"`).join(', ')}; replace them with plain words.`, 2000),
        ...(step ? { step_id: step } : {}),
        resolved: false,
      });
    }
  }

  private draftSummary(o: DrafterOutput): string {
    const c = o.case;
    return `${c.starting_facts.length} starting facts, ${c.steps.length} steps, ${c.sources.length} sources; ${o.resolutions.length} resolutions.`;
  }

  /** The drafter's resolutions, matched to this round's questions, flags and gaps. */
  private recordResolutions(resolutions: Resolution[], r: RoundCritique, questions: Map<string, QuestionRecord>) {
    const byRef = new Map(resolutions.map((x) => [x.ref, { action: x.action, text: x.resolution }]));
    for (const q of r.hard?.questions ?? []) {
      const res = byRef.get(q.id);
      const rec = questions.get(q.id);
      if (res && rec) rec.drafterResolution = res;
    }
    for (const t of r.redTeams) {
      for (const f of t.flags) {
        const res = byRef.get(f.flag.id);
        if (res) f.drafterResolution = res;
      }
    }
  }

  private questionForReview(q: QuestionRecord): HardQuestion {
    const res = q.drafterResolution;
    const resolution = [q.item.resolution, res ? `Drafter (${res.action.replace(/_/g, ' ')}): ${res.text}` : ''].filter(Boolean).join(' ');
    return {
      ...q.item,
      round: q.firstRound,
      step_ids: q.item.step_ids ?? [],
      ...(resolution ? { resolution: clip(resolution, 2000) } : {}),
    };
  }

  /** Everything that still blocks after the last round, as open issues. */
  private unresolvedIssues(r: RoundCritique, c: DraftCase): DraftIssue[] {
    const out: DraftIssue[] = [];
    const b = this.blocking(r);
    const stepRef = (id: string | undefined) => (id ? stepIdOf(id, c) : undefined);
    for (const q of b.questions) {
      const step = q.step_ids?.map((s) => stepRef(s)).find(Boolean);
      out.push({ source: 'hard_questions', severity: 'high', description: clip(`Unanswered blocking question: ${q.question}`, 2000), ...(step ? { step_id: step } : {}), resolved: false });
    }
    for (const g of b.gaps) {
      out.push({ source: 'hard_questions', severity: 'high', description: clip(`Blocking gap: ${g.description} (search hint: ${g.search_hint})`, 2000), resolved: false });
    }
    for (const { side, flag } of b.flags) {
      const step = stepRef(flag.step_id);
      out.push({
        source: 'red_team',
        severity: 'high',
        description: clip(`Red team for "${side.label}": ${flag.kind.replace(/_/g, ' ')}: ${flag.note}`, 2000),
        ...(step ? { step_id: step } : {}),
        resolved: false,
        target: `flag:${flag.id}`,
      });
    }
    for (const row of b.factRows) {
      const step = stepRef(row.target);
      out.push({
        source: 'fact_checker',
        severity: 'high',
        description: clip(`Fact-check (${isNotChecked(row) ? 'not checked' : row.verdict}) on ${row.target}: ${row.claim}${row.note ? ` (${row.note})` : ''}`, 2000),
        ...(step ? { step_id: step } : {}),
        resolved: false,
        target: row.target,
      });
    }
    for (const e of b.validationErrors) out.push({ source: 'validator', severity: 'high', description: clip(e, 2000), resolved: false });
    for (const f of b.failedCritics) out.push({ source: 'pipeline', severity: 'high', description: clip(`A critic did not finish: ${f}`, 2000), resolved: false });
    return out;
  }

  /**
   * A red-team flag's status for the review record:
   * - before the last round: "addressed" only when the drafter says it changed
   *   the draft for it AND the next round's red team, shown the flag, did not
   *   raise it again; "wont_fix" when the drafter says it does not apply;
   *   otherwise "unaddressed";
   * - in the last round (no red team reads the result): "addressed" when the
   *   editor says it changed the case for it and that change survived the
   *   fact-check of the editor's changes.
   */
  private flagStatus(f: FlagRecord, round: number, lastRound: number, finalCheck: FinalCheck | undefined): { status: BiasFlag['status']; resolution?: string } {
    const words = (r: ResolutionRecord) => r.action.replace(/_/g, ' ');
    if (round < lastRound) {
      const res = f.drafterResolution;
      const parts = [res ? `Drafter (${words(res)}): ${res.text}` : 'The drafter did not respond to this flag.'];
      if (f.reraised) parts.push(`The round ${round + 1} red team raised it again.`);
      else if (res?.action === 'changed') parts.push(`The round ${round + 1} red team did not raise it again.`);
      const status = res?.action === 'not_applicable' ? 'wont_fix' : res?.action === 'changed' && !f.reraised ? 'addressed' : 'unaddressed';
      return { status, resolution: clip(parts.join(' '), 2000) };
    }
    const res = this.editorResolutions.get(f.flag.id);
    if (!res) return { status: 'unaddressed' };
    const stepId = f.flag.step_id;
    const reverted = !!stepId && [...(finalCheck?.reverted.keys() ?? [])].some((t) => t === stepId || t.startsWith(`layer:${stepId}/`));
    const text = `Editor (${words(res)}): ${res.text}${reverted ? ' The editor\'s change to this step failed the final fact-check and was put back.' : res.action === 'changed' ? ' (After the last red-team round: no red team re-read it.)' : ''}`;
    const status = res.action === 'not_applicable' ? 'wont_fix' : res.action === 'changed' && !reverted ? 'addressed' : 'unaddressed';
    return { status, resolution: clip(text, 2000) };
  }

  private assembleReview(
    final: DraftCase,
    rounds: RoundCritique[],
    questions: Map<string, QuestionRecord>,
    clean: boolean,
    finalFailures: CitationFailure[],
    /** The last critiqued draft, before the editor's pass. */
    critiqued: DraftCase,
    finalCheck?: FinalCheck,
  ): ReviewRecord {
    const sideIds = new Set(final.sides.map((s) => s.id));
    const sideLabel = (id: string | undefined) => final.sides.find((s) => s.id === id)?.label ?? id;
    const last = rounds[rounds.length - 1];
    const lastRound = last?.round ?? 0;

    const hard_questions: HardQuestion[] = [...questions.values()].map((q) => {
      const h = this.questionForReview(q);
      // Answered when the drafter says it changed the draft for it and the hard-questions agent stopped asking.
      if (h.status === 'open' && q.drafterResolution?.action === 'changed' && last && q.lastRound < last.round) h.status = 'answered';
      if (h.side_id && !sideIds.has(h.side_id)) delete h.side_id;
      return h;
    });

    const flagIssues = new Map<string, DraftIssue>();
    const bias_reports: BiasReport[] = rounds.flatMap((r) =>
      r.redTeams
        .filter((t) => t.out && sideIds.has(t.side.id))
        .map((t) => ({
          side_id: t.side.id,
          round: r.round,
          summary: clip(t.out!.summary, 4000),
          flags: t.flags.map((f) => {
            const { status, resolution } = this.flagStatus(f, r.round, lastRound, finalCheck);
            // The latest copy of each flag decides whether the admin must look at it: a medium or high flag still
            // unaddressed after the last round, or one the drafter left for the admin.
            const key = `${t.side.id}\u0000${f.flag.id}`;
            flagIssues.delete(key);
            const forAdmin = r.round === lastRound || f.drafterResolution?.action === 'needs_admin';
            if (status === 'unaddressed' && f.flag.severity !== 'low' && forAdmin && !f.reraised) {
              const step = f.flag.step_id ? stepIdOf(f.flag.step_id, final) : undefined;
              flagIssues.set(key, {
                source: 'red_team',
                severity: f.flag.severity,
                description: clip(
                  `Red team for "${t.side.label}" (round ${r.round}, not addressed): ${f.flag.kind.replace(/_/g, ' ')}: ${f.flag.note}${resolution ? ` ${resolution}` : ''}`,
                  2000,
                ),
                ...(step ? { step_id: step } : {}),
                resolved: false,
                target: `flag:${f.flag.id}`,
              });
            }
            return { ...f.flag, status, ...(resolution ? { resolution } : {}) };
          }),
        })),
    );

    const fact_check: FactCheckRow[] = rounds.flatMap((r) => [
      ...r.factRows.map((row) => ({ ...row, round: r.round })),
      ...r.citations.map((f) => ({ ...f, note: clip(`Deterministic check: ${f.note}`, 2000), round: r.round })),
    ]);
    fact_check.push(...(finalCheck?.rows ?? []).map((row) => ({ ...row, round: lastRound })));
    // Failures the final checks still find that the last round did not record (e.g. after an editor fallback).
    const recorded = new Set((last?.citations ?? []).map(failureKey));
    for (const f of finalFailures) {
      if (!recorded.has(failureKey(f))) fact_check.push({ ...f, note: clip(`Deterministic check (final): ${f.note}`, 2000), round: lastRound });
    }

    const open: DraftIssue[] = [...this.issues];
    const blockingHigh = !clean && last ? this.unresolvedIssues(last, final) : [];
    open.push(...blockingHigh);
    const already = new Set(blockingHigh.map((o) => o.target).filter(Boolean));
    for (const issue of flagIssues.values()) if (!already.has(issue.target)) open.push(issue);

    // A partly supported claim does not block the loop (its confidence is downgraded and the editor is told
    // to narrow it), but the admin sees each one the last round still found.
    for (const row of last?.factRows.filter((x) => x.verdict === 'partially_supported') ?? []) {
      const step = stepIdOf(row.target, final);
      open.push({
        source: 'fact_checker',
        severity: 'medium',
        description: clip(
          `Fact-check (partially supported) on ${row.target}: ${row.claim}${row.note ? ` (${row.note})` : ''} The editor was asked to narrow this text; check the final wording.`,
          2000,
        ),
        ...(step ? { step_id: step } : {}),
        resolved: false,
        target: row.target,
      });
    }
    // Downgrades not applied because the row's claim is not in the step's own text: the admin checks the label
    // and whether the step still needs that citation.
    for (const row of [...(last?.skippedDowngrades ?? []), ...(finalCheck?.skippedDowngrades ?? [])]) {
      const step = stepIdOf(row.target, final);
      const item = row.target.startsWith('fact:') ? final.starting_facts.find((f) => `fact:${f.id}` === row.target) : final.steps.find((x) => x.id === row.target);
      if (!item) continue;
      open.push({
        source: 'fact_checker',
        severity: 'medium',
        description: clip(
          `Fact-check on ${row.target}${row.source_id ? ` (source ${row.source_id})` : ''}: the fact-checker suggested "${row.confidence_after}" for "${clip(row.claim, 300)}", ` +
            `which the item's own text does not state, so its label stays "${item.confidence}". If the item cites ${row.source_id ?? 'that source'} only for that detail, remove the citation and its evidence; otherwise relabel it.`,
          2000,
        ),
        ...(step ? { step_id: step } : {}),
        resolved: false,
        target: row.target,
      });
    }
    const seen = new Set(open.filter((o) => o.source === 'fact_checker').map((o) => o.description));
    for (const f of finalFailures) {
      const description = clip(`Citation check (${f.verdict}) on ${f.target}: ${f.note}`, 2000);
      if (seen.has(description)) continue;
      seen.add(description);
      const step = stepIdOf(f.target, final);
      open.push({ source: 'fact_checker', severity: 'high', description, ...(step ? { step_id: step } : {}), resolved: false });
    }

    // Hard questions still open at the end: blocking ones already counted above stay as they are; the rest
    // reach the admin too (medium when blocking, low otherwise).
    const blockingQuestions = new Set(blockingHigh.filter((o) => o.source === 'hard_questions').map((o) => o.description));
    for (const q of hard_questions.filter((x) => x.status === 'open')) {
      if (blockingQuestions.has(clip(`Unanswered blocking question: ${q.question}`, 2000))) continue;
      const step = q.step_ids.map((x) => stepIdOf(x, final)).find(Boolean);
      open.push({
        source: 'hard_questions',
        severity: q.blocking ? 'medium' : 'low',
        description: clip(`Open question${q.side_id ? ` (skeptic for "${sideLabel(q.side_id)}")` : ''}: ${q.question}${q.resolution ? ` ${q.resolution}` : ''}`, 2000),
        ...(step ? { step_id: step } : {}),
        resolved: false,
      });
    }
    // Gaps the hard-questions agent still reported in the last round that are not blocking (blocking ones are above).
    for (const g of last?.hard?.gaps.filter((x) => !x.blocking) ?? []) {
      open.push({
        source: 'hard_questions',
        severity: 'low',
        description: clip(`Gap (not blocking): ${g.description}${g.search_hint ? ` (search hint: ${g.search_hint})` : ''}`, 2000),
        resolved: false,
      });
    }
    // What the researchers and the drafter could not find: research gaps for the admin (never shown to readers).
    for (const [scope, gaps] of this.researchGaps) {
      if (!gaps.length) continue;
      open.push({
        source: 'pipeline',
        severity: gaps.some((g) => g.blocking) ? 'medium' : 'low',
        description: clip(
          `Research gaps reported by the ${scope === RECORDS_SCOPE ? 'records' : `"${sideLabel(scope)}"`} researcher: ` +
            gaps.map((g, i) => `(${i + 1}) ${g.description}${g.blocking ? ' [blocking]' : ''}`).join(' '),
          2000,
        ),
        resolved: false,
      });
    }
    if (this.drafterGaps.length) {
      open.push({
        source: 'pipeline',
        severity: 'low',
        description: clip(`Facts the drafter needed and no claim supplied: ${this.drafterGaps.map((g, i) => `(${i + 1}) ${g}`).join(' ')}`, 2000),
        resolved: false,
      });
    }

    // The critics saw the draft before the editor's pass. When the editor changed an item a finding is about, say
    // what happened next: the fact-check of the editor's changes resolved it, put the change back, or did not run.
    const before = new Map(critiqued.steps.map((st) => [st.id, JSON.stringify({ ...st, order: 0 })]));
    const editedSteps = new Set(final.steps.filter((st) => before.get(st.id) !== JSON.stringify({ ...st, order: 0 })).map((st) => st.id));
    const revertedSteps = new Set([...(finalCheck?.reverted.keys() ?? [])].map((t) => stepIdOf(t, critiqued)).filter(Boolean));
    for (const o of open) {
      if (o.source === 'editor' || o.source === 'pipeline' || o.description.startsWith('Citation check')) continue;
      if (finalCheck?.ran && o.source === 'fact_checker' && o.target && finalCheck.passed.has(o.target)) {
        o.resolved = true;
        o.description = clip(`${o.description} Resolved: the editor revised this item and the fact-check of its changes found it supported.`, 2000);
        continue;
      }
      if (o.step_id && revertedSteps.has(o.step_id)) {
        o.description = clip(`${o.description} The editor's change to this step failed the fact-check of its changes and was put back, so this finding stands.`, 2000);
      } else if (o.step_id && editedSteps.has(o.step_id)) {
        o.description = clip(
          `${o.description} The editor revised this step after this finding; ${finalCheck?.ran ? 'the fact-check of its changes found the facts supported, but no red team or hard-questions agent re-read it.' : 'no critic re-checked the edited text.'}`,
          2000,
        );
      }
    }

    const parsed = CaseSchema.parse({ ...final, review: undefined });
    return {
      pipeline_run_id: this.deps.runId.slice(0, 100),
      rounds: rounds.length,
      agent_reports: this.reports,
      hard_questions,
      bias_reports,
      fact_check,
      balance: toBalanceSummary(computeBalance(parsed)),
      open_issues: open.map(({ target: _t, ...o }, i) => ({ id: `oi-${i + 1}`, ...o })),
      decisions: [],
    };
  }
}
