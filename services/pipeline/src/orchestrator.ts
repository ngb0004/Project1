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
  type BiasReport,
  type Case,
  type FactCheckRow,
  type HardQuestion,
  type OpenIssue,
  type ReviewRecord,
} from '@sia/case-schema';
import drafterSpec, { type DrafterInput, type DrafterOutput } from './agents/drafter';
import editorSpec, { type EditorInput, type EditorOutput } from './agents/editor';
import factCheckerSpec, { type FactCheckItem, type FactCheckerInput, type FactCheckerOutput } from './agents/factChecker';
import hardQuestionsSpec, { type HardQuestionItem, type HardQuestionsInput, type HardQuestionsOutput } from './agents/hardQuestions';
import recordsResearcherSpec from './agents/recordsResearcher';
import redTeamSpec, { type RedTeamFlag, type RedTeamInput, type RedTeamOutput } from './agents/redTeam';
import researcherSpec, { type ResearchClaim, type ResearchOutput, type ResearcherInput } from './agents/researcher';
import scoperSpec, { MAX_MUST_ANSWER, developmentItem, outlineFromCase, updateDevelopmentsItem, type Outline, type OutlineSide, type ScoperInput } from './agents/scoper';
import type { Critiques, DraftCase, Gap, GapInput, OpenedSourceRef, SourceSnapshotRef } from './agents/shared';
import { bestSnapshot, describeDrift, quotesBySource, sourceDrift, type ArchivedSnapshot } from './archive';
import type { AgentContext, AgentSpec } from './agents/types';
import { checkCitations, failureKey, type CitationFailure } from './factcheck';
import type { LogSummary } from './research/log';
import type { SourceStore } from './research/store';
import { matchQuote, urlKey } from './research/text';
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

interface QuestionRecord {
  item: HardQuestionItem;
  firstRound: number;
  lastRound: number;
  drafterResolution?: string;
}

interface FlagRecord {
  flag: RedTeamFlag;
  drafterResolution?: string;
}

interface RoundCritique {
  round: number;
  hard?: HardQuestionsOutput;
  redTeams: { side: OutlineSide; out?: RedTeamOutput; flags: FlagRecord[] }[];
  factRows: FactCheckItem[];
  citations: CitationFailure[];
  validationErrors: string[];
  failedCritics: string[];
}

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
  private readonly issues: Omit<OpenIssue, 'id'>[] = [];
  private outline!: Outline;
  private base: Case | undefined;
  /** Live updates: the live version, the screened research, and the drafter's resolutions by ref. */
  private live: Case | undefined;
  private screening: ScreenedDevelopments | undefined;
  private readonly resolutions = new Map<string, string>();
  /** Researcher calls that failed, as "scope: message". */
  private readonly researchFailures: string[] = [];

  constructor(private readonly deps: PipelineDeps) {
    this.agents = deps.agents ?? DEFAULT_AGENTS;
    this.asOf = deps.asOf ?? todayUtc();
    this.maxRounds = Math.max(1, deps.maxRounds ?? MAX_ROUNDS);
    this.budget = deps.budgetUsd ?? Infinity;
  }

  private get store(): SourceStore {
    return this.deps.store;
  }

  private progress(message: string) {
    this.deps.onProgress?.(message);
  }

  private async note(text: string, round: number, scope: string | null = null) {
    await this.store.log.append({ agent: PIPELINE_LOG_AGENT, scope, round, kind: 'note', excerpt: text });
  }

  // -------------------------------------------------------------------------
  // Agent calls
  // -------------------------------------------------------------------------

  /**
   * Kept back for the editor, so a loop that runs long still ends with the
   * house-style pass: 10% of the run budget, at most $4.
   */
  private get reserveUsd(): number {
    return Number.isFinite(this.budget) ? Math.min(this.budget * 0.1, 4) : 0;
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
        this.cost += e instanceof AgentRunError ? e.costUsd : 0;
        await tools.note(`Agent call failed: ${label}, attempt ${attempt}: ${err.message}`).catch(() => {});
        this.progress(`${label}: failed (${err.message})`);
        if (e instanceof AgentRunError && e.reason === 'unavailable') {
          throw new ServiceUnavailableError(`the model service is unavailable (${label}): ${err.message}`, this.cost);
        }
        const retryable = e instanceof AgentRunError && (e.reason === 'output' || e.reason === 'execution');
        if (attempt >= 2 || !retryable || this.deps.signal?.aborted) throw e;
        continue;
      }
      this.cost += r.costUsd;
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
          fresh.push(...(await this.acceptClaims(salvaged, scope, round)));
        }
        continue;
      }
      fresh.push(...(await this.acceptClaims(r.value.out.claims, scope, round)));
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
   */
  private async acceptClaims(claims: ResearchClaim[], scope: string, round: number): Promise<ResearchClaim[]> {
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
    return out;
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

  /** Applies the fact-checker's confidence downgrades (never upgrades) to the draft. */
  private applyDowngrades(c: DraftCase, rows: FactCheckItem[]): string[] {
    const changes: string[] = [];
    for (const row of rows) {
      if (!row.confidence_after) continue;
      const item = row.target.startsWith('fact:')
        ? c.starting_facts.find((f) => `fact:${f.id}` === row.target)
        : c.steps.find((s) => s.id === row.target);
      if (!item) continue;
      const next = weakerConfidence(item.confidence, row.confidence_after);
      if (next !== item.confidence) {
        changes.push(`${row.target}: ${item.confidence} -> ${next}`);
        item.confidence = next;
      }
    }
    return changes;
  }

  // -------------------------------------------------------------------------
  // The critic loop
  // -------------------------------------------------------------------------

  private async critique(draft: DraftCase, round: number, previousQuestions: HardQuestion[]): Promise<RoundCritique> {
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
          { draft, must_answer: this.outline.must_answer, ...(previousQuestions.length ? { previous: previousQuestions } : {}) },
          round,
          {
            share: share(weight.hard),
            summarize: (o) =>
              `${o.questions.length} questions (${o.questions.filter((q) => q.blocking && q.status === 'open').length} blocking and open), ` +
              `${o.gaps.length} gaps (${o.gaps.filter((g) => g.blocking).length} blocking). Most moving fact: ${o.most_moving_fact}`,
          },
        ),
      ),
      settle(
        'fact_checker',
        this.call(this.agents.factChecker, { draft, sources }, round, {
          share: share(weight.fact),
          summarize: (o) => {
            const by = new Map<string, number>();
            for (const r of o.rows) by.set(r.verdict, (by.get(r.verdict) ?? 0) + 1);
            return `${o.rows.length} rows: ${[...by].map(([v, n]) => `${n} ${v}`).join(', ') || 'none'}.`;
          },
        }),
      ),
      // Each red team is a fresh call that sees the draft JSON and the snapshot list, nothing else.
      ...sides.map((side) =>
        settle(
          `red_team (${side.id})`,
          this.call(this.agents.redTeam, { draft: structuredClone(draft), side, sources }, round, {
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
      factRows: (fc as FactCheckerOutput | undefined)?.rows ?? [],
      citations: checkCitations(draft, this.store),
      validationErrors: validation.errors,
      failedCritics: failed,
    };
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
  private routeGaps(b: Blocking): { side?: OutlineSide; gaps: GapInput[] }[] {
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
      fact_check: [
        ...r.factRows.filter((row) => row.verdict !== 'supported'),
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
      },
      0,
      { summarize: (o) => this.draftSummary(o) },
    );
    for (const r of first.resolutions) this.resolutions.set(r.ref, r.resolution);
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
        r = await this.critique(draft, round, previous);
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError)) throw e;
        budgetStop = true;
        await this.note(`Stopped before the critics of round ${round}: ${e.message}.`, round);
        break;
      }
      rounds.push(r);
      for (const q of r.hard?.questions ?? []) {
        const prev = questions.get(q.id);
        questions.set(q.id, { item: q, firstRound: prev?.firstRound ?? round, lastRound: round, ...(prev?.drafterResolution ? { drafterResolution: prev.drafterResolution } : {}) });
      }
      const downgrades = this.applyDowngrades(draft, r.factRows);
      if (downgrades.length) await this.note(`Applied the fact-checker's confidence downgrades: ${downgrades.join('; ')}`, round);

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
        const jobs = this.routeGaps(b);
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
          },
          round,
          { summarize: (o) => this.draftSummary(o) },
        );
        redraftCost = this.cost - redraftStart;
        this.recordResolutions(revised.resolutions, r, questions);
        for (const x of revised.resolutions) this.resolutions.set(x.ref, x.resolution);
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
    const draftFailures = new Set(checkCitations(draft, this.store).map(failureKey));
    const editRound = Math.max(rounds.length, 0);
    try {
      const edited = await this.call(
        this.agents.editor,
        {
          draft,
          critiques: last ? this.critiquesFor(last) : {},
          openIssues: [...this.issues, ...openBefore].map((o, i) => ({ id: `oi-${i + 1}`, ...o })),
          ...(this.live ? { unchanged: this.unchangedItems(draft) } : {}),
        },
        editRound,
        { useReserve: true, summarize: (o) => o.notes.join(' ') || 'No changes.' },
      );
      const candidate = this.prepare(edited.case);
      const v = this.validation(candidate);
      const newFailures = checkCitations(candidate, this.store).filter((f) => !draftFailures.has(failureKey(f)));
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
    // Only the editor's own version gets the "edited after the finding" note; a fallback is not the editor's text.
    const review = this.assembleReview(final, rounds, questions, clean, finalFailures, editorFallback ? final : draft);
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

  private draftSummary(o: DrafterOutput): string {
    const c = o.case;
    return `${c.starting_facts.length} starting facts, ${c.steps.length} steps, ${c.sources.length} sources; ${o.resolutions.length} resolutions.`;
  }

  /** The drafter's resolutions, matched to this round's questions, flags and gaps. */
  private recordResolutions(resolutions: DrafterOutput['resolutions'], r: RoundCritique, questions: Map<string, QuestionRecord>) {
    const byRef = new Map(resolutions.map((x) => [x.ref, x.resolution]));
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
    const resolution = [q.item.resolution, q.drafterResolution ? `Drafter: ${q.drafterResolution}` : ''].filter(Boolean).join(' ');
    return {
      ...q.item,
      round: q.firstRound,
      step_ids: q.item.step_ids ?? [],
      ...(resolution ? { resolution: clip(resolution, 2000) } : {}),
    };
  }

  /** Everything that still blocks after the last round, as open issues. */
  private unresolvedIssues(r: RoundCritique, c: DraftCase): Omit<OpenIssue, 'id'>[] {
    const out: Omit<OpenIssue, 'id'>[] = [];
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
      });
    }
    for (const row of b.factRows) {
      const step = stepRef(row.target);
      out.push({
        source: 'fact_checker',
        severity: 'high',
        description: clip(`Fact-check (${row.verdict}) on ${row.target}: ${row.claim}${row.note ? ` (${row.note})` : ''}`, 2000),
        ...(step ? { step_id: step } : {}),
        resolved: false,
      });
    }
    for (const e of b.validationErrors) out.push({ source: 'validator', severity: 'high', description: clip(e, 2000), resolved: false });
    for (const f of b.failedCritics) out.push({ source: 'pipeline', severity: 'high', description: clip(`A critic did not finish: ${f}`, 2000), resolved: false });
    return out;
  }

  private assembleReview(
    final: DraftCase,
    rounds: RoundCritique[],
    questions: Map<string, QuestionRecord>,
    clean: boolean,
    finalFailures: CitationFailure[],
    /** The last critiqued draft, before the editor's pass. */
    critiqued: DraftCase,
  ): ReviewRecord {
    const sideIds = new Set(final.sides.map((s) => s.id));
    const last = rounds[rounds.length - 1];

    const hard_questions: HardQuestion[] = [...questions.values()].map((q) => {
      const h = this.questionForReview(q);
      // A question the hard-questions agent stopped asking after the drafter answered it counts as answered.
      if (h.status === 'open' && q.drafterResolution && last && q.lastRound < last.round) h.status = 'answered';
      if (h.side_id && !sideIds.has(h.side_id)) delete h.side_id;
      return h;
    });

    const bias_reports: BiasReport[] = rounds.flatMap((r) =>
      r.redTeams
        .filter((t) => t.out && sideIds.has(t.side.id))
        .map((t) => ({
          side_id: t.side.id,
          round: r.round,
          summary: clip(t.out!.summary, 4000),
          flags: t.flags.map((f) => ({
            ...f.flag,
            status: f.drafterResolution ? ('addressed' as const) : ('unaddressed' as const),
            ...(f.drafterResolution ? { resolution: clip(f.drafterResolution, 2000) } : {}),
          })),
        })),
    );

    const fact_check: FactCheckRow[] = rounds.flatMap((r) => [
      ...r.factRows.map((row) => ({ ...row, round: r.round })),
      ...r.citations.map((f) => ({ ...f, note: clip(`Deterministic check: ${f.note}`, 2000), round: r.round })),
    ]);
    // Failures the final checks still find that the last round did not record (e.g. after an editor fallback).
    const recorded = new Set((last?.citations ?? []).map(failureKey));
    const lastRound = last?.round ?? 0;
    for (const f of finalFailures) {
      if (!recorded.has(failureKey(f))) fact_check.push({ ...f, note: clip(`Deterministic check (final): ${f.note}`, 2000), round: lastRound });
    }

    const open: Omit<OpenIssue, 'id'>[] = [...this.issues];
    if (!clean && last) open.push(...this.unresolvedIssues(last, final));
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

    // The critics saw the draft before the editor's pass. When the editor then changed a flagged step, say so:
    // the finding may already be fixed (or made worse), and no critic has checked the edited text.
    const before = new Map(critiqued.steps.map((st) => [st.id, JSON.stringify({ ...st, order: 0 })]));
    const editedSteps = new Set(final.steps.filter((st) => before.get(st.id) !== JSON.stringify({ ...st, order: 0 })).map((st) => st.id));
    for (const o of open) {
      if (o.step_id && editedSteps.has(o.step_id) && o.source !== 'editor' && o.source !== 'pipeline' && !o.description.startsWith('Citation check')) {
        o.description = clip(`${o.description} The editor revised this step after this finding; no critic re-checked the edited text.`, 2000);
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
      open_issues: open.map((o, i) => ({ id: `oi-${i + 1}`, ...o })),
      decisions: [],
    };
  }
}
