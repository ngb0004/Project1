import type { Case, CaseInput, Confidence, FactCheckVerdict } from '@sia/case-schema';
import type { SourceStore } from './research/store';
import { matchQuote } from './research/text';

/**
 * The deterministic layer of the fact-check. It needs no model and cannot be
 * talked out of a verdict:
 *
 * - every source the case cites was opened in this run (matched on the
 *   requested or final URL of a snapshot);
 * - every step and starting fact has an evidence quote from each source it cites;
 * - every evidence quote, and every quote layer, appears verbatim in a snapshot
 *   of that source (whitespace, quote marks and dashes normalized; an ellipsis
 *   marks an omission).
 *
 * It returns only failures, as fact-check rows.
 */

export type CitationVerdict = Extract<FactCheckVerdict, 'uncited' | 'unsupported' | 'source_unavailable'>;

export interface CitationFailure {
  /** Step id, `fact:<id>`, `layer:<step>/<layer>`, or `source:<id>` for a listed source nothing cites. */
  target: string;
  claim: string;
  source_id?: string;
  verdict: CitationVerdict;
  quote?: string;
  note: string;
  confidence_before?: Confidence;
}

type Evidence = { source_id: string; quote: string };
type AnyCase = Case | CaseInput;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function checkCitations(input: AnyCase, store: SourceStore): CitationFailure[] {
  const c = input as Partial<Case>;
  const out: CitationFailure[] = [];
  const sources = new Map((c.sources ?? []).map((s) => [s.id, s]));
  const snapshotsOf = (sourceId: string) => {
    const src = sources.get(sourceId);
    return src ? store.findAllByUrl(src.url) : [];
  };
  const cited = new Set<string>();

  const fail = (f: Omit<CitationFailure, 'claim'> & { claim: string }) =>
    out.push({ ...f, claim: clip(f.claim.trim() || f.target, 2000), ...(f.quote ? { quote: clip(f.quote, 1500) } : {}) });

  /** Checks that a cited source exists and was opened; returns its snapshots' texts, or null after logging a failure. */
  const opened = (target: string, claim: string, sid: string, confidence?: Confidence): string[] | null => {
    cited.add(sid);
    const src = sources.get(sid);
    const base = { target, claim, source_id: sid, ...(confidence ? { confidence_before: confidence } : {}) };
    if (!src) {
      fail({ ...base, verdict: 'uncited', note: `Cites source "${sid}", which is not in the source list.` });
      return null;
    }
    const snaps = snapshotsOf(sid);
    if (snaps.length === 0) {
      fail({ ...base, verdict: 'source_unavailable', note: `Source "${sid}" (${src.url}) was not opened in this run.` });
      return null;
    }
    return snaps.map((s) => s.text);
  };

  const checkQuote = (target: string, claim: string, sid: string, quote: string, texts: string[], confidence?: Confidence) => {
    const results = texts.map((t) => matchQuote(quote, t));
    if (results.some((r) => r.ok)) return;
    const tooShort = results.some((r) => !r.ok && r.reason === 'too_short');
    fail({
      target,
      claim,
      source_id: sid,
      verdict: 'unsupported',
      quote,
      note: tooShort
        ? `The quote from "${sid}" is too short to verify.`
        : `The quote does not appear in the snapshot of "${sid}".`,
      ...(confidence ? { confidence_before: confidence } : {}),
    });
  };

  /** A step or starting fact: each cited source needs at least one quote, and every quote must be in it. */
  const checkItem = (target: string, claim: string, sourceIds: string[] | undefined, evidence: Evidence[] | undefined, confidence?: Confidence) => {
    const ids = sourceIds ?? [];
    if (ids.length === 0) {
      fail({ target, claim, verdict: 'uncited', note: 'Cites no source.', ...(confidence ? { confidence_before: confidence } : {}) });
      return;
    }
    for (const sid of ids) {
      const texts = opened(target, claim, sid, confidence);
      if (!texts) continue;
      const quotes = (evidence ?? []).filter((e) => e.source_id === sid);
      if (quotes.length === 0) {
        fail({
          target,
          claim,
          source_id: sid,
          verdict: 'uncited',
          note: `No evidence quote from "${sid}" backs this claim.`,
          ...(confidence ? { confidence_before: confidence } : {}),
        });
        continue;
      }
      for (const e of quotes) checkQuote(target, claim, sid, e.quote, texts, confidence);
    }
  };

  for (const f of c.starting_facts ?? []) {
    checkItem(`fact:${f.id}`, f.text, f.source_ids, f.evidence, f.confidence);
  }

  for (const s of c.steps ?? []) {
    checkItem(s.id, s.headline || s.body, s.source_ids, s.evidence, s.confidence);
    for (const layer of s.depth ?? []) {
      const target = `layer:${s.id}/${layer.id}`;
      switch (layer.kind) {
        case 'document':
          opened(target, layer.title, layer.source_id);
          break;
        case 'quote': {
          const texts = opened(target, layer.text, layer.source_id);
          if (texts) checkQuote(target, `${layer.speaker}: ${layer.text}`, layer.source_id, layer.text, texts);
          break;
        }
        case 'context':
          for (const sid of layer.source_ids ?? []) opened(target, layer.title, sid);
          break;
        case 'timeline':
          for (const e of layer.entries ?? []) for (const sid of e.source_ids ?? []) opened(target, e.text, sid);
          break;
      }
    }
  }

  for (const src of c.sources ?? []) {
    if (cited.has(src.id)) continue;
    if (store.findAllByUrl(src.url).length === 0) {
      fail({
        target: `source:${src.id}`,
        claim: src.title,
        source_id: src.id,
        verdict: 'source_unavailable',
        note: `Source "${src.id}" (${src.url}) is listed but was not opened in this run.`,
      });
    }
  }

  return out;
}

/** A stable key for comparing failures between two versions of a draft. */
export function failureKey(f: Pick<CitationFailure, 'target' | 'source_id' | 'verdict' | 'quote'>): string {
  return [f.target, f.source_id ?? '', f.verdict, f.quote ?? ''].join('\u0000');
}
