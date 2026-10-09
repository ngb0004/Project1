import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { assertValidCase } from '@sia/case-schema';
import { main } from '../src/cli';
import { runCasePipeline, type PipelinePackage } from '../src/orchestrator';
import { checkSavedPackage, writePackageToDir } from '../src/package';
import { FileResearchLog, type LoggedEntry, type SnapshotRecord } from '../src/research/log';
import { SourceStore } from '../src/research/store';
import { FakeRunner } from '../src/runner/fake';
import { AS_OF, cleanScripts, fakeFetcher } from './helpers';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function runToDir() {
  const dir = await mkdtemp(join(tmpdir(), 'pipeline-pkg-'));
  dirs.push(dir);
  const log = new FileResearchLog(dir);
  const store = new SourceStore({ log, fetcher: fakeFetcher() });
  const result = await runCasePipeline({ kind: 'new_case', brief: 'Maple County water main break' }, { runner: new FakeRunner(cleanScripts()), store, runId: 'pkg-run', asOf: AS_OF });
  if (result.kind !== 'package') throw new Error('expected a package');
  await writePackageToDir(result, dir, { store });
  return { dir, pkg: result as PipelinePackage, store };
}

describe('writePackageToDir', () => {
  it('writes the case, review, outline, research log and every snapshot', async () => {
    const { dir, pkg, store } = await runToDir();
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(['case.json', 'manifest.json', 'outline.json', 'research-log-summary.json', 'research-log.jsonl', 'review.json', 'snapshots']);

    const saved = assertValidCase(JSON.parse(await readFile(join(dir, 'case.json'), 'utf8')));
    expect(saved).toEqual(pkg.case);
    expect(JSON.parse(await readFile(join(dir, 'review.json'), 'utf8'))).toEqual(pkg.review);

    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ run_id: 'pkg-run', request: 'new_case', slug: pkg.case.slug, rounds: 1, clean: true, open_issues: 0, sources_opened: store.opened().length });

    const lines = (await readFile(join(dir, 'research-log.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as LoggedEntry);
    expect(lines.length).toBe(pkg.researchLog.total);
    expect(new Set(lines.map((l) => l.kind))).toEqual(new Set(['query', 'open', 'claim', 'note']));

    const snaps = await readdir(join(dir, 'snapshots'));
    expect(snaps.length).toBe(store.opened().length);
    const first = JSON.parse(await readFile(join(dir, 'snapshots', snaps[0]!), 'utf8')) as SnapshotRecord;
    expect(first).toMatchObject({ http_status: 200, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(store.get(first.id)?.text).toBe(first.text_content);
  });

  it('a saved package re-checks clean against its snapshots, and a tampered quote fails', async () => {
    const { dir } = await runToDir();
    const casePath = join(dir, 'case.json');
    const snapshots = join(dir, 'snapshots');
    const ok = await checkSavedPackage(casePath, snapshots);
    expect(ok).toMatchObject({ ok: true, schemaErrors: [], failures: [] });

    const doc = JSON.parse(await readFile(casePath, 'utf8'));
    doc.steps[0].evidence[0].quote = 'The council voted unanimously to cancel the project outright.';
    const tampered = join(dir, 'tampered.json');
    await writeFile(tampered, JSON.stringify(doc));
    const bad = await checkSavedPackage(tampered, snapshots);
    expect(bad.ok).toBe(false);
    expect(bad.failures).toEqual([expect.objectContaining({ target: doc.steps[0].id, verdict: 'unsupported' })]);

    // The same through the CLI: exit code 0 when clean, 1 on a failure.
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['check', casePath, '--snapshots', snapshots])).toBe(0);
      expect(await main(['check', tampered, '--snapshots', snapshots])).toBe(1);
      expect(out.mock.calls.map((c) => String(c[0])).join('')).toMatch(/unsupported\s+s1/);
    } finally {
      out.mockRestore();
    }
  });

  it('a saved package checked against an empty snapshot directory fails every source as not opened', async () => {
    const { dir, pkg } = await runToDir();
    const empty = await mkdtemp(join(tmpdir(), 'pipeline-empty-'));
    dirs.push(empty);
    const r = await checkSavedPackage(join(dir, 'case.json'), empty);
    expect(r.ok).toBe(false);
    expect(new Set(r.failures.map((f) => f.verdict))).toEqual(new Set(['source_unavailable']));
    expect(new Set(r.failures.map((f) => f.source_id))).toEqual(new Set(pkg.case.sources.map((s) => s.id)));
  });
});
