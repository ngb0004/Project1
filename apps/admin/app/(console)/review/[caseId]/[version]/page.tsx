import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { SeedProfileInput } from '@sia/case-schema';
import {
  adminFairnessSignals,
  adminFinalCrowd,
  adminFlagsBySide,
  findAdminEditDraft,
  getPipelineJob,
  getStaffCase,
  getStaffVersion,
  listReviewDecisions,
  listSnapshotMeta,
  listVersionSummaries,
  researchLogOpenedUrls,
  researchLogSummary,
  type ResearchLogSummary,
  type StaffVersionRow,
} from '@sia/case-store';
import { LocalTime } from '@/components/LocalTime';
import { LiveBadge, StatusBadge } from '@/components/StatusBadge';
import { SupersededNotice } from '@/components/review/SupersededNotice';
import type { PreviewHistory } from '@/components/review/PreviewPlayer';
import { AuditTabs } from '@/components/review/AuditTabs';
import {
  AgentReportsView,
  BiasReportsView,
  DecisionsView,
  FactCheckView,
  HardQuestionsView,
  OpenIssuesView,
  ResearchLogView,
} from '@/components/review/audit';
import { ReviewWorkspace, type CompareTarget } from '@/components/review/ReviewWorkspace';
import { requireAdmin } from '@/lib/auth';
import { diveAppUrl } from '@/lib/env';
import { formatDate, formatDateTime, isUuid, parseVersion, plural } from '@/lib/format';
import type { UserSignals } from '@/lib/step-flags';
import { openIssueCount } from '@/lib/step-flags';

export const metadata: Metadata = { title: 'Review' };

/** Notices carried in the URL after a save; each one only makes sense in the status it was written for. */
const NOTICES: Record<string, { text: string; status: string }> = {
  saved: { text: 'Your edits are saved in this draft (tagged admin_edit). Approve it below when it is ready.', status: 'draft' },
  published: { text: 'Saved and published. This version is live now; readers who answered the earlier version stay attached to it.', status: 'published' },
};

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string; version: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { db } = await requireAdmin();
  const { caseId, version: versionParam } = await params;
  const sp = await searchParams;
  const version = parseVersion(versionParam);
  if (!isUuid(caseId) || version === null) notFound();
  const row = await getStaffVersion(db, caseId, version);
  if (!row) notFound();
  const doc = row.doc;

  const [caseRow, decisions, existingDraft, summaries] = await Promise.all([
    getStaffCase(db, caseId),
    listReviewDecisions(db, caseId),
    row.status === 'draft' ? Promise.resolve(null) : findAdminEditDraft(db, caseId, version),
    listVersionSummaries(db, [caseId]),
  ]);
  const liveVersion = caseRow?.live_version ?? null;
  const published = summaries.filter((v) => v.published_at !== null);
  const isPublished = (v: number | null) => v !== null && published.some((p) => p.version === v);
  // A package still in review whose admin edit already went live (a scheduled publish does not retire the package it was edited from).
  const supersededBy =
    row.status === 'in_review' || row.status === 'changes_requested'
      ? (summaries.find((v) => v.based_on_version === version && v.origin === 'admin' && v.tags.includes('admin_edit') && v.published_at !== null)?.version ?? null)
      : null;

  // What to compare against: the live version, the version this was derived from, and the version it updates.
  const wanted: { key: string; label: string; version: number }[] = [];
  const add = (key: string, label: string, v: number | null) => {
    if (v !== null && v !== version && !wanted.some((w) => w.version === v)) wanted.push({ key, label, version: v });
  };
  add('live', `Live version v${liveVersion}`, liveVersion);
  add('base', `Base version v${row.based_on_version}`, row.based_on_version);
  add('parent', `Updated version v${row.parent_version}`, row.parent_version);
  const loaded = await Promise.all(wanted.map((w) => getStaffVersion(db, caseId, w.version)));
  const compareTargets: CompareTarget[] = wanted.flatMap((w, i) => (loaded[i] ? [{ key: w.key, label: w.label, doc: loaded[i]!.doc }] : []));

  // The pipeline run behind this version (an admin edit inherits its base's run).
  const runId = doc.review?.pipeline_run_id;
  let jobId: string | null = row.pipeline_job_id ?? (isUuid(runId) ? runId : null);
  if (!jobId && row.based_on_version) {
    const base: StaffVersionRow | null =
      loaded[wanted.findIndex((w) => w.version === row.based_on_version)] ?? (await getStaffVersion(db, caseId, row.based_on_version));
    jobId = base?.pipeline_job_id ?? null;
  }
  const emptySummary: ResearchLogSummary = { total: 0, groups: [] };
  const [job, logSummary, snapshots, opened] = jobId
    ? await Promise.all([
        getPipelineJob(db, jobId),
        researchLogSummary(db, jobId),
        listSnapshotMeta(db, jobId),
        researchLogOpenedUrls(db, jobId, doc.sources.map((s) => s.url)),
      ])
    : [null, emptySummary, [], new Set<string>()];

  // Readers' signals: this version's once published; for a revision or an edit
  // draft, the published version it updates (what sent it back into review).
  const signalsVersion = row.published_at
    ? version
    : isPublished(row.parent_version)
      ? row.parent_version
      : isPublished(row.based_on_version)
        ? row.based_on_version
        : null;
  let signals: UserSignals | null = null;
  if (signalsVersion !== null) {
    const [s, bySide] = await Promise.all([adminFairnessSignals(db, caseId, signalsVersion), adminFlagsBySide(db, caseId, signalsVersion)]);
    signals = { version: signalsVersion, flags: s.flags, flagsBySide: bySide, alerts: s.alerts, sides: s.sides };
  }

  // What readers will see about earlier versions once this one is live: the
  // version note in the reveals and the history on the transparency page.
  let previewHistory: PreviewHistory | null = null;
  const earlier = published.filter((v) => v.version < version);
  if (earlier.length) {
    const note = await adminFinalCrowd(db, caseId, version).then((c) => c.version_note, () => null);
    const completions = new Map((note?.earlier_versions ?? []).map((e) => [e.version, e.completions]));
    previewHistory = {
      earlier: earlier.map((v) => ({
        version: v.version,
        title: v.title,
        as_of: v.as_of,
        published_at: v.published_at,
        parent_version: v.parent_version,
        completions: completions.get(v.version) ?? 0,
      })),
    };
  }

  const issues = openIssueCount(doc);
  const n = typeof sp.notice === 'string' ? NOTICES[sp.notice] : undefined;
  const notice = n && n.status === row.status ? n.text : undefined;
  const review = doc.review;
  const audit = (
    <AuditTabs
      tabs={[
        {
          key: 'research',
          label: 'Research log',
          count: logSummary.total,
          content: (
            <ResearchLogView key="research" doc={doc} caseId={caseId} version={version} jobId={jobId} job={job} summary={logSummary} openedUrls={[...opened]} snapshots={snapshots} />
          ),
        },
        { key: 'questions', label: 'Hard questions', count: review.hard_questions.length, content: <HardQuestionsView key="questions" doc={doc} /> },
        { key: 'bias', label: 'Bias reports', count: review.bias_reports.length, content: <BiasReportsView key="bias" doc={doc} /> },
        { key: 'factcheck', label: 'Fact-check', count: review.fact_check.length, content: <FactCheckView key="factcheck" doc={doc} /> },
        { key: 'decisions', label: 'Decisions', count: decisions.length, content: <DecisionsView key="decisions" decisions={decisions} version={version} /> },
        { key: 'agents', label: 'Agent reports', count: review.agent_reports.length, content: <AgentReportsView key="agents" doc={doc} /> },
        { key: 'issues', label: 'Open issues', count: issues, content: <OpenIssuesView key="issues" doc={doc} /> },
      ]}
    />
  );

  return (
    <main className="page">
      <header className="review-header" aria-labelledby="review-title">
        <p className="kicker">
          <Link href="/">Queue</Link> › <Link href={`/cases/${caseId}`}>{row.slug}</Link> › <span className="section-num">1</span>Review
        </p>
        <h1 id="review-title" data-testid="review-title">
          {doc.title}
        </h1>
        <div className="row">
          <span className="badge badge-solid">v{row.version}</span>
          <StatusBadge status={row.status} scheduled={row.scheduled_publish_at} />
          {row.is_live ? <LiveBadge /> : null}
          {issues ? <span className="badge badge-warn" data-testid="open-issue-count">{plural(issues, 'open issue')}</span> : <span className="badge" data-testid="open-issue-count">no open issues</span>}
          {row.tags.map((t) => (
            <span key={t} className="badge">
              {t}
            </span>
          ))}
        </div>
        <ul className="meta-list">
          <li>
            As of <strong>{formatDate(doc.as_of)}</strong>
          </li>
          <li>
            Origin <strong>{row.origin}</strong>
          </li>
          <li>
            Live version{' '}
            <strong>{liveVersion ? (liveVersion === version ? `v${liveVersion} (this)` : <Link href={`/review/${caseId}/${liveVersion}`}>v{liveVersion}</Link>) : 'none'}</strong>
          </li>
          {row.parent_version ? (
            <li>
              Updates{' '}
              <strong>
                <Link href={`/review/${caseId}/${row.parent_version}`}>v{row.parent_version}</Link>
              </strong>
            </li>
          ) : null}
          {row.based_on_version ? (
            <li>
              Derived from{' '}
              <strong>
                <Link href={`/review/${caseId}/${row.based_on_version}`}>v{row.based_on_version}</Link>
              </strong>
            </li>
          ) : null}
          <li>
            {row.published_at ? (
              <>
                Published <strong>{formatDateTime(row.published_at)}</strong> by {row.published_by}
              </>
            ) : row.submitted_at ? (
              <>
                Submitted <strong>{formatDateTime(row.submitted_at)}</strong>
              </>
            ) : (
              <>
                Created <strong>{formatDateTime(row.created_at)}</strong> by {row.created_by}
              </>
            )}
          </li>
          {row.scheduled_publish_at ? (
            <li>
              Goes live{' '}
              <strong>
                <LocalTime iso={row.scheduled_publish_at} />
              </strong>
            </li>
          ) : null}
          <li>{plural(doc.steps.length, 'step')}</li>
        </ul>
        {notice ? (
          <p className="notice notice-ok" role="status" style={{ marginTop: 16 }} data-testid="page-notice">
            {notice}
          </p>
        ) : null}
        {supersededBy ? <SupersededNotice caseId={caseId} version={version} by={supersededBy} /> : null}
        {existingDraft && row.status !== 'draft' ? (
          <p className="notice notice-info" style={{ marginTop: 16 }}>
            You have an unpublished edit draft of this version: <Link href={`/review/${caseId}/${existingDraft}`}>v{existingDraft}</Link>.
          </p>
        ) : null}
      </header>

      <ReviewWorkspace
        key={`${caseId}:${version}`}
        meta={{
          caseId,
          slug: row.slug,
          version,
          status: row.status,
          origin: row.origin,
          tags: row.tags,
          parentVersion: row.parent_version,
          liveVersion,
          isLive: !!row.is_live,
          scheduledAt: row.scheduled_publish_at,
          existingDraft,
        }}
        saved={doc}
        compareTargets={compareTargets}
        seedProfile={(caseRow?.seed_profile ?? null) as SeedProfileInput | null}
        signals={signals}
        shareBaseUrl={diveAppUrl()}
        previewHistory={previewHistory}
        audit={audit}
      />
    </main>
  );
}
