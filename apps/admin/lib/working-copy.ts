import {
  LocalId,
  TAKE_LENSES,
  deepEqual,
  type Case,
  type Fact,
  type Issue,
  type Layer,
  type LayerKind,
  type Side,
  type Source,
  type Step,
  type Take,
  type TakeCheck,
  type TimelineEvent,
} from '@sia/case-schema';

/**
 * The review screen edits a working copy of the case document. Every helper
 * here is pure: it returns a new document and never mutates its input, so the
 * editor can keep the original for "unsaved edits" checks and the diff.
 *
 * The working copy may be invalid while the admin types (an empty headline, a
 * step with no source yet). The validator reports that; these helpers never
 * refuse an edit because it would make the document invalid.
 */

export type Doc = Case;
export type PathKey = string | number;
export type Path = readonly PathKey[];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function pathToString(path: Path): string {
  return path.map(String).join('.');
}

export function parsePath(s: string): PathKey[] {
  if (s === '') return [];
  return s.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

type Container = Record<string, unknown> | unknown[];

const isContainer = (v: unknown): v is Container => typeof v === 'object' && v !== null;

export function getAt(obj: unknown, path: Path): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!isContainer(cur)) return undefined;
    cur = (cur as Record<PathKey, unknown>)[k];
  }
  return cur;
}

/**
 * Sets `value` at `path`, copying only the containers along the path.
 * `undefined` removes an object key (optional fields are absent, never null).
 * Missing containers are created (an array when the next key is a number).
 */
export function setAt<T>(obj: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path as [PathKey, ...PathKey[]];
  const cur: unknown = obj;
  const base: Container = isContainer(cur) ? cur : typeof head === 'number' ? [] : {};
  const child = (base as Record<PathKey, unknown>)[head];
  const next = rest.length === 0 ? value : setAt(child, rest, value);
  if (Array.isArray(base)) {
    const copy = base.slice();
    if (typeof head !== 'number') throw new Error(`array index expected at "${String(head)}"`);
    copy[head] = next;
    return copy as T;
  }
  const copy: Record<string, unknown> = { ...base };
  if (next === undefined) delete copy[head];
  else copy[head] = next;
  return copy as T;
}

export function updateAt<T>(obj: T, path: Path, fn: (current: unknown) => unknown): T {
  return setAt(obj, path, fn(getAt(obj, path)));
}

function arrayAt(obj: unknown, path: Path): unknown[] {
  const v = getAt(obj, path);
  return Array.isArray(v) ? v : [];
}

/** Inserts `item` at `index` (clamped) in the array at `path`. */
export function insertAt<T>(obj: T, path: Path, index: number, item: unknown): T {
  const arr = arrayAt(obj, path).slice();
  arr.splice(Math.max(0, Math.min(index, arr.length)), 0, item);
  return setAt(obj, path, arr);
}

export function removeAt<T>(obj: T, path: Path, index: number): T {
  const arr = arrayAt(obj, path).slice();
  if (index < 0 || index >= arr.length) return obj;
  arr.splice(index, 1);
  return setAt(obj, path, arr);
}

/** Moves the item at `from` to `to` (both clamped); a no-op returns the same object. */
export function moveAt<T>(obj: T, path: Path, from: number, to: number): T {
  const arr = arrayAt(obj, path).slice();
  if (from < 0 || from >= arr.length) return obj;
  const target = Math.max(0, Math.min(to, arr.length - 1));
  if (target === from) return obj;
  const [item] = arr.splice(from, 1);
  arr.splice(target, 0, item);
  return setAt(obj, path, arr);
}

// ---------------------------------------------------------------------------
// Field edits
// ---------------------------------------------------------------------------

/** Optional text: an empty (or blank) value removes the field instead of storing "". */
export function setOptionalText<T>(obj: T, path: Path, value: string): T {
  return setAt(obj, path, value.trim() === '' ? undefined : value);
}

/** Adds or removes `id` in a list of ids, keeping the list's order. */
export function toggleId(list: readonly string[] | undefined, id: string, on: boolean): string[] {
  const cur = list ?? [];
  if (on) return cur.includes(id) ? [...cur] : [...cur, id];
  return cur.filter((x) => x !== id);
}

/** `prefix1`, `prefix2`, ... : the first id not already taken. */
export function uniqueId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!used.has(id)) return id;
  }
}

/** Why `id` cannot replace `current` in a list of `taken` ids, or null when it can. */
export function idProblem(id: string, taken: readonly string[], current?: string): string | null {
  if (id === current) return null;
  if (!LocalId.safeParse(id).success) return 'Use lowercase letters, digits, "-" or "_" (start with a letter or digit).';
  if (taken.includes(id)) return `"${id}" is already used.`;
  return null;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Sets every step's `order` to its position (1..n). */
export function renumberSteps(doc: Doc): Doc {
  const steps = doc.steps ?? [];
  if (steps.every((s, i) => s.order === i + 1)) return doc;
  return { ...doc, steps: steps.map((s, i) => (s.order === i + 1 ? s : { ...s, order: i + 1 })) };
}

export function moveStep(doc: Doc, from: number, to: number): Doc {
  return renumberSteps(moveAt(doc, ['steps'], from, to));
}

export function newStep(doc: Doc): Step {
  const steps = doc.steps ?? [];
  return {
    id: uniqueId('s', steps.map((s) => s.id)),
    order: steps.length + 1,
    headline: '',
    body: '',
    depth: [],
    source_ids: [],
    confidence: 'reported',
    micro_poll: { statement: '' },
  };
}

/** Inserts a blank step after `afterIndex` (at the end by default) and renumbers. */
export function addStep(doc: Doc, afterIndex?: number): { doc: Doc; index: number } {
  const steps = doc.steps ?? [];
  const index = afterIndex === undefined ? steps.length : Math.max(0, Math.min(afterIndex + 1, steps.length));
  return { doc: renumberSteps(insertAt(doc, ['steps'], index, newStep(doc))), index };
}

export function removeStep(doc: Doc, index: number): Doc {
  return renumberSteps(removeAt(doc, ['steps'], index));
}

// ---------------------------------------------------------------------------
// New items
// ---------------------------------------------------------------------------

export function newFact(doc: Doc): Fact {
  return {
    id: uniqueId('f', (doc.starting_facts ?? []).map((f) => f.id)),
    text: '',
    source_ids: [],
    confidence: 'reported',
  };
}

export function newSide(doc: Doc): Side {
  return { id: uniqueId('side', (doc.sides ?? []).map((s) => s.id)), label: '', steelman: '' };
}

/** A blank timeline event dated like the last one. */
export function newEvent(doc: Doc): TimelineEvent {
  const events = doc.timeline ?? [];
  return { id: uniqueId('e', events.map((e) => e.id)), date: events.at(-1)?.date ?? doc.as_of ?? '', text: '', source_ids: [] };
}

/** A blank online take for the first lens the case does not have yet. */
export function newTake(doc: Doc): Take {
  const takes = doc.takes ?? [];
  const lens = TAKE_LENSES.find((l) => !takes.some((t) => t.lens === l)) ?? 'center';
  return {
    id: uniqueId(lens, takes.map((t) => t.id)),
    lens,
    label: `How the ${lens === 'center' ? 'middle' : lens} is telling it`,
    summary: '',
    source_ids: [],
    checks: [newCheck()],
  };
}

export function newCheck(): TakeCheck {
  return { claim: '', verdict: 'unknown', note: '', source_ids: [] };
}

export function newSource(doc: Doc, now: Date = new Date()): Source {
  return {
    id: uniqueId('src', (doc.sources ?? []).map((s) => s.id)),
    title: '',
    publisher: '',
    url: 'https://',
    date: now.toISOString().slice(0, 10),
    type: 'news',
    accessed_at: now.toISOString(),
  };
}

/** A blank depth layer of `kind`, citing `sourceId` when one is given. */
export function newLayer(kind: LayerKind, takenIds: readonly string[], sourceId = ''): Layer {
  const id = uniqueId(kind.charAt(0), takenIds);
  switch (kind) {
    case 'document':
      return { kind, id, title: '', summary: '', source_id: sourceId };
    case 'quote':
      return { kind, id, text: '', speaker: '', source_id: sourceId };
    case 'timeline':
      return { kind, id, title: '', entries: [{ date: '', text: '', source_ids: sourceId ? [sourceId] : [] }] };
    case 'context':
      return { kind, id, title: '', body: '', source_ids: sourceId ? [sourceId] : [] };
  }
}

// ---------------------------------------------------------------------------
// Renames that keep every reference pointing at the renamed item
// ---------------------------------------------------------------------------

const swap = (id: string, from: string, to: string) => (id === from ? to : id);
const swapAll = (ids: readonly string[] | undefined, from: string, to: string) => ids?.map((x) => swap(x, from, to));

function renameInLayer(layer: Layer, from: string, to: string): Layer {
  switch (layer.kind) {
    case 'document':
    case 'quote':
      return { ...layer, source_id: swap(layer.source_id, from, to) };
    case 'context':
      return { ...layer, source_ids: swapAll(layer.source_ids, from, to) ?? [] };
    case 'timeline':
      return { ...layer, entries: layer.entries.map((e) => ({ ...e, source_ids: swapAll(e.source_ids, from, to) ?? [] })) };
  }
}

/** Renames a source and every citation of it (facts, steps, evidence, depth layers, fact-check rows). */
export function renameSourceId(doc: Doc, from: string, to: string): Doc {
  if (from === to) return doc;
  const ev = <E extends { source_id: string }>(list: E[] | undefined) =>
    list?.map((e) => ({ ...e, source_id: swap(e.source_id, from, to) }));
  const out: Doc = {
    ...doc,
    sources: (doc.sources ?? []).map((s) => (s.id === from ? { ...s, id: to } : s)),
    starting_facts: (doc.starting_facts ?? []).map((f) => {
      const next: Fact = { ...f, source_ids: swapAll(f.source_ids, from, to) ?? [] };
      if (f.evidence) next.evidence = ev(f.evidence);
      return next;
    }),
    steps: (doc.steps ?? []).map((s) => {
      const next: Step = {
        ...s,
        source_ids: swapAll(s.source_ids, from, to) ?? [],
        depth: (s.depth ?? []).map((l) => renameInLayer(l, from, to)),
      };
      if (s.evidence) next.evidence = ev(s.evidence);
      return next;
    }),
    timeline: (doc.timeline ?? []).map((e) => {
      const next: TimelineEvent = { ...e, source_ids: swapAll(e.source_ids, from, to) ?? [] };
      if (e.evidence) next.evidence = ev(e.evidence);
      return next;
    }),
    takes: (doc.takes ?? []).map((t) => ({
      ...t,
      source_ids: swapAll(t.source_ids, from, to) ?? [],
      checks: (t.checks ?? []).map((c) => {
        const next: TakeCheck = { ...c, source_ids: swapAll(c.source_ids, from, to) ?? [] };
        if (c.evidence) next.evidence = ev(c.evidence);
        return next;
      }),
    })),
  };
  if (doc.review) {
    out.review = {
      ...doc.review,
      fact_check: (doc.review.fact_check ?? []).map((r) =>
        r.source_id === from ? { ...r, source_id: to } : r,
      ),
    };
  }
  return out;
}

/** Renames a side and every reference to it (step `favors`, hard questions, bias reports). */
export function renameSideId(doc: Doc, from: string, to: string): Doc {
  if (from === to) return doc;
  const out: Doc = {
    ...doc,
    sides: (doc.sides ?? []).map((s) => (s.id === from ? { ...s, id: to } : s)),
    steps: (doc.steps ?? []).map((s) => (s.favors === from ? { ...s, favors: to } : s)),
  };
  if (doc.review) {
    out.review = {
      ...doc.review,
      hard_questions: (doc.review.hard_questions ?? []).map((q) => (q.side_id === from ? { ...q, side_id: to } : q)),
      bias_reports: (doc.review.bias_reports ?? []).map((r) => (r.side_id === from ? { ...r, side_id: to } : r)),
    };
  }
  return out;
}

/** Renames a step and every review-record reference to it (questions, flags, issues, fact-check targets). */
export function renameStepId(doc: Doc, from: string, to: string): Doc {
  if (from === to) return doc;
  const out: Doc = { ...doc, steps: (doc.steps ?? []).map((s) => (s.id === from ? { ...s, id: to } : s)) };
  if (doc.review) {
    const target = (t: string) => {
      if (t === from) return to;
      const prefix = `layer:${from}/`;
      return t.startsWith(prefix) ? `layer:${to}/${t.slice(prefix.length)}` : t;
    };
    out.review = {
      ...doc.review,
      hard_questions: (doc.review.hard_questions ?? []).map((q) => ({ ...q, step_ids: swapAll(q.step_ids, from, to) ?? [] })),
      bias_reports: (doc.review.bias_reports ?? []).map((r) => ({
        ...r,
        flags: (r.flags ?? []).map((f) => (f.step_id === from ? { ...f, step_id: to } : f)),
      })),
      open_issues: (doc.review.open_issues ?? []).map((o) => (o.step_id === from ? { ...o, step_id: to } : o)),
      fact_check: (doc.review.fact_check ?? []).map((r) => ({ ...r, target: target(r.target) })),
    };
  }
  return out;
}

/** Renames a starting fact and its fact-check targets (`fact:<id>`). */
export function renameFactId(doc: Doc, from: string, to: string): Doc {
  if (from === to) return doc;
  const out: Doc = {
    ...doc,
    starting_facts: (doc.starting_facts ?? []).map((f) => (f.id === from ? { ...f, id: to } : f)),
  };
  if (doc.review) {
    out.review = {
      ...doc.review,
      fact_check: (doc.review.fact_check ?? []).map((r) => (r.target === `fact:${from}` ? { ...r, target: `fact:${to}` } : r)),
    };
  }
  return out;
}

/** Renames a depth layer within one step, and fact-check targets `layer:<step>/<layer>`. */
export function renameLayerId(doc: Doc, stepIndex: number, from: string, to: string): Doc {
  const step = doc.steps?.[stepIndex];
  if (!step || from === to) return doc;
  let out = setAt(doc, ['steps', stepIndex, 'depth'], step.depth.map((l) => (l.id === from ? { ...l, id: to } : l)));
  if (doc.review) {
    const old = `layer:${step.id}/${from}`;
    out = setAt(
      out,
      ['review', 'fact_check'],
      (doc.review.fact_check ?? []).map((r) => (r.target === old ? { ...r, target: `layer:${step.id}/${to}` } : r)),
    );
  }
  return out;
}

/**
 * What in the review record names a side (hard questions asked for it, its
 * red team's reports). Removing such a side would leave review entries the
 * console cannot fix, so the editor refuses to remove it.
 */
export function sideReviewReferences(doc: Doc, sideId: string): string[] {
  const out: string[] = [];
  const qs = (doc.review?.hard_questions ?? []).filter((q) => q.side_id === sideId).length;
  const reports = (doc.review?.bias_reports ?? []).filter((r) => r.side_id === sideId).length;
  const rows = (doc.review?.fact_check ?? []).filter((r) => r.target === `side:${sideId}`).length;
  if (qs) out.push(`${qs} hard question${qs === 1 ? '' : 's'}`);
  if (reports) out.push(`${reports} red-team report${reports === 1 ? '' : 's'}`);
  if (rows) out.push(`${rows} fact-check row${rows === 1 ? '' : 's'}`);
  return out;
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/** Where each source is cited: "fact f1", "step s3", "step s3 › layer d1". */
export function citationsBySource(doc: Doc): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, where: string) => {
    const list = out.get(id) ?? [];
    if (!list.includes(where)) list.push(where);
    out.set(id, list);
  };
  for (const f of doc.starting_facts ?? []) for (const id of f.source_ids ?? []) add(id, `fact ${f.id}`);
  for (const s of doc.steps ?? []) {
    for (const id of s.source_ids ?? []) add(id, `step ${s.id}`);
    for (const l of s.depth ?? []) {
      const where = `step ${s.id} › ${l.kind} ${l.id}`;
      if (l.kind === 'document' || l.kind === 'quote') add(l.source_id, where);
      else if (l.kind === 'context') for (const id of l.source_ids ?? []) add(id, where);
      else for (const e of l.entries ?? []) for (const id of e.source_ids ?? []) add(id, where);
    }
  }
  for (const e of doc.timeline ?? []) for (const id of e.source_ids ?? []) add(id, `timeline ${e.id}`);
  for (const t of doc.takes ?? []) {
    for (const id of t.source_ids ?? []) add(id, `take ${t.id}`);
    (t.checks ?? []).forEach((c, i) => {
      for (const id of c.source_ids ?? []) add(id, `take ${t.id} › check ${i + 1}`);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation issues, linked to fields
// ---------------------------------------------------------------------------

/** Issues at `path` or anywhere below it. */
export function issuesUnder(issues: readonly Issue[], path: string): Issue[] {
  if (path === '') return [...issues];
  return issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`));
}

/** DOM id of the editor field for a document path, e.g. `steps.2.headline` -> `f-steps-2-headline`. */
export function fieldDomId(path: string): string {
  return `f-${path.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

/**
 * DOM ids to try, most specific first, when jumping to the field behind an
 * issue: `steps.2.source_ids.0` falls back to `steps.2.source_ids`, then the
 * step card `steps.2`, then the step list.
 */
export function domIdCandidates(issuePath: string): string[] {
  const parts = issuePath === '' ? [] : issuePath.split('.');
  const out: string[] = [];
  for (let n = parts.length; n >= 1; n--) out.push(fieldDomId(parts.slice(0, n).join('.')));
  return out;
}

/** Fields the database manages or the review appends to; they are never edited in the console. */
export const MANAGED_KEYS = ['review', 'status', 'id', 'slug', 'version', 'parent_version'] as const;

/**
 * The review-record lists the console does change: ids in them follow the
 * renames above, and the admin's triage (a red-team flag marked addressed, a
 * hard question answered, an open issue resolved) is recorded in them. Agent
 * reports, rounds, the balance summary and decisions stay as the database
 * stored them (decisions are only ever appended by the review actions).
 */
export const REVIEW_EDITABLE_KEYS = ['hard_questions', 'bias_reports', 'fact_check', 'open_issues'] as const;

/** The part of a document the admin edits: everything but the managed fields. */
export function contentOf(doc: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
  for (const k of MANAGED_KEYS) delete out[k];
  return out;
}

/** The review-record lists the console may change (see REVIEW_EDITABLE_KEYS). */
export function reviewEditsOf(doc: unknown): Record<string, unknown> {
  const review = ((doc as { review?: Record<string, unknown> } | null)?.review ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of REVIEW_EDITABLE_KEYS) out[k] = review[k] ?? [];
  return out;
}

/** True when the case content (what readers see, plus admin-only tags) differs. */
export function isContentDirty(saved: unknown, working: unknown): boolean {
  return !deepEqual(contentOf(saved), contentOf(working));
}

/**
 * True when the working copy differs from the saved document: its content, or
 * the admin's triage of review items. A new decision appended to the review
 * record, or a status change, is not an edit.
 */
export function isDirty(saved: unknown, working: unknown): boolean {
  return isContentDirty(saved, working) || !deepEqual(reviewEditsOf(saved), reviewEditsOf(working));
}

/**
 * The working copy with the saved document's managed fields (status, ids,
 * decisions and pipeline metadata) laid over it. The review lists the console
 * edits (renamed references, triage) come from the working copy, so a rename
 * or a resolved flag is validated, previewed and saved as the admin sees it.
 */
export function withManagedFields(working: Doc, saved: Doc): Doc {
  const out: Record<string, unknown> = { ...working };
  for (const k of MANAGED_KEYS) {
    if (saved[k] === undefined) delete out[k];
    else out[k] = saved[k];
  }
  if (saved.review) {
    const edits = working.review ? reviewEditsOf(working) : {};
    const review: Record<string, unknown> = { ...saved.review };
    let changed = false;
    for (const [k, v] of Object.entries(edits)) {
      if (!deepEqual(v, (saved.review as Record<string, unknown>)[k] ?? [])) {
        review[k] = v;
        changed = true;
      }
    }
    if (changed) out.review = review;
  }
  return out as Doc;
}
