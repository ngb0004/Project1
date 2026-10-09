import type { Case, CaseInput, Confidence, FactCheckVerdict } from '@sia/case-schema';
import type { SourceStore } from './research/store';
import { isNegation, matchQuote, normalizeForMatch, wordsBeforeQuote } from './research/text';

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
  /** Step id, `fact:<id>`, `layer:<step>/<layer>`, `take:<id>` or `take:<id>/<n>` (a take's nth check), or `source:<id>` for a listed source nothing cites. */
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
  // Publications (news and analysis outlets) in the source list: a quote layer's speaker is never one of them.
  const newsPublishers = (c.sources ?? [])
    .filter((s) => s.type === 'news' || s.type === 'analysis')
    .map((s) => publicationKey(s.publisher))
    .filter((p) => p.length >= 3);

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
          if (!texts) break;
          const before = out.length;
          checkQuote(target, `${layer.speaker}: ${layer.text}`, layer.source_id, layer.text, texts);
          if (out.length === before) {
            const problem = quoteLayerProblem(layer, texts, newsPublishers);
            if (problem) fail({ target, claim: `${layer.speaker}: ${layer.text}`, source_id: layer.source_id, verdict: 'unsupported', quote: layer.text, note: problem });
          }
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

  // Online takes: each must cite where it is being said, and each check is held to the same quote rules as a step.
  for (const t of c.takes ?? []) {
    for (const sid of t.source_ids ?? []) opened(`take:${t.id}`, t.summary, sid);
    (t.checks ?? []).forEach((ch, j) => checkItem(`take:${t.id}/${j + 1}`, ch.claim, ch.source_ids, ch.evidence));
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

const publicationKey = (s: string) => normalizeForMatch(s).toLowerCase().replace(/^the\s+/, '').replace(/[.,]+$/, '');

const NARRATION = /\b(describing|describes|described|reporting|reports|reported|summariz\w*|paraphras\w*|according to|as quoted|quoted (?:by|in|after))\b/i;

/**
 * Why a quote layer misrepresents its source, or null. A quote layer shows words
 * the named speaker said or wrote, in quotation marks, so it fails when:
 * - its text starts mid-sentence (a lowercase first letter, after any ellipsis);
 * - the word just before it in the source is a negation it cut off;
 * - its speaker is a publication (the text is the outlet's narration or
 *   paraphrase, which belongs in a context layer), or describes narration;
 * - its speaker field carries a note in parentheses or brackets.
 */
export function quoteLayerProblem(layer: { speaker: string; text: string }, snapshots: string[], publications: string[]): string | null {
  const start = layer.text.replace(/^[\s"'\u201c\u2018.\u2026\[\]]+/u, '');
  if (/^\p{Ll}/u.test(start)) {
    return 'Quote layer starts mid-sentence (lowercase first word): a quote layer must start at a sentence or quotation boundary, so readers see the speaker\'s whole statement.';
  }
  const before = snapshots.map((t) => wordsBeforeQuote(layer.text, t)).find((w) => w.length > 0) ?? [];
  if (before.length && before.every(isNegation)) {
    return `Quote layer cuts a negation off its start: the source has "${before[0]}" right before the quoted words, so the layer as shown says the opposite.`;
  }
  const speaker = normalizeForMatch(layer.speaker);
  if (/[()[\]]/.test(speaker)) {
    return 'Quote layer speaker carries a note in parentheses or brackets: the speaker field holds only a name and role.';
  }
  const head = publicationKey(speaker.split(',')[0] ?? speaker);
  const names = (p: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(head);
  if (NARRATION.test(speaker) || publications.some(names)) {
    return `Quote layer speaker "${clip(layer.speaker, 120)}" is a publication or its narration, not the person quoted: a reporter's paraphrase belongs in a context layer.`;
  }
  return null;
}

/** A stable key for comparing failures between two versions of a draft. */
export function failureKey(f: Pick<CitationFailure, 'target' | 'source_id' | 'verdict' | 'quote'>): string {
  return [f.target, f.source_id ?? '', f.verdict, f.quote ?? ''].join('\u0000');
}
