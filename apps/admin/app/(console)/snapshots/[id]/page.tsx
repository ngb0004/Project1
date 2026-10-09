import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSourceSnapshot } from '@sia/case-store';
import { requireAdmin } from '@/lib/auth';
import { formatDateTime, isUuid, safeHref } from '@/lib/format';

export const metadata: Metadata = { title: 'Source snapshot' };

/** The text of a page an agent opened, as it was fetched, so the admin can check a claim against it. */
export default async function SnapshotPage({ params }: { params: Promise<{ id: string }> }) {
  const { db } = await requireAdmin();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const snap = await getSourceSnapshot(db, id);
  if (!snap) notFound();
  return (
    <main className="page page-narrow">
      <p className="kicker">Source snapshot · fetched {formatDateTime(snap.fetched_at)}</p>
      <h1>{snap.title ?? snap.url}</h1>
      <ul className="meta-list">
        <li>
          URL{' '}
          {safeHref(snap.url) ? (
            <a href={safeHref(snap.url)!} target="_blank" rel="noreferrer noopener">
              {snap.url}
            </a>
          ) : (
            <span className="mono">{snap.url}</span>
          )}
        </li>
        {snap.final_url && snap.final_url !== snap.url ? (
          <li>
            Redirected to <span className="mono">{snap.final_url}</span>
          </li>
        ) : null}
        <li>HTTP {snap.http_status ?? '—'}</li>
        <li>{snap.content_type ?? 'unknown type'}</li>
        <li>
          <span className="mono small">sha256 {snap.sha256.slice(0, 16)}…</span>
        </li>
        <li>
          Pipeline job <span className="mono">{snap.job_id.slice(0, 8)}</span>
        </li>
      </ul>
      <p className="small muted" style={{ marginTop: 16 }}>
        This is the text the pipeline saw when it opened the page. The live page may have changed since. <Link href="/">Back to the queue</Link>
      </p>
      <div className="snapshot-text" data-testid="snapshot-text">
        {snap.text_content || <span className="empty">The snapshot has no text.</span>}
      </div>
    </main>
  );
}
