import type { Case } from './schema';
import { ADMIN_ONLY_STEP_KEYS, type PublicCase } from './public';

/**
 * Version diff for the admin review screen: what a revision (or an admin
 * edit) changes against the live version.
 *
 * - Top-level copy (title, as-of date, content warning, question, slider
 *   labels, open questions) is reported in `fields`.
 * - Starting facts, steps, sides and sources are matched by `id`. Each gets an
 *   `ItemDiff` with its status, its index on each side, whether its relative
 *   order changed, and the field-level changes (paths relative to the item).
 * - String fields carry a word-level text diff.
 *
 * Admin-only fields (`favors`, `impact`, `evidence`) are compared only when
 * both documents are full admin cases. A `PublicCase` never carries them, so
 * diffing against one would otherwise report every tag as removed. The review
 * record, status, version numbers and step `order` numbers are ignored: order
 * is shown through `beforeIndex` / `afterIndex` / `moved` instead, so adding
 * one step does not mark every later step as changed.
 */

export type CaseLike = Case | PublicCase;

// ---------------------------------------------------------------------------
// Word-level text diff
// ---------------------------------------------------------------------------

export type TextOp = { op: 'equal' | 'insert' | 'delete'; text: string };

/**
 * Tokens: runs of whitespace, words (letters/digits/marks, with inner
 * apostrophes as in "didn't" or "council's"), and single punctuation marks.
 * Concatenating the tokens always gives back the input.
 */
const TOKEN_RE = /\s+|[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*|[^\s]/gu;

export function tokenizeText(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}

/** Above this many DP cells the diff falls back to a whole-span replace (keeps memory bounded). */
const MAX_LCS_CELLS = 4_000_000;

const isBlank = (s: string) => s.length > 0 && s.trim().length === 0;

/**
 * Word-level diff of two strings: LCS over word, whitespace and punctuation
 * tokens. Adjacent ops of the same kind are merged, and within each changed
 * span the deleted text comes before the inserted text. A whitespace-only
 * equal run between two changes is folded into the change so that
 * "a b" -> "x y" reads as one replacement rather than two.
 *
 * Invariants: the `equal` + `delete` texts concatenate to `before`, and the
 * `equal` + `insert` texts concatenate to `after`.
 */
export function diffText(before: string, after: string): TextOp[] {
  if (before === after) return before ? [{ op: 'equal', text: before }] : [];
  const a = tokenizeText(before);
  const b = tokenizeText(after);

  // Trim the common prefix and suffix; the DP only runs on the middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const raw: TextOp[] = [];
  for (let i = 0; i < pre; i++) raw.push({ op: 'equal', text: a[i]! });

  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    for (const t of am) raw.push({ op: 'delete', text: t });
    for (const t of bm) raw.push({ op: 'insert', text: t });
  } else {
    // dp[i][j] = LCS length of am[i..] and bm[j..].
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          am[i] === bm[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        raw.push({ op: 'equal', text: am[i]! });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
        raw.push({ op: 'delete', text: am[i]! });
        i++;
      } else {
        raw.push({ op: 'insert', text: bm[j]! });
        j++;
      }
    }
    while (i < n) raw.push({ op: 'delete', text: am[i++]! });
    while (j < m) raw.push({ op: 'insert', text: bm[j++]! });
  }

  for (let i = a.length - suf; i < a.length; i++) raw.push({ op: 'equal', text: a[i]! });
  return cleanupTextOps(raw);
}

/** Merge equal runs, fold whitespace-only equals between changes, then group each change span as delete+insert. */
function cleanupTextOps(raw: TextOp[]): TextOp[] {
  // 1. Merge adjacent equal tokens into runs; keep change tokens as-is for now.
  const runs: TextOp[] = [];
  for (const op of raw) {
    const last = runs[runs.length - 1];
    if (last && last.op === 'equal' && op.op === 'equal') last.text += op.text;
    else runs.push({ ...op });
  }
  // 2. A whitespace-only equal run sitting between two changes becomes part of the change.
  const folded: TextOp[] = [];
  runs.forEach((op, k) => {
    const prev = runs[k - 1];
    const next = runs[k + 1];
    if (op.op === 'equal' && isBlank(op.text) && prev && prev.op !== 'equal' && next && next.op !== 'equal') {
      folded.push({ op: 'delete', text: op.text }, { op: 'insert', text: op.text });
    } else {
      folded.push(op);
    }
  });
  // 3. Group each maximal change span into one delete followed by one insert, and merge equals.
  const out: TextOp[] = [];
  let del = '';
  let ins = '';
  const flush = () => {
    if (del) out.push({ op: 'delete', text: del });
    if (ins) out.push({ op: 'insert', text: ins });
    del = '';
    ins = '';
  };
  for (const op of folded) {
    if (op.op === 'delete') del += op.text;
    else if (op.op === 'insert') ins += op.text;
    else {
      flush();
      const last = out[out.length - 1];
      if (last && last.op === 'equal') last.text += op.text;
      else out.push({ op: 'equal', text: op.text });
    }
  }
  flush();
  return out.filter((op) => op.text.length > 0);
}

// ---------------------------------------------------------------------------
// Case diff types
// ---------------------------------------------------------------------------

export interface FieldChange {
  /** Dotted path. Top-level fields are absolute (`question.prompt`); item changes are relative to the item (`headline`, `depth.d1.summary`). */
  path: string;
  /** Human-readable name, e.g. "Headline" or "Depth › d1 › Summary". */
  label: string;
  /** `undefined` when the field was added. */
  before: unknown;
  /** `undefined` when the field was removed. */
  after: unknown;
  /** Word-level diff, present when both sides are strings. */
  text?: TextOp[];
}

export interface ItemDiff {
  id: string;
  /** `changed` means at least one field changed; a pure move stays `unchanged` with `moved: true`. */
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  /** Index in the before document's array, or null when added. */
  beforeIndex: number | null;
  /** Index in the after document's array, or null when removed. */
  afterIndex: number | null;
  /** True when the item's order relative to the other kept items changed (minimal set of moves). */
  moved: boolean;
  /** Field changes for `changed` items; empty for added, removed and unchanged items. */
  changes: FieldChange[];
}

export interface CaseDiff {
  /** Changed top-level fields only: title, as_of, content_warning, question.prompt, the slider labels, open_questions. */
  fields: FieldChange[];
  /**
   * Item diffs in merged order: the after document's order, with each removed
   * item placed right after the kept item that preceded it in the before document.
   */
  startingFacts: ItemDiff[];
  steps: ItemDiff[];
  sides: ItemDiff[];
  timeline: ItemDiff[];
  takes: ItemDiff[];
  sources: ItemDiff[];
  /** Counted over starting facts + steps + sides + takes + sources. A moved item that also changed counts in both. */
  summary: { added: number; removed: number; changed: number; moved: number };
  hasChanges: boolean;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Structural equality for JSON-like values. A key holding `undefined` equals a missing key. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** Indices (into `a`) of one longest common subsequence of `a` and `b`. Ties keep later items of `a` as the stable ones. */
function lcsIndices(a: readonly string[], b: readonly string[]): Set<number> {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const keep = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keep.add(i);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  return keep;
}

/** Ids of `common` items whose relative order differs between `beforeIds` and `afterIds`. */
function movedIds(beforeIds: readonly string[], afterIds: readonly string[]): Set<string> {
  const inAfter = new Set(afterIds);
  const inBefore = new Set(beforeIds);
  const b = beforeIds.filter((id) => inAfter.has(id));
  const a = afterIds.filter((id) => inBefore.has(id));
  const keep = lcsIndices(b, a);
  return new Set(b.filter((_, i) => !keep.has(i)));
}

const KEY_LABELS: Record<string, string> = {
  title: 'Title',
  as_of: 'As-of date',
  content_warning: 'Content warning',
  headline: 'Headline',
  body: 'Body',
  depth: 'Depth',
  favors: 'Favors',
  impact: 'Impact',
  source_ids: 'Sources',
  source_id: 'Source',
  confidence: 'Confidence',
  evidence: 'Evidence',
  micro_poll: 'Fact vote',
  statement: 'Statement',
  prompt: 'Prompt',
  lens: 'Lens',
  seen_on: 'Seen on',
  checks: 'Checks',
  claim: 'Claim',
  verdict: 'Verdict',
  note: 'Note',
  text: 'Text',
  label: 'Label',
  steelman: 'Steelman',
  publisher: 'Publisher',
  url: 'URL',
  date: 'Date',
  type: 'Type',
  accessed_at: 'Accessed',
  quote_excerpt: 'Quote excerpt',
  quote: 'Quote',
  kind: 'Kind',
  summary: 'Summary',
  speaker: 'Speaker',
  context: 'Context',
  entries: 'Entries',
};

const keyLabel = (key: string) => {
  const known = KEY_LABELS[key];
  if (known) return known;
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const SEP = ' › ';

function change(path: string, label: string, before: unknown, after: unknown): FieldChange {
  const c: FieldChange = { path, label, before, after };
  if (typeof before === 'string' && typeof after === 'string') c.text = diffText(before, after);
  return c;
}

/** Arrays whose elements are all objects with a unique string `id` (depth layers, for example). */
function isIdArray(v: unknown): v is Obj[] {
  if (!Array.isArray(v)) return false;
  const seen = new Set<string>();
  for (const x of v) {
    if (!isObj(x) || typeof x.id !== 'string' || seen.has(x.id)) return false;
    seen.add(x.id);
  }
  return true;
}

/** Recursive field diff for values inside an item. Pushes nothing when equal. */
function diffValue(path: string, label: string, before: unknown, after: unknown, out: FieldChange[]): void {
  if (deepEqual(before, after)) return;

  if (isIdArray(before) && isIdArray(after) && (before.length > 0 || after.length > 0)) {
    const bIds = before.map((x) => x.id as string);
    const aIds = after.map((x) => x.id as string);
    const bById = new Map(before.map((x) => [x.id as string, x]));
    const aById = new Map(after.map((x) => [x.id as string, x]));
    if (movedIds(bIds, aIds).size > 0) {
      out.push(change(path, `${label}${SEP}order`, bIds, aIds));
    }
    for (const id of [...bIds, ...aIds.filter((x) => !bById.has(x))]) {
      diffValue(`${path}.${id}`, `${label}${SEP}${id}`, bById.get(id), aById.get(id), out);
    }
    return;
  }

  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.length === after.length &&
    before.length > 0 &&
    before.every(isObj) &&
    after.every(isObj)
  ) {
    before.forEach((x, i) => diffValue(`${path}.${i}`, `${label}${SEP}${i + 1}`, x, after[i], out));
    return;
  }

  if (isObj(before) && isObj(after)) {
    // A depth layer that changed kind is a different thing, not an edit.
    if ('kind' in before && 'kind' in after && before.kind !== after.kind) {
      out.push(change(path, label, before, after));
      return;
    }
    const keys = [...Object.keys(before), ...Object.keys(after).filter((k) => !(k in before))];
    for (const k of keys) diffValue(`${path}.${k}`, `${label}${SEP}${keyLabel(k)}`, before[k], after[k], out);
    return;
  }

  out.push(change(path, label, before, after));
}

// ---------------------------------------------------------------------------
// Item lists
// ---------------------------------------------------------------------------

type ItemKind = 'startingFacts' | 'steps' | 'sides' | 'timeline' | 'takes' | 'sources';

/** Preferred field order per item kind; any other keys follow in document order. */
const FIELD_ORDER: Record<ItemKind, readonly string[]> = {
  startingFacts: ['text', 'confidence', 'source_ids', 'evidence'],
  steps: ['headline', 'body', 'confidence', 'favors', 'impact', 'source_ids', 'evidence', 'depth', 'micro_poll'],
  sides: ['label', 'steelman'],
  timeline: ['date', 'text', 'source_ids', 'evidence'],
  takes: ['lens', 'label', 'summary', 'seen_on', 'source_ids', 'checks'],
  sources: ['title', 'publisher', 'url', 'date', 'type', 'accessed_at', 'quote_excerpt'],
};

/** Keys never compared: identity and the step number (position is reported via indices and `moved`). */
const IGNORED_ITEM_KEYS = new Set(['id', 'order']);

/** Admin-only keys inside items (never present in a PublicCase). */
const ADMIN_ONLY_ITEM_KEYS: Record<ItemKind, readonly string[]> = {
  startingFacts: ['evidence'],
  steps: ADMIN_ONLY_STEP_KEYS,
  sides: [],
  timeline: ['evidence'],
  // Evidence sits inside each check; it is compared as part of `checks`.
  takes: [],
  sources: [],
};

function diffItem(kind: ItemKind, before: Obj, after: Obj, compareAdmin: boolean): FieldChange[] {
  const skip = new Set<string>(IGNORED_ITEM_KEYS);
  if (!compareAdmin) for (const k of ADMIN_ONLY_ITEM_KEYS[kind]) skip.add(k);
  const preferred = FIELD_ORDER[kind];
  const keys = [...preferred];
  for (const k of [...Object.keys(before), ...Object.keys(after)]) if (!keys.includes(k)) keys.push(k);
  const out: FieldChange[] = [];
  for (const k of keys) {
    if (skip.has(k)) continue;
    diffValue(k, keyLabel(k), before[k], after[k], out);
  }
  return out;
}

function diffItems(kind: ItemKind, beforeList: readonly Obj[], afterList: readonly Obj[], compareAdmin: boolean): ItemDiff[] {
  const idOf = (x: Obj) => String(x.id);
  const bIds = beforeList.map(idOf);
  const aIds = afterList.map(idOf);
  // First occurrence wins if a malformed document repeats an id.
  const bIndex = new Map<string, number>();
  bIds.forEach((id, i) => bIndex.has(id) || bIndex.set(id, i));
  const aIndex = new Map<string, number>();
  aIds.forEach((id, i) => aIndex.has(id) || aIndex.set(id, i));
  const moved = movedIds([...bIndex.keys()], [...aIndex.keys()]);

  const kept = (id: string) => aIndex.has(id);

  // Removed items are anchored after the nearest preceding before-item that is kept and not moved.
  const leading: ItemDiff[] = [];
  const anchored = new Map<string, ItemDiff[]>();
  let anchor: string | null = null;
  for (const [id, i] of bIndex) {
    if (kept(id)) {
      if (!moved.has(id)) anchor = id;
      continue;
    }
    const d: ItemDiff = { id, status: 'removed', beforeIndex: i, afterIndex: null, moved: false, changes: [] };
    if (anchor === null) leading.push(d);
    else {
      const list = anchored.get(anchor) ?? [];
      list.push(d);
      anchored.set(anchor, list);
    }
  }

  const out: ItemDiff[] = [...leading];
  for (const [id, j] of aIndex) {
    const i = bIndex.get(id);
    if (i === undefined) {
      out.push({ id, status: 'added', beforeIndex: null, afterIndex: j, moved: false, changes: [] });
      continue;
    }
    const changes = diffItem(kind, beforeList[i]!, afterList[j]!, compareAdmin);
    out.push({
      id,
      status: changes.length ? 'changed' : 'unchanged',
      beforeIndex: i,
      afterIndex: j,
      moved: moved.has(id),
      changes,
    });
    out.push(...(anchored.get(id) ?? []));
  }
  return out;
}

// ---------------------------------------------------------------------------
// diffCases
// ---------------------------------------------------------------------------

/** A full admin case carries `status` and `review`; a PublicCase carries neither. */
const isAdminCase = (c: CaseLike) => 'status' in c || 'review' in c;

const asObjs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

const TOP_FIELDS: { path: string; label: string; get: (c: CaseLike) => unknown }[] = [
  { path: 'title', label: 'Title', get: (c) => c.title },
  { path: 'as_of', label: 'As-of date', get: (c) => c.as_of },
  { path: 'content_warning', label: 'Content warning', get: (c) => c.content_warning },
  { path: 'question.prompt', label: 'Question', get: (c) => c.question?.prompt },
  { path: 'question.scale.left_label', label: 'Slider left label', get: (c) => c.question?.scale?.left_label },
  { path: 'question.scale.right_label', label: 'Slider right label', get: (c) => c.question?.scale?.right_label },
  { path: 'open_questions', label: 'Open questions', get: (c) => c.open_questions ?? [] },
];

export function diffCases(before: CaseLike, after: CaseLike): CaseDiff {
  const compareAdmin = isAdminCase(before) && isAdminCase(after);

  const fields: FieldChange[] = [];
  for (const f of TOP_FIELDS) {
    const b = f.get(before);
    const a = f.get(after);
    if (!deepEqual(b, a)) fields.push(change(f.path, f.label, b, a));
  }

  const startingFacts = diffItems('startingFacts', asObjs(before.starting_facts), asObjs(after.starting_facts), compareAdmin);
  const steps = diffItems('steps', asObjs(before.steps), asObjs(after.steps), compareAdmin);
  const sides = diffItems('sides', asObjs(before.sides), asObjs(after.sides), compareAdmin);
  const timeline = diffItems('timeline', asObjs(before.timeline), asObjs(after.timeline), compareAdmin);
  const takes = diffItems('takes', asObjs(before.takes), asObjs(after.takes), compareAdmin);
  const sources = diffItems('sources', asObjs(before.sources), asObjs(after.sources), compareAdmin);

  const summary = { added: 0, removed: 0, changed: 0, moved: 0 };
  for (const d of [...startingFacts, ...steps, ...sides, ...timeline, ...takes, ...sources]) {
    if (d.status === 'added') summary.added++;
    else if (d.status === 'removed') summary.removed++;
    else if (d.status === 'changed') summary.changed++;
    if (d.moved) summary.moved++;
  }

  const hasChanges = fields.length > 0 || summary.added + summary.removed + summary.changed + summary.moved > 0;
  return { fields, startingFacts, steps, sides, timeline, takes, sources, summary, hasChanges };
}

// ---------------------------------------------------------------------------
// summarizeDiff
// ---------------------------------------------------------------------------

const NOUNS: Record<ItemKind, [string, string]> = {
  startingFacts: ['starting fact', 'starting facts'],
  steps: ['step', 'steps'],
  sides: ['side', 'sides'],
  timeline: ['timeline event', 'timeline events'],
  takes: ['online take', 'online takes'],
  sources: ['source', 'sources'],
};

/** Short field names for the summary, keyed by the first segment of a change path. */
const SHORT_NAMES: Record<string, string> = {
  source_ids: 'sources',
  micro_poll: 'fact vote',
  accessed_at: 'accessed date',
  quote_excerpt: 'quote excerpt',
  url: 'URL',
};

const shortName = (path: string) => {
  const head = path.split('.')[0] ?? path;
  return SHORT_NAMES[head] ?? head.replace(/_/g, ' ');
};

/** "a", "a and b", "a, b and c". */
function andList(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** How many items a clause names before it says "and N more". */
const MAX_NAMED = 6;

function named(parts: readonly string[], sep = ', '): string {
  if (parts.length <= MAX_NAMED) return parts.join(sep);
  return `${parts.slice(0, MAX_NAMED).join(sep)}${sep}and ${parts.length - MAX_NAMED} more`;
}

const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

function fieldPhrase(f: FieldChange): string {
  switch (f.path) {
    case 'as_of':
      return typeof f.before === 'string' && typeof f.after === 'string'
        ? `as-of date changed from ${f.before} to ${f.after}`
        : 'as-of date changed';
    case 'content_warning':
      if (f.before === undefined) return 'content warning added';
      if (f.after === undefined) return 'content warning removed';
      return 'content warning changed';
    case 'question.prompt':
      return 'question changed';
    case 'open_questions': {
      const b = Array.isArray(f.before) ? (f.before as unknown[]).map(String) : [];
      const a = Array.isArray(f.after) ? (f.after as unknown[]).map(String) : [];
      const remaining = [...b];
      let added = 0;
      for (const q of a) {
        const k = remaining.indexOf(q);
        if (k >= 0) remaining.splice(k, 1);
        else added++;
      }
      const removed = remaining.length;
      const parts: string[] = [];
      if (added) parts.push(`${added} added`);
      if (removed) parts.push(`${removed} removed`);
      return `open questions changed (${parts.length ? parts.join(', ') : 'reordered'})`;
    }
    default:
      return `${f.label.charAt(0).toLowerCase()}${f.label.slice(1)} changed`;
  }
}

function itemClauses(kind: ItemKind, items: readonly ItemDiff[], after: CaseLike): string[] {
  const noun = NOUNS[kind];
  const clauses: string[] = [];

  const changed = items.filter((d) => d.status === 'changed');
  if (changed.length) {
    const perItem = changed.map((d) => [d.id, [...new Set(d.changes.map((c) => shortName(c.path)))]] as const);
    const sep = perItem.some(([, names]) => names.length > 2) ? '; ' : ', ';
    const details = perItem.map(([id, names]) => `${id} ${andList(names)}`);
    clauses.push(`${count(changed.length, noun)} changed (${named(details, sep)})`);
  }

  const added = items.filter((d) => d.status === 'added');
  if (added.length) clauses.push(`${count(added.length, noun)} added (${named(added.map((d) => d.id))})`);

  const removed = items.filter((d) => d.status === 'removed');
  if (removed.length) clauses.push(`${count(removed.length, noun)} removed (${named(removed.map((d) => d.id))})`);

  const moved = items.filter((d) => d.moved);
  if (moved.length) {
    const position = (d: ItemDiff) => {
      if (kind === 'steps' && d.afterIndex !== null) {
        const order = after.steps[d.afterIndex]?.order;
        if (typeof order === 'number') return `${d.id} now step ${order}`;
      }
      return `${d.id} now ${noun[0]} ${(d.afterIndex ?? 0) + 1}`;
    };
    clauses.push(`${count(moved.length, noun)} moved (${named(moved.map(position))})`);
  }
  return clauses;
}

/**
 * Plain one-paragraph summary of a diff, for the review header and the
 * decision log, e.g. "As-of date changed from 2026-09-30 to 2026-10-08. 2 steps
 * changed (s3 headline, s5 confidence), 1 step added (s9), 1 source added (src-new)."
 */
export function summarizeDiff(d: CaseDiff, after: CaseLike): string {
  if (!d.hasChanges) return 'No changes.';
  const sentences: string[] = [];
  const fieldPhrases = d.fields.map(fieldPhrase);
  if (fieldPhrases.length) sentences.push(fieldPhrases.join(', '));
  const clauses = [
    ...itemClauses('startingFacts', d.startingFacts, after),
    ...itemClauses('steps', d.steps, after),
    ...itemClauses('sides', d.sides, after),
    ...itemClauses('timeline', d.timeline, after),
    ...itemClauses('takes', d.takes, after),
    ...itemClauses('sources', d.sources, after),
  ];
  if (clauses.length) sentences.push(clauses.join(', '));
  return sentences.map((s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`).join(' ');
}
