import { Case, PublicCase, toPublicCase, type SeedProfileInput } from '@sia/case-schema';
import type { DiveApi } from '@sia/dive-engine';
import { LocalDiveApi, type LocalCaseInput } from '@sia/dive-engine/local';

interface DemoEntry {
  doc: unknown;
  seedProfile?: SeedProfileInput | null;
}

/** Accepts a full case document or its public projection; admin-only fields never reach the UI. */
export function toLocalCase(entry: DemoEntry): LocalCaseInput {
  const full = Case.safeParse(entry.doc);
  const doc = full.success ? toPublicCase(full.data) : PublicCase.parse(entry.doc);
  return { doc, seedProfile: entry.seedProfile ?? null };
}

export async function loadDemoApi(url: string): Promise<DiveApi> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load demo cases from ${url} (HTTP ${res.status}).`);
  const entries: unknown = await res.json();
  if (!Array.isArray(entries)) throw new Error('Demo cases must be a JSON array of { doc, seedProfile? }.');
  return new LocalDiveApi({ cases: (entries as DemoEntry[]).map(toLocalCase) });
}
