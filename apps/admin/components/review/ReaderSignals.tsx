'use client';

import type { Side } from '@sia/case-schema';
import { AlertDetails, ResolveAlertForm } from '@/components/Alerts';
import { formatDateTime, formatPercent } from '@/lib/format';
import type { UserSignals } from '@/lib/step-flags';

/**
 * What readers of the published version said: "Was this fair to your side?"
 * per side, open reader flags, and the alerts that sent the case back into
 * review. Shown on the live version and on any revision or edit draft of it.
 */
export function ReaderSignalsPanel({ signals, sides, thisVersion }: { signals: UserSignals; sides: Side[]; thisVersion: number }) {
  const label = (id: string | null) => (id ? (sides.find((s) => s.id === id)?.label || id) : 'any side');
  const openAlerts = signals.alerts.filter((a) => !a.resolved_at);
  const ratings = signals.sides ?? [];
  const openFlags = signals.flags.reduce((n, f) => n + f.open, 0);
  if (!openAlerts.length && !ratings.length && !openFlags) return null;
  const whose = signals.version === thisVersion ? 'this version' : `v${signals.version}, the version this updates`;
  return (
    <section className="panel signals" aria-labelledby="signals-h" data-testid="reader-signals">
      <h3 id="signals-h" style={{ margin: 0 }}>
        {openAlerts.length ? 'Why this is back in review' : 'What readers said'} <span className="small faint">readers of {whose}</span>
      </h3>
      {openAlerts.length ? (
        <ul className="flag-list">
          {openAlerts.map((a) => (
            <li key={a.id} data-testid={`signal-alert-${a.id}`}>
              <span className="badge badge-warn">{a.kind} alert</span> <AlertDetails alert={a} />
              {a.kind === 'fairness' ? <span className="small"> · readers on “{label(a.side_id)}” rated the dive unfair</span> : null}
              <span className="small faint"> · raised {formatDateTime(a.created_at)}</span>
              <ResolveAlertForm alertId={a.id} />
            </li>
          ))}
        </ul>
      ) : null}
      {ratings.length ? (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table data-testid="fairness-by-side">
            <thead>
              <tr>
                <th>“Was this fair to your side?”</th>
                <th className="num">Ratings</th>
                <th className="num">Fair</th>
                <th className="num">Somewhat</th>
                <th className="num">Unfair</th>
                <th className="num">Unfair share</th>
              </tr>
            </thead>
            <tbody>
              {ratings.map((r) => (
                <tr key={r.side_id}>
                  <td>{label(r.side_id)}</td>
                  <td className="num">{r.ratings}</td>
                  <td className="num">{r.fair}</td>
                  <td className="num">{r.somewhat_fair}</td>
                  <td className="num">{r.unfair}</td>
                  <td className="num">{formatPercent(r.unfair_share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {openFlags ? (
        <p className="small muted" style={{ marginBottom: 0 }}>
          {openFlags} open reader flag{openFlags === 1 ? '' : 's'} on facts; each step card lists its own.
        </p>
      ) : null}
    </section>
  );
}
