/** Ten 10-point bins as small bars, 0 on the left label's end and 100 on the right. */
export function Histogram({ bins, label }: { bins: number[] | null; label?: string }) {
  if (!bins) return <p className="empty small">Nobody counts yet.</p>;
  const max = Math.max(...bins, 0.0001);
  return (
    <div role="img" aria-label={label ?? `Distribution: ${bins.map((b, i) => `${i * 10}-${i === 9 ? 100 : i * 10 + 9}: ${Math.round(b * 100)}%`).join(', ')}`}>
      <div className="hist">
        {bins.map((b, i) => (
          <span key={i} style={{ height: `${(b / max) * 100}%` }} title={`${i * 10}–${i === 9 ? 100 : i * 10 + 9}: ${Math.round(b * 100)}%`} />
        ))}
      </div>
      <div className="hist-axis">
        <span>0</span>
        <span>50</span>
        <span>100</span>
      </div>
    </div>
  );
}
