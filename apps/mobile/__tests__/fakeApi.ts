import type { PublicCase } from '@sia/case-schema';
import {
  DiveApiError,
  slotsOf,
  type DiveApi,
  type FinalCrowd,
  type LoadedCase,
  type Reveal,
  type SessionStart,
  type StepCrowd,
  type VersionNote,
} from '@sia/dive-engine';

/**
 * A small in-memory DiveApi for UI tests. It keeps the contract that matters to
 * the screens (fixed order, locked answers, no reveal before commit) and
 * returns fixed, seeded-looking crowd numbers.
 */
export interface FakeApi extends DiveApi {
  calls: { method: keyof DiveApi; args: unknown[] }[];
}

const HISTOGRAM = [0.02, 0.03, 0.05, 0.08, 0.12, 0.15, 0.2, 0.17, 0.12, 0.06];
const PUBLISHED_AT = '2026-10-01T12:00:00Z';

export function createFakeApi(docs: PublicCase[], opts: { versionNote?: Partial<VersionNote> } = {}): FakeApi {
  const sessions = new Map<
    string,
    { doc: PublicCase; device: string; answers: { step_id: string; value: number }[] }
  >();
  const calls: FakeApi['calls'] = [];
  const log = (method: keyof DiveApi, ...args: unknown[]) => calls.push({ method, args });

  const versionNote = (doc: PublicCase): VersionNote => ({
    version: doc.version,
    published_at: PUBLISHED_AT,
    parent_version: null,
    earlier_versions: [],
    ...opts.versionNote,
  });

  const stepCrowd = (stepId: string): StepCrowd => ({
    step_id: stepId,
    n_real: 3,
    n_seed: 400,
    seed_weight: 1,
    seeded_share: 0.99,
    histogram: HISTOGRAM,
    previous_histogram: HISTOGRAM,
    mean_value: 58,
    mean_previous: 62,
    mean_delta: -4,
    moved_share: 0.41,
    shift: { left_big: 0.12, left: 0.2, none: 0.59, right: 0.06, right_big: 0.03 },
  });

  const finalCrowd = (doc: PublicCase): FinalCrowd => ({
    n_real: 3,
    n_seed: 400,
    seed_weight: 1,
    seeded_share: 0.99,
    before_histogram: HISTOGRAM,
    after_histogram: [...HISTOGRAM].reverse(),
    mean_before: 62,
    mean_after: 51,
    steps: doc.steps.map((s, i) => ({ step_id: s.id, mean_delta: -i, mean_abs_delta: 3 + i, moved_share: 0.4 })),
    top_step_id: doc.steps[doc.steps.length - 1]!.id,
  });

  const reveal = (sessionId: string, slot: string, locked: boolean): Reveal => {
    const s = sessions.get(sessionId)!;
    const i = s.answers.findIndex((a) => a.step_id === slot);
    const value = s.answers[i]!.value;
    if (slot === 'before') return { step_id: 'before', value, locked };
    const previous = s.answers[i - 1]!.value;
    if (slot === 'after') {
      let top: string | null = null;
      let best = 0;
      s.answers.forEach((a, j) => {
        const d = j > 0 ? Math.abs(a.value - s.answers[j - 1]!.value) : 0;
        if (a.step_id !== 'before' && a.step_id !== 'after' && d > best) {
          best = d;
          top = a.step_id;
        }
      });
      return {
        step_id: 'after',
        value,
        previous_value: previous,
        locked,
        you: { answers: [...s.answers], top_step_id: top },
        crowd: finalCrowd(s.doc),
        version_note: versionNote(s.doc),
      };
    }
    return {
      step_id: slot,
      value,
      previous_value: previous,
      locked,
      crowd: stepCrowd(slot),
      version_note: versionNote(s.doc),
    };
  };

  const session = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new DiveApiError('not_found', 'unknown session');
    return s;
  };

  return {
    calls,
    async listLiveCases() {
      log('listLiveCases');
      return docs.map((d) => ({
        case_id: d.id,
        slug: d.slug,
        version: d.version,
        title: d.title,
        as_of: d.as_of,
        published_at: PUBLISHED_AT,
        content_warning: d.content_warning ?? null,
        step_count: d.steps.length,
      }));
    },
    async getCase(slug, version) {
      log('getCase', slug, version);
      const doc = docs.find((d) => d.slug === slug && (version === undefined || d.version === version));
      if (!doc) return null;
      const loaded: LoadedCase = {
        case_id: doc.id,
        slug,
        version: doc.version,
        published_at: PUBLISHED_AT,
        is_live: true,
        doc,
      };
      return loaded;
    },
    async startSession(caseId, version, deviceId): Promise<SessionStart> {
      log('startSession', caseId, version, deviceId);
      const doc = docs.find((d) => d.id === caseId && d.version === version);
      if (!doc) throw new DiveApiError('not_found', 'case version is not published');
      const existing = [...sessions.entries()].find(([, s]) => s.device === deviceId && s.doc === doc);
      const id = existing?.[0] ?? `session-${sessions.size + 1}`;
      if (!existing) sessions.set(id, { doc, device: deviceId, answers: [] });
      const s = sessions.get(id)!;
      return {
        session_id: id,
        case_id: caseId,
        case_version: version,
        resumed: Boolean(existing),
        completed: s.answers.some((a) => a.step_id === 'after'),
        answers: [...s.answers],
      };
    },
    async submit(sessionId, slot, value) {
      log('submit', sessionId, slot, value);
      const s = session(sessionId);
      if (s.answers.some((a) => a.step_id === slot)) return reveal(sessionId, slot, true);
      const expected = slotsOf(s.doc)[s.answers.length];
      if (expected !== slot) throw new DiveApiError('out_of_order', `expected ${expected}, got ${slot}`);
      s.answers.push({ step_id: slot, value });
      return reveal(sessionId, slot, false);
    },
    async getReveal(sessionId, slot) {
      log('getReveal', sessionId, slot);
      const s = session(sessionId);
      if (!s.answers.some((a) => a.step_id === slot))
        throw new DiveApiError('forbidden', 'commit an answer before seeing the crowd');
      return reveal(sessionId, slot, true);
    },
    async flagFact(sessionId, stepId, reason, note) {
      log('flagFact', sessionId, stepId, reason, note);
      session(sessionId);
    },
    async rateFairness(sessionId, sideId, rating) {
      log('rateFairness', sessionId, sideId, rating);
      session(sessionId);
    },
    async getHistory(slug) {
      log('getHistory', slug);
      const doc = docs.find((d) => d.slug === slug);
      if (!doc) return null;
      return {
        case_id: doc.id,
        slug,
        live_version: doc.version,
        versions: [
          {
            version: doc.version,
            title: doc.title,
            as_of: doc.as_of,
            status: 'published',
            published_at: PUBLISHED_AT,
            parent_version: null,
            completions: 3,
          },
        ],
      };
    },
  };
}
