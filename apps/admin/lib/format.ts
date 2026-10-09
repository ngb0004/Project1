/**
 * Formatting shared by server and client components. Times are always shown
 * in UTC so a server render and a browser render print the same text.
 */

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

export function formatPercent(share: number | null | undefined, digits = 0): string {
  if (share === null || share === undefined || Number.isNaN(share)) return '—';
  return `${(share * 100).toFixed(digits)}%`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  published: 'Published',
  archived: 'Archived',
};

export const DECISION_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  approve_publish: 'Approved and published',
  approve_schedule: 'Approved and scheduled',
  request_changes: 'Changes requested',
  admin_edit: 'Admin edit saved',
  reject: 'Rejected',
  archive: 'Archived',
  superseded: 'Superseded',
  scheduled_publish: 'Published on schedule',
  unschedule: 'Schedule cancelled',
};

// ---------------------------------------------------------------------------
// Update cadence (Postgres intervals)
// ---------------------------------------------------------------------------

export const CADENCE_CHOICES = [
  { value: 'off', label: 'Off', interval: null },
  { value: '6h', label: 'Every 6 hours', interval: '6 hours' },
  { value: 'daily', label: 'Daily', interval: '1 day' },
  { value: 'weekly', label: 'Weekly', interval: '7 days' },
] as const;

export type CadenceChoice = (typeof CADENCE_CHOICES)[number]['value'] | 'custom';

const UNIT_SECONDS: Record<string, number> = {
  year: 365 * 86400,
  mon: 30 * 86400,
  month: 30 * 86400,
  week: 7 * 86400,
  day: 86400,
  hour: 3600,
  min: 60,
  minute: 60,
  sec: 1,
  second: 1,
};

/**
 * Seconds in a Postgres interval as PostgREST returns it (the default
 * `postgres` style, e.g. "1 day", "7 days", "06:00:00", "1 day 02:00:00"), or
 * an ISO 8601 duration ("PT6H"). Null when it cannot be read.
 */
export function intervalSeconds(text: string | null | undefined): number | null {
  if (!text) return null;
  const s = text.trim().toLowerCase();
  const iso = /^p(?:(\d+)w)?(?:(\d+)d)?(?:t(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?)?$/.exec(s);
  if (iso && s !== 'p' && s !== 'pt') {
    const [, w, d, h, m, sec] = iso;
    return Number(w ?? 0) * 604800 + Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(sec ?? 0);
  }
  let total = 0;
  let matched = false;
  let rest = s;
  const unitRe = /(-?\d+(?:\.\d+)?)\s*(years?|mons?|months?|weeks?|days?|hours?|mins?|minutes?|secs?|seconds?)\b/g;
  rest = rest.replace(unitRe, (_m, n: string, unit: string) => {
    const key = unit.replace(/s$/, '');
    total += Number(n) * (UNIT_SECONDS[key] ?? 0);
    matched = true;
    return ' ';
  });
  const clock = /(-?)(\d+):(\d{2})(?::(\d{2}(?:\.\d+)?))?/.exec(rest);
  if (clock) {
    const [, sign, h, m, sec] = clock;
    const v = Number(h) * 3600 + Number(m) * 60 + Number(sec ?? 0);
    total += sign === '-' ? -v : v;
    matched = true;
    rest = rest.replace(clock[0], ' ');
  }
  return matched && rest.trim() === '' ? total : null;
}

export function cadenceChoiceOf(text: string | null | undefined): CadenceChoice {
  if (!text) return 'off';
  const secs = intervalSeconds(text);
  const hit = CADENCE_CHOICES.find((c) => c.interval !== null && intervalSeconds(c.interval) === secs);
  return hit ? hit.value : 'custom';
}

export function cadenceInterval(choice: string): string | null | undefined {
  const hit = CADENCE_CHOICES.find((c) => c.value === choice);
  return hit ? hit.interval : undefined;
}

export function cadenceLabel(text: string | null | undefined): string {
  const choice = cadenceChoiceOf(text);
  if (choice === 'custom') return `Every ${text}`;
  return CADENCE_CHOICES.find((c) => c.value === choice)!.label;
}

// ---------------------------------------------------------------------------
// Request parameters
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** A version number from a URL segment: a positive 32-bit integer, else null. */
export function parseVersion(s: unknown): number | null {
  if (typeof s !== 'string' || !/^[1-9]\d{0,8}$/.test(s)) return null;
  return Number(s);
}

/** An href for a URL from pipeline output: http(s) only, anything else becomes null (rendered as plain text). */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}
