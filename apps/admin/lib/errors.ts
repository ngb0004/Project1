import { CaseValidationError } from '@sia/case-schema';
import { StoreError } from '@sia/case-store';

/** Plain-words message for an error from the store or the validator. Server only. */
export function describeError(e: unknown): string {
  if (e instanceof CaseValidationError) {
    const shown = e.errors.slice(0, 5).map((i) => `${i.path || '(document)'}: ${i.message}`);
    const more = e.errors.length > shown.length ? ` (and ${e.errors.length - shown.length} more)` : '';
    return `The case does not pass validation, so nothing was saved: ${shown.join('; ')}${more}.`;
  }
  if (e instanceof StoreError) {
    if (e.message === 'admin only' || e.code === '42501') return `Not allowed: ${e.message}.`;
    return `The database refused: ${e.message}.`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
