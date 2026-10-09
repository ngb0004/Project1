'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ResearchLogGroup, ResearchLogRow } from '@sia/case-store';
import { loadResearchLog } from '@/app/(console)/review/actions';
import { formatDateTime, plural, safeHref } from '@/lib/format';

const label = (s: string) => s.replace(/_/g, ' ');

/** A link to a page the pipeline reported; non-http(s) URLs are shown as text, never linked. */
function ExternalLink({ url, text }: { url: string | null; text: string }) {
  const href = safeHref(url);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {text}
    </a>
  ) : (
    <span>{text}</span>
  );
}

function renderClaims(claims: unknown): React.ReactNode {
  if (claims === null || claims === undefined) return null;
  const list = Array.isArray(claims) ? claims : [claims];
  return (
    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
      {list.map((c, i) => {
        if (typeof c === 'string') return <li key={i}>{c}</li>;
        if (c && typeof c === 'object') {
          const o = c as Record<string, unknown>;
          const text = o.claim ?? o.text ?? o.statement;
          const quote = o.quote ?? o.excerpt;
          return (
            <li key={i}>
              {typeof text === 'string' ? text : <code>{JSON.stringify(c)}</code>}
              {typeof quote === 'string' ? <div className="quote">&ldquo;{quote}&rdquo;</div> : null}
            </li>
          );
        }
        return <li key={i}>{String(c)}</li>;
      })}
    </ul>
  );
}

function countsText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([k, n]) => (k === 'open' ? `${n} opened` : plural(n, k === 'query' ? 'query' : k, k === 'query' ? 'queries' : `${k}s`)))
    .join(' · ');
}

type Load = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

function Group({
  group,
  caseId,
  version,
  jobId,
  snapIdByUrl,
}: {
  group: ResearchLogGroup;
  caseId: string;
  version: number;
  jobId: string;
  snapIdByUrl: Record<string, string>;
}) {
  const [rows, setRows] = useState<ResearchLogRow[]>([]);
  const [more, setMore] = useState(false);
  const [load, setLoad] = useState<Load>({ status: 'idle' });

  const fetchPage = async (offset: number) => {
    setLoad({ status: 'loading' });
    try {
      const r = await loadResearchLog({ caseId, version, jobId, agent: group.agent, scope: group.scope, round: group.round, offset });
      if (!r.ok) return setLoad({ status: 'error', message: r.error });
      setRows((prev) => (offset === 0 ? r.rows : [...prev, ...r.rows]));
      setMore(r.more);
      setLoad({ status: 'ready' });
    } catch (e) {
      setLoad({ status: 'error', message: `Could not load the log (${(e as Error).message || 'network error'}).` });
    }
  };

  return (
    <details
      className="card"
      data-testid="research-log-group"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && load.status === 'idle') void fetchPage(0);
      }}
    >
      <summary>
        <span className="card-title">
          {label(group.agent)}
          {group.scope ? ` · ${group.scope}` : ''} · round {group.round}
        </span>
        <span className="small muted">{countsText(group.counts)}</span>
      </summary>
      <div className="card-body">
        {load.status === 'error' ? (
          <p className="notice notice-error small" role="alert">
            {load.message}{' '}
            <button type="button" className="btn btn-small" onClick={() => void fetchPage(rows.length)}>
              Retry
            </button>
          </p>
        ) : null}
        <ul className="flag-list">
          {rows.map((r) => {
            const snapId = r.snapshot_id ?? (r.url ? snapIdByUrl[r.url] : undefined);
            return (
              <li key={r.id}>
                <span className="badge">{r.kind}</span> <span className="faint small">{formatDateTime(r.created_at)}</span>
                {r.kind === 'query' ? <div>Searched: “{r.query}”</div> : null}
                {r.kind === 'open' ? (
                  <div>
                    Opened <ExternalLink url={r.url} text={r.title ?? r.url ?? 'a page'} />
                    {r.http_status ? <span className="faint small"> · HTTP {r.http_status}</span> : null}
                    {snapId ? (
                      <>
                        {' '}
                        · <Link href={`/snapshots/${snapId}`} target="_blank">read snapshot</Link>
                      </>
                    ) : null}
                  </div>
                ) : null}
                {r.kind === 'claim' ? (
                  <div>
                    Claims{r.url ? <> from <ExternalLink url={r.url} text={r.title ?? r.url} /></> : null}:{renderClaims(r.claims)}
                  </div>
                ) : null}
                {r.excerpt ? <div className="quote small">{r.excerpt}</div> : null}
                {r.kind === 'note' && r.claims ? renderClaims(r.claims) : null}
              </li>
            );
          })}
        </ul>
        {load.status === 'loading' ? <p className="small muted" role="status">Loading…</p> : null}
        {more && load.status === 'ready' ? (
          <button type="button" className="btn btn-small" onClick={() => void fetchPage(rows.length)}>
            Show more ({rows.length} of {group.total})
          </button>
        ) : null}
      </div>
    </details>
  );
}

/** The research log, one group per agent, scope and round; each group's rows load when it is opened. */
export function ResearchLogGroups({
  groups,
  caseId,
  version,
  jobId,
  snapIdByUrl,
}: {
  groups: ResearchLogGroup[];
  caseId: string;
  version: number;
  jobId: string;
  snapIdByUrl: Record<string, string>;
}) {
  if (groups.length === 0) return <p className="empty">The run logged nothing.</p>;
  return (
    <>
      {groups.map((g) => (
        <Group key={`${g.agent}|${g.scope ?? ''}|${g.round}`} group={g} caseId={caseId} version={version} jobId={jobId} snapIdByUrl={snapIdByUrl} />
      ))}
    </>
  );
}
