import { describe, expect, it } from 'vitest';
import {
  DEFAULT_START_VALUE,
  buildScreens,
  canAdvance,
  currentScreen,
  currentSlot,
  diveReducer,
  initDive,
  pollDefault,
  progress,
  resumeCursor,
  slotOf,
  slotsOf,
  stepById,
  visibleReveal,
  type DiveAction,
  type DiveState,
} from '../src/flow';
import type { BeforeReveal, Reveal, SessionStart, StepReveal } from '../src/types';
import { loadFixture } from './helpers';

const doc = loadFixture('fixture-harbor-bridge');
const stepIds = doc.steps.map((s) => s.id);
const STEP1 = stepIds[0]!;
const STEP2 = stepIds[1]!;

const run = (state: DiveState, ...actions: DiveAction[]) => actions.reduce(diveReducer, state);

function session(answers: SessionStart['answers'] = []): SessionStart {
  return {
    session_id: 'session-1',
    case_id: doc.id,
    case_version: doc.version,
    resumed: answers.length > 0,
    completed: false,
    answers,
  };
}

function reveal(slot: string, value: number, previous = 50): Reveal {
  if (slot === 'before') return { step_id: 'before', value, locked: false } satisfies BeforeReveal;
  return {
    step_id: slot,
    value,
    previous_value: previous,
    locked: false,
    crowd: {
      step_id: slot,
      n_real: 3,
      n_seed: 0,
      seed_weight: 1,
      seeded_share: 0,
      histogram: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
      previous_histogram: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
      mean_value: 55,
      mean_previous: 55,
      mean_delta: 0,
      moved_share: 0,
      shift: { left_big: 0, left: 0, none: 1, right: 0, right_big: 0 },
    },
    version_note: { version: 1, published_at: null, parent_version: null, earlier_versions: [] },
  } satisfies StepReveal;
}

/** Commits the current screen's slot with `value` the way the app does: start, then the server's reveal. */
function commit(state: DiveState, value: number): DiveState {
  const slot = currentSlot(state)!;
  const previous = pollDefault(state, slot);
  return run(state, { type: 'set_draft', value }, { type: 'commit_start' }, { type: 'commit_success', reveal: reveal(slot, value, previous) });
}

const started = () => run(initDive(doc, doc.id, doc.version), { type: 'session_started', session: session() });
/** Started and moved onto the Before screen. */
const atBefore = () => run(started(), { type: 'next' }, { type: 'next' });

describe('screens', () => {
  it('builds the same fixed sequence for every case: card, facts, before, one per step, after, final, share', () => {
    const screens = buildScreens(doc);
    expect(screens.map((s) => s.kind)).toEqual([
      'case_card',
      'starting_facts',
      'before',
      ...stepIds.map(() => 'step'),
      'after',
      'final',
      'share',
    ]);
    expect(screens.filter((s) => s.kind === 'step')).toEqual(stepIds.map((stepId, index) => ({ kind: 'step', stepId, index })));
    expect(screens.map(slotOf)).toEqual([null, null, 'before', ...stepIds, 'after', null, null]);
    expect(slotsOf(doc)).toEqual(['before', ...stepIds, 'after']);
    expect(stepById(doc, STEP2)?.headline).toBe(doc.steps[1]!.headline);
  });
});

describe('the crowd result stays hidden until the user commits', () => {
  it('visibleReveal is null before commit and set after', () => {
    let s = run(atBefore(), { type: 'set_draft', value: 80 });
    expect(visibleReveal(s, 'before')).toBeNull();
    s = commit(s, 80);
    expect(visibleReveal(s, 'before')).toMatchObject({ step_id: 'before', value: 80 });

    s = run(s, { type: 'next' });
    expect(currentSlot(s)).toBe(STEP1);
    expect(visibleReveal(s, STEP1)).toBeNull();
    s = run(s, { type: 'set_draft', value: 60 }, { type: 'commit_start' });
    expect(s.pending).toBe(true);
    expect(visibleReveal(s, STEP1)).toBeNull(); // still waiting for the server
    s = run(s, { type: 'commit_success', reveal: reveal(STEP1, 60, 80) });
    expect(visibleReveal(s, STEP1)).toMatchObject({ step_id: STEP1, value: 60, previous_value: 80 });
  });

  it('ignores a reveal_loaded for a slot that has not been answered', () => {
    const s = atBefore();
    const after = run(s, { type: 'reveal_loaded', reveal: reveal(STEP1, 10) });
    expect(after).toBe(s);
    expect(after.reveals[STEP1]).toBeUndefined();
    expect(visibleReveal(after, STEP1)).toBeNull();
  });

  it('never shows a stored reveal for an uncommitted slot, even if one got into state', () => {
    const s = { ...atBefore(), reveals: { [STEP1]: reveal(STEP1, 10) } };
    expect(visibleReveal(s, STEP1)).toBeNull();
  });

  it('keeps reveals of resumed answers hidden until they are re-fetched, then shows them', () => {
    let s = run(initDive(doc, doc.id, doc.version), {
      type: 'session_started',
      session: session([
        { step_id: 'before', value: 70 },
        { step_id: STEP1, value: 65 },
      ]),
    });
    expect(visibleReveal(s, STEP1)).toBeNull();
    s = run(s, { type: 'reveal_loaded', reveal: reveal(STEP1, 65, 70) });
    expect(visibleReveal(s, STEP1)).toMatchObject({ value: 65 });
  });
});

describe('navigation', () => {
  it('the case card needs a session before the dive can start', () => {
    const s = initDive(doc, doc.id, doc.version);
    expect(canAdvance(s)).toBe(false);
    expect(run(s, { type: 'next' }).cursor).toBe(0);
    expect(run(s, { type: 'go_to', cursor: 1 }).cursor).toBe(0);
    const ready = run(s, { type: 'session_started', session: session() });
    expect(canAdvance(ready)).toBe(true);
    expect(run(ready, { type: 'next' }).cursor).toBe(1);
  });

  it('canAdvance blocks every unanswered poll, including Before and After', () => {
    let s = atBefore();
    expect(currentScreen(s).kind).toBe('before');
    expect(canAdvance(s)).toBe(false);
    expect(run(s, { type: 'next' }).cursor).toBe(s.cursor);
    s = commit(s, 40);
    expect(canAdvance(s)).toBe(true);
    for (const _ of stepIds) {
      s = run(s, { type: 'next' });
      expect(currentScreen(s).kind).toBe('step');
      expect(canAdvance(s)).toBe(false);
      s = commit(s, 40);
    }
    s = run(s, { type: 'next' });
    expect(currentScreen(s).kind).toBe('after');
    expect(canAdvance(s)).toBe(false);
    s = commit(s, 40);
    s = run(s, { type: 'next' }, { type: 'next' });
    expect(currentScreen(s).kind).toBe('share');
    expect(canAdvance(s)).toBe(false); // last screen
  });

  it('cannot advance or go back while a commit is pending', () => {
    const s = run(atBefore(), { type: 'commit_start' });
    expect(s.pending).toBe(true);
    expect(canAdvance(s)).toBe(false);
    expect(run(s, { type: 'back' })).toBe(s);
    expect(run(s, { type: 'set_draft', value: 1 })).toBe(s);
    expect(run(s, { type: 'commit_start' })).toBe(s);
  });

  it('go_to never skips past an unanswered poll', () => {
    const s = commit(atBefore(), 50);
    const firstStep = s.screens.findIndex((x) => x.kind === 'step');
    expect(run(s, { type: 'go_to', cursor: firstStep + 1 }).cursor).toBe(s.cursor);
    expect(run(s, { type: 'go_to', cursor: 999 }).cursor).toBe(s.cursor);
    expect(run(s, { type: 'go_to', cursor: firstStep }).cursor).toBe(firstStep);
    expect(run(s, { type: 'go_to', cursor: 0 }).cursor).toBe(0);
  });

  it('back navigation keeps answers locked', () => {
    let s = commit(atBefore(), 90);
    s = run(s, { type: 'next' });
    s = commit(s, 75);
    s = run(s, { type: 'back' });
    expect(currentSlot(s)).toBe('before');
    expect(s.draft).toBe(90); // shows the locked answer
    expect(run(s, { type: 'set_draft', value: 10 })).toBe(s);
    expect(run(s, { type: 'commit_start' })).toBe(s);
    expect(visibleReveal(s, 'before')).toMatchObject({ value: 90 });
    s = run(s, { type: 'next' });
    expect(currentSlot(s)).toBe(STEP1);
    expect(s.draft).toBe(75);
    expect(s.answers).toEqual({ before: 90, [STEP1]: 75 });
  });

  it('records the locked value the server returns, not the draft', () => {
    let s = run(atBefore(), { type: 'set_draft', value: 10 }, { type: 'commit_start' });
    s = run(s, { type: 'commit_success', reveal: { step_id: 'before', value: 90, locked: true } });
    expect(s.answers.before).toBe(90);
    expect(s.draft).toBe(90);
  });

  it('a failed commit leaves the slot open and reports the error', () => {
    let s = run(atBefore(), { type: 'set_draft', value: 30 }, { type: 'commit_start' }, { type: 'commit_error', message: 'offline' });
    expect(s).toMatchObject({ pending: false, error: 'offline', draft: 30 });
    expect(canAdvance(s)).toBe(false);
    s = run(s, { type: 'clear_error' });
    expect(s.error).toBeNull();
    expect(run(s, { type: 'commit_start' }).pending).toBe(true);
  });
});

describe('the slider', () => {
  it('pollDefault pre-fills the last committed value, or 50 before anything is answered', () => {
    let s = atBefore();
    expect(pollDefault(s, 'before')).toBe(DEFAULT_START_VALUE);
    expect(s.draft).toBe(DEFAULT_START_VALUE);
    s = commit(s, 90);
    expect(pollDefault(s, STEP1)).toBe(90);
    s = run(s, { type: 'next' });
    expect(s.draft).toBe(90);
    s = commit(s, 75);
    expect(pollDefault(s, STEP2)).toBe(75);
    expect(pollDefault(s, 'after')).toBe(75);
    s = run(s, { type: 'next' });
    expect(s.draft).toBe(75);
  });

  it('clamps and rounds drafts, and ignores them off poll screens', () => {
    const s = atBefore();
    expect(run(s, { type: 'set_draft', value: 140 }).draft).toBe(100);
    expect(run(s, { type: 'set_draft', value: -3 }).draft).toBe(0);
    expect(run(s, { type: 'set_draft', value: 42.6 }).draft).toBe(43);
    const card = started();
    expect(run(card, { type: 'set_draft', value: 10 })).toBe(card);
    expect(run(card, { type: 'commit_start' })).toBe(card);
  });

  it('commit_start needs a session', () => {
    const noSession = { ...atBefore(), sessionId: null };
    expect(run(noSession, { type: 'commit_start' })).toBe(noSession);
  });
});

describe('resume', () => {
  const resumed = (answers: SessionStart['answers']) =>
    run(initDive(doc, doc.id, doc.version), { type: 'session_started', session: session(answers) });

  it('starts at the case card when nothing was answered', () => {
    expect(resumeCursor(resumed([]))).toBe(0);
  });

  it('lands on the first unanswered poll and treats earlier answers as locked', () => {
    const s = resumed([
      { step_id: 'before', value: 80 },
      { step_id: STEP1, value: 70 },
    ]);
    const cursor = resumeCursor(s);
    expect(s.screens[cursor]).toMatchObject({ kind: 'step', stepId: STEP2 });
    const there = run(s, { type: 'go_to', cursor });
    expect(there.cursor).toBe(cursor);
    expect(there.draft).toBe(70);
    expect(progress(there)).toBeCloseTo(2 / slotsOf(doc).length);
  });

  it('lands on the final reveal when every slot was answered', () => {
    const all = slotsOf(doc).map((step_id) => ({ step_id, value: 60 }));
    const s = resumed(all);
    expect(s.screens[resumeCursor(s)]!.kind).toBe('final');
    expect(progress(s)).toBe(1);
  });
});

describe('depth layers', () => {
  it('toggles a step open and closed', () => {
    const s = run(started(), { type: 'toggle_depth', stepId: STEP1 });
    expect(s.expanded[STEP1]).toBe(true);
    expect(run(s, { type: 'toggle_depth', stepId: STEP1 }).expanded[STEP1]).toBe(false);
  });
});
