'use client';

import { useEffect, useState } from 'react';
import { formatDateTime } from '@/lib/format';

/** The browser's time zone, e.g. "America/Los_Angeles" (empty on the server). */
export function zoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** "Oct 8, 2026, 5:28 PM PDT" in the browser's time zone. */
export function localWithZone(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // dateStyle/timeStyle cannot be combined with timeZoneName, so the parts are named one by one.
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

/**
 * A time shown in UTC (the same text on the server and in the browser), with
 * the admin's local time and zone added once the page is running in the
 * browser: "2026-10-09 00:28 UTC · Oct 8, 2026, 5:28 PM PDT your time".
 */
export function LocalTime({ iso }: { iso: string | null | undefined }) {
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    if (!iso) return;
    const d = new Date(iso);
    // Only worth adding when the local zone is not UTC.
    if (Number.isNaN(d.getTime()) || d.getTimezoneOffset() === 0) return setLocal(null);
    setLocal(localWithZone(iso));
  }, [iso]);
  if (!iso) return <>—</>;
  return (
    <span data-testid="local-time">
      {formatDateTime(iso)}
      {local ? <span className="faint"> · {local} your time</span> : null}
    </span>
  );
}
