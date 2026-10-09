import type { ReviewAlertRow } from '@sia/case-store';
import { resolveAlertAction } from '@/app/(console)/actions';
import { ActionForm } from './ActionForm';

export function AlertDetails({ alert }: { alert: ReviewAlertRow }) {
  const entries = Object.entries(alert.details ?? {}).filter(([, v]) => v !== null && typeof v !== 'object');
  return (
    <span className="small muted">
      {alert.kind === 'fairness' ? `Side ${alert.side_id ?? '?'}` : `Step ${alert.step_id ?? '?'}`}
      {entries.length ? ` · ${entries.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`).join(', ')}` : ''}
    </span>
  );
}

export function ResolveAlertForm({ alertId }: { alertId: number }) {
  return (
    <ActionForm action={resolveAlertAction} submitLabel="Resolve" className="row" testId={`resolve-alert-${alertId}`}>
      <input type="hidden" name="alertId" value={alertId} />
      <input type="text" name="resolution" placeholder="How it was resolved" required aria-label="Resolution" style={{ flex: 1, minWidth: 180 }} />
    </ActionForm>
  );
}
