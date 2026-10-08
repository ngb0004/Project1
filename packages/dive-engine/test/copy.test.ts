import { describe, expect, it } from 'vitest';
import { CONFIDENCE_LEVELS } from '@sia/case-schema';
import {
  CONFIDENCE_HINT,
  CONFIDENCE_LABEL,
  SHARE_TAGLINE,
  caseUrl,
  crowdCountText,
  estimateMinutes,
  formatDate,
  mirrorText,
  seededNoteText,
  shareCardData,
  shareHeadline,
  shareText,
  versionNoteText,
} from '../src/copy';
import { LocalDiveApi } from '../src/local';
import { isFinalReveal } from '../src/types';
import { FIXTURES, deviceId, loadFixture } from './helpers';

describe('personal mirror', () => {
  it('says how far the user moved, or that they did not', () => {
    expect(mirrorText(90, 75)).toBe('You moved from 90 to 75.');
    expect(mirrorText(20, 35)).toBe('You moved from 20 to 35.');
    expect(mirrorText(60, 60)).toBe("This didn't move you.");
  });
});

describe('estimateMinutes', () => {
  const words = (n: number) => Array(n).fill('word').join(' ');
  const doc = (stepWords: number[], factWords = 0, promptWords = 0) => ({
    question: { prompt: words(promptWords), scale: { type: 'slider' as const, min: 0 as const, max: 100 as const, left_label: 'a', right_label: 'b' } },
    starting_facts: [{ id: 'f', text: words(factWords), source_ids: ['x'], confidence: 'established' as const }],
    steps: stepWords.map((n, i) => ({
      id: `s${i}`,
      order: i + 1,
      headline: '',
      body: words(n),
      depth: [],
      source_ids: ['x'],
      confidence: 'established' as const,
      micro_poll: { prompt: 'p', re_ask_slider: true as const },
    })),
  });

  it('reads at 220 words a minute plus about 12 seconds per poll', () => {
    // 660 words = 3 min; 3 steps + before + after = 5 polls = 1 min
    expect(estimateMinutes(doc([220, 220, 200], 10, 10))).toBe(4);
    expect(estimateMinutes(doc([1]))).toBe(1);
  });

  it.each(FIXTURES)('gives whole minutes for a real case (%s)', (name) => {
    const minutes = estimateMinutes(loadFixture(name));
    expect(Number.isInteger(minutes)).toBe(true);
    expect(minutes).toBeGreaterThanOrEqual(1);
  });
});

describe('formatDate', () => {
  it('formats plain dates without timezone drift', () => {
    expect(formatDate('2026-10-07')).toBe('Oct 7, 2026');
    expect(formatDate('2026-01-01', { year: false })).toBe('Jan 1');
    expect(formatDate('2026-12-31T23:30:00-08:00')).toBe('Dec 31, 2026');
    expect(formatDate('2026-10')).toBe('Oct 2026');
    expect(formatDate('soon')).toBe('soon');
  });
});

describe('versionNoteText', () => {
  const note = (earlier: { version: number; completions: number }[], published_at: string | null = '2026-10-12T09:00:00+00:00') => ({
    version: earlier.length + 1,
    published_at,
    parent_version: earlier.length || null,
    earlier_versions: earlier.map((e) => ({ ...e, published_at: '2026-10-01T09:00:00+00:00' })),
  });

  it('is silent for a first version', () => {
    expect(versionNoteText(note([]))).toBeNull();
    expect(versionNoteText(null)).toBeNull();
    expect(versionNoteText(note([{ version: 1, completions: 5 }], null))).toBeNull();
  });

  it('counts the people who saw earlier versions', () => {
    expect(versionNoteText(note([{ version: 1, completions: 3104 }]))).toBe('Updated Oct 12; 3,104 people saw the earlier version.');
    expect(versionNoteText(note([{ version: 1, completions: 1 }]))).toBe('Updated Oct 12; 1 person saw the earlier version.');
    expect(
      versionNoteText(
        note([
          { version: 1, completions: 10 },
          { version: 2, completions: 5 },
        ]),
      ),
    ).toBe('Updated Oct 12; 15 people saw earlier versions.');
  });

  it('leaves out the count when no one finished an earlier version', () => {
    expect(versionNoteText(note([{ version: 1, completions: 0 }]))).toBe('Updated Oct 12.');
  });
});

describe('seeded and crowd-size notes', () => {
  it('flags any seeded share, and says so plainly when the crowd is all seeded', () => {
    expect(seededNoteText(0)).toBeNull();
    expect(seededNoteText(1)).toBe('Early estimate: these crowd numbers are seeded until more people finish.');
    expect(seededNoteText(0.996)).toBe('Early estimate: these crowd numbers are seeded until more people finish.');
    expect(seededNoteText(0.42)).toBe('Includes seeded estimates (42% of this crowd) until more people finish.');
    expect(seededNoteText(0.001)).toBe('Includes seeded estimates (0% of this crowd) until more people finish.');
  });

  it('counts readers', () => {
    expect(crowdCountText(0)).toBe('No readers yet');
    expect(crowdCountText(1)).toBe('1 reader');
    expect(crowdCountText(1234)).toBe('1,234 readers');
  });
});

describe('confidence labels', () => {
  it('covers every confidence level', () => {
    for (const c of CONFIDENCE_LEVELS) {
      expect(CONFIDENCE_LABEL[c]).toBeTruthy();
      expect(CONFIDENCE_HINT[c]).toBeTruthy();
    }
  });
});

describe('share card', () => {
  it('builds the personal shift line', () => {
    expect(shareHeadline(95, 70)).toBe('I started at 95. I ended at 70.');
    expect(shareText(95, 70, 'https://x.test/case/a')).toBe(`I started at 95. I ended at 70. ${SHARE_TAGLINE} https://x.test/case/a`);
    expect(SHARE_TAGLINE).toBe('Find where you break.');
  });

  it('deep-links into the case', () => {
    expect(caseUrl('https://x.test/', 'my-case')).toBe('https://x.test/case/my-case');
    expect(caseUrl('https://x.test//', 'a b')).toBe('https://x.test/case/a%20b');
    expect(caseUrl('dive://', 'my-case')).toBe('dive://case/my-case');
  });

  it.each(FIXTURES)('takes its words from the record and its numbers from the final reveal (%s)', async (name) => {
    const doc = loadFixture(name);
    const api = new LocalDiveApi({ cases: [{ doc }] });
    const s = await api.startSession(doc.id, doc.version, deviceId());
    const values = [95, ...doc.steps.map((_, i) => 90 - i * 5), 70];
    let last;
    for (const [i, slot] of ['before', ...doc.steps.map((x) => x.id), 'after'].entries()) {
      last = await api.submit(s.session_id, slot, values[i]!);
    }
    if (!last || !isFinalReveal(last)) throw new Error('expected the final reveal');
    const url = caseUrl('https://example.test', doc.slug);
    const card = shareCardData(doc, last, url);
    expect(card).toEqual({
      before: 95,
      after: 70,
      title: doc.title,
      question: doc.question.prompt,
      leftLabel: doc.question.scale.left_label,
      rightLabel: doc.question.scale.right_label,
      crowdAfter: last.crowd.after_histogram,
      seeded: false,
      url,
      headline: 'I started at 95. I ended at 70.',
      tagline: SHARE_TAGLINE,
    });
  });

  it('draws no crowd when no completion is counted yet', async () => {
    const doc = loadFixture(FIXTURES[0]!);
    const api = new LocalDiveApi({ cases: [{ doc }] });
    const s = await api.startSession(doc.id, doc.version, deviceId());
    let last;
    for (const slot of ['before', ...doc.steps.map((x) => x.id), 'after']) last = await api.submit(s.session_id, slot, 50);
    if (!last || !isFinalReveal(last)) throw new Error('expected the final reveal');
    // What the database sends when the reader's own session falls under the reading-time floor.
    const empty = { ...last, crowd: { ...last.crowd, n_real: 0, mean_before: null, mean_after: null, after_histogram: Array(10).fill(0) } };
    expect(shareCardData(doc, empty, caseUrl('https://example.test', doc.slug)).crowdAfter).toBeNull();
  });
});
