import type { Metadata } from 'next';
import Link from 'next/link';
import {
  listPipelineJobs,
  listQueue,
  listReviewAlerts,
  listStaffCases,
  listVersionSummaries,
  type StaffCaseRow,
  type VersionSummaryRow,
} from '@sia/case-store';
import { ActionForm } from '@/components/ActionForm';
import { AlertDetails, ResolveAlertForm } from '@/components/Alerts';
import { LocalTime } from '@/components/LocalTime';
import { LiveBadge, StatusBadge } from '@/components/StatusBadge';
import { requireAdmin } from '@/lib/auth';
import { cadenceLabel, formatDate, formatDateTime, plural } from '@/lib/format';
import { cancelJobAction, createCaseAction } from './actions';

export const metadata: Metadata = { title: 'Queue' };

function caseTitle(caseId: string, summaries: VersionSummaryRow[], fallback: string): string {
  const mine = summaries.filter((s) => s.case_id === caseId);
  return (mine.find((s) => s.is_live) ?? mine[0])?.title ?? fallback;
}

export default async function QueuePage() {
  const { db } = await requireAdmin();
  const [queue, alerts, jobs, cases] = await Promise.all([
    listQueue(db),
    listReviewAlerts(db, { openOnly: true, limit: 100 }),
    listPipelineJobs(db, { statuses: ['queued', 'running', 'failed'], limit: 50 }),
    listStaffCases(db),
  ]);
  const summaries = await listVersionSummaries(db, cases.map((c) => c.id));
  const caseById = new Map<string, StaffCaseRow>(cases.map((c) => [c.id, c]));
  const live = cases.filter((c) => c.live_version !== null);
  // A package whose admin edit went live on schedule stays in review until it is archived; say so.
  const supersededBy = (caseId: string, version: number) =>
    summaries.find((v) => v.case_id === caseId && v.based_on_version === version && v.origin === 'admin' && v.tags.includes('admin_edit') && v.published_at !== null)
      ?.version ?? null;
  const notLive = cases.filter((c) => c.live_version === null);

  return (
    <main className="page">
      <section className="section" aria-labelledby="queue-h">
        <header>
          <h2 id="queue-h">Waiting for a decision</h2>
          <span className="muted small">{plural(queue.length, 'version')}</span>
        </header>
        {queue.length === 0 ? (
          <p className="empty">Nothing is waiting for review.</p>
        ) : (
          <div className="table-wrap">
            <table data-testid="queue-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>As of</th>
                  <th>Origin · tags</th>
                  <th className="num">Steps</th>
                  <th className="num">Open issues</th>
                  <th>Submitted</th>
                  <th>Scheduled</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((q) => (
                  <tr key={`${q.case_id}:${q.version}`}>
                    <td>
                      <Link href={`/review/${q.case_id}/${q.version}`} data-testid="queue-link">
                        {q.title}
                      </Link>
                      <div className="small faint">{q.slug}</div>
                    </td>
                    <td className="nowrap">
                      v{q.version}
                      {q.parent_version ? <div className="small faint">updates v{q.parent_version}</div> : null}
                      {q.based_on_version ? <div className="small faint">from v{q.based_on_version}</div> : null}
                    </td>
                    <td>
                      <StatusBadge status={q.status} scheduled={q.scheduled_publish_at} />
                      {supersededBy(q.case_id, q.version) ? (
                        <div className="small" data-testid="queue-superseded">
                          <span className="badge badge-warn">superseded by v{supersededBy(q.case_id, q.version)}</span>
                        </div>
                      ) : null}
                    </td>
                    <td className="nowrap">{formatDate(q.as_of)}</td>
                    <td>
                      <span className="small">{q.origin}</span>
                      {q.tags.length ? (
                        <div className="chips" style={{ marginTop: 4 }}>
                          {q.tags.map((t) => (
                            <span key={t} className="badge">
                              {t}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td className="num">{q.step_count}</td>
                    <td className="num">
                      {q.open_issue_count > 0 ? <span className="badge badge-warn">{q.open_issue_count}</span> : '0'}
                    </td>
                    <td className="nowrap small">{formatDateTime(q.submitted_at ?? q.created_at)}</td>
                    <td className="small">{q.scheduled_publish_at ? <LocalTime iso={q.scheduled_publish_at} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="alerts-h">
        <header>
          <h2 id="alerts-h">Open review alerts</h2>
          <span className="muted small">Raised by reader fairness ratings and fact flags</span>
        </header>
        {alerts.length === 0 ? (
          <p className="empty">No open alerts.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Kind</th>
                  <th>Details</th>
                  <th>Raised</th>
                  <th style={{ width: '34%' }}>Resolve</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => {
                  const c = caseById.get(a.case_id);
                  return (
                    <tr key={a.id}>
                      <td>
                        <Link href={`/cases/${a.case_id}`}>{caseTitle(a.case_id, summaries, c?.slug ?? a.case_id)}</Link>
                        <div className="small faint">
                          <Link href={`/review/${a.case_id}/${a.case_version}`}>v{a.case_version}</Link>
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${a.kind === 'fairness' ? 'badge-warn' : 'badge-info'}`}>{a.kind}</span>
                      </td>
                      <td>
                        <AlertDetails alert={a} />
                        {a.pipeline_job_id ? <div className="small faint">Revision job {a.pipeline_job_id.slice(0, 8)}</div> : null}
                      </td>
                      <td className="small nowrap">{formatDateTime(a.created_at)}</td>
                      <td>
                        <ResolveAlertForm alertId={a.id} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section" id="jobs" aria-labelledby="jobs-h">
        <header>
          <h2 id="jobs-h">Pipeline jobs</h2>
          <span className="muted small">Queued, running and failed</span>
        </header>
        {jobs.length === 0 ? (
          <p className="empty">No pipeline jobs are queued, running or failed.</p>
        ) : (
          <div className="table-wrap">
            <table data-testid="jobs-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Kind</th>
                  <th>Brief or instructions</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Last heartbeat</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="mono small">{j.id.slice(0, 8)}</td>
                    <td>
                      {j.kind}
                      {j.case_id ? (
                        <div className="small">
                          <Link href={`/cases/${j.case_id}`}>{caseById.get(j.case_id)?.slug ?? 'case'}</Link>
                          {j.base_version ? ` · v${j.base_version}` : ''}
                        </div>
                      ) : null}
                    </td>
                    <td className="small" style={{ maxWidth: 380 }}>
                      {j.brief ?? j.instructions ?? '—'}
                      {j.error ? <div className="notice notice-error small" style={{ marginTop: 6 }}>{j.error}</div> : null}
                    </td>
                    <td>
                      <span className={`badge ${j.status === 'failed' ? 'badge-error' : j.status === 'running' ? 'badge-info' : ''}`}>{j.status}</span>
                      {j.attempts > 1 ? <div className="small faint">{j.attempts} attempts</div> : null}
                    </td>
                    <td className="small nowrap">{formatDateTime(j.created_at)}</td>
                    <td className="small nowrap">{formatDateTime(j.heartbeat_at)}</td>
                    <td>
                      {j.status === 'queued' ? (
                        <ActionForm action={cancelJobAction} submitLabel="Cancel" danger confirm="Cancel this queued job?">
                          <input type="hidden" name="jobId" value={j.id} />
                        </ActionForm>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="panel" style={{ marginTop: 16 }}>
          <h3>New case from a one-line brief</h3>
          <p className="muted small">The pipeline scopes, researches, drafts and checks the case, then submits a package to this queue. Nothing publishes without your approval.</p>
          <ActionForm action={createCaseAction} submitLabel="Start research" pendingLabel="Queuing…" testId="new-case-form">
            <label className="field">
              <span className="field-label">Brief</span>
              <input type="text" name="brief" maxLength={2000} required placeholder="e.g. Harbor bridge closure: who is responsible?" />
            </label>
          </ActionForm>
        </div>
      </section>

      <section className="section" id="cases" aria-labelledby="cases-h">
        <header>
          <h2 id="cases-h">Live cases</h2>
          <span className="muted small">{plural(live.length, 'case')}</span>
        </header>
        {live.length === 0 ? (
          <p className="empty">No case is live yet.</p>
        ) : (
          <div className="table-wrap">
            <table data-testid="live-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Live version</th>
                  <th>Re-research</th>
                  <th className="num">In review</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {live.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/cases/${c.id}`}>{caseTitle(c.id, summaries, c.slug)}</Link>
                      <div className="small faint">{c.slug}</div>
                    </td>
                    <td>
                      <LiveBadge /> <Link href={`/review/${c.id}/${c.live_version}`}>v{c.live_version}</Link>
                    </td>
                    <td className="small">
                      {cadenceLabel(c.update_cadence)}
                      {c.next_update_at ? <div className="faint">next {formatDateTime(c.next_update_at)}</div> : null}
                    </td>
                    <td className="num">{c.in_review_count}</td>
                    <td>
                      <Link href={`/cases/${c.id}`}>Overview</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {notLive.length ? (
          <details style={{ marginTop: 16 }}>
            <summary className="muted">Cases not live yet ({notLive.length})</summary>
            <ul>
              {notLive.map((c) => (
                <li key={c.id}>
                  <Link href={`/cases/${c.id}`}>{caseTitle(c.id, summaries, c.slug)}</Link> <span className="small faint">{c.slug}</span>
                  {c.in_review_count ? <span className="small muted"> · {c.in_review_count} in review</span> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
    </main>
  );
}
