import { describe, expect, it } from 'vitest';
import { validateCase, assertValidCase, CaseValidationError, normalizeCase, Case } from '../src/index';
import { FIXTURES, loadFixture } from './helpers';

describe('validateCase', () => {
  it.each(FIXTURES)('accepts fixture %s', (name) => {
    const r = validateCase(loadFixture(name));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.case?.review.decisions).toEqual([]);
  });

  it('rejects a step with no sources (uncited step)', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.steps[1].source_ids = [];
    const r = validateCase(c);
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual(expect.objectContaining({ code: 'step_uncited', path: 'steps.1.source_ids' }));
  });

  it('rejects a step with the source_ids field missing entirely', () => {
    const c = loadFixture('fixture-harbor-bridge');
    delete c.steps[0].source_ids;
    const r = validateCase(c);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'steps.0.source_ids')).toBe(true);
  });

  it('rejects an uncited starting fact', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.starting_facts[0].source_ids = [];
    const r = validateCase(c);
    expect(r.errors).toContainEqual(expect.objectContaining({ code: 'fact_uncited' }));
  });

  it('rejects a citation to a source that does not exist', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.steps[0].source_ids = ['src-made-up'];
    const r = validateCase(c);
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual(expect.objectContaining({ code: 'unknown_source', path: 'steps.0.source_ids.0' }));
  });

  it('rejects depth layers citing unknown sources', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.steps[1].depth[0].entries[0].source_ids = ['nope'];
    expect(validateCase(c).errors).toContainEqual(expect.objectContaining({ code: 'unknown_source' }));
  });

  it('rejects "established" when only news or analysis sources are cited', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.steps[3].confidence = 'established'; // cites only src-news
    const r = validateCase(c);
    expect(r.errors).toContainEqual(expect.objectContaining({ code: 'overstated_confidence', path: 'steps.3.confidence' }));
  });

  it('allows "established" when at least one primary source is cited', () => {
    const c = loadFixture('fixture-harbor-bridge');
    expect(c.steps[2].source_ids).toEqual(['src-state', 'src-news']);
    expect(validateCase(c).ok).toBe(true);
  });

  it('rejects favors that names an unknown side', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.steps[0].favors = 'someone-else';
    expect(validateCase(c).errors).toContainEqual(expect.objectContaining({ code: 'unknown_side' }));
  });

  it('rejects out-of-order steps and duplicate ids', () => {
    const c = loadFixture('fixture-harbor-bridge');
    [c.steps[0], c.steps[1]] = [c.steps[1], c.steps[0]];
    c.sources.push({ ...c.sources[0] });
    const codes = validateCase(c).errors.map((e) => e.code);
    expect(codes).toContain('step_order');
    expect(codes).toContain('duplicate_id');
  });

  it('rejects reserved step ids', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.steps[0].id = 'before';
    expect(validateCase(c).ok).toBe(false);
  });

  it('rejects a slider that is not 0-100', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.question.scale.max = 10;
    expect(validateCase(c).ok).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.surprise = true;
    expect(validateCase(c).ok).toBe(false);
  });

  it('rejects a parent_version that is not older than version', () => {
    const c = loadFixture('fixture-orchard-school');
    c.parent_version = 3;
    expect(validateCase(c).errors).toContainEqual(expect.objectContaining({ code: 'parent_version' }));
  });

  it('rejects evidence that quotes a source the step does not cite', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.steps[0].evidence = [{ source_id: 'src-news', quote: 'x' }];
    expect(validateCase(c).errors).toContainEqual(expect.objectContaining({ code: 'evidence_not_cited' }));
  });

  it('warns on judging words but ignores quoted speech', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.steps[0].headline = 'Inspectors found shocking damage.';
    c.steps[1].body = 'The mayor called it "an appalling vote." The council disagreed. It passed.';
    const r = validateCase(c);
    expect(r.ok).toBe(true);
    const judging = r.warnings.filter((w) => w.code === 'judging_word');
    expect(judging.map((w) => w.path)).toEqual(['steps.0.headline']);
  });

  it('assertValidCase throws CaseValidationError with issues', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.steps[0].source_ids = [];
    expect(() => assertValidCase(c)).toThrow(CaseValidationError);
  });
});

describe('normalizeCase', () => {
  it('sorts steps, renumbers, and downgrades overstated confidence', () => {
    const c = loadFixture('fixture-harbor-bridge');
    c.steps.reverse();
    c.steps.forEach((s: any, i: number) => (s.order = (4 - i) * 10));
    c.steps.find((s: any) => s.id === 's4').confidence = 'established';
    const { case: n, changes } = normalizeCase(c);
    expect(n.steps.map((s: any) => s.id)).toEqual(['s1', 's2', 's3', 's4']);
    expect(n.steps.map((s: any) => s.order)).toEqual([1, 2, 3, 4]);
    expect(n.steps[3].confidence).toBe('reported');
    expect(changes.length).toBeGreaterThan(0);
    expect(validateCase(n).ok).toBe(true);
    // input untouched
    expect(c.steps[0].id).toBe('s4');
  });

  it('never upgrades confidence', () => {
    const c = Case.parse(loadFixture('fixture-harbor-bridge'));
    c.steps[0]!.confidence = 'alleged';
    expect(normalizeCase(c).case.steps[0]!.confidence).toBe('alleged');
  });
});
