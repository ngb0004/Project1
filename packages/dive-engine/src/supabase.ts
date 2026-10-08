import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DiveApiError,
  type CaseHistory,
  type DiveApi,
  type DiveErrorCode,
  type FairnessValue,
  type FlagReason,
  type LiveCaseSummary,
  type LoadedCase,
  type Reveal,
  type SessionStart,
  type SlotKey,
} from './types';

/** Maps PostgREST errors (custom SQLSTATE PTxxx -> HTTP xxx) to dive error codes. */
function toDiveError(err: { message: string; code?: string }): DiveApiError {
  const code = err.code ?? '';
  const map: Record<string, DiveErrorCode> = {
    PT404: 'not_found',
    PT409: 'out_of_order',
    PT429: 'rate_limited',
    PT410: 'gone',
    PT403: 'forbidden',
    '22023': 'invalid',
  };
  return new DiveApiError(map[code] ?? 'network', err.message);
}

async function call<T>(p: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw toDiveError(error);
  return data as T;
}

/** The production backend: the database functions behind Supabase's REST API, called as anon. */
export class SupabaseDiveApi implements DiveApi {
  constructor(private readonly db: SupabaseClient) {}

  listLiveCases(): Promise<LiveCaseSummary[]> {
    return call(this.db.rpc('list_live_cases'));
  }

  async getCase(slug: string, version?: number): Promise<LoadedCase | null> {
    const rows = await call<LoadedCase[]>(this.db.rpc('get_published_case', { p_slug: slug, p_version: version ?? null }));
    return rows[0] ?? null;
  }

  startSession(caseId: string, version: number, deviceId: string): Promise<SessionStart> {
    return call(this.db.rpc('start_session', { p_case_id: caseId, p_version: version, p_device_id: deviceId }));
  }

  submit(sessionId: string, slot: SlotKey, value: number): Promise<Reveal> {
    return call(this.db.rpc('submit_response', { p_session_id: sessionId, p_step_id: slot, p_value: value }));
  }

  getReveal(sessionId: string, slot: SlotKey): Promise<Reveal> {
    return call(this.db.rpc('get_reveal', { p_session_id: sessionId, p_step_id: slot }));
  }

  async flagFact(sessionId: string, stepId: string, reason: FlagReason, note?: string): Promise<void> {
    await call(this.db.rpc('flag_fact', { p_session_id: sessionId, p_step_id: stepId, p_reason: reason, p_note: note ?? null }));
  }

  async rateFairness(sessionId: string, sideId: string, rating: FairnessValue): Promise<void> {
    await call(this.db.rpc('rate_fairness', { p_session_id: sessionId, p_side_id: sideId, p_rating: rating }));
  }

  getHistory(slug: string): Promise<CaseHistory | null> {
    return call(this.db.rpc('get_case_history', { p_slug: slug }));
  }
}
