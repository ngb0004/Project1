/** Result of a server action, as the console's forms and buttons show it. Safe to import from client code. */
export type ActionResult =
  | { ok: true; message: string; href?: string; version?: number; /** A time the result is about (e.g. a scheduled publish), ISO. */ at?: string }
  | { ok: false; error: string; href?: string; version?: number };

export interface FormState {
  status: 'idle' | 'ok' | 'error';
  message: string | null;
  /** A page the result points at, e.g. the new draft. */
  href?: string | null;
  /** Bumped on every result so repeated identical messages still re-render. */
  at?: number;
}

export const IDLE: FormState = { status: 'idle', message: null };

export const okState = (message: string, href?: string | null): FormState => ({ status: 'ok', message, href: href ?? null, at: Date.now() });
export const errorState = (message: string, href?: string | null): FormState => ({ status: 'error', message, href: href ?? null, at: Date.now() });
