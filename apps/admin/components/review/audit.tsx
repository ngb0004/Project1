import Link from 'next/link';
import type { Case } from '@sia/case-schema';
import type { PipelineJobRow, ResearchLogSummary, ReviewDecisionRow, SourceSnapshotMeta } from '@sia/case-store';
import { DECISION_LABEL, formatDateTime, plural, safeHref } from '@/lib/format';
import { fieldDomId } from '@/lib/working-copy';
import { ResearchLogGroups } from './ResearchLogGroups';

/**
 * Audit tab contents, rendered on the server from the saved version's review
 * record and the pipeline's research log.
 */

const label = (s: string) => s.replace(/_/g, ' ');
const SEVERITY: Record<string, string> = { high: 'badge-error', medium: 'badge-warn', low: '' };
const VERDICT: Record<string, string> = {
  supported: 'badge-ok',
  partially_supported: 'badge-warn',
  unsupported: 'badge-error',
  source_unavailable: 'badge-error',
  uncited: 'badge-error',
};

/**
 * A link to a step card by step id. The review screen resolves the id against
 * the working copy when it is clicked (so a reordered step is still found) and
 * scrolls the card into view below the top bar.
 */
function StepLink({ doc, id }: { doc: Case; id: string }) {
  const i = doc.steps.findIndex((s) => s.id === id);
  if (i < 0) return <span className="mono">{id}</span>;
  return (
    <a href={`#${fieldDomId(`steps.${i}`)}`} data-step-id={id} title={doc.steps[i]!.headline}>
      step {doc.steps[i]!.order}
    </a>
  );
}

function TargetLink({ doc, target }: { doc: Case; target: string }) {
  if (target.startsWith('fact:')) {
    const i = doc.starting_facts.findIndex((f) => f.id === target.slice(5));
    return i < 0 ? <span className="mono">{target}</span> : <a href={`#${fieldDomId(`starting_facts.${i}`)}`}>fact {i + 1}</a>;
  }
  if (target.startsWith('layer:')) {
    const [stepId, layerId] = target.slice(6).split('/');
    return (
      <span>
        <StepLink doc={doc} id={stepId ?? ''} /> › {layerId}
      </span>
    );
  }
  if (target.startsWith('side:')) {
    const side = doc.sides.find((s) => s.id === target.slice(5));
    return <span>steelman: {side?.label ?? target.slice(5)}</span>;
  }
  return <StepLink doc={doc} id={target} />;
}

// ---------------------------------------------------------------------------
// Research log
// ---------------------------------------------------------------------------

export function ResearchLogView({
  doc,
  caseId,
  version,
  jobId,
  job,
  summary,
  openedUrls,
  snapshots,
}: {
  doc: Case;
  caseId: string;
  version: number;
  jobId: string | null;
  job: PipelineJobRow | null;
  summary: ResearchLogSummary;
  /** Cited source URLs the job logged as opened (checked in the database). */
  openedUrls: string[];
  snapshots: SourceSnapshotMeta[];
}) {
  if (!jobId) {
    return <p className="empty">No pipeline run is linked to this version (it was imported or written in the console), so there is no research log.</p>;
  }
  const snapByUrl = new Map<string, SourceSnapshotMeta>();
  for (const s of snapshots) {
    snapByUrl.set(s.url, s);
    if (s.final_url) snapByUrl.set(s.final_url, s);
  }
  const opened = new Set(openedUrls);
  const snapIdByUrl: Record<string, string> = {};
  for (const [url, s] of snapByUrl) snapIdByUrl[url] = s.id;
  const notOpened = doc.sources.filter((s) => !opened.has(s.url) && !snapByUrl.get(s.url)).length;
  return (
    <div data-testid="research-log">
      <p className="small muted" data-testid="research-log-summary">
        Pipeline job <span className="mono">{jobId.slice(0, 8)}</span>
        {job ? ` · ${job.kind} · ${job.status} · started ${formatDateTime(job.claimed_at ?? job.created_at)}` : ''}
        {job?.brief ? ` · brief: “${job.brief}”` : ''} · {plural(summary.total, 'log entry', 'log entries')}, {plural(snapshots.length, 'page snapshot')}.
      </p>

      <h4>Were the cited sources actually opened?</h4>
      <p className="small muted">
        Checked against every “open” entry in the log{notOpened ? `: ${plural(notOpened, 'cited source')} with no record` : ': every cited source was opened'}.
      </p>
      <div className="table-wrap" style={{ marginBottom: 20 }}>
        <table data-testid="opened-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Opened in this run</th>
              <th>Snapshot</th>
            </tr>
          </thead>
          <tbody>
            {doc.sources.map((s) => {
              const snap = snapByUrl.get(s.url);
              const wasOpened = opened.has(s.url) || !!snap;
              return (
                <tr key={s.id}>
                  <td>
                    <span className="mono small">{s.id}</span> {s.title} <span className="faint small">· {s.publisher}</span>
                  </td>
                  <td>{wasOpened ? <span className="badge badge-ok">opened</span> : <span className="badge badge-warn">no record</span>}</td>
                  <td>{snap ? <Link href={`/snapshots/${snap.id}`} target="_blank">Read snapshot</Link> : <span className="faint">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h4>Everything the run logged</h4>
      <p className="small muted">Open a group to load its queries, opened pages and extracted claims.</p>
      <ResearchLogGroups groups={summary.groups} caseId={caseId} version={version} jobId={jobId} snapIdByUrl={snapIdByUrl} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review record tabs
// ---------------------------------------------------------------------------

export function HardQuestionsView({ doc }: { doc: Case }) {
  const qs = doc.review.hard_questions;
  if (!qs.length) return <p className="empty">The hard-questions agent left no questions.</p>;
  const side = (id?: string) => (id ? (doc.sides.find((s) => s.id === id)?.label ?? id) : 'any side');
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Question</th>
            <th>Asked for</th>
            <th>Status</th>
            <th>Resolution</th>
            <th>Steps</th>
          </tr>
        </thead>
        <tbody>
          {qs.map((q) => (
            <tr key={q.id}>
              <td>
                {q.question}
                <div className="small faint">
                  {q.id} · round {q.round}
                </div>
              </td>
              <td className="small">{side(q.side_id)}</td>
              <td>
                <span className={`badge ${q.status === 'open' ? 'badge-warn' : q.status === 'answered' ? 'badge-ok' : ''}`}>{label(q.status)}</span>
                {q.blocking ? <div><span className="badge badge-error">blocking</span></div> : null}
              </td>
              <td className="small">{q.resolution ?? <span className="faint">—</span>}</td>
              <td className="small">
                {q.step_ids.length
                  ? q.step_ids.map((id, i) => (
                      <span key={id}>
                        {i ? ', ' : ''}
                        <StepLink doc={doc} id={id} />
                      </span>
                    ))
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BiasReportsView({ doc }: { doc: Case }) {
  const reports = doc.review.bias_reports;
  if (!reports.length) return <p className="empty">No red-team reports.</p>;
  return (
    <div>
      {doc.sides.map((side) => {
        const mine = reports.filter((r) => r.side_id === side.id).sort((a, b) => b.round - a.round);
        return (
          <div key={side.id} className="panel" style={{ marginBottom: 12 }}>
            <h3>Read as a partisan of “{side.label}”</h3>
            {mine.length === 0 ? <p className="empty">No report from this side&rsquo;s red team.</p> : null}
            {mine.map((r) => (
              <div key={r.round} style={{ marginBottom: 12 }}>
                <p className="small muted">Round {r.round}</p>
                {r.summary ? <p>{r.summary}</p> : null}
                {r.flags.length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>Flag</th>
                        <th>Step</th>
                        <th>Severity</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.flags.map((f) => (
                        <tr key={f.id}>
                          <td>
                            <span className="small faint">{label(f.kind)}</span>
                            <div>{f.note}</div>
                            {f.resolution ? <div className="small muted">Resolution: {f.resolution}</div> : null}
                          </td>
                          <td className="small">{f.step_id ? <StepLink doc={doc} id={f.step_id} /> : 'whole case'}</td>
                          <td>
                            <span className={`badge ${SEVERITY[f.severity]}`}>{f.severity}</span>
                          </td>
                          <td>
                            <span className={`badge ${f.status === 'unaddressed' ? 'badge-warn' : ''}`}>{label(f.status)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="small muted">No flags.</p>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function FactCheckView({ doc }: { doc: Case }) {
  const rows = [...doc.review.fact_check].sort((a, b) => (b.round ?? 0) - (a.round ?? 0));
  if (!rows.length) return <p className="empty">No fact-check table in this package.</p>;
  const latest = rows[0]!.round ?? 0;
  const source = (id?: string) => (id ? doc.sources.find((s) => s.id === id) : undefined);
  return (
    <div className="table-wrap">
      <table data-testid="fact-check-table">
        <thead>
          <tr>
            <th>Target</th>
            <th>Claim</th>
            <th>Source</th>
            <th>Verdict</th>
            <th>Confidence</th>
            <th>Round</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const s = source(r.source_id);
            return (
              <tr key={i} style={(r.round ?? 0) !== latest ? { opacity: 0.6 } : undefined}>
                <td className="small nowrap">
                  <TargetLink doc={doc} target={r.target} />
                </td>
                <td className="small">
                  {r.claim}
                  {r.quote ? <div className="quote">&ldquo;{r.quote}&rdquo;</div> : null}
                  {r.note ? <div className="muted">{r.note}</div> : null}
                </td>
                <td className="small">
                  {s ? (
                    <a href={safeHref(s.url) ?? undefined} target="_blank" rel="noreferrer noopener">
                      {s.title}
                    </a>
                  ) : (
                    (r.source_id ?? '—')
                  )}
                </td>
                <td>
                  <span className={`badge ${VERDICT[r.verdict] ?? ''}`}>{label(r.verdict)}</span>
                </td>
                <td className="small nowrap">
                  {r.confidence_before && r.confidence_after && r.confidence_before !== r.confidence_after
                    ? `${r.confidence_before} → ${r.confidence_after}`
                    : (r.confidence_after ?? r.confidence_before ?? '—')}
                </td>
                <td className="num">
                  {r.round ?? 0}
                  {(r.round ?? 0) === latest ? '' : ' (earlier)'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DecisionsView({ decisions, version }: { decisions: ReviewDecisionRow[]; version: number }) {
  if (!decisions.length) return <p className="empty">No decisions logged yet.</p>;
  return (
    <div className="table-wrap">
      <table data-testid="decisions-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Version</th>
            <th>Decision</th>
            <th>By</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((d) => (
            <tr key={d.id} style={d.version === version ? { background: '#fbf8f1' } : undefined}>
              <td className="small nowrap">{formatDateTime(d.at)}</td>
              <td className="nowrap">
                v{d.version}
                {d.version === version ? <span className="faint small"> (this)</span> : null}
              </td>
              <td>
                {DECISION_LABEL[d.action] ?? d.action}
                {d.scheduled_for ? <div className="small faint">for {formatDateTime(d.scheduled_for)}</div> : null}
              </td>
              <td className="small">{d.actor}</td>
              <td className="small">
                {d.notes ?? <span className="faint">—</span>}
                {d.doc_sha256 ? <div className="mono faint" title="Hash of the approved content">sha256 {d.doc_sha256.slice(0, 12)}…</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentReportsView({ doc }: { doc: Case }) {
  const reports = doc.review.agent_reports;
  if (!reports.length) return <p className="empty">No agent reports in this package.</p>;
  return (
    <ul className="flag-list">
      {reports.map((r, i) => (
        <li key={i}>
          <strong>{label(r.agent)}</strong>
          {r.scope ? <span className="muted"> · {r.scope}</span> : null}
          <span className="faint small">
            {' '}
            · round {r.round} · {formatDateTime(r.at)}
          </span>
          <div style={{ whiteSpace: 'pre-wrap' }}>{r.summary}</div>
        </li>
      ))}
    </ul>
  );
}

export function OpenIssuesView({ doc }: { doc: Case }) {
  const issues = [...doc.review.open_issues].sort((a, b) => Number(a.resolved) - Number(b.resolved));
  if (!issues.length) return <p className="empty">The pipeline left no open issues.</p>;
  return (
    <ul className="flag-list" data-testid="open-issues">
      {issues.map((o) => (
        <li key={o.id}>
          <span className={`badge ${o.resolved ? '' : SEVERITY[o.severity]}`}>{o.resolved ? 'resolved' : o.severity}</span>{' '}
          <span className="small faint">
            {label(o.source)}
            {o.step_id ? (
              <>
                {' · '}
                <StepLink doc={doc} id={o.step_id} />
              </>
            ) : null}
          </span>
          <div>{o.description}</div>
        </li>
      ))}
    </ul>
  );
}
