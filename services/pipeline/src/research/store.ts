import { createHash } from 'node:crypto';
import { fetchSource, type FetchOptions, type FetchedSource } from './fetch';
import type { ResearchLog, SnapshotRecord } from './log';
import { urlKey } from './text';

/**
 * The pages one pipeline run has opened. A source counts as opened only if it
 * was fetched in this run, answered HTTP 200 and yielded non-trivial text; the
 * text is snapshotted (sha256) so later agents and the fact-check read exactly
 * what the researchers read. Every open, successful or not, is logged.
 */

export interface Snapshot {
  id: string;
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  sha256: string;
  text: string;
  fetchedAt: string;
  /**
   * Set for a snapshot an earlier job took of a source the base version cites
   * (see `archive`): evidence for facts a revision or update leaves unchanged,
   * not a page opened in this run.
   */
  archivedFrom?: { jobId: string };
}

export interface OpenResult {
  ok: boolean;
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  snapshot?: Snapshot;
  error?: string;
}

/** Pages with less readable text than this are not counted as opened. */
export const MIN_TEXT_CHARS = 100;

export type Fetcher = (url: string, options?: FetchOptions) => Promise<FetchedSource>;

export interface SourceStoreOptions {
  log: ResearchLog;
  fetch?: FetchOptions;
  /** Replaces the network fetch (tests). */
  fetcher?: Fetcher;
}

export class SourceStore {
  private readonly byId = new Map<string, Snapshot>();
  private readonly order: Snapshot[] = [];
  /** URL key -> snapshots fetched from it (requested or final URL). Identical text from two URLs shares one snapshot. */
  private readonly byUrl = new Map<string, Snapshot[]>();

  constructor(private readonly opts: SourceStoreOptions) {}

  get log(): ResearchLog {
    return this.opts.log;
  }

  /** Fetches `url`, snapshots its text and logs the open for `agent`. */
  async open(url: string, agent: string, scope?: string | null, round = 0): Promise<OpenResult> {
    const fetcher = this.opts.fetcher ?? fetchSource;
    const page = await fetcher(url, this.opts.fetch);
    const fetchedAt = new Date().toISOString();
    const text = page.text ?? '';
    let error = page.error;
    if (!error && page.status !== 200) error = `HTTP ${page.status}`;
    if (!error && text.length < MIN_TEXT_CHARS) error = `only ${text.length} characters of readable text`;
    const usable = page.status === 200 && text.length >= MIN_TEXT_CHARS;

    let snapshot: Snapshot | undefined;
    if (usable) {
      const sha256 = createHash('sha256').update(text).digest('hex');
      const id = await this.log.saveSnapshot({
        url,
        final_url: page.finalUrl,
        http_status: page.status,
        content_type: page.contentType,
        title: page.title,
        sha256,
        text_content: text,
        fetched_at: fetchedAt,
      });
      snapshot = this.byId.get(id) ?? {
        id,
        url,
        finalUrl: page.finalUrl,
        status: page.status,
        contentType: page.contentType,
        title: page.title,
        sha256,
        text,
        fetchedAt,
      };
      this.remember(snapshot, [url, page.finalUrl]);
    }

    const redirected = page.finalUrl && urlKey(page.finalUrl) !== urlKey(url) ? `Redirected to ${page.finalUrl}. ` : '';
    await this.log.append({
      agent,
      scope: scope ?? null,
      round,
      kind: 'open',
      url,
      title: page.title || null,
      snapshot_id: snapshot?.id ?? null,
      http_status: page.status || null,
      excerpt: usable ? `${redirected}${text.slice(0, 300)}` : `${redirected}Not usable: ${error}`,
    });

    return {
      ok: usable,
      url,
      finalUrl: page.finalUrl,
      status: page.status,
      title: page.title,
      ...(snapshot ? { snapshot } : {}),
      ...(usable ? {} : { error: error ?? 'not usable' }),
    };
  }

  private remember(snapshot: Snapshot, urls: string[], listed = true): void {
    if (!this.byId.has(snapshot.id)) {
      this.byId.set(snapshot.id, snapshot);
      if (listed) this.order.push(snapshot);
    }
    for (const key of new Set(urls.filter(Boolean).map(urlKey))) {
      const list = this.byUrl.get(key) ?? [];
      if (!list.includes(snapshot)) list.push(snapshot);
      this.byUrl.set(key, list);
    }
  }

  get(snapshotId: string): Snapshot | undefined {
    return this.byId.get(snapshotId);
  }

  /** Every snapshot of this URL (matched on the requested or final URL), archived ones first, then oldest first. */
  findAllByUrl(url: string): Snapshot[] {
    return [...(this.byUrl.get(urlKey(url)) ?? [])];
  }

  /** The latest snapshot of this URL: the one opened in this run, else an archived one. */
  findByUrl(url: string): Snapshot | undefined {
    const all = this.findAllByUrl(url);
    return all[all.length - 1];
  }

  /** Snapshots taken in this run (not the archive). */
  opened(): Snapshot[] {
    return [...this.order];
  }

  /** The archived snapshots loaded with `archive`. */
  archived(): Snapshot[] {
    return [...this.byId.values()].filter((s) => s.archivedFrom);
  }

  /**
   * Adds snapshots that earlier jobs took of the sources a base version cites.
   * They back the evidence of facts a revision or update leaves unchanged when
   * a page has changed since (a paywall, a removed article): the citation check
   * and the critics can still read what was cited. They are not "opened in this
   * run": `opened()` leaves them out, and claims cannot cite them.
   */
  archive(records: Array<SnapshotRecord & { job_id: string }>): number {
    let n = 0;
    for (const r of records) {
      if (this.byId.has(r.id)) continue;
      if (r.http_status !== 200 || r.text_content.length < MIN_TEXT_CHARS) continue;
      const snap: Snapshot = {
        id: r.id,
        url: r.url,
        finalUrl: r.final_url || r.url,
        status: r.http_status,
        contentType: r.content_type,
        title: r.title,
        sha256: r.sha256,
        text: r.text_content,
        fetchedAt: r.fetched_at,
        archivedFrom: { jobId: r.job_id },
      };
      this.remember(snap, [snap.url, snap.finalUrl], false);
      n++;
    }
    return n;
  }

  /** Adds snapshots saved earlier (e.g. a package directory), as `pipeline check` does. */
  load(records: SnapshotRecord[]): void {
    for (const r of records) {
      if (this.byId.has(r.id)) continue;
      if (r.http_status !== 200 || r.text_content.length < MIN_TEXT_CHARS) continue;
      const snap: Snapshot = {
        id: r.id,
        url: r.url,
        finalUrl: r.final_url || r.url,
        status: r.http_status,
        contentType: r.content_type,
        title: r.title,
        sha256: r.sha256,
        text: r.text_content,
        fetchedAt: r.fetched_at,
      };
      this.remember(snap, [snap.url, snap.finalUrl]);
    }
  }
}
