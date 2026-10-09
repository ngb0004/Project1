'use client';

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Issue, Source } from '@sia/case-schema';
import { getAt, type Doc, type Path } from '@/lib/working-copy';

/**
 * The review editor's state lives in a small external store so each field
 * subscribes to its own value: typing in one field re-renders that field (and
 * the card around it), not the ~500 other inputs on a long package.
 *
 * Edits update the store synchronously inside the input's event, so a
 * controlled input never sees a stale value.
 */

export interface IssueSet {
  errors: Issue[];
  warnings: Issue[];
}

const NONE: IssueSet = Object.freeze({ errors: [], warnings: [] }) as IssueSet;
const EMPTY: never[] = [];

/** Validation issues indexed by path, with cached "at or below a path" lookups (stable per validation run). */
export class IssueIndex {
  private readonly exact = new Map<string, IssueSet>();
  private readonly underCache = new Map<string, IssueSet>();

  constructor(
    readonly errors: Issue[] = [],
    readonly warnings: Issue[] = [],
  ) {
    for (const e of errors) this.slot(e.path).errors.push(e);
    for (const w of warnings) this.slot(w.path).warnings.push(w);
  }

  private slot(p: string): IssueSet {
    let s = this.exact.get(p);
    if (!s) {
      s = { errors: [], warnings: [] };
      this.exact.set(p, s);
    }
    return s;
  }

  at(path: string): IssueSet {
    return this.exact.get(path) ?? NONE;
  }

  under(path: string): IssueSet {
    if (path === '') return this.errors.length || this.warnings.length ? { errors: this.errors, warnings: this.warnings } : NONE;
    const hit = this.underCache.get(path);
    if (hit) return hit;
    const inside = (i: Issue) => i.path === path || i.path.startsWith(`${path}.`);
    const errors = this.errors.filter(inside);
    const warnings = this.warnings.filter(inside);
    const out = errors.length || warnings.length ? { errors, warnings } : NONE;
    this.underCache.set(path, out);
    return out;
  }
}

interface State {
  doc: Doc;
  readOnly: boolean;
  issues: IssueIndex;
}

export class EditorStore {
  private state: State;
  private readonly listeners = new Set<() => void>();

  constructor(doc: Doc, readOnly: boolean) {
    this.state = { doc, readOnly, issues: new IssueIndex() };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getDoc = () => this.state.doc;
  getReadOnly = () => this.state.readOnly;
  getIssues = () => this.state.issues;

  private emit(next: State) {
    this.state = next;
    for (const l of [...this.listeners]) l();
  }

  setDoc(doc: Doc) {
    if (doc !== this.state.doc) this.emit({ ...this.state, doc });
  }

  updateDoc(fn: (d: Doc) => Doc) {
    this.setDoc(fn(this.state.doc));
  }

  setReadOnly(readOnly: boolean) {
    if (readOnly !== this.state.readOnly) this.emit({ ...this.state, readOnly });
  }

  setIssues(issues: IssueIndex) {
    if (issues !== this.state.issues) this.emit({ ...this.state, issues });
  }
}

export interface EditorApi {
  store: EditorStore;
  set(path: Path, value: unknown): void;
  setOptional(path: Path, value: string): void;
  update(fn: (doc: Doc) => Doc): void;
}

export const EditorContext = createContext<EditorApi | null>(null);

/** The editor's stable API (setters and the store). Never changes while the screen is open. */
export function useEditor(): EditorApi {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditor outside the review editor');
  return ctx;
}

/** A slice of the working copy. `select` must return a stable value (a part of the doc, or a primitive). */
export function useDoc<T>(select: (doc: Doc) => T): T {
  const { store } = useEditor();
  return useSyncExternalStore(store.subscribe, () => select(store.getDoc()), () => select(store.getDoc()));
}

export function useDocAt(path: Path): unknown {
  return useDoc((d) => getAt(d, path));
}

export function useReadOnly(): boolean {
  const { store } = useEditor();
  return useSyncExternalStore(store.subscribe, store.getReadOnly, store.getReadOnly);
}

/** Issues exactly at `path`. */
export function useIssuesAt(path: string): IssueSet {
  const { store } = useEditor();
  const get = () => store.getIssues().at(path);
  return useSyncExternalStore(store.subscribe, get, get);
}

/** Issues at `path` or anywhere below it (card headers, lists). */
export function useIssuesUnder(path: string): IssueSet {
  const { store } = useEditor();
  const get = () => store.getIssues().under(path);
  return useSyncExternalStore(store.subscribe, get, get);
}

/** The case's sources (stable while other parts of the document are edited). */
export function useSources(): Source[] {
  return useDoc((d) => d.sources ?? EMPTY);
}

export interface ReviewContextValue {
  caseId: string;
  version: number;
  /** The admin can change the working copy (and so triage review items). */
  canEdit: boolean;
  /** Readers' signals (this version's, or the live version's this one revises). */
  signalsVersion: number | null;
  /** A write (save, an action) is in flight: every other write waits. */
  busy: boolean;
}

export const ReviewContext = createContext<ReviewContextValue | null>(null);

export function useReview(): ReviewContextValue {
  const ctx = useContext(ReviewContext);
  if (!ctx) throw new Error('useReview outside the review screen');
  return ctx;
}
