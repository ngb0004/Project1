import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseDiveApi } from '../src/supabase';
import { DiveApiError, type DiveErrorCode } from '../src/types';

/** A client whose every RPC fails with the given PostgREST error. */
function failingWith(error: { message: string; code?: string }) {
  const db = { rpc: async () => ({ data: null, error }) };
  return new SupabaseDiveApi(db as unknown as SupabaseClient);
}

async function codeOf(error: { message: string; code?: string }): Promise<DiveErrorCode> {
  const err = await failingWith(error)
    .submit('00000000-0000-0000-0000-000000000000', 'before', 50)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DiveApiError);
  return (err as DiveApiError).code;
}

describe('SupabaseDiveApi errors', () => {
  it.each([
    ['PT404', 'not_found'],
    ['PT409', 'out_of_order'],
    ['PT410', 'gone'],
    ['PT429', 'rate_limited'],
    ['PT403', 'forbidden'],
    ['42501', 'forbidden'],
    ['22023', 'invalid'],
    ['22P02', 'invalid'], // invalid_text_representation, e.g. 4.5 for an int
    ['22003', 'invalid'], // numeric_value_out_of_range, e.g. ?v=99999999999
    ['23514', 'invalid'], // check_violation
  ] as const)('maps SQLSTATE %s to %s', async (code, expected) => {
    expect(await codeOf({ message: 'refused', code })).toBe(expected);
  });

  it('keeps "network" for requests that never got an answer from the database', async () => {
    expect(await codeOf({ message: 'TypeError: Failed to fetch', code: '' })).toBe('network');
    expect(await codeOf({ message: 'no code' })).toBe('network');
    expect(await codeOf({ message: 'Could not connect to the database', code: 'PGRST001' })).toBe('network');
  });
});
