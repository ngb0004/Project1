import { randomUUID } from 'node:crypto';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '@sia/case-store';

/**
 * Where a run's research log and page snapshots go. Every agent's queries,
 * opened pages and extracted claims are written with the agent, scope and
 * round, so the admin can audit how any fact got in.
 *
 * - DbResearchLog: `research_log` and `source_snapshots` rows for a pipeline
 *   job, written as the signed-in pipeline account (row-level security allows
 *   inserts only).
 * - FileResearchLog: `research-log.jsonl` plus one JSON file per snapshot, for
 *   offline runs.
 * - MemoryResearchLog: kept in memory, for tests.
 */

export type LogKind = 'query' | 'open' | 'claim' | 'note';

export interface LogEntry {
  agent: string;
  scope?: string | null;
  round: number;
  kind: LogKind;
  query?: string | null;
  url?: string | null;
  title?: string | null;
  snapshot_id?: string | null;
  http_status?: number | null;
  /** At most 4,000 characters (the column limit); longer text is cut. */
  excerpt?: string | null;
  claims?: unknown;
}

export interface LoggedEntry extends LogEntry {
  at: string;
}

export interface SnapshotInput {
  url: string;
  final_url: string;
  http_status: number;
  content_type: string;
  title: string;
  sha256: string;
  text_content: string;
  fetched_at: string;
}

export interface SnapshotRecord extends SnapshotInput {
  id: string;
}

export interface LogGroup {
  agent: string;
  scope: string | null;
  round: number;
  counts: Partial<Record<LogKind, number>>;
  total: number;
}

export interface LogSummary {
  total: number;
  groups: LogGroup[];
}

export interface ResearchLog {
  /** Stores a page snapshot and returns its id. Saving the same text twice returns the same id. */
  saveSnapshot(s: SnapshotInput): Promise<string>;
  append(entry: LogEntry): Promise<void>;
  /** Counts per agent, scope, round and kind, in the order they were first logged. */
  summary(): LogSummary;
}

export const EXCERPT_MAX = 4000;

function clip(s: string | null | undefined, max = EXCERPT_MAX): string | null {
  if (s === null || s === undefined) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Postgres text and jsonb cannot hold NUL characters. */
const noNul = <T>(v: T): T => (typeof v === 'string' ? (v.replace(/\u0000/g, '') as T) : v);

/** Shared bookkeeping: the summary counts and the per-run snapshot dedupe. */
abstract class BaseLog implements ResearchLog {
  private groups = new Map<string, LogGroup>();
  private total = 0;
  private bySha = new Map<string, Promise<string>>();

  protected abstract writeSnapshot(s: SnapshotInput): Promise<string>;
  protected abstract writeEntry(e: LoggedEntry): Promise<void>;

  saveSnapshot(s: SnapshotInput): Promise<string> {
    let id = this.bySha.get(s.sha256);
    if (!id) {
      id = this.writeSnapshot(s);
      this.bySha.set(s.sha256, id);
      id.catch(() => this.bySha.delete(s.sha256));
    }
    return id;
  }

  async append(entry: LogEntry): Promise<void> {
    const e: LoggedEntry = { ...entry, scope: entry.scope ?? null, excerpt: clip(entry.excerpt), at: new Date().toISOString() };
    await this.writeEntry(e);
    const key = `${e.agent}\u0000${e.scope ?? ''}\u0000${e.round}`;
    let g = this.groups.get(key);
    if (!g) {
      g = { agent: e.agent, scope: e.scope ?? null, round: e.round, counts: {}, total: 0 };
      this.groups.set(key, g);
    }
    g.counts[e.kind] = (g.counts[e.kind] ?? 0) + 1;
    g.total++;
    this.total++;
  }

  summary(): LogSummary {
    return { total: this.total, groups: [...this.groups.values()].map((g) => ({ ...g, counts: { ...g.counts } })) };
  }
}

export class MemoryResearchLog extends BaseLog {
  readonly entries: LoggedEntry[] = [];
  readonly snapshots: SnapshotRecord[] = [];

  protected async writeSnapshot(s: SnapshotInput): Promise<string> {
    const id = randomUUID();
    this.snapshots.push({ ...s, id });
    return id;
  }

  protected async writeEntry(e: LoggedEntry): Promise<void> {
    this.entries.push(e);
  }
}

/** `research-log.jsonl` and `snapshots/<id>.json` under `dir`. */
export class FileResearchLog extends BaseLog {
  private ready: Promise<void>;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly dir: string) {
    super();
    this.ready = mkdir(join(dir, 'snapshots'), { recursive: true }).then(() => {});
  }

  get logPath(): string {
    return join(this.dir, 'research-log.jsonl');
  }

  get snapshotDir(): string {
    return join(this.dir, 'snapshots');
  }

  protected async writeSnapshot(s: SnapshotInput): Promise<string> {
    await this.ready;
    const id = randomUUID();
    const record: SnapshotRecord = { id, ...s };
    await writeFile(join(this.snapshotDir, `${id}.json`), JSON.stringify(record, null, 2));
    return id;
  }

  protected writeEntry(e: LoggedEntry): Promise<void> {
    // Serialize appends so lines never interleave.
    const next = this.queue.then(async () => {
      await this.ready;
      await appendFile(this.logPath, `${JSON.stringify(e)}\n`);
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

/**
 * Rows for one pipeline job, written as the pipeline account. The snapshot id is
 * the database's id, so log rows and the admin's snapshot viewer agree.
 */
export class DbResearchLog extends BaseLog {
  constructor(
    private readonly db: Db,
    readonly jobId: string,
    readonly caseId: string | null = null,
  ) {
    super();
  }

  protected async writeSnapshot(s: SnapshotInput): Promise<string> {
    const ins = await this.db
      .from('source_snapshots')
      .insert({ job_id: this.jobId, ...s, title: noNul(s.title), text_content: noNul(s.text_content) })
      .select('id')
      .single();
    if (!ins.error) return (ins.data as { id: string }).id;
    if (ins.error.code === '23505') {
      // The same text was saved for this job before (e.g. by an earlier attempt).
      const found = await this.db
        .from('source_snapshots')
        .select('id')
        .eq('job_id', this.jobId)
        .eq('sha256', s.sha256)
        .limit(1)
        .single();
      if (!found.error) return (found.data as { id: string }).id;
    }
    throw new Error(`could not save the snapshot of ${s.url}: ${ins.error.message}`);
  }

  protected async writeEntry(e: LoggedEntry): Promise<void> {
    const res = await this.db.from('research_log').insert({
      job_id: this.jobId,
      case_id: this.caseId,
      agent: e.agent,
      scope: e.scope,
      round: e.round,
      kind: e.kind,
      query: noNul(e.query ?? null),
      url: noNul(e.url ?? null),
      title: noNul(clip(e.title, 1000)),
      snapshot_id: e.snapshot_id ?? null,
      http_status: e.http_status ?? null,
      excerpt: noNul(e.excerpt ?? null),
      claims: e.claims === undefined || e.claims === null ? null : JSON.parse(JSON.stringify(e.claims).replace(/\\u0000/g, '')),
    });
    if (res.error) throw new Error(`could not write the research log: ${res.error.message}`);
  }
}
