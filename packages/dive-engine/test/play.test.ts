import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Layer, PublicCase, SeedProfileInput } from '@sia/case-schema';
import {
  CONFIDENCE_LABEL,
  caseUrl,
  crowdCountText,
  estimateMinutes,
  formatDate,
  mirrorText,
  seededNoteText,
  shareCardData,
  versionNoteText,
} from '../src/copy';
import {
  buildScreens,
  canAdvance,
  currentScreen,
  currentSlot,
  diveReducer,
  initDive,
  resumeCursor,
  stepById,
  visibleReveal,
  type DiveAction,
  type DiveState,
  type ScreenKind,
} from '../src/flow';
import { LocalDiveApi } from '../src/local';
import { DiveApiError, isFinalReveal, isStepReveal, type DiveApi } from '../src/types';
import { FIXTURES, clock, deviceId, loadFixture, stringsOf, type FixtureName } from './helpers';

/**
 * Phase 2 acceptance, engine side: both fixture cases play through the whole
 * flow with the same code, the reducer driven by LocalDiveApi, with seeded crowd
 * data, and no crowd result is visible before its slot is committed.
 */

const BASE_URL = 'https://dive.example';

/** The user-facing prose of a case: everything a screen may quote from the record. */
function proseOf(doc: PublicCase): string[] {
  return [
    doc.title,
    doc.question.prompt,
    doc.question.scale.left_label,
    doc.question.scale.right_label,
    ...(doc.content_warning ? [doc.content_warning] : []),
    ...doc.starting_facts.map((f) => f.text),
    ...doc.steps.flatMap((s) => [s.headline, s.body, s.micro_poll.prompt, ...s.depth.flatMap(layerText)]),
    ...doc.sides.flatMap((s) => [s.label, s.steelman]),
    ...doc.open_questions,
  ];
}

function layerText(layer: Layer): string[] {
  switch (layer.kind) {
    case 'document':
      return [layer.title, layer.summary];
    case 'quote':
      return [layer.text, layer.speaker, ...(layer.context ? [layer.context] : [])];
    case 'timeline':
      return [layer.title, ...layer.entries.map((e) => e.text)];
    case 'context':
      return [layer.title, layer.body];
  }
}

interface Rendered {
  /** Text quoted from the case record. */
  record: string[];
  /** Generic interface copy (labels, mirror lines, crowd notes). */
  chrome: string[];
  /** Whether a crowd result is on screen. */
  crowd: boolean;
}

/**
 * A headless stand-in for the dive screens: what each one shows. The real UI is
 * packages/dive-ui; this checks the engine gives it everything from the record
 * and only ever a committed slot's crowd.
 */
function render(state: DiveState): Rendered {
  const { doc } = state;
  const screen = currentScreen(state);
  const out: Rendered = { record: [], chrome: [], crowd: false };
  const { prompt, scale } = doc.question;
  switch (screen.kind) {
    case 'case_card':
      out.record.push(doc.title, ...(doc.content_warning ? [doc.content_warning] : []));
      out.chrome.push(`As of ${formatDate(doc.as_of)}`, `${estimateMinutes(doc)} min`);
      break;
    case 'starting_facts':
      out.record.push(...doc.starting_facts.map((f) => f.text));
      out.chrome.push(...doc.starting_facts.map((f) => CONFIDENCE_LABEL[f.confidence]));
      break;
    case 'before':
    case 'after':
      out.record.push(prompt, scale.left_label, scale.right_label);
      out.chrome.push('Lock in');
      break;
    case 'step': {
      const step = stepById(doc, screen.stepId)!;
      out.record.push(step.headline, step.body, step.micro_poll.prompt, scale.left_label, scale.right_label);
      out.chrome.push(CONFIDENCE_LABEL[step.confidence], 'Flag this fact');
      if (step.depth.length > 0) out.chrome.push('Go deeper');
      if (state.expanded[step.id]) out.record.push(...step.depth.flatMap(layerText));
      const r = visibleReveal(state, step.id);
      if (r && isStepReveal(r)) {
        out.crowd = true;
        out.chrome.push(mirrorText(r.previous_value, r.value), crowdCountText(r.crowd.n_real));
        const seeded = seededNoteText(r.crowd.seeded_share);
        if (seeded) out.chrome.push(seeded);
        const note = versionNoteText(r.version_note);
        if (note) out.chrome.push(note);
      }
      break;
    }
    case 'final': {
      const r = visibleReveal(state, 'after');
      if (r && isFinalReveal(r)) {
        out.crowd = true;
        for (const id of [r.you.top_step_id, r.crowd.top_step_id]) if (id) out.record.push(stepById(doc, id)!.headline);
        out.record.push(...doc.open_questions, scale.left_label, scale.right_label);
        out.chrome.push(mirrorText(r.you.answers[0]!.value, r.value));
        const seeded = seededNoteText(r.crowd.seeded_share);
        if (seeded) out.chrome.push(seeded);
      }
      break;
    }
    case 'share': {
      const r = visibleReveal(state, 'after');
      if (r && isFinalReveal(r)) {
        out.crowd = true;
        const card = shareCardData(doc, r, caseUrl(BASE_URL, doc.slug));
        out.record.push(card.title, card.question, card.leftLabel, card.rightLabel);
        out.chrome.push(card.headline, card.tagline);
      }
      break;
    }
  }
  return out;
}

/** A seed profile for any case, built from its step ids alone. */
function seedProfileFor(doc: PublicCase): SeedProfileInput {
  return {
    sessions: 120,
    before_bins: [1, 1, 2, 3, 4, 4, 3, 2, 1, 1],
    steps: Object.fromEntries(
      doc.steps.map((s, i) => [s.id, { move_share: 0.4, mean_shift: i % 2 === 0 ? -8 : 6, spread: 5 }]),
    ),
    after: { move_share: 0.1, mean_shift: 0, spread: 3 },
    rng_seed: 42,
  };
}

/** The answers our reader gives: Before 72, then some steps move them and some do not. */
function plannedValues(doc: PublicCase): number[] {
  const values = [72];
  doc.steps.forEach((_, i) => values.push(Math.max(0, Math.min(100, values[i]! + (i % 3 === 1 ? 0 : i % 2 === 0 ? -9 : 4)))));
  values.push(values[values.length - 1]! - 3);
  return values;
}

interface PlayResult {
  doc: PublicCase;
  visited: ScreenKind[];
  slots: string[];
  renders: Partial<Record<ScreenKind, Rendered[]>>;
  finalValues: number[];
}

/** Plays one case from the case card to the share card, the way the app drives the engine. */
async function playThrough(name: FixtureName): Promise<PlayResult> {
  const fixture = loadFixture(name);
  const local = new LocalDiveApi({
    cases: [{ doc: fixture, seedProfile: seedProfileFor(fixture) }],
    now: clock(),
  });
  // The flow only sees the DiveApi interface, as the app does.
  const api: DiveApi = local;

  // Three earlier readers, so the crowd mixes real and seeded answers.
  for (let r = 0; r < 3; r++) {
    const s = await api.startSession(fixture.id, fixture.version, deviceId());
    for (const [i, slot] of ['before', ...fixture.steps.map((x) => x.id), 'after'].entries()) {
      await api.submit(s.session_id, slot, (i * 17 + r * 31) % 101);
    }
  }

  const [summary] = await api.listLiveCases();
  const loaded = (await api.getCase(summary!.slug))!;
  const doc = loaded.doc;
  const values = plannedValues(doc);
  const allowed = stringsOf(doc);
  const prose = proseOf(doc);
  const device = deviceId();

  let state = initDive(doc, loaded.case_id, loaded.version);
  const dispatch = (...actions: DiveAction[]) => {
    for (const a of actions) state = diveReducer(state, a);
  };
  const result: PlayResult = { doc, visited: [], slots: [], renders: {}, finalValues: [] };

  const check = () => {
    const kind = currentScreen(state).kind;
    const r = render(state);
    (result.renders[kind] ??= []).push(r);
    // Every case-specific word on screen comes from the record...
    for (const text of r.record) {
      expect(text.length, `${kind}: empty text`).toBeGreaterThan(0);
      expect(allowed.has(text), `${kind}: "${text}" is not in the record`).toBe(true);
    }
    // ...and the interface's own copy never carries case content.
    for (const text of r.chrome) for (const p of prose) expect(text.includes(p), `${kind}: "${text}"`).toBe(false);
    // The crowd is on screen only once this screen's slot (or the After slot) is committed.
    const slot = currentSlot(state) ?? (kind === 'final' || kind === 'share' ? 'after' : null);
    if (slot !== null && !(slot in state.answers)) expect(r.crowd, `${kind}: crowd before commit`).toBe(false);
    return r;
  };

  // Case card: shown before any session exists.
  check();
  expect(canAdvance(state)).toBe(false);
  dispatch({ type: 'session_started', session: await api.startSession(state.caseId, state.version, device) });

  let restarted = false;
  for (;;) {
    const screen = currentScreen(state);
    result.visited.push(screen.kind);
    if (screen.kind === 'step') dispatch({ type: 'toggle_depth', stepId: screen.stepId });
    const slot = currentSlot(state);

    if (slot !== null) {
      result.slots.push(slot);
      // Uncommitted: no crowd anywhere, cannot move on, and the server will not reveal it either.
      expect(visibleReveal(state, slot)).toBeNull();
      expect(canAdvance(state)).toBe(false);
      await expect(api.getReveal(state.sessionId!, slot)).rejects.toMatchObject({ code: 'forbidden' });
      const before = check();
      expect(before.crowd).toBe(false);

      const index = result.slots.length - 1;
      const previous = index === 0 ? null : values[index - 1]!;
      if (previous !== null) expect(state.draft, 'slider pre-filled at the last value').toBe(previous);
      dispatch({ type: 'set_draft', value: values[index]! }, { type: 'commit_start' });
      const reveal = await api.submit(state.sessionId!, slot, state.draft!);
      dispatch({ type: 'commit_success', reveal });

      expect(visibleReveal(state, slot)).toEqual(reveal);
      expect(reveal).toMatchObject({ step_id: slot, value: values[index], locked: false });
      if (isStepReveal(reveal)) {
        expect(reveal.previous_value).toBe(previous);
        expect(reveal.crowd.n_real).toBe(4);
        expect(reveal.crowd.n_seed).toBe(120);
        expect(reveal.crowd.seeded_share).toBeGreaterThan(0);
        expect(check().chrome).toContain(mirrorText(previous!, values[index]!));
      }
      if (isFinalReveal(reveal)) result.finalValues = reveal.you.answers.map((a) => a.value);
      expect(canAdvance(state)).toBe(true);

      // Flag the first fact, as a reader might.
      if (index === 1) await api.flagFact(state.sessionId!, slot, 'cherry_picked', 'Missing context.');

      // After the second step: go back, find the earlier answer locked, come forward again.
      if (index === 2) {
        dispatch({ type: 'back' });
        const prevSlot = currentSlot(state)!;
        expect(state.draft).toBe(values[1]);
        dispatch({ type: 'set_draft', value: 0 }, { type: 'commit_start' });
        expect(state.answers[prevSlot]).toBe(values[1]);
        expect(state.pending).toBe(false);
        expect(await api.submit(state.sessionId!, prevSlot, 0)).toMatchObject({ value: values[1], locked: true });
        dispatch({ type: 'next' });
        expect(currentSlot(state)).toBe(slot);
      }

      // After the third step: the app restarts and resumes on the same device.
      if (index === 3 && !restarted) {
        restarted = true;
        state = initDive((await api.getCase(doc.slug))!.doc, loaded.case_id, loaded.version);
        const resumed = await api.startSession(state.caseId, state.version, device);
        expect(resumed).toMatchObject({ resumed: true, completed: false });
        dispatch({ type: 'session_started', session: resumed });
        dispatch({ type: 'go_to', cursor: resumeCursor(state) });
        const next = currentSlot(state)!;
        expect(next).toBe(doc.steps[3]?.id ?? 'after');
        expect(state.draft).toBe(values[3]);
        for (const a of resumed.answers) {
          expect(visibleReveal(state, a.step_id)).toBeNull(); // not until re-fetched
          dispatch({ type: 'reveal_loaded', reveal: await api.getReveal(state.sessionId!, a.step_id) });
          expect(visibleReveal(state, a.step_id)).toMatchObject({ value: a.value, locked: true });
        }
        // Loop again on the resumed screen.
        continue;
      }
    } else {
      check();
    }

    if (screen.kind === 'share') break;
    expect(canAdvance(state)).toBe(true);
    dispatch({ type: 'next' });
  }

  await api.rateFairness(state.sessionId!, doc.sides[doc.sides.length - 1]!.id, 'fair');
  const { flags, ratings } = local.signals();
  expect(flags).toHaveLength(1);
  expect(ratings).toHaveLength(1);
  return result;
}

const results = new Map<FixtureName, PlayResult>();
const fetchSpy = vi.fn(() => {
  throw new Error('LocalDiveApi must not touch the network');
});

beforeAll(() => vi.stubGlobal('fetch', fetchSpy));
afterAll(() => vi.unstubAllGlobals());

describe.each(FIXTURES)('%s plays through the full flow', (name) => {
  it('from the case card to the share card, with seeded crowd data, the crowd hidden until each commit', async () => {
    const r = await playThrough(name);
    results.set(name, r);
    const { doc } = r;
    const n = doc.steps.length;
    // Every screen once, in order (the restart resumed exactly where the reader left off).
    expect(r.visited).toEqual(buildScreens(doc).map((s) => s.kind));
    expect(r.visited).toHaveLength(n + 6);
    expect(r.slots).toEqual(['before', ...doc.steps.map((s) => s.id), 'after']);
    expect(r.finalValues).toEqual(plannedValues(doc));

    // Every step screen showed its own headline, body, poll wording and depth layers from the record.
    const stepRenders = r.renders.step!.filter((x) => x.crowd);
    expect(stepRenders).toHaveLength(n);
    doc.steps.forEach((step, i) => {
      expect(stepRenders[i]!.record).toEqual(expect.arrayContaining([step.headline, step.body, step.micro_poll.prompt, ...step.depth.flatMap(layerText)]));
    });
    // The case card shows the content warning exactly when the record has one.
    const card = r.renders.case_card![0]!;
    expect(card.record.includes(doc.content_warning ?? '')).toBe(Boolean(doc.content_warning));
    // The final reveal and share card are built from the record too.
    expect(r.renders.final!.at(-1)!.record).toEqual(expect.arrayContaining(doc.open_questions));
    expect(r.renders.share!.at(-1)!.record).toEqual([doc.title, doc.question.prompt, doc.question.scale.left_label, doc.question.scale.right_label]);
  });
});

describe('two different case files, no code change', () => {
  it('played different screen sequences from the same engine', () => {
    const [a, b] = FIXTURES.map((f) => results.get(f)!);
    expect(a && b).toBeTruthy();
    const screens = (r: PlayResult) => r.visited.length;
    expect(screens(a!)).toBe(a!.doc.steps.length + 6);
    expect(screens(b!)).toBe(b!.doc.steps.length + 6);
    expect(screens(a!)).not.toBe(screens(b!));
    expect(a!.doc.sides.length).not.toBe(b!.doc.sides.length);
    expect(Boolean(a!.doc.content_warning)).not.toBe(Boolean(b!.doc.content_warning));
    const pollWords = (r: PlayResult) => new Set(r.doc.steps.map((s) => s.micro_poll.prompt));
    expect(pollWords(a!)).not.toEqual(pollWords(b!));
  });

  it('never touched the network', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports errors as DiveApiError codes the UI can act on', async () => {
    const api = new LocalDiveApi({ cases: [{ doc: loadFixture('fixture-harbor-bridge') }] });
    await expect(api.getReveal('missing', 'before')).rejects.toBeInstanceOf(DiveApiError);
  });
});
