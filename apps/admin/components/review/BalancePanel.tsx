'use client';

import { useMemo } from 'react';
import { NEUTRAL, computeBalance, type Case } from '@sia/case-schema';
import { fieldDomId } from '@/lib/working-copy';

/** Muted, distinguishable side colors (color carries meaning here, so labels repeat it in text). */
export const SIDE_COLORS = ['#4f6d8f', '#a0603a', '#5f7f4f', '#7d5a8c', '#8f7a3a', '#3f7f7f'];
const NEUTRAL_COLOR = '#a9a294';

/**
 * Steps per side, and where in the order each side's strongest facts fall.
 * Computed live from the working copy with the shared computeBalance().
 */
export function BalancePanel({ doc }: { doc: Pick<Case, 'steps' | 'sides' | 'review'> }) {
  const steps = useMemo(() => doc.steps ?? [], [doc.steps]);
  const sides = useMemo(() => doc.sides ?? [], [doc.sides]);
  const report = useMemo(() => computeBalance({ steps, sides }), [steps, sides]);
  const colorOf = (favors: string | null) => {
    if (favors === null) return null;
    if (favors === NEUTRAL) return NEUTRAL_COLOR;
    const i = sides.findIndex((s) => s.id === favors);
    return i >= 0 ? SIDE_COLORS[i % SIDE_COLORS.length]! : '#c0392b';
  };
  const strongest = new Set(report.sides.flatMap((s) => s.strongest_orders));
  const max = Math.max(1, ...report.sides.map((s) => s.count), report.neutral, report.untagged);
  const pipelineWarnings = (doc.review?.balance?.warnings ?? []).filter((w) => !report.warnings.includes(w));

  return (
    <div className="panel" data-testid="balance-panel">
      <div className="balance-bars">
        {report.sides.map((s, i) => (
          <BarRow key={s.side_id} label={s.label || s.side_id} count={s.count} max={max} color={SIDE_COLORS[i % SIDE_COLORS.length]!} />
        ))}
        <BarRow label="Neutral" count={report.neutral} max={max} color={NEUTRAL_COLOR} />
        {report.untagged ? <BarRow label="Untagged" count={report.untagged} max={max} color="#d9cdb8" /> : null}
      </div>

      <h4 style={{ marginTop: 20 }}>Order of the facts</h4>
      <div className="strip" role="list" aria-label="Step order by side">
        {report.steps.map((st, i) => {
          const color = colorOf(st.favors);
          const side = sides.find((s) => s.id === st.favors);
          const name = st.favors === null ? 'untagged' : st.favors === NEUTRAL ? 'neutral' : (side?.label ?? st.favors);
          const headline = steps[i]?.headline ?? '';
          return (
            <a
              key={st.step_id}
              role="listitem"
              href={`#${fieldDomId(`steps.${i}`)}`}
              data-step-id={st.step_id}
              className={`strip-cell ${color ? '' : 'untagged'}`}
              style={color ? { background: color } : undefined}
              title={`${st.order}. ${headline} · favors ${name} · ${st.impact} impact${strongest.has(st.order) && st.favors !== null && st.favors !== NEUTRAL ? ' · strongest for its side' : ''}`}
              aria-label={`Step ${st.order}, favors ${name}, ${st.impact} impact`}
            >
              {strongest.has(st.order) && st.favors !== null && st.favors !== NEUTRAL ? <span className="star" aria-hidden>★</span> : null}
              {st.order}
            </a>
          );
        })}
      </div>
      <div className="legend">
        {sides.map((s, i) => (
          <span key={s.id}>
            <span className="swatch" style={{ background: SIDE_COLORS[i % SIDE_COLORS.length] }} />
            {s.label || s.id}
          </span>
        ))}
        <span>
          <span className="swatch" style={{ background: NEUTRAL_COLOR }} />
          Neutral
        </span>
        <span>★ strongest facts per side (highest impact)</span>
      </div>

      <table style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>Side</th>
            <th className="num">Steps</th>
            <th>Strongest facts at</th>
            <th className="num">Mean position</th>
          </tr>
        </thead>
        <tbody>
          {report.sides.map((s) => (
            <tr key={s.side_id}>
              <td>{s.label || s.side_id}</td>
              <td className="num">{s.count}</td>
              <td>{s.strongest_orders.length ? s.strongest_orders.map((o) => `step ${o}`).join(', ') : '—'}</td>
              <td className="num">{s.strongest_mean_position === null ? '—' : `${Math.round(s.strongest_mean_position * 100)}% in`}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {report.warnings.length ? (
        <div className="notice notice-warn" style={{ marginTop: 16 }} data-testid="balance-warnings">
          <strong>Balance warnings</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {report.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="notice notice-ok small" style={{ marginTop: 16 }}>
          No balance warnings: neither side&rsquo;s best facts are bunched at the end.
        </p>
      )}
      {pipelineWarnings.length ? (
        <p className="small muted">
          The pipeline&rsquo;s package also noted: {pipelineWarnings.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

function BarRow({ label, count, max, color }: { label: string; count: number; max: number; color: string }) {
  return (
    <>
      <span className="small">{label}</span>
      <span className="bar" aria-hidden>
        <span style={{ width: `${(count / max) * 100}%`, background: color }} />
      </span>
      <span className="small nowrap">
        {count} step{count === 1 ? '' : 's'}
      </span>
    </>
  );
}
