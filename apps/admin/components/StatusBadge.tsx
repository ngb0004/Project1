import { STATUS_LABEL } from '@/lib/format';

export function StatusBadge({ status, scheduled }: { status: string; scheduled?: string | null }) {
  return (
    <span className={`badge status-${status}`} data-testid="status-badge">
      {STATUS_LABEL[status] ?? status}
      {scheduled ? ' · scheduled' : ''}
    </span>
  );
}

export function LiveBadge() {
  return <span className="badge badge-solid">Live</span>;
}
