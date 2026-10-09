'use client';

import Link from 'next/link';

/** Shown when a page's data could not be loaded (for example, the database refused a read). */
export default function ConsoleError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="page page-narrow">
      <h1>Something went wrong</h1>
      <p className="notice notice-error" role="alert">
        {error.message || 'The page could not be loaded.'}
        {error.digest ? <span className="mono small"> ({error.digest})</span> : null}
      </p>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={reset}>
          Try again
        </button>
        <Link href="/">Back to the queue</Link>
      </div>
    </main>
  );
}
