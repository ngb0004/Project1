import {
  ADMIN_ONLY_CASE_KEYS,
  ADMIN_ONLY_STEP_KEYS,
  AFTER,
  BEFORE,
  FAIRNESS_RATINGS,
  FLAG_REASONS,
  SeedProfile,
  generateSeedSessions,
  type PublicCase,
  type SeedProfileInput,
} from '@sia/case-schema';
import {
  DiveApiError,
  type CaseHistory,
  type DiveApi,
  type FairnessValue,
  type FinalCrowd,
  type FinalStepStat,
  type FlagReason,
  type Histogram,
  type LiveCaseSummary,
  type LoadedCase,
  type Reveal,
  type SessionPath,
  type SessionStart,
  type SlotKey,
  type StepCrowd,
  type VersionNote,
} from './types';
import {
  WeightedSum,
  ZERO,
  compare,
  div,
  ratio,
  round,
  roundOrNull,
  seedWeightDec,
  seedWeightFromFloat,
  type Dec,
} from './numeric';

/**
 * In-memory implementation of the dive API with the same semantics as the
 * database functions (locked answers, fixed order, reveal only after commit,
 * seeded rows that fade out). Used by tests, the web demo and the admin preview.
 *
 * It makes no network calls. Unlike the database it has no rate limits and no
 * reading-time floor, so no local session is ever excluded from the crowd.
 */

export interface LocalCaseInput {
  doc: PublicCase;
  /** Defaults to doc.id. */
  caseId?: string;
  /** Defaults to doc.version. */
  version?: number;
  publishedAt?: string;
  /** Seeds this version (and sets its fade threshold), like the case's seed_profile in the database. */
  seedProfile?: SeedProfileInput | null;
}

export interface LocalDiveApiOptions {
  cases: LocalCaseInput[];
  /** Clock in ms, for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export interface CrowdRow {
  session_id: string;
  is_seed: boolean;
  excluded: boolean;
  /** Answers by slot index: 0 = before, 1..n steps, n+1 = after. */
  values: (number | undefined)[];
}

// ---------------------------------------------------------------------------
// Aggregates (mirror app.histogram, app.step_crowd and app.final_crowd)
// ---------------------------------------------------------------------------

const binOf = (value: number) => Math.min(Math.floor(value / 10), 9);

/** app.histogram(): weighted share per 10-point bin; all zeros when the total weight is 0. */
function histogram(points: { value: number; isSeed: boolean }[], w: Dec): Histogram {
  const bins = Array.from({ length: 10 }, () => new WeightedSum());
  const total = new WeightedSum();
  for (const p of points) {
    bins[binOf(p.value)]!.add(1, p.isSeed);
    total.add(1, p.isSeed);
  }
  const t = total.value(w);
  return bins.map((b) => roundOrNull(ratio(b.value(w), t), 4) ?? 0);
}

/**
 * Mirrors app.step_crowd(): how everyone who reached step `stepIndex` (1..n) moved there.
 * `seedWeight` is the float seedWeight() returns; it is recomputed as the database's
 * numeric so every share and mean matches app.step_crowd digit for digit.
 */
export function computeStepCrowd(rows: CrowdRow[], stepId: string, stepIndex: number, seedWeight: number): StepCrowd {
  return stepCrowdOf(rows, stepId, stepIndex, seedWeightFromFloat(seedWeight));
}

function stepCrowdOf(allRows: CrowdRow[], stepId: string, stepIndex: number, w: Dec): StepCrowd {
  // Seeded rows that carry no weight (faded or left out) are not counted at all.
  const rows = w.v === 0n ? allRows.filter((r) => !r.is_seed) : allRows;
  const total = new WeightedSum();
  const seeded = new WeightedSum();
  const sumValue = new WeightedSum();
  const sumPrev = new WeightedSum();
  const sumDelta = new WeightedSum();
  const moved = new WeightedSum();
  const shift = {
    left_big: new WeightedSum(),
    left: new WeightedSum(),
    none: new WeightedSum(),
    right: new WeightedSum(),
    right_big: new WeightedSum(),
  };
  const values: { value: number; isSeed: boolean }[] = [];
  const prevs: { value: number; isSeed: boolean }[] = [];
  let nReal = 0;
  let nSeed = 0;

  // Each answer at this step, paired with the same session's previous slot.
  for (const row of rows) {
    if (row.excluded) continue;
    const value = row.values[stepIndex];
    const prev = row.values[stepIndex - 1];
    if (value === undefined || prev === undefined) continue;
    const isSeed = row.is_seed;
    const d = value - prev;
    if (isSeed) nSeed += 1;
    else nReal += 1;
    total.add(1, isSeed);
    if (isSeed) seeded.add(1, isSeed);
    sumValue.add(value, isSeed);
    sumPrev.add(prev, isSeed);
    sumDelta.add(d, isSeed);
    if (d !== 0) moved.add(1, isSeed);
    const bucket = d <= -15 ? 'left_big' : d < 0 ? 'left' : d === 0 ? 'none' : d < 15 ? 'right' : 'right_big';
    shift[bucket].add(1, isSeed);
    values.push({ value, isSeed });
    prevs.push({ value: prev, isSeed });
  }

  const t = total.value(w);
  const has = t !== null && t.v > 0n;
  const share = (x: WeightedSum) => round(div(x.value(w) ?? ZERO, t!), 4);
  const mean = (x: WeightedSum) => round(div(x.value(w)!, t!), 2);
  return {
    step_id: stepId,
    n_real: nReal,
    n_seed: nSeed,
    seed_weight: round(w, 4),
    seeded_share: has ? share(seeded) : 0,
    histogram: has ? histogram(values, w) : null,
    previous_histogram: has ? histogram(prevs, w) : null,
    mean_value: has ? mean(sumValue) : null,
    mean_previous: has ? mean(sumPrev) : null,
    mean_delta: has ? mean(sumDelta) : null,
    moved_share: has ? share(moved) : null,
    shift: has
      ? {
          left_big: share(shift.left_big),
          left: share(shift.left),
          none: share(shift.none),
          right: share(shift.right),
          right_big: share(shift.right_big),
        }
      : null,
  };
}

/** Mirrors app.final_crowd(), with `seedWeight` handled as in computeStepCrowd. */
export function computeFinalCrowd(rows: CrowdRow[], stepIds: string[], seedWeight: number): FinalCrowd {
  return finalCrowdOf(rows, stepIds, seedWeightFromFloat(seedWeight));
}

function finalCrowdOf(allRows: CrowdRow[], stepIds: string[], w: Dec): FinalCrowd {
  const rows = w.v === 0n ? allRows.filter((r) => !r.is_seed) : allRows;
  const afterIndex = stepIds.length + 1;
  // Completed sessions only: the ones that answered After.
  const done = rows.filter((r) => !r.excluded && r.values[afterIndex] !== undefined);

  const total = new WeightedSum();
  const seeded = new WeightedSum();
  const sumBefore = new WeightedSum();
  const sumAfter = new WeightedSum();
  for (const r of done) {
    total.add(1, r.is_seed);
    if (r.is_seed) seeded.add(1, true);
    if (r.values[0] !== undefined) sumBefore.add(r.values[0], r.is_seed);
    sumAfter.add(r.values[afterIndex]!, r.is_seed);
  }
  const t = total.value(w);
  const answersAt = (index: number) =>
    done.filter((r) => r.values[index] !== undefined).map((r) => ({ value: r.values[index]!, isSeed: r.is_seed }));

  const steps: FinalStepStat[] = [];
  // Unrounded mean absolute change of each listed step, for picking the top step.
  const meanAbs: (Dec | null)[] = [];
  stepIds.forEach((stepId, i) => {
    const index = i + 1;
    const weight = new WeightedSum();
    const delta = new WeightedSum();
    const abs = new WeightedSum();
    const moved = new WeightedSum();
    for (const r of done) {
      const value = r.values[index];
      const prev = r.values[index - 1];
      if (value === undefined || prev === undefined) continue;
      weight.add(1, r.is_seed);
      delta.add(value - prev, r.is_seed);
      abs.add(Math.abs(value - prev), r.is_seed);
      if (value !== prev) moved.add(1, r.is_seed);
    }
    const sw = weight.value(w);
    // Every step is listed; a step nobody answered has no numbers.
    const exactAbs = sw === null ? null : ratio(abs.value(w), sw);
    if (sw === null) {
      steps.push({ step_id: stepId, mean_delta: null, mean_abs_delta: null, moved_share: 0 });
      meanAbs.push(null);
      return;
    }
    steps.push({
      step_id: stepId,
      mean_delta: roundOrNull(ratio(delta.value(w), sw), 2),
      mean_abs_delta: roundOrNull(exactAbs, 2),
      moved_share: roundOrNull(ratio(moved.value(w), sw), 4) ?? 0,
    });
    meanAbs.push(exactAbs);
  });

  // Largest mean absolute change among steps that moved anyone; ties go to the earlier step.
  let top = -1;
  meanAbs.forEach((x, i) => {
    if (x === null || compare(x, ZERO) <= 0) return;
    if (top < 0 || compare(x, meanAbs[top]!) > 0) top = i;
  });
  const hasCrowd = t !== null && t.v > 0n;

  return {
    n_real: done.filter((r) => !r.is_seed).length,
    n_seed: done.filter((r) => r.is_seed).length,
    seed_weight: round(w, 4),
    seeded_share: roundOrNull(ratio(seeded.value(w), t), 4) ?? 0,
    before_histogram: hasCrowd ? histogram(answersAt(0), w) : null,
    after_histogram: hasCrowd ? histogram(answersAt(afterIndex), w) : null,
    mean_before: roundOrNull(ratio(sumBefore.value(w), t), 2),
    mean_after: roundOrNull(ratio(sumAfter.value(w), t), 2),
    steps,
    top_step_id: top < 0 ? null : steps[top]!.step_id,
  };
}

/** Mirrors app.session_path(): the user's answers and the step that moved them most. */
function sessionPath(slots: SlotKey[], values: (number | undefined)[]): SessionPath {
  const answers: SessionPath['answers'] = [];
  let topStep: string | null = null;
  let topMove = 0;
  let prev: number | undefined;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const value = values[i];
    if (value === undefined) continue;
    answers.push({ step_id: slot, value });
    if (slot !== BEFORE && slot !== AFTER && prev !== undefined && Math.abs(value - prev) > topMove) {
      topStep = slot;
      topMove = Math.abs(value - prev);
    }
    prev = value;
  }
  return { answers, top_step_id: topStep };
}

// ---------------------------------------------------------------------------
// LocalDiveApi
// ---------------------------------------------------------------------------

interface LocalSession {
  id: string;
  caseId: string;
  version: number;
  isSeed: boolean;
  excluded: boolean;
  completedAt: number | null;
  /** Answers by slot index (see CrowdRow). */
  values: (number | undefined)[];
}

interface LocalVersion {
  caseId: string;
  slug: string;
  version: number;
  publishedAt: string;
  doc: PublicCase;
  slots: SlotKey[];
  stepIds: string[];
  fadeAfter: number;
  sessions: LocalSession[];
}

export interface LocalFactFlag {
  session_id: string;
  case_id: string;
  case_version: number;
  step_id: string;
  reason: FlagReason;
  note: string | null;
  created_at: string;
}

export interface LocalFairnessRating {
  session_id: string;
  case_id: string;
  case_version: number;
  side_id: string;
  rating: FairnessValue;
  created_at: string;
}

const DEFAULT_FADE_AFTER = 500;

/** case_public_projection(): admin-only fields never reach the client, even if the caller passed them. */
function projectDoc(doc: PublicCase, caseId: string, version: number): PublicCase {
  const out: Record<string, unknown> = { ...doc, id: caseId, version };
  for (const k of ADMIN_ONLY_CASE_KEYS) delete out[k];
  const strip = (o: object, keys: readonly string[]) => {
    const copy: Record<string, unknown> = { ...o };
    for (const k of keys) delete copy[k];
    return copy;
  };
  out.steps = doc.steps.map((s) => strip(s, ADMIN_ONLY_STEP_KEYS));
  out.starting_facts = doc.starting_facts.map((f) => strip(f, ['evidence']));
  return JSON.parse(JSON.stringify(out)) as PublicCase;
}

/** left(note, 1000), trimmed of spaces, empty -> null (as flag_fact stores it). */
function normalizeNote(note: string | undefined): string | null {
  if (note == null) return null;
  const s = Array.from(note).slice(0, 1000).join('').replace(/^ +| +$/g, '');
  return s === '' ? null : s;
}

/** A well-formed v4 UUID built from a counter: deterministic and needs no crypto. */
function counterUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export class LocalDiveApi implements DiveApi {
  private readonly now: () => number;
  private readonly versions: LocalVersion[] = [];
  private readonly sessions = new Map<string, LocalSession>();
  private readonly devices = new Map<string, LocalSession>();
  private readonly flags = new Map<string, LocalFactFlag>();
  private readonly ratings = new Map<string, LocalFairnessRating>();
  private nextId = 1;

  constructor(opts: LocalDiveApiOptions) {
    this.now = opts.now ?? Date.now;
    for (const input of opts.cases) this.addVersion(input);
  }

  private addVersion(input: LocalCaseInput) {
    const caseId = input.caseId ?? input.doc.id;
    const version = input.version ?? input.doc.version;
    if (this.versionOf(caseId, version)) {
      throw new DiveApiError('invalid', `case ${caseId} version ${version} was given twice`);
    }
    const sameCase = this.versions.find((v) => v.caseId === caseId);
    if (sameCase && sameCase.slug !== input.doc.slug) {
      throw new DiveApiError('invalid', `case ${caseId} has two slugs`);
    }
    if (this.versions.some((v) => v.slug === input.doc.slug && v.caseId !== caseId)) {
      throw new DiveApiError('invalid', `slug ${input.doc.slug} belongs to another case`);
    }
    const doc = projectDoc(input.doc, caseId, version);
    const stepIds = doc.steps.map((s) => s.id);
    const profile = input.seedProfile ? SeedProfile.parse(input.seedProfile) : null;
    const publishedAt = input.publishedAt ?? new Date(this.now()).toISOString();
    const v: LocalVersion = {
      caseId,
      slug: doc.slug,
      version,
      publishedAt,
      doc,
      slots: [BEFORE, ...stepIds, AFTER],
      stepIds,
      fadeAfter: profile?.fade_after_real_completions ?? DEFAULT_FADE_AFTER,
      sessions: [],
    };
    if (profile) {
      const at = Date.parse(publishedAt);
      for (const seed of generateSeedSessions(profile, stepIds)) {
        v.sessions.push({
          id: this.newId(),
          caseId,
          version,
          isSeed: true,
          excluded: false,
          completedAt: at,
          values: seed.answers.map((a) => a.value),
        });
      }
    }
    this.versions.push(v);
  }

  private newId(): string {
    return counterUuid(this.nextId++);
  }

  private versionOf(caseId: string, version: number): LocalVersion | undefined {
    return this.versions.find((v) => v.caseId === caseId && v.version === version);
  }

  /** The live version of a case: the latest published one. */
  private liveOf(caseId: string): LocalVersion | undefined {
    return this.versions
      .filter((v) => v.caseId === caseId)
      .reduce<LocalVersion | undefined>((a, v) => (a === undefined || v.version > a.version ? v : a), undefined);
  }

  private realSession(sessionId: string): LocalSession {
    const s = this.sessions.get(sessionId);
    if (!s || s.isSeed) throw new DiveApiError('not_found', 'unknown session');
    return s;
  }

  private versionOfSession(s: LocalSession): LocalVersion {
    return this.versionOf(s.caseId, s.version)!;
  }

  // -- aggregates ---------------------------------------------------------------

  private realCompletions(v: LocalVersion): number {
    return v.sessions.filter((s) => !s.isSeed && !s.excluded && s.completedAt !== null).length;
  }

  /** Real completions across every version of the case: seeds fade case-wide. */
  private caseRealCompletions(caseId: string): number {
    return this.versions.filter((v) => v.caseId === caseId).reduce((a, v) => a + this.realCompletions(v), 0);
  }

  /** app.seed_weight_for(): 1 with no real completions on the case, 0 at the profile's threshold (default 500). */
  private seedWeightFor(v: LocalVersion, includeSeed: boolean): Dec {
    return includeSeed ? seedWeightDec(this.caseRealCompletions(v.caseId), v.fadeAfter) : ZERO;
  }

  private rows(v: LocalVersion): CrowdRow[] {
    return v.sessions.map((s) => ({ session_id: s.id, is_seed: s.isSeed, excluded: s.excluded, values: s.values }));
  }

  /** The crowd at one step of a version (app.step_crowd). Exposed for the admin preview. */
  stepCrowd(caseId: string, version: number, stepId: string, includeSeed = true): StepCrowd {
    const v = this.versionOf(caseId, version);
    if (!v) throw new DiveApiError('not_found', 'case version is not published');
    return stepCrowdOf(this.rows(v), stepId, v.slots.indexOf(stepId), this.seedWeightFor(v, includeSeed));
  }

  /** The crowd's before/after distributions for a version (app.final_crowd). Exposed for the admin preview. */
  finalCrowd(caseId: string, version: number, includeSeed = true): FinalCrowd {
    const v = this.versionOf(caseId, version);
    if (!v) throw new DiveApiError('not_found', 'case version is not published');
    return finalCrowdOf(this.rows(v), v.stepIds, this.seedWeightFor(v, includeSeed));
  }

  /** Fact flags and fairness ratings recorded so far (what the admin console reads). */
  signals(): { flags: LocalFactFlag[]; ratings: LocalFairnessRating[] } {
    return {
      flags: [...this.flags.values()].map((f) => ({ ...f })),
      ratings: [...this.ratings.values()].map((r) => ({ ...r })),
    };
  }

  private versionNote(v: LocalVersion): VersionNote {
    return {
      version: v.version,
      published_at: v.publishedAt,
      parent_version: v.doc.parent_version ?? null,
      earlier_versions: this.versions
        .filter((e) => e.caseId === v.caseId && e.version < v.version)
        .sort((a, b) => a.version - b.version)
        .map((e) => ({ version: e.version, published_at: e.publishedAt, completions: this.realCompletions(e) })),
    };
  }

  /** app.reveal(): the payload for an answered slot. */
  private reveal(s: LocalSession, slot: SlotKey, locked: boolean): Reveal {
    const v = this.versionOfSession(s);
    const index = v.slots.indexOf(slot);
    const value = s.values[index]!;
    if (slot === BEFORE) return { step_id: BEFORE, value, locked };
    const previous_value = s.values[index - 1]!;
    if (slot === AFTER) {
      return {
        step_id: AFTER,
        value,
        previous_value,
        locked,
        you: sessionPath(v.slots, s.values),
        crowd: finalCrowdOf(this.rows(v), v.stepIds, this.seedWeightFor(v, true)),
        version_note: this.versionNote(v),
      };
    }
    return {
      step_id: slot,
      value,
      previous_value,
      locked,
      crowd: stepCrowdOf(this.rows(v), slot, index, this.seedWeightFor(v, true)),
      version_note: this.versionNote(v),
    };
  }

  // -- DiveApi --------------------------------------------------------------------

  async listLiveCases(): Promise<LiveCaseSummary[]> {
    const caseIds = [...new Set(this.versions.map((v) => v.caseId))];
    return caseIds
      .map((id) => this.liveOf(id)!)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .map((v) => ({
        case_id: v.caseId,
        slug: v.slug,
        version: v.version,
        title: v.doc.title,
        as_of: v.doc.as_of,
        published_at: v.publishedAt,
        content_warning: v.doc.content_warning ?? null,
        step_count: v.stepIds.length,
      }));
  }

  async getCase(slug: string, version?: number): Promise<LoadedCase | null> {
    const any = this.versions.find((v) => v.slug === slug);
    if (!any) return null;
    const live = this.liveOf(any.caseId)!;
    const v = version === undefined ? live : this.versionOf(any.caseId, version);
    if (!v) return null;
    return {
      case_id: v.caseId,
      slug: v.slug,
      version: v.version,
      published_at: v.publishedAt,
      is_live: v.version === live.version,
      doc: JSON.parse(JSON.stringify(v.doc)) as PublicCase,
    };
  }

  async startSession(caseId: string, version: number, deviceId: string): Promise<SessionStart> {
    if (typeof deviceId !== 'string' || deviceId.length < 16 || deviceId.length > 200) {
      throw new DiveApiError('invalid', 'invalid device id');
    }
    const v = this.versionOf(caseId, version);
    if (!v) throw new DiveApiError('not_found', 'case version is not published');
    const key = JSON.stringify([caseId, version, deviceId]);
    let s = this.devices.get(key);
    const resumed = s !== undefined;
    if (!s) {
      s = {
        id: this.newId(),
        caseId,
        version,
        isSeed: false,
        excluded: false,
        completedAt: null,
        values: [],
      };
      v.sessions.push(s);
      this.sessions.set(s.id, s);
      this.devices.set(key, s);
    }
    return {
      session_id: s.id,
      case_id: caseId,
      case_version: version,
      resumed,
      completed: s.completedAt !== null,
      answers: sessionPath(v.slots, s.values).answers,
    };
  }

  async submit(sessionId: string, slot: SlotKey, value: number): Promise<Reveal> {
    const s = this.realSession(sessionId);
    const v = this.versionOfSession(s);
    const index = v.slots.indexOf(slot);
    if (index < 0) throw new DiveApiError('not_found', `unknown step ${slot}`);

    // Locked: a repeat call returns the stored answer, whatever value it carries.
    if (s.values[index] !== undefined) return this.reveal(s, slot, true);

    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new DiveApiError('invalid', 'value must be between 0 and 100');
    }
    const answered = s.values.filter((x) => x !== undefined).length;
    if (answered !== index) {
      throw new DiveApiError('out_of_order', `answer the earlier steps first (expected slot ${answered}, got ${index})`);
    }
    s.values[index] = value;
    if (slot === AFTER) s.completedAt = this.now();
    return this.reveal(s, slot, false);
  }

  async getReveal(sessionId: string, slot: SlotKey): Promise<Reveal> {
    const s = this.realSession(sessionId);
    const index = this.versionOfSession(s).slots.indexOf(slot);
    if (index < 0 || s.values[index] === undefined) {
      throw new DiveApiError('forbidden', 'commit an answer before seeing the crowd');
    }
    return this.reveal(s, slot, true);
  }

  async flagFact(sessionId: string, stepId: string, reason: FlagReason, note?: string): Promise<void> {
    const s = this.realSession(sessionId);
    if (!this.versionOfSession(s).stepIds.includes(stepId)) {
      throw new DiveApiError('not_found', `unknown step ${stepId}`);
    }
    if (!(FLAG_REASONS as readonly string[]).includes(reason)) throw new DiveApiError('invalid', 'unknown reason');
    // One flag per session and step; flagging again replaces it.
    this.flags.set(JSON.stringify([s.id, stepId]), {
      session_id: s.id,
      case_id: s.caseId,
      case_version: s.version,
      step_id: stepId,
      reason,
      note: normalizeNote(note),
      created_at: new Date(this.now()).toISOString(),
    });
  }

  async rateFairness(sessionId: string, sideId: string, rating: FairnessValue): Promise<void> {
    const s = this.realSession(sessionId);
    if (s.completedAt === null) throw new DiveApiError('out_of_order', 'finish the dive first');
    if (!(FAIRNESS_RATINGS as readonly string[]).includes(rating)) throw new DiveApiError('invalid', 'unknown rating');
    if (!this.versionOfSession(s).doc.sides.some((side) => side.id === sideId)) {
      throw new DiveApiError('not_found', `unknown side ${sideId}`);
    }
    // One rating per session; rating again replaces it.
    this.ratings.set(s.id, {
      session_id: s.id,
      case_id: s.caseId,
      case_version: s.version,
      side_id: sideId,
      rating,
      created_at: new Date(this.now()).toISOString(),
    });
  }

  async getHistory(slug: string): Promise<CaseHistory | null> {
    const any = this.versions.find((v) => v.slug === slug);
    if (!any) return null;
    const live = this.liveOf(any.caseId)!;
    return {
      case_id: any.caseId,
      slug,
      live_version: live.version,
      versions: this.versions
        .filter((v) => v.caseId === any.caseId)
        .sort((a, b) => b.version - a.version)
        .map((v) => ({
          version: v.version,
          title: v.doc.title,
          as_of: v.doc.as_of,
          status: 'published',
          published_at: v.publishedAt,
          parent_version: v.doc.parent_version ?? null,
          completions: this.realCompletions(v),
        })),
    };
  }
}
