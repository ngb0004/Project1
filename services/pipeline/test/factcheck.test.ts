import { describe, expect, it } from 'vitest';
import type { CaseInput } from '@sia/case-schema';
import { checkCitations } from '../src/factcheck';
import { URLS, memoryStore } from './helpers';

const poll = { prompt: 'Does this change your position?', re_ask_slider: true as const };

/** A small case citing three of the fixture pages. */
function caseFixture(): CaseInput {
  return {
    id: 'c',
    slug: 'maple-county-water-main',
    title: 'The Elm Street water main break',
    status: 'draft',
    version: 1,
    as_of: '2026-10-01',
    question: { prompt: 'How responsible is the council?', scale: { type: 'slider', min: 0, max: 100, left_label: 'Not', right_label: 'Fully' } },
    starting_facts: [
      {
        id: 'f1',
        text: 'The main broke on September 12, 2025.',
        source_ids: ['src-news'],
        confidence: 'reported',
        evidence: [{ source_id: 'src-news', quote: 'The Elm Street water main broke on September 12, 2025' }],
      },
    ],
    steps: [
      {
        id: 's1',
        order: 1,
        headline: 'The council voted 5-4 to postpone the replacement.',
        body: 'The council postponed the project. It moved it to 2027.',
        depth: [{ kind: 'quote', id: 'q1', text: 'We made the best choice we could with the money we had', speaker: 'Dana Price', source_id: 'src-news' }],
        source_ids: ['src-minutes', 'src-news'],
        confidence: 'established',
        evidence: [
          { source_id: 'src-minutes', quote: 'The council voted 5-4 to postpone the replacement project to the 2027 budget.' },
          { source_id: 'src-news', quote: 'the section the council had postponed replacing' },
        ],
        micro_poll: poll,
      },
      {
        id: 's2',
        order: 2,
        headline: 'State grants fell 40 percent.',
        body: 'The state cut grants. The county got less.',
        depth: [{ kind: 'context', id: 'c1', title: 'Grants', body: 'Background on grants.', source_ids: ['src-grants'] }],
        source_ids: ['src-grants'],
        confidence: 'established',
        evidence: [{ source_id: 'src-grants', quote: "Maple County's allocation fell from $2.1 million to $1.26 million." }],
        micro_poll: poll,
      },
    ],
    sides: [
      { id: 'a', label: 'A', steelman: 'A says so.' },
      { id: 'b', label: 'B', steelman: 'B says so.' },
    ],
    open_questions: [],
    sources: [
      { id: 'src-minutes', title: 'Minutes', publisher: 'County', url: URLS.minutes, date: '2025-06-03', type: 'official', accessed_at: '2026-10-01T00:00:00Z' },
      { id: 'src-news', title: 'Break', publisher: 'News', url: URLS.breakNews, date: '2025-09', type: 'news', accessed_at: '2026-10-01T00:00:00Z' },
      { id: 'src-grants', title: 'Grants', publisher: 'State', url: URLS.grants, date: '2025', type: 'official', accessed_at: '2026-10-01T00:00:00Z' },
    ],
  };
}

async function openedStore(urls: string[] = [URLS.minutes, URLS.breakNews, URLS.grants]) {
  const { store } = memoryStore();
  for (const u of urls) await store.open(u, 'researcher', 'a', 0);
  return store;
}

describe('checkCitations', () => {
  it('passes a case whose sources were all opened and whose quotes are all in them', async () => {
    expect(checkCitations(caseFixture(), await openedStore())).toEqual([]);
  });

  it('fails every item citing a source that was not opened in this run', async () => {
    const store = await openedStore([URLS.minutes, URLS.breakNews]);
    const failures = checkCitations(caseFixture(), store);
    expect(failures.map((f) => [f.target, f.source_id, f.verdict])).toEqual([
      ['s2', 'src-grants', 'source_unavailable'],
      ['layer:s2/c1', 'src-grants', 'source_unavailable'],
    ]);
    expect(failures[0]!.note).toContain('was not opened in this run');
  });

  it('a source that was fetched but unusable does not count as opened', async () => {
    const c = caseFixture();
    c.sources[2]!.url = 'https://news.example.com/paywalled';
    const store = await openedStore([URLS.minutes, URLS.breakNews, 'https://news.example.com/paywalled']);
    expect(checkCitations(c, store).filter((f) => f.verdict === 'source_unavailable').map((f) => f.target)).toEqual(['s2', 'layer:s2/c1']);
  });

  it('fails a fabricated quote planted in a step', async () => {
    const c = caseFixture();
    c.steps[0]!.evidence![1] = { source_id: 'src-news', quote: 'Council chair Dana Price admitted the council ignored three written warnings.' };
    const failures = checkCitations(c, await openedStore());
    expect(failures).toEqual([
      expect.objectContaining({ target: 's1', source_id: 'src-news', verdict: 'unsupported', quote: 'Council chair Dana Price admitted the council ignored three written warnings.', confidence_before: 'established' }),
    ]);
  });

  it('tolerates whitespace, curly quote and dash differences, and ellipses for omissions', async () => {
    const c = caseFixture();
    c.steps[0]!.evidence![0]!.quote = '  The council voted 5–4 to postpone\n the replacement   project … 2027 budget. ';
    c.steps[0]!.depth![0] = { kind: 'quote', id: 'q1', text: '“We made the best choice we could with the money we had,”', speaker: 'Dana Price', source_id: 'src-news' };
    expect(checkCitations(c, await openedStore())).toEqual([]);
  });

  it('fails fragments that are out of order or a quote too short to verify', async () => {
    const c = caseFixture();
    c.steps[0]!.evidence![0]!.quote = 'to the 2027 budget ... The council voted 5-4';
    c.steps[1]!.evidence![0]!.quote = '40 percent';
    const failures = checkCitations(c, await openedStore());
    expect(failures.map((f) => [f.target, f.verdict, f.note.includes('too short')])).toEqual([
      ['s1', 'unsupported', false],
      ['s2', 'unsupported', true],
    ]);
  });

  it('marks a cited source without an evidence quote, and a step citing nothing, as uncited', async () => {
    const c = caseFixture();
    c.steps[0]!.evidence = [c.steps[0]!.evidence![0]!]; // no quote from src-news any more
    c.starting_facts[0]!.source_ids = [];
    c.steps[1]!.source_ids = ['src-missing'];
    const failures = checkCitations(c, await openedStore());
    expect(failures.map((f) => [f.target, f.source_id ?? null, f.verdict])).toEqual([
      ['fact:f1', null, 'uncited'],
      ['s1', 'src-news', 'uncited'],
      ['s2', 'src-missing', 'uncited'],
    ]);
  });

  it('checks quote layers verbatim against their source', async () => {
    const c = caseFixture();
    c.steps[0]!.depth![0] = { kind: 'quote', id: 'q1', text: 'We did nothing wrong and would do it again.', speaker: 'Dana Price', source_id: 'src-news' };
    expect(checkCitations(c, await openedStore())).toEqual([expect.objectContaining({ target: 'layer:s1/q1', verdict: 'unsupported' })]);
  });

  it('flags a listed source nobody cites when it was never opened', async () => {
    const c = caseFixture();
    c.sources.push({ id: 'src-extra', title: 'Extra', publisher: 'X', url: 'https://example.org/never-opened', date: '2025', type: 'news', accessed_at: '2026-10-01T00:00:00Z' });
    expect(checkCitations(c, await openedStore())).toEqual([expect.objectContaining({ target: 'source:src-extra', verdict: 'source_unavailable' })]);
  });
});
