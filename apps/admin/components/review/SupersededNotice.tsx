'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { archiveVersion } from '@/app/(console)/review/actions';
import type { ActionResult } from '@/lib/form-state';

/**
 * Shown on a package that is still in review although the admin's edit of it
 * already went live (Approve and schedule on the edit draft does not retire
 * the package it was edited from, unlike Approve and publish). One click
 * archives it as superseded, logged with that reason.
 */
export function SupersededNotice({ caseId, version, by }: { caseId: string; version: number; by: number }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div className="notice notice-warn" style={{ marginTop: 16 }} data-testid="superseded-notice">
      Your edit of this package, <Link href={`/review/${caseId}/${by}`}>v{by}</Link>, is already published, so this version is superseded and can no
      longer go live.{' '}
      <button
        type="button"
        className="btn btn-small"
        disabled={pending || result?.ok === true}
        data-testid="archive-superseded"
        onClick={() => {
          if (!window.confirm(`Archive v${version} as superseded by v${by}?`)) return;
          start(async () => {
            try {
              setResult(await archiveVersion({ caseId, version, notes: `Superseded by version ${by} (the admin's edit of it, published on schedule).` }));
            } catch (e) {
              setResult({ ok: false, error: `Could not reach the console (${(e as Error).message || 'network error'}).` });
            }
          });
        }}
      >
        {pending ? 'Archiving…' : 'Archive as superseded'}
      </button>
      {result ? <div className="small" role={result.ok ? 'status' : 'alert'}>{result.ok ? result.message : result.error}</div> : null}
    </div>
  );
}
