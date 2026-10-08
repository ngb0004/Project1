import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createClient } from '@supabase/supabase-js';
import type { DiveApi } from '@sia/dive-engine';
import { SupabaseDiveApi } from '@sia/dive-engine/supabase';
import { errorMessage } from '@sia/dive-ui';
import { config } from './config';
import { loadDemoApi } from './demo';

export type Backend =
  | { status: 'loading' }
  | { status: 'ready'; api: DiveApi; source: 'supabase' | 'demo' }
  | { status: 'unconfigured' }
  | { status: 'error'; message: string };

function initialBackend(): Backend {
  if (config.supabaseUrl && config.supabaseAnonKey) {
    const db = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return { status: 'ready', api: new SupabaseDiveApi(db), source: 'supabase' };
  }
  if (config.demoCasesUrl) return { status: 'loading' };
  return { status: 'unconfigured' };
}

const BackendContext = createContext<Backend>({ status: 'loading' });

/**
 * Picks the data source once per app launch: the Supabase API when it is
 * configured, otherwise in-memory demo cases fetched from a URL.
 */
export function BackendProvider({ children }: { children: ReactNode }) {
  const [backend, setBackend] = useState<Backend>(initialBackend);

  useEffect(() => {
    const url = config.demoCasesUrl;
    if (!url || (config.supabaseUrl && config.supabaseAnonKey)) return;
    let alive = true;
    loadDemoApi(url).then(
      (api) => alive && setBackend({ status: 'ready', api, source: 'demo' }),
      (e: unknown) =>
        alive && setBackend({ status: 'error', message: e instanceof Error ? e.message : errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
  }, []);

  return <BackendContext.Provider value={backend}>{children}</BackendContext.Provider>;
}

export function useBackend(): Backend {
  return useContext(BackendContext);
}
