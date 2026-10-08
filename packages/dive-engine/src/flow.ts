import { AFTER, BEFORE, type PublicCase, type PublicStep } from '@sia/case-schema';
import type { Reveal, SessionStart, SlotKey } from './types';

/**
 * The dive is a fixed sequence of screens generated from the case record.
 * The flow is identical for every case and every user:
 *
 *   case card -> starting facts -> before -> step 1..n -> after -> final reveal -> share
 *
 * This module is a pure state machine (a reducer plus selectors). It holds no
 * case-specific logic and never shows a crowd result for a slot that has not
 * been committed.
 */

export type Screen =
  | { kind: 'case_card' }
  | { kind: 'starting_facts' }
  | { kind: 'before' }
  | { kind: 'step'; stepId: string; index: number }
  | { kind: 'after' }
  | { kind: 'final' }
  | { kind: 'share' };

export type ScreenKind = Screen['kind'];

export function buildScreens(doc: Pick<PublicCase, 'steps'>): Screen[] {
  return [
    { kind: 'case_card' },
    { kind: 'starting_facts' },
    { kind: 'before' },
    ...doc.steps.map((s, index): Screen => ({ kind: 'step', stepId: s.id, index })),
    { kind: 'after' },
    { kind: 'final' },
    { kind: 'share' },
  ];
}

/** The answer slot a screen asks for, if any. */
export function slotOf(screen: Screen): SlotKey | null {
  switch (screen.kind) {
    case 'before':
      return BEFORE;
    case 'after':
      return AFTER;
    case 'step':
      return screen.stepId;
    default:
      return null;
  }
}

/** All answer slots in order: before, each step, after. */
export function slotsOf(doc: Pick<PublicCase, 'steps'>): SlotKey[] {
  return [BEFORE, ...doc.steps.map((s) => s.id), AFTER];
}

export const DEFAULT_START_VALUE = 50;

export interface DiveState {
  doc: PublicCase;
  caseId: string;
  version: number;
  screens: Screen[];
  cursor: number;
  sessionId: string | null;
  /** Committed (locked) answers by slot. */
  answers: Record<SlotKey, number>;
  /** Reveals by slot. Only ever set for committed slots. */
  reveals: Record<SlotKey, Reveal>;
  /** Current uncommitted slider value for the screen's slot. */
  draft: number | null;
  /** Depth layers the user expanded, by step id. */
  expanded: Record<string, boolean>;
  pending: boolean;
  error: string | null;
}

export type DiveAction =
  | { type: 'session_started'; session: SessionStart }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'go_to'; cursor: number }
  | { type: 'set_draft'; value: number }
  | { type: 'commit_start' }
  | { type: 'commit_success'; reveal: Reveal }
  | { type: 'commit_error'; message: string }
  | { type: 'reveal_loaded'; reveal: Reveal }
  | { type: 'toggle_depth'; stepId: string }
  | { type: 'clear_error' };

export function initDive(doc: PublicCase, caseId: string, version: number): DiveState {
  return {
    doc,
    caseId,
    version,
    screens: buildScreens(doc),
    cursor: 0,
    sessionId: null,
    answers: {},
    reveals: {},
    draft: null,
    expanded: {},
    pending: false,
    error: null,
  };
}

const clampValue = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** The slider's starting value on a poll screen: the user's last committed value (pre-filled), or 50. */
export function pollDefault(state: Pick<DiveState, 'doc' | 'answers'>, slot: SlotKey): number {
  const slots = slotsOf(state.doc);
  const i = slots.indexOf(slot);
  for (let j = i - 1; j >= 0; j--) {
    const v = state.answers[slots[j]!];
    if (v !== undefined) return v;
  }
  return DEFAULT_START_VALUE;
}

export function currentScreen(state: DiveState): Screen {
  return state.screens[state.cursor]!;
}

export function currentSlot(state: DiveState): SlotKey | null {
  return slotOf(currentScreen(state));
}

export function isCommitted(state: Pick<DiveState, 'answers'>, slot: SlotKey): boolean {
  return state.answers[slot] !== undefined;
}

/**
 * The reveal the UI may show for a slot. Null until the user has committed that
 * slot: the crowd result is never visible before commit.
 */
export function visibleReveal(state: Pick<DiveState, 'answers' | 'reveals'>, slot: SlotKey): Reveal | null {
  if (!isCommitted(state, slot)) return null;
  return state.reveals[slot] ?? null;
}

/** Whether the user may move to the next screen. Poll screens require a committed answer. */
export function canAdvance(state: DiveState): boolean {
  if (state.pending) return false;
  if (state.cursor >= state.screens.length - 1) return false;
  const screen = currentScreen(state);
  if (screen.kind === 'case_card') return state.sessionId !== null;
  const slot = slotOf(screen);
  return slot === null || isCommitted(state, slot);
}

/** Index of the first screen whose slot is not yet answered (for resuming). */
export function resumeCursor(state: DiveState): number {
  const firstPoll = state.screens.findIndex((s) => s.kind === 'before');
  const hasAny = Object.keys(state.answers).length > 0;
  if (!hasAny) return 0;
  for (let i = firstPoll; i < state.screens.length; i++) {
    const slot = slotOf(state.screens[i]!);
    if (slot !== null && !isCommitted(state, slot)) return i;
  }
  // Everything answered: land on the final reveal.
  return state.screens.findIndex((s) => s.kind === 'final');
}

function withDraftFor(state: DiveState, cursor: number): DiveState {
  const slot = slotOf(state.screens[cursor]!);
  const draft = slot === null ? null : (state.answers[slot] ?? pollDefault(state, slot));
  return { ...state, cursor, draft, error: null };
}

export function diveReducer(state: DiveState, action: DiveAction): DiveState {
  switch (action.type) {
    case 'session_started': {
      const answers: Record<SlotKey, number> = {};
      for (const a of action.session.answers) answers[a.step_id] = a.value;
      const next: DiveState = { ...state, sessionId: action.session.session_id, answers };
      return next;
    }
    case 'next': {
      if (!canAdvance(state)) return state;
      return withDraftFor(state, state.cursor + 1);
    }
    case 'back': {
      if (state.cursor === 0 || state.pending) return state;
      return withDraftFor(state, state.cursor - 1);
    }
    case 'go_to': {
      const target = Math.max(0, Math.min(state.screens.length - 1, action.cursor));
      // Never skip ahead past an unanswered poll.
      for (let i = 0; i < target; i++) {
        const slot = slotOf(state.screens[i]!);
        if (slot !== null && !isCommitted(state, slot)) return state;
      }
      if (target > 0 && state.sessionId === null) return state;
      return withDraftFor(state, target);
    }
    case 'set_draft': {
      const slot = currentSlot(state);
      if (slot === null || isCommitted(state, slot) || state.pending) return state;
      return { ...state, draft: clampValue(action.value) };
    }
    case 'commit_start': {
      const slot = currentSlot(state);
      if (slot === null || isCommitted(state, slot) || state.pending || state.sessionId === null) return state;
      return { ...state, pending: true, error: null };
    }
    case 'commit_success': {
      const r = action.reveal;
      return {
        ...state,
        pending: false,
        answers: { ...state.answers, [r.step_id]: r.value },
        reveals: { ...state.reveals, [r.step_id]: r },
        draft: currentSlot(state) === r.step_id ? r.value : state.draft,
      };
    }
    case 'commit_error':
      return { ...state, pending: false, error: action.message };
    case 'reveal_loaded': {
      const r = action.reveal;
      if (!isCommitted(state, r.step_id)) return state; // never store a reveal for an unanswered slot
      return { ...state, reveals: { ...state.reveals, [r.step_id]: r } };
    }
    case 'toggle_depth':
      return { ...state, expanded: { ...state.expanded, [action.stepId]: !state.expanded[action.stepId] } };
    case 'clear_error':
      return { ...state, error: null };
  }
}

export function stepById(doc: PublicCase, id: string): PublicStep | undefined {
  return doc.steps.find((s) => s.id === id);
}

/** 0..1 progress through the answer slots, for a thin progress bar. */
export function progress(state: DiveState): number {
  const slots = slotsOf(state.doc);
  return slots.filter((s) => isCommitted(state, s)).length / slots.length;
}
