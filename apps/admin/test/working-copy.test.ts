import { describe, expect, it } from 'vitest';
import { validateCase } from '@sia/case-schema';
import {
  addStep,
  citationsBySource,
  domIdCandidates,
  fieldDomId,
  getAt,
  idProblem,
  insertAt,
  isDirty,
  issuesUnder,
  moveAt,
  moveStep,
  newLayer,
  newSource,
  parsePath,
  removeAt,
  removeStep,
  renameFactId,
  renameLayerId,
  renameSideId,
  renameSourceId,
  renameStepId,
  setAt,
  setOptionalText,
  toggleId,
  uniqueId,
  withManagedFields,
} from '@/lib/working-copy';
import { loadFixture, sampleReview } from './helpers';

describe('path helpers', () => {
  it('parses and reads dotted paths', () => {
    expect(parsePath('steps.2.headline')).toEqual(['steps', 2, 'headline']);
    expect(parsePath('')).toEqual([]);
    const doc = loadFixture();
    expect(getAt(doc, parsePath('steps.1.id'))).toBe('s2');
    expect(getAt(doc, ['nope', 3])).toBeUndefined();
  });

  it('sets values immutably, sharing untouched branches', () => {
    const doc = loadFixture();
    const next = setAt(doc, ['steps', 0, 'headline'], 'New headline');
    expect(next).not.toBe(doc);
    expect(next.steps[0]!.headline).toBe('New headline');
    expect(doc.steps[0]!.headline).not.toBe('New headline');
    expect(next.steps[1]).toBe(doc.steps[1]);
    expect(next.sources).toBe(doc.sources);
  });

  it('removes a key when set to undefined, and optional text when blank', () => {
    const doc = setOptionalText(loadFixture(), ['content_warning'], 'Mentions injuries.');
    expect(doc.content_warning).toBe('Mentions injuries.');
    const cleared = setOptionalText(doc, ['content_warning'], '   ');
    expect('content_warning' in cleared).toBe(false);
  });

  it('inserts, removes and moves array items', () => {
    const obj = { list: ['a', 'b', 'c'] };
    expect(insertAt(obj, ['list'], 1, 'x').list).toEqual(['a', 'x', 'b', 'c']);
    expect(insertAt(obj, ['list'], 99, 'x').list).toEqual(['a', 'b', 'c', 'x']);
    expect(removeAt(obj, ['list'], 0).list).toEqual(['b', 'c']);
    expect(removeAt(obj, ['list'], 5)).toBe(obj);
    expect(moveAt(obj, ['list'], 0, 2).list).toEqual(['b', 'c', 'a']);
    expect(moveAt(obj, ['list'], 1, 1)).toBe(obj);
    expect(obj.list).toEqual(['a', 'b', 'c']);
  });
});

describe('step edits keep the order valid', () => {
  it('moves a step and renumbers 1..n', () => {
    const doc = moveStep(loadFixture(), 3, 0);
    expect(doc.steps.map((s) => s.id)).toEqual(['s4', 's1', 's2', 's3']);
    expect(doc.steps.map((s) => s.order)).toEqual([1, 2, 3, 4]);
    expect(validateCase(doc).errors).toEqual([]);
  });

  it('adds a blank step with a fresh id that the validator then asks to fill in', () => {
    const { doc, index } = addStep(loadFixture(), 1);
    expect(index).toBe(2);
    expect(doc.steps[2]!.id).toBe('s5');
    expect(doc.steps.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
    const codes = validateCase(doc).errors.map((e) => `${e.path}:${e.code}`);
    expect(codes).toContain('steps.2.source_ids:step_uncited');
    expect(codes).toContain('steps.2.headline:schema');
  });

  it('removes a step and renumbers', () => {
    const doc = removeStep(loadFixture(), 0);
    expect(doc.steps.map((s) => [s.id, s.order])).toEqual([
      ['s2', 1],
      ['s3', 2],
      ['s4', 3],
    ]);
  });
});

describe('ids', () => {
  it('generates unique ids and checks new ones', () => {
    expect(uniqueId('s', ['s1', 's2', 's4'])).toBe('s3');
    expect(idProblem('s2', ['s1', 's2'], 's1')).toMatch(/already used/);
    expect(idProblem('S 2', ['s1'], 's1')).toMatch(/lowercase/);
    expect(idProblem('s1', ['s1'], 's1')).toBeNull();
    expect(idProblem('s9', ['s1'], 's1')).toBeNull();
  });

  it('toggles ids in a list', () => {
    expect(toggleId(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(toggleId(undefined, 'a', true)).toEqual(['a']);
  });

  it('renames a source everywhere it is cited, and the case stays valid', () => {
    const doc = { ...loadFixture(), review: sampleReview() };
    const before = citationsBySource(doc).get('src-inspection');
    const next = renameSourceId(doc, 'src-inspection', 'src-report');
    expect(next.sources.map((s) => s.id)).toContain('src-report');
    expect(citationsBySource(next).get('src-inspection')).toBeUndefined();
    expect(citationsBySource(next).get('src-report')).toEqual(before);
    expect(next.review.fact_check[0]!.source_id).toBe('src-report');
    expect(validateCase(next).errors).toEqual([]);
  });

  it('renames a side in favors tags and the review record', () => {
    const doc = { ...loadFixture(), review: sampleReview() };
    const next = renameSideId(doc, 'council-not-responsible', 'council-cleared');
    expect(next.steps.filter((s) => s.favors === 'council-cleared').map((s) => s.id)).toEqual(['s3', 's4']);
    expect(next.review.bias_reports[0]!.side_id).toBe('council-cleared');
    expect(validateCase(next).errors).toEqual([]);
  });

  it('renames a step in review references, including layer targets', () => {
    const doc = { ...loadFixture(), review: sampleReview() };
    const next = renameStepId(doc, 's2', 's2b');
    expect(next.steps[1]!.id).toBe('s2b');
    expect(next.review.hard_questions[0]!.step_ids).toEqual(['s1', 's2b']);
    expect(next.review.fact_check.map((r) => r.target)).toContain('layer:s2b/t1');
    expect(next.review.open_issues[2]!.step_id).toBe('s2b');
  });

  it('renames a fact and a layer with their fact-check targets', () => {
    const doc = { ...loadFixture(), review: sampleReview() };
    expect(renameFactId(doc, 'f1', 'f-one').review.fact_check.map((r) => r.target)).toContain('fact:f-one');
    const next = renameLayerId(doc, 1, 't1', 'timeline');
    expect(next.steps[1]!.depth[0]!.id).toBe('timeline');
    expect(next.review.fact_check.map((r) => r.target)).toContain('layer:s2/timeline');
  });
});

describe('new items', () => {
  it('creates blank layers of every kind', () => {
    expect(newLayer('quote', ['q1'], 'src-a')).toMatchObject({ kind: 'quote', id: 'q2', source_id: 'src-a' });
    expect(newLayer('timeline', [], 'src-a')).toMatchObject({ kind: 'timeline', id: 't1', entries: [{ source_ids: ['src-a'] }] });
    expect(newLayer('context', [])).toMatchObject({ kind: 'context', id: 'c1', source_ids: [] });
    expect(newLayer('document', [])).toMatchObject({ kind: 'document', id: 'd1' });
  });

  it('creates a source stamped with the access time', () => {
    const s = newSource(loadFixture(), new Date('2026-10-08T10:00:00Z'));
    expect(s).toMatchObject({ id: 'src1', date: '2026-10-08', accessed_at: '2026-10-08T10:00:00.000Z' });
  });
});

describe('validation issues link to fields', () => {
  it('finds issues under a path', () => {
    const issues = [
      { path: 'steps.1.source_ids', code: 'step_uncited', message: '' },
      { path: 'steps.1.source_ids.0', code: 'unknown_source', message: '' },
      { path: 'steps.10.headline', code: 'schema', message: '' },
    ] as const;
    expect(issuesUnder([...issues], 'steps.1').map((i) => i.path)).toEqual(['steps.1.source_ids', 'steps.1.source_ids.0']);
    expect(issuesUnder([...issues], '')).toHaveLength(3);
  });

  it('builds DOM ids from paths, most specific first', () => {
    expect(fieldDomId('steps.2.headline')).toBe('f-steps-2-headline');
    expect(domIdCandidates('steps.2.source_ids.0')).toEqual([
      'f-steps-2-source_ids-0',
      'f-steps-2-source_ids',
      'f-steps-2',
      'f-steps',
    ]);
  });

  it('detects unsaved edits, ignoring fields the database manages', () => {
    const doc = loadFixture();
    expect(isDirty(doc, structuredClone(doc))).toBe(false);
    expect(isDirty(doc, setAt(doc, ['title'], 'Other'))).toBe(true);
    // A decision appended by a review action, or a status change, is not an edit.
    const decided = setAt(setAt(doc, ['review', 'decisions'], [{ action: 'approve_publish', actor: 'a', at: '2026-10-08T00:00:00Z', version: 1 }]), ['status'], 'published');
    expect(isDirty(doc, decided)).toBe(false);
  });

  it('lays the saved managed fields over a working copy', () => {
    const saved = { ...loadFixture(), review: sampleReview(), status: 'published' as const, version: 3, parent_version: 2 };
    // The working copy starts as the saved document; managed fields edited in it are replaced again.
    const working = setAt({ ...saved, version: 1, status: 'draft' as const }, ['title'], 'Edited');
    const merged = withManagedFields(working, saved);
    expect(merged.title).toBe('Edited');
    expect(merged.version).toBe(3);
    expect(merged.parent_version).toBe(2);
    expect(merged.review).toBe(saved.review);
    const noParent = withManagedFields({ ...working, parent_version: 9 }, { ...saved, parent_version: undefined });
    expect('parent_version' in noParent).toBe(false);
  });
});
