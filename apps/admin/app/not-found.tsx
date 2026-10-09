import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="page page-narrow">
      <h1>Not found</h1>
      <p className="muted">That case or version does not exist, or this account cannot see it.</p>
      <p>
        <Link href="/">Back to the queue</Link>
      </p>
    </main>
  );
}
