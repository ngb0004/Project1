import { PublicCase, type SeedProfileInput } from '@sia/case-schema';
import type { DiveApi } from '@sia/dive-engine';
import { LocalDiveApi, type LocalCaseInput } from '@sia/dive-engine/local';

interface DemoEntry {
  doc: unknown;
  seedProfile?: SeedProfileInput | null;
}

/**
 * Accepts only a case's public projection. A full document (with favors, impact,
 * evidence or the review record) is rejected rather than stripped here: by then
 * it has already been downloaded to every device that runs the demo.
 */
export function toLocalCase(entry: DemoEntry): LocalCaseInput {
  const parsed = PublicCase.safeParse(entry.doc);
  if (!parsed.success) {
    const slug = (entry.doc as { slug?: unknown } | null)?.slug;
    throw new Error(
      `Demo case ${typeof slug === 'string' ? slug : '(no slug)'} is not a public projection: ${parsed.error.issues
        .map((i) => i.message)
        .join('; ')}`,
    );
  }
  return { doc: parsed.data, seedProfile: entry.seedProfile ?? null };
}

export async function loadDemoApi(url: string): Promise<DiveApi> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load demo cases from ${url} (HTTP ${res.status}).`);
  const entries: unknown = await res.json();
  if (!Array.isArray(entries)) throw new Error('Demo cases must be a JSON array of { doc, seedProfile? }.');
  return new LocalDiveApi({ cases: (entries as DemoEntry[]).map(toLocalCase) });
}
