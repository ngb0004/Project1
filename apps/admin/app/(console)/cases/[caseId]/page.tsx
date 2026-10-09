import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  adminFairnessSignals,
  adminFinalCrowd,
  adminFlagsBySide,
  getStaffCase,
  getStaffVersion,
  listPipelineJobs,
  listReviewAlerts,
  listVersionSummaries,
} from '@sia/case-store';
import { ActionForm } from '@/components/ActionForm';
import { AlertDetails, ResolveAlertForm } from '@/components/Alerts';
import { CadenceForm } from '@/components/CadenceForm';
import { Histogram } from '@/components/Histogram';
import { SeedProfileEditor } from '@/components/SeedProfileEditor';
import { LocalTime } from '@/components/LocalTime';
import { LiveBadge, StatusBadge } from '@/components/StatusBadge';
import { requireAdmin } from '@/lib/auth';
import { diveAppUrl } from '@/lib/env';
import { cadenceLabel, formatDate, formatDateTime, formatPercent, isUuid, parseVersion, plural } from '@/lib/format';
import { requestUpdateAction } from '../../actions';

export const metadata: Metadata = { title: 'Case overview' };

type Search = Record<string, string | string[] | undefined>;

export default async function CasePage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<Search> }) {
  const { db } = await requireAdmin();
  const { caseId } = await params;
  const sp = await searchParams;
  if (!isUuid(caseId)) notFound();
  const c = await getStaffCase(db, caseId);
  if (!c) notFound();

  const [versions, alerts, jobs] = await Promise.all([
    listVersionSummaries(db, [caseId]),
    listReviewAlerts(db, { caseId, limit: 200 }),
    listPipelineJobs(db, { caseId, limit: 20 }),
  ]);
  const published = versions.filter((v) => v.published_at !== null);
  const asked = parseVersion(sp.v);
  const crowdVersion = published.find((v) => v.version === asked)?.version ?? c.live_version ?? published[0]?.version ?? null;
  const includeSeed = sp.seed !== '0';
  const title = (versions.find((v) => v.is_live) ?? versions[0])?.title ?? c.slug;

  const [crowd, signals, flagsBySide, crowdDoc] = crowdVersion
    ? await Promise.all([
        adminFinalCrowd(db, caseId, crowdVersion, includeSeed),
        adminFairnessSignals(db, caseId, crowdVersion),
        adminFlagsBySide(db, caseId, crowdVersion),
        getStaffVersion(db, caseId, crowdVersion),
      ])
    : [null, null, [], null];
  const liveDoc = c.live_version === crowdVersion ? crowdDoc : c.live_version ? await getStaffVersion(db, caseId, c.live_version) : null;
  const sideLabel = new Map((crowdDoc?.doc.sides ?? []).map((s) => [s.id, s.label]));
  const stepHeadline = new Map((crowdDoc?.doc.steps ?? []).map((s) => [s.id, `${s.order}. ${s.headline}`]));
  const appUrl = diveAppUrl();
  const transparencyPath = `/case/${c.slug}/about`;
  const qs = (next: { v?: number | null; seed?: boolean }) => {
    const p = new URLSearchParams();
    const v = next.v === undefined ? crowdVersion : next.v;
    if (v) p.set('v', String(v));
    if (!(next.seed ?? includeSeed)) p.set('seed', '0');
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return (
    <main className="page">
      <p className="kicker">
        <Link href="/">Queue</Link> › Case
      </p>
      <h1>{title}</h1>
      <ul className="meta-list">
        <li>
          Slug <strong>{c.slug}</strong>
        </li>
        <li>
          Live version <strong>{c.live_version ? `v${c.live_version}` : 'none'}</strong>
        </li>
        <li>
          Created <strong>{formatDateTime(c.created_at)}</strong> by {c.created_by}
        </li>
        <li>
          Transparency page{' '}
          {appUrl && c.live_version ? (
            <a href={`${appUrl}${transparencyPath}`} target="_blank" rel="noreferrer">
              {transparencyPath}
            </a>
          ) : (
            <span className="mono">{transparencyPath}</span>
          )}
          {!appUrl ? <span className="faint small"> (set NEXT_PUBLIC_DIVE_APP_URL to link it)</span> : null}
        </li>
      </ul>

      <section className="section" style={{ marginTop: 32 }} aria-labelledby="versions-h">
        <header>
          <h2 id="versions-h">Versions</h2>
          <span className="small muted">{plural(versions.length, 'version')}</span>
        </header>
        <div className="table-wrap">
          <table data-testid="versions-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Title</th>
                <th>Origin · tags</th>
                <th>As of</th>
                <th>Created</th>
                <th>Published</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version} data-testid={`version-row-${v.version}`}>
                  <td className="nowrap">
                    v{v.version} {v.is_live ? <LiveBadge /> : null}
                    {v.parent_version ? <div className="small faint">updates v{v.parent_version}</div> : null}
                    {v.based_on_version ? <div className="small faint">from v{v.based_on_version}</div> : null}
                  </td>
                  <td>
                    <StatusBadge status={v.status} scheduled={v.scheduled_publish_at} />
                    {v.scheduled_publish_at ? <div className="small faint"><LocalTime iso={v.scheduled_publish_at} /></div> : null}
                  </td>
                  <td>{v.title}</td>
                  <td className="small">
                    {v.origin}
                    {v.tags.length ? ` · ${v.tags.join(', ')}` : ''}
                  </td>
                  <td className="nowrap">{formatDate(v.as_of)}</td>
                  <td className="small nowrap">{formatDateTime(v.created_at)}</td>
                  <td className="small nowrap">{formatDateTime(v.published_at)}</td>
                  <td>
                    <Link href={`/review/${caseId}/${v.version}`}>Review</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section" aria-labelledby="crowd-h">
        <header>
          <h2 id="crowd-h">Crowd{crowdVersion ? ` · v${crowdVersion}` : ''}</h2>
          {crowdVersion ? (
            <span className="row small">
              {published.length > 1 ? (
                <span>
                  Version:{' '}
                  {published.map((v) => (
                    <Link key={v.version} href={qs({ v: v.version })} aria-current={v.version === crowdVersion ? 'page' : undefined} style={{ marginRight: 8, fontWeight: v.version === crowdVersion ? 600 : undefined }}>
                      v{v.version}
                    </Link>
                  ))}
                </span>
              ) : null}
              <Link href={qs({ seed: !includeSeed })} data-testid="seed-toggle">
                {includeSeed ? 'Show real responses only' : 'Include seeded responses'}
              </Link>
            </span>
          ) : null}
        </header>
        {!crowd || !crowdVersion ? (
          <p className="empty">No published version yet, so there is no crowd.</p>
        ) : (
          <div className="grid-2">
            <div className="panel">
              <div className="stats">
                <div>
                  <div className="stat">{crowd.n_real}</div>
                  <div className="stat-label">Real completions</div>
                </div>
                <div>
                  <div className="stat">{crowd.n_seed}</div>
                  <div className="stat-label">Seeded sessions counted</div>
                </div>
                <div>
                  <div className="stat">{formatPercent(crowd.seeded_share)}</div>
                  <div className="stat-label">Seeded share</div>
                </div>
              </div>
              {includeSeed && crowd.seeded_share > 0 ? (
                <p className="notice notice-warn small" data-testid="seeded-flag">
                  {formatPercent(crowd.seeded_share)} of these numbers come from seeded responses (seed weight {crowd.seed_weight}). Readers see them flagged as seeded.
                </p>
              ) : (
                <p className="muted small">{includeSeed ? 'No seeded responses count toward these numbers.' : 'Showing real responses only.'}</p>
              )}
              <div className="grid-2" style={{ gap: 24 }}>
                <div>
                  <h4>Before · mean {crowd.mean_before ?? '—'}</h4>
                  <Histogram bins={crowd.before_histogram} />
                </div>
                <div>
                  <h4>After · mean {crowd.mean_after ?? '—'}</h4>
                  <Histogram bins={crowd.after_histogram} />
                </div>
              </div>
              {crowd.version_note?.earlier_versions.length ? (
                <p className="small muted" style={{ marginTop: 12 }}>
                  Earlier versions:{' '}
                  {crowd.version_note.earlier_versions.map((e) => `v${e.version} (${plural(e.completions, 'completion')})`).join(', ')}.
                </p>
              ) : null}
            </div>
            <div className="panel">
              <h4>Fact votes (finished readers)</h4>
              <table>
                <thead>
                  <tr>
                    <th>Fact</th>
                    <th className="num">Agree</th>
                    <th className="num">Not sure</th>
                    <th className="num">Disagree</th>
                  </tr>
                </thead>
                <tbody>
                  {crowd.steps.map((s) => (
                    <tr key={s.step_id}>
                      <td className="small">
                        {stepHeadline.get(s.step_id) ?? s.step_id}
                        {crowd.most_split_step_id === s.step_id ? <span className="badge badge-info" style={{ marginLeft: 6 }}>split the crowd most</span> : null}
                      </td>
                      <td className="num">{s.votes ? formatPercent(s.votes.agree) : '—'}</td>
                      <td className="num">{s.votes ? formatPercent(s.votes.unsure) : '—'}</td>
                      <td className="num">{s.votes ? formatPercent(s.votes.disagree) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {crowdVersion && signals ? (
        <section className="section" aria-labelledby="fair-h">
          <header>
            <h2 id="fair-h">Fairness signals · v{crowdVersion}</h2>
            <span className="small muted">Unfair threshold {formatPercent(c.fairness_unfair_threshold)} after {c.fairness_min_ratings} ratings</span>
          </header>
          <div className="grid-2">
            <div className="panel">
              <h4>&ldquo;Was this fair to your side?&rdquo;</h4>
              {signals.sides.length === 0 ? (
                <p className="empty">No ratings yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Side</th>
                      <th className="num">Ratings</th>
                      <th className="num">Fair</th>
                      <th className="num">Somewhat</th>
                      <th className="num">Unfair</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signals.sides.map((s) => (
                      <tr key={s.side_id}>
                        <td>{sideLabel.get(s.side_id) ?? s.side_id}</td>
                        <td className="num">{s.ratings}</td>
                        <td className="num">{s.fair}</td>
                        <td className="num">{s.somewhat_fair}</td>
                        <td className="num">
                          {s.unfair}{' '}
                          <span className={(s.unfair_share ?? 0) >= c.fairness_unfair_threshold ? 'badge badge-error' : 'faint'}>{formatPercent(s.unfair_share)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="panel">
              <h4>Reader fact flags per step</h4>
              {signals.flags.length === 0 ? (
                <p className="empty">No flags yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th className="num">Open / total</th>
                      <th>By reason</th>
                      <th>By flagger&rsquo;s side</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signals.flags.map((f) => (
                      <tr key={f.step_id}>
                        <td className="small">{stepHeadline.get(f.step_id) ?? f.step_id}</td>
                        <td className="num">
                          {f.open} / {f.total}
                        </td>
                        <td className="small">
                          {Object.entries(f.by_reason ?? {})
                            .map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`)
                            .join(', ')}
                        </td>
                        <td className="small">
                          {flagsBySide
                            .filter((r) => r.step_id === f.step_id)
                            .map((r) => `${r.side_id === 'unrated' ? 'unrated' : (sideLabel.get(r.side_id) ?? r.side_id)} ${r.flags}`)
                            .join(', ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </section>
      ) : null}

      <section className="section" aria-labelledby="alerts-h">
        <header>
          <h2 id="alerts-h">Alerts</h2>
          <span className="small muted">{plural(alerts.filter((a) => !a.resolved_at).length, 'open alert')}</span>
        </header>
        {alerts.length === 0 ? (
          <p className="empty">No alerts for this case.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Kind</th>
                  <th>Details</th>
                  <th>Raised</th>
                  <th style={{ width: '34%' }}>Resolution</th>
                </tr>
              </thead>
              <tbody>
                {[...alerts]
                  .sort((a, b) => Number(!!a.resolved_at) - Number(!!b.resolved_at))
                  .map((a) => (
                    <tr key={a.id}>
                      <td>v{a.case_version}</td>
                      <td>
                        <span className={`badge ${a.resolved_at ? '' : a.kind === 'fairness' ? 'badge-warn' : 'badge-info'}`}>{a.kind}</span>
                      </td>
                      <td>
                        <AlertDetails alert={a} />
                      </td>
                      <td className="small nowrap">{formatDateTime(a.created_at)}</td>
                      <td>
                        {a.resolved_at ? (
                          <span className="small">
                            {a.resolution} <span className="faint">({a.resolved_by}, {formatDateTime(a.resolved_at)})</span>
                          </span>
                        ) : (
                          <ResolveAlertForm alertId={a.id} />
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="updates-h">
        <header>
          <h2 id="updates-h">Live updates</h2>
        </header>
        <div className="grid-2">
          <div className="panel">
            <h4>Re-research cadence</h4>
            <p className="small muted">
              Currently: <strong>{cadenceLabel(c.update_cadence)}</strong>
              {c.next_update_at ? ` · next run ${formatDateTime(c.next_update_at)}` : ''}. New developments come back as a revision package for review; the live case never changes without approval.
            </p>
            <CadenceForm caseId={caseId} current={c.update_cadence} />
            <hr />
            <ActionForm action={requestUpdateAction} submitLabel="Re-research now" pendingLabel="Queuing…" testId="update-form" disabled={!c.live_version}>
              <input type="hidden" name="caseId" value={caseId} />
              {!c.live_version ? <p className="small muted">Needs a live version first.</p> : null}
            </ActionForm>
            {jobs.length ? (
              <>
                <h4 style={{ marginTop: 16 }}>Recent jobs</h4>
                <ul className="flag-list small">
                  {jobs.map((j) => (
                    <li key={j.id}>
                      <span className="mono">{j.id.slice(0, 8)}</span> {j.kind}
                      {j.base_version ? ` of v${j.base_version}` : ''} · <span className={`badge ${j.status === 'failed' ? 'badge-error' : ''}`}>{j.status}</span>{' '}
                      <span className="faint">{formatDateTime(j.created_at)}</span>
                      {j.error ? <div className="notice notice-error small">{j.error}</div> : null}
                      {j.status === 'no_changes' && typeof j.result?.summary === 'string' ? <div className="muted">{j.result.summary}</div> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
          <div className="panel">
            <h4>Seeded crowd</h4>
            <p className="small muted">
              A Before distribution, a vote mix for each fact, and a shift from Before to After. Seeded rows are stored as seeded, flagged in every readout, and fade out as real completions arrive. Saving regenerates the seeds for the live version.
            </p>
            <SeedProfileEditor caseId={caseId} initial={c.seed_profile} stepIds={(liveDoc?.doc.steps ?? []).map((s) => s.id)} />
          </div>
        </div>
      </section>
    </main>
  );
}
