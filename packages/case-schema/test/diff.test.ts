import { describe, expect, it } from 'vitest';
import {
  assertValidCase,
  diffCases,
  diffText,
  summarizeDiff,
  toPublicCase,
  tokenizeText,
  type Case,
  type CaseDiff,
  type ItemDiff,
  type TextOp,
} from '../src/index';
import { loadFixture } from './helpers';

const harbor = (): Case => assertValidCase(loadFixture('fixture-harbor-bridge'));
const orchard = (): Case => assertValidCase(loadFixture('fixture-orchard-school'));

/** Reassemble each side from the ops; both must round-trip exactly. */
function sides(ops: TextOp[]): { before: string; after: string } {
  return {
    before: ops.filter((o) => o.op !== 'insert').map((o) => o.text).join(''),
    after: ops.filter((o) => o.op !== 'delete').map((o) => o.text).join(''),
  };
}

/** Compact rendering for readable assertions: [-del-]{+ins+}. */
function render(ops: TextOp[]): string {
  return ops.map((o) => (o.op === 'equal' ? o.text : o.op === 'delete' ? `[-${o.text}-]` : `{+${o.text}+}`)).join('');
}

function expectWellFormed(ops: TextOp[], before: string, after: string) {
  expect(sides(ops)).toEqual({ before, after });
  for (const o of ops) expect(o.text.length).toBeGreaterThan(0);
  // Adjacent ops never share a kind, and a change span is always delete then insert.
  for (let i = 1; i < ops.length; i++) {
    expect(ops[i]!.op).not.toBe(ops[i - 1]!.op);
    expect(ops[i - 1]!.op === 'insert' && ops[i]!.op === 'delete').toBe(false);
  }
}

const byId = (items: ItemDiff[], id: string): ItemDiff => {
  const d = items.find((x) => x.id === id);
  if (!d) throw new Error(`no item ${id}`);
  return d;
};

/** Renumber steps 1..n after array surgery so the case stays valid. */
const renumber = (c: Case) => c.steps.forEach((s, i) => (s.order = i + 1));

const newStep = (id: string, sourceId: string): Case['steps'][number] => ({
  id,
  order: 99,
  headline: `New fact ${id}.`,
  body: 'A new development was reported. This is a fictional test fixture.',
  depth: [],
  favors: 'neutral',
  source_ids: [sourceId],
  confidence: 'reported',
  micro_poll: { statement: 'This new fact matters.' },
});

// ---------------------------------------------------------------------------
// diffText
// ---------------------------------------------------------------------------

describe('tokenizeText', () => {
  it('splits words, whitespace runs and single punctuation marks, losslessly', () => {
    const s = "The council's vote didn't pass,  3-2.\nSee: “minutes”!";
    const t = tokenizeText(s);
    expect(t.join('')).toBe(s);
    expect(t).toEqual([
      'The', ' ', "council's", ' ', 'vote', ' ', "didn't", ' ', 'pass', ',', '  ', '3', '-', '2', '.', '\n',
      'See', ':', ' ', '“', 'minutes', '”', '!',
    ]);
  });

  it('keeps accented and non-Latin words whole', () => {
    expect(tokenizeText('café São Paulo 東京')).toEqual(['café', ' ', 'São', ' ', 'Paulo', ' ', '東京']);
  });
});

describe('diffText', () => {
  it('returns one equal op for identical text and nothing for two empty strings', () => {
    expect(diffText('Same text.', 'Same text.')).toEqual([{ op: 'equal', text: 'Same text.' }]);
    expect(diffText('', '')).toEqual([]);
  });

  it('handles empty on either side', () => {
    expect(diffText('', 'New text')).toEqual([{ op: 'insert', text: 'New text' }]);
    expect(diffText('Old text', '')).toEqual([{ op: 'delete', text: 'Old text' }]);
  });

  it('replaces a single word', () => {
    const ops = diffText('The council voted no.', 'The council voted yes.');
    expect(ops).toEqual([
      { op: 'equal', text: 'The council voted ' },
      { op: 'delete', text: 'no' },
      { op: 'insert', text: 'yes' },
      { op: 'equal', text: '.' },
    ]);
  });

  it('inserts and deletes words without touching neighbours', () => {
    expect(render(diffText('the cat sat', 'the big cat sat'))).toBe('the {+big +}cat sat');
    expect(render(diffText('the big cat sat', 'the cat sat'))).toBe('the [-big -]cat sat');
    expect(render(diffText('cat sat', 'cat sat down'))).toBe('cat sat{+ down+}');
    expect(render(diffText('Finally the cat sat', 'the cat sat'))).toBe('[-Finally -]the cat sat');
  });

  it('treats punctuation as its own token', () => {
    expect(render(diffText('The bridge closed.', 'The bridge closed, then reopened.'))).toBe(
      'The bridge closed{+, then reopened+}.',
    );
    expect(render(diffText('It was closed.', 'It was closed!'))).toBe('It was closed[-.-]{+!+}');
    expect(render(diffText('"Poor," the report said.', '"Fair," the report said.'))).toBe(
      '"[-Poor-]{+Fair+}," the report said.',
    );
  });

  it('matches the right copy of a repeated word', () => {
    expect(render(diffText('the cat sat on the mat', 'the cat sat on the hat'))).toBe('the cat sat on the [-mat-]{+hat+}');
    expect(render(diffText('the the cat', 'the cat'))).toBe('the [-the -]cat');
    expect(render(diffText('no no no', 'no no'))).toBe('no no[- no-]');
    expect(render(diffText('a b a b', 'a b c a b'))).toBe('a b {+c +}a b');
  });

  it('folds a whitespace-only gap between two changes into one replacement', () => {
    expect(diffText('voted no today', 'voted yes tomorrow')).toEqual([
      { op: 'equal', text: 'voted ' },
      { op: 'delete', text: 'no today' },
      { op: 'insert', text: 'yes tomorrow' },
    ]);
  });

  it('keeps a real word between two changes as equal', () => {
    expect(render(diffText('in 2023 the council', 'in 2024 the mayor'))).toBe('in [-2023-]{+2024+} the [-council-]{+mayor+}');
  });

  it('reports whitespace-only edits', () => {
    expect(render(diffText('a b', 'a  b'))).toBe('a[- -]{+  +}b');
    expect(render(diffText('line one\nline two', 'line one line two'))).toBe('line one[-\n-]{+ +}line two');
  });

  it('is well-formed and lossless across a batch of edits', () => {
    const pairs: [string, string][] = [
      ['A 2023 inspection gave the bridge deck a poor rating.', 'A 2023 inspection rated the deck "poor", and a 2024 one agreed.'],
      ['One. Two. Three.', 'Three. Two. One.'],
      ['x y z', 'a b c'],
      ['   leading and trailing   ', 'leading and trailing'],
      ['Mixed, punctuation; here: yes!', 'Mixed punctuation here yes'],
      ['the the the', 'the'],
      ['', '...'],
      ["Don't stop", 'Do not stop'],
    ];
    for (const [b, a] of pairs) {
      expectWellFormed(diffText(b, a), b, a);
      expectWellFormed(diffText(a, b), a, b);
    }
  });

  it('produces a minimal word diff (equal text is maximal)', () => {
    const ops = diffText('one two three four five', 'one three two four five six');
    const equalWords = ops.filter((o) => o.op === 'equal').map((o) => o.text).join('').split(/\s+/).filter(Boolean);
    // LCS of the word sequences has 4 words (one, two|three, four, five).
    expect(equalWords.length).toBe(4);
    expectWellFormed(ops, 'one two three four five', 'one three two four five six');
  });

  it('stays bounded and correct on long text', () => {
    const words = Array.from({ length: 3000 }, (_, i) => `w${i % 97}`);
    const b = words.join(' ');
    const a = words.map((w, i) => (i % 500 === 0 ? 'CHANGED' : w)).join(' ');
    const ops = diffText(b, a);
    expectWellFormed(ops, b, a);
  });
});

// ---------------------------------------------------------------------------
// diffCases
// ---------------------------------------------------------------------------

describe('diffCases', () => {
  it('reports nothing for identical cases', () => {
    const c = harbor();
    const d = diffCases(c, structuredClone(c));
    expect(d.hasChanges).toBe(false);
    expect(d.fields).toEqual([]);
    expect(d.summary).toEqual({ added: 0, removed: 0, changed: 0, moved: 0 });
    for (const list of [d.startingFacts, d.steps, d.sides, d.sources]) {
      expect(list.every((x) => x.status === 'unchanged' && !x.moved && x.changes.length === 0)).toBe(true);
    }
    expect(d.steps.map((s) => [s.id, s.beforeIndex, s.afterIndex])).toEqual([
      ['s1', 0, 0],
      ['s2', 1, 1],
      ['s3', 2, 2],
      ['s4', 3, 3],
    ]);
    expect(d.sources).toHaveLength(6);
    expect(d.takes).toHaveLength(3);
    expect(d.startingFacts).toHaveLength(2);
    expect(d.sides).toHaveLength(2);
    expect(summarizeDiff(d, c)).toBe('No changes.');
  });

  it('ignores the review record, status, version numbers and key order', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.status = 'in_review';
    b.version = 2;
    b.parent_version = 1;
    b.review.decisions.push({ action: 'admin_edit', actor: 'owner', at: '2026-10-08T12:00:00Z', version: 2 });
    b.review.open_issues.push({ id: 'x', source: 'admin', severity: 'low', description: 'note', resolved: false });
    b.steps[0] = Object.fromEntries(Object.entries(b.steps[0]!).reverse()) as Case['steps'][number];
    expect(diffCases(a, b).hasChanges).toBe(false);
  });

  it('reports top-level field changes with text diffs', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.title = 'FIXTURE: The Harbor Bridge Reopening';
    b.as_of = '2026-10-08';
    b.question.prompt = 'The city council is to blame for the bridge closing.';
    b.question.scale.left_label = 'Strongly disagree';
    b.question.scale.right_label = 'Strongly agree';
    const d = diffCases(a, b);
    expect(d.fields.map((f) => f.path)).toEqual([
      'title',
      'as_of',
      'question.prompt',
      'question.scale.left_label',
      'question.scale.right_label',
    ]);
    const title = d.fields[0]!;
    expect(title.label).toBe('Title');
    expect(title.before).toBe('FIXTURE: The Harbor Bridge Closure');
    expect(render(title.text!)).toBe('FIXTURE: The Harbor Bridge [-Closure-]{+Reopening+}');
    expect(render(d.fields[2]!.text!)).toBe('The city council is to blame for the [-harbor -]bridge closing.');
    expect(render(d.fields[3]!.text!)).toBe('[-Disagree-]{+Strongly disagree+}');
    expect(d.fields[4]!.label).toBe('Slider right label');
    expect(d.hasChanges).toBe(true);
    expect(d.summary).toEqual({ added: 0, removed: 0, changed: 0, moved: 0 });
    expect(summarizeDiff(d, b)).toBe(
      'Title changed, as-of date changed from 2026-09-30 to 2026-10-08, question changed, slider left label changed, slider right label changed.',
    );
  });

  it('reports a content warning being added, edited and removed', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.content_warning = 'Describes a serious injury.';
    let d = diffCases(a, b);
    expect(d.fields).toEqual([
      { path: 'content_warning', label: 'Content warning', before: undefined, after: 'Describes a serious injury.' },
    ]);
    expect(d.fields[0]!.text).toBeUndefined();
    expect(summarizeDiff(d, b)).toBe('Content warning added.');

    d = diffCases(b, a);
    expect(d.fields[0]!.after).toBeUndefined();
    expect(summarizeDiff(d, a)).toBe('Content warning removed.');

    const c = structuredClone(b);
    c.content_warning = 'Describes a serious injury to a worker.';
    d = diffCases(b, c);
    expect(render(d.fields[0]!.text!)).toBe('Describes a serious injury{+ to a worker+}.');
    expect(summarizeDiff(d, c)).toBe('Content warning changed.');
  });

  it('reports open questions as one list change', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.open_questions = [a.open_questions[1]!, 'Who pays for the new deck?'];
    const d = diffCases(a, b);
    expect(d.fields).toHaveLength(1);
    const f = d.fields[0]!;
    expect(f.path).toBe('open_questions');
    expect(f.label).toBe('Open questions');
    expect(f.before).toEqual(a.open_questions);
    expect(f.after).toEqual(b.open_questions);
    expect(f.text).toBeUndefined();
    expect(summarizeDiff(d, b)).toBe('Open questions changed (1 added, 1 removed).');

    const r = structuredClone(a);
    r.open_questions = [...a.open_questions].reverse();
    expect(summarizeDiff(diffCases(a, r), r)).toBe('Open questions changed (reordered).');

    const e = structuredClone(a);
    e.open_questions = [];
    expect(summarizeDiff(diffCases(a, e), e)).toBe('Open questions changed (2 removed).');
  });

  it('reports an edited step headline and body with text diffs', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.steps[2]!.headline = b.steps[2]!.headline.replace(/\.$/, ' in 2024.');
    b.steps[2]!.body = `${b.steps[2]!.body} A second sentence.`;
    const d = diffCases(a, b);
    const s3 = byId(d.steps, 's3');
    expect(s3.status).toBe('changed');
    expect(s3.moved).toBe(false);
    expect(s3.changes.map((c) => [c.path, c.label])).toEqual([
      ['headline', 'Headline'],
      ['body', 'Body'],
    ]);
    expect(s3.changes[0]!.text!.filter((o) => o.op !== 'equal')).toEqual([{ op: 'insert', text: ' in 2024' }]);
    expect(d.steps.filter((s) => s.id !== 's3').every((s) => s.status === 'unchanged')).toBe(true);
    expect(d.summary).toEqual({ added: 0, removed: 0, changed: 1, moved: 0 });
    expect(summarizeDiff(d, b)).toBe('1 step changed (s3 headline and body).');
  });

  it('reports confidence, favors, impact and source changes', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.steps[0]!.confidence = 'reported';
    b.steps[1]!.favors = 'neutral';
    b.steps[1]!.impact = 'low';
    b.steps[3]!.source_ids = [...b.steps[3]!.source_ids, 'src-news'];
    delete b.steps[3]!.impact;
    const d = diffCases(a, b);

    const s1 = byId(d.steps, 's1');
    expect(s1.changes).toEqual([{ path: 'confidence', label: 'Confidence', before: 'established', after: 'reported', text: expect.any(Array) }]);

    const s2 = byId(d.steps, 's2');
    expect(s2.changes.map((c) => [c.path, c.before, c.after])).toEqual([
      ['favors', 'council-responsible', 'neutral'],
      ['impact', a.steps[1]!.impact, 'low'],
    ]);

    const s4 = byId(d.steps, 's4');
    expect(s4.changes.map((c) => c.path)).toEqual(['impact', 'source_ids']);
    const impact = s4.changes[0]!;
    expect(impact.before).toBe(a.steps[3]!.impact);
    expect(impact.after).toBeUndefined();
    expect(impact.text).toBeUndefined();
    const srcs = s4.changes[1]!;
    expect(srcs.label).toBe('Sources');
    expect(srcs.before).toEqual(a.steps[3]!.source_ids);
    expect(srcs.after).toEqual([...a.steps[3]!.source_ids, 'src-news']);
    expect(srcs.text).toBeUndefined();

    expect(d.summary.changed).toBe(3);
    expect(summarizeDiff(d, b)).toBe('3 steps changed (s1 confidence, s2 favors and impact, s4 impact and sources).');
  });

  it('reports evidence quote edits per item and evidence list changes as a whole', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.steps[0]!.evidence![0]!.quote = 'deck condition: poor (rated 4 of 9)';
    let s1 = byId(diffCases(a, b).steps, 's1');
    expect(s1.changes.map((c) => [c.path, c.label])).toEqual([['evidence.0.quote', 'Evidence › 1 › Quote']]);
    expect(render(s1.changes[0]!.text!)).toBe('deck condition: poor{+ (rated 4 of 9)+}');

    const c = structuredClone(a);
    c.steps[0]!.evidence!.push({ source_id: 'src-inspection', quote: 'repair within two years' });
    s1 = byId(diffCases(a, c).steps, 's1');
    expect(s1.changes.map((x) => x.path)).toEqual(['evidence']);
    expect((s1.changes[0]!.after as unknown[]).length).toBe(2);
  });

  it('reports depth layer edits, additions, removals and reorders', () => {
    const a = harbor();
    const b = structuredClone(a);
    const s1 = b.steps[0]!;
    const doc = s1.depth[0]!;
    if (doc.kind !== 'document') throw new Error('fixture changed');
    doc.summary = doc.summary.replace('three', 'four');
    s1.depth.push({ kind: 'quote', id: 'q9', text: 'We knew.', speaker: 'An inspector', source_id: 'src-inspection' });
    // s2: timeline entry text edited.
    const tl = b.steps[1]!.depth[0]!;
    if (tl.kind !== 'timeline') throw new Error('fixture changed');
    tl.entries[0]!.text = `${tl.entries[0]!.text} (amended)`;
    // s3: its only layer removed.
    b.steps[2]!.depth = [];

    const d = diffCases(a, b);
    const d1 = byId(d.steps, 's1');
    expect(d1.changes.map((c) => [c.path, c.label])).toEqual([
      ['depth.d1.summary', 'Depth › d1 › Summary'],
      ['depth.q9', 'Depth › q9'],
    ]);
    expect(d1.changes[0]!.text!.filter((o) => o.op !== 'equal')).toEqual([
      { op: 'delete', text: 'three' },
      { op: 'insert', text: 'four' },
    ]);
    expect(d1.changes[1]!.before).toBeUndefined();
    expect(d1.changes[1]!.after).toMatchObject({ kind: 'quote', id: 'q9' });

    const d2 = byId(d.steps, 's2');
    expect(d2.changes.map((c) => c.path)).toEqual(['depth.t1.entries.0.text']);
    expect(d2.changes[0]!.label).toBe('Depth › t1 › Entries › 1 › Text');

    const d3 = byId(d.steps, 's3');
    expect(d3.changes.map((c) => [c.path, c.after])).toEqual([['depth.q1', undefined]]);

    expect(summarizeDiff(d, b)).toBe('3 steps changed (s1 depth, s2 depth, s3 depth).');

    // Reorder two layers within a step.
    const c = structuredClone(b);
    c.steps[0]!.depth.reverse();
    const r = byId(diffCases(b, c).steps, 's1');
    expect(r.changes).toEqual([
      { path: 'depth', label: 'Depth › order', before: ['d1', 'q9'], after: ['q9', 'd1'] },
    ]);
  });

  it('reports a depth layer that changed kind as one replacement', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.steps[0]!.depth[0] = { kind: 'context', id: 'd1', title: 'Context', body: 'Some context.', source_ids: ['src-inspection'] };
    const s1 = byId(diffCases(a, b).steps, 's1');
    expect(s1.changes.map((c) => c.path)).toEqual(['depth.d1']);
    expect(s1.changes[0]!.before).toMatchObject({ kind: 'document' });
    expect(s1.changes[0]!.after).toMatchObject({ kind: 'context' });
  });

  it('reports a fact-vote statement change', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.steps[1]!.micro_poll.statement = 'The council made the right call.';
    const s2 = byId(diffCases(a, b).steps, 's2');
    expect(s2.changes.map((c) => [c.path, c.label])).toEqual([['micro_poll.statement', 'Fact vote › Statement']]);
    expect(summarizeDiff(diffCases(a, b), b)).toBe('1 step changed (s2 fact vote).');
  });

  it('reports a changed online take', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.takes[2]!.checks[0]!.verdict = 'not_backed';
    const d = diffCases(a, b);
    expect(byId(d.takes, 'right').status).toBe('changed');
    expect(summarizeDiff(d, b)).toBe('1 online take changed (right checks).');
  });

  it('reports an added step without marking later steps as changed', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.steps.splice(1, 0, newStep('s9', 'src-news'));
    renumber(b);
    const d = diffCases(a, b);
    expect(d.steps.map((s) => [s.id, s.status, s.beforeIndex, s.afterIndex, s.moved])).toEqual([
      ['s1', 'unchanged', 0, 0, false],
      ['s9', 'added', null, 1, false],
      ['s2', 'unchanged', 1, 2, false],
      ['s3', 'unchanged', 2, 3, false],
      ['s4', 'unchanged', 3, 4, false],
    ]);
    expect(d.steps.find((s) => s.id === 's9')!.changes).toEqual([]);
    expect(d.summary).toEqual({ added: 1, removed: 0, changed: 0, moved: 0 });
    expect(summarizeDiff(d, b)).toBe('1 step added (s9).');
  });

  it('reports a removed step in its old place', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.steps.splice(1, 1);
    renumber(b);
    const d = diffCases(a, b);
    expect(d.steps.map((s) => [s.id, s.status, s.beforeIndex, s.afterIndex])).toEqual([
      ['s1', 'unchanged', 0, 0],
      ['s2', 'removed', 1, null],
      ['s3', 'unchanged', 2, 1],
      ['s4', 'unchanged', 3, 2],
    ]);
    expect(d.summary).toEqual({ added: 0, removed: 1, changed: 0, moved: 0 });
    expect(summarizeDiff(d, b)).toBe('1 step removed (s2).');

    // Removing the first item puts it first.
    const c = structuredClone(a);
    c.steps.splice(0, 1);
    renumber(c);
    expect(diffCases(a, c).steps.map((s) => [s.id, s.status])).toEqual([
      ['s1', 'removed'],
      ['s2', 'unchanged'],
      ['s3', 'unchanged'],
      ['s4', 'unchanged'],
    ]);
  });

  it('flags only the step that moved', () => {
    const a = harbor();
    const b = structuredClone(a);
    const [s4] = b.steps.splice(3, 1);
    b.steps.unshift(s4!);
    renumber(b);
    const d = diffCases(a, b);
    expect(d.steps.map((s) => [s.id, s.status, s.beforeIndex, s.afterIndex, s.moved])).toEqual([
      ['s4', 'unchanged', 3, 0, true],
      ['s1', 'unchanged', 0, 1, false],
      ['s2', 'unchanged', 1, 2, false],
      ['s3', 'unchanged', 2, 3, false],
    ]);
    expect(d.summary).toEqual({ added: 0, removed: 0, changed: 0, moved: 1 });
    expect(d.hasChanges).toBe(true);
    expect(summarizeDiff(d, b)).toBe('1 step moved (s4 now step 1).');
  });

  it('flags one step for an adjacent swap', () => {
    const a = harbor();
    const b = structuredClone(a);
    [b.steps[1], b.steps[2]] = [b.steps[2]!, b.steps[1]!];
    renumber(b);
    const d = diffCases(a, b);
    expect(d.summary.moved).toBe(1);
    expect(d.steps.map((s) => s.id)).toEqual(['s1', 's3', 's2', 's4']);
    expect(d.steps.filter((s) => s.moved).map((s) => s.id)).toEqual(['s2']);
  });

  it('counts a moved and edited step in both changed and moved', () => {
    const a = harbor();
    const b = structuredClone(a);
    const [s1] = b.steps.splice(0, 1);
    s1!.headline = 'Inspectors rated the deck poor in 2023.';
    b.steps.push(s1!);
    renumber(b);
    const d = diffCases(a, b);
    const m = byId(d.steps, 's1');
    expect(m).toMatchObject({ status: 'changed', moved: true, beforeIndex: 0, afterIndex: 3 });
    expect(m.changes.map((c) => c.path)).toEqual(['headline']);
    expect(d.summary).toEqual({ added: 0, removed: 0, changed: 1, moved: 1 });
    expect(summarizeDiff(d, b)).toBe('1 step changed (s1 headline), 1 step moved (s1 now step 4).');
  });

  it('places a removed item after its nearest kept, unmoved predecessor', () => {
    const a = orchard();
    const b = structuredClone(a);
    // Remove 'epipen' (index 2), move 'menu-label' (index 0) to the end, add a new step at the front.
    b.steps = [newStep('new-first', 'src-news-1'), ...b.steps.filter((s) => s.id !== 'epipen' && s.id !== 'menu-label'), b.steps[0]!];
    renumber(b);
    const d = diffCases(a, b);
    expect(d.steps.map((s) => [s.id, s.status, s.moved])).toEqual([
      ['new-first', 'added', false],
      ['vendor-change', 'unchanged', false],
      ['epipen', 'removed', false],
      ['training', 'unchanged', false],
      ['parent-form', 'unchanged', false],
      ['other-districts', 'unchanged', false],
      ['menu-label', 'unchanged', true],
    ]);
    expect(d.summary).toEqual({ added: 1, removed: 1, changed: 0, moved: 1 });
  });

  it('diffs starting facts, sides and sources by id', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.starting_facts[0]!.text = `${b.starting_facts[0]!.text} Updated.`;
    b.starting_facts.reverse();
    b.sides[1]!.steelman = `${b.sides[1]!.steelman} New point.`;
    b.sources.push({
      id: 'src-new',
      title: 'New report',
      publisher: 'State DOT',
      url: 'https://example.org/new',
      date: '2026-10-01',
      type: 'official',
      accessed_at: '2026-10-08T10:00:00Z',
    });
    b.sources = b.sources.filter((s) => s.id !== 'src-state');
    b.sources[0]!.title = 'Inspection report 2023 (revised)';
    b.sources[1]!.accessed_at = '2026-10-08T10:00:00Z';
    // Keep the case valid: nothing may cite the removed source.
    for (const s of b.steps) s.source_ids = s.source_ids.map((x) => (x === 'src-state' ? 'src-new' : x));
    const d = diffCases(a, b);

    expect(d.startingFacts.map((f) => [f.id, f.status, f.moved])).toEqual([
      ['f2', 'unchanged', false],
      ['f1', 'changed', true],
    ]);
    expect(byId(d.startingFacts, 'f1').changes.map((c) => c.path)).toEqual(['text']);

    expect(byId(d.sides, a.sides[1]!.id).changes.map((c) => [c.path, c.label])).toEqual([['steelman', 'Steelman']]);

    expect(d.sources.map((s) => [s.id, s.status])).toEqual([
      ['src-inspection', 'changed'],
      ['src-charter', 'changed'],
      ['src-minutes', 'unchanged'],
      ['src-state', 'removed'],
      ['src-news', 'unchanged'],
      ['src-post', 'unchanged'],
      ['src-new', 'added'],
    ]);
    expect(byId(d.sources, 'src-charter').changes.map((c) => [c.path, c.label])).toEqual([['accessed_at', 'Accessed']]);

    expect(d.summary).toEqual({ added: 1, removed: 1, changed: 4 + d.steps.filter((s) => s.status === 'changed').length, moved: 1 });
    expect(summarizeDiff(d, b)).toContain('1 starting fact changed (f1 text), 1 starting fact moved (f1 now starting fact 2)');
    expect(summarizeDiff(d, b)).toContain(`1 side changed (${a.sides[1]!.id} steelman)`);
    expect(summarizeDiff(d, b)).toContain(
      '2 sources changed (src-inspection title, src-charter accessed date), 1 source added (src-new), 1 source removed (src-state).',
    );
  });

  it('skips admin-only fields when one side is a PublicCase, but compares shared fields', () => {
    const a = harbor();
    const pub = toPublicCase(a);
    expect(diffCases(a, pub).hasChanges).toBe(false);
    expect(diffCases(pub, a).hasChanges).toBe(false);

    const b = structuredClone(a);
    b.steps[0]!.favors = 'neutral';
    b.steps[0]!.evidence = [];
    b.starting_facts[0]!.evidence = [{ source_id: b.starting_facts[0]!.source_ids[0]!, quote: 'q' }];
    expect(diffCases(a, toPublicCase(b)).hasChanges).toBe(false);
    // Between two full cases the same edits are reported.
    const full = diffCases(a, b);
    expect(byId(full.steps, 's1').changes.map((c) => c.path)).toEqual(['favors', 'evidence']);
    expect(byId(full.startingFacts, 'f1').changes.map((c) => c.path)).toEqual(['evidence']);

    b.steps[0]!.confidence = 'disputed';
    b.steps[0]!.source_ids = ['src-news'];
    b.steps[0]!.depth = [];
    const mixed = diffCases(toPublicCase(a), b);
    expect(byId(mixed.steps, 's1').changes.map((c) => c.path)).toEqual(['confidence', 'source_ids', 'depth.d1']);
    // Two public cases compare the same way.
    expect(byId(diffCases(toPublicCase(a), toPublicCase(b)).steps, 's1').changes.map((c) => c.path)).toEqual([
      'confidence',
      'source_ids',
      'depth.d1',
    ]);
  });

  it('does not mutate its inputs', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.steps.reverse();
    renumber(b);
    b.title = 'Other';
    const aCopy = structuredClone(a);
    const bCopy = structuredClone(b);
    summarizeDiff(diffCases(a, b), b);
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });
});

// ---------------------------------------------------------------------------
// summarizeDiff
// ---------------------------------------------------------------------------

describe('summarizeDiff', () => {
  it('matches the house wording for a typical revision', () => {
    const a = orchard();
    const b = structuredClone(a);
    b.as_of = '2026-10-08';
    b.steps[2]!.headline = `${b.steps[2]!.headline.replace(/\.$/, '')} again.`;
    b.steps[4]!.confidence = 'alleged';
    b.steps.push(newStep('s9', 'src-news-1'));
    renumber(b);
    b.sources.push({
      id: 'src-news-2',
      title: 'Follow-up',
      publisher: 'Local paper',
      url: 'https://example.org/f',
      date: '2026-10-07',
      type: 'news',
      accessed_at: '2026-10-08T09:00:00Z',
    });
    const d = diffCases(a, b);
    expect(summarizeDiff(d, b)).toBe(
      `As-of date changed from ${a.as_of} to 2026-10-08. ` +
        '2 steps changed (epipen headline, parent-form confidence), 1 step added (s9), 1 source added (src-news-2).',
    );
  });

  it('uses semicolons between items when one item lists three or more fields', () => {
    const a = harbor();
    const b = structuredClone(a);
    b.steps[0]!.headline = 'A';
    b.steps[0]!.body = 'B b b.';
    b.steps[0]!.confidence = 'reported';
    b.steps[1]!.headline = 'C';
    expect(summarizeDiff(diffCases(a, b), b)).toBe('2 steps changed (s1 headline, body and confidence; s2 headline).');
  });

  it('names at most six items and counts the rest', () => {
    const a = orchard();
    const b = structuredClone(a);
    for (let i = 0; i < 8; i++) b.steps.push(newStep(`n${i}`, 'src-news-1'));
    renumber(b);
    expect(summarizeDiff(diffCases(a, b), b)).toBe('8 steps added (n0, n1, n2, n3, n4, n5, and 2 more).');
  });

  it('summarizes an empty diff object safely', () => {
    const empty: CaseDiff = {
      fields: [],
      startingFacts: [],
      steps: [],
      sides: [],
      timeline: [],
      takes: [],
      sources: [],
      summary: { added: 0, removed: 0, changed: 0, moved: 0 },
      hasChanges: false,
    };
    expect(summarizeDiff(empty, harbor())).toBe('No changes.');
  });
});
