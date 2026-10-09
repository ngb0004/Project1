/**
 * Text and URL matching shared by the source store, the research tools and the
 * deterministic fact-check. A quote counts as verbatim when it matches the
 * snapshot after whitespace, quote marks, dashes and invisible characters are
 * normalized; an ellipsis in a quote stands for an omission, so each fragment
 * must appear, in order.
 */

/** Shortest quote (after normalization) that can be checked meaningfully. */
export const MIN_QUOTE_CHARS = 15;

export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc`\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits a quote at ellipses (`...`, `…`, `[...]`) into the fragments that must appear in order. */
function fragments(quote: string): string[] {
  return normalizeForMatch(quote)
    .split(/\s*(?:\[\s*(?:\.\s*){3}\]|\[\s*\u2026\s*\]|(?:\.\s*){3}|\u2026)\s*/)
    .map((f) => f.replace(/^["']+|["']+$/g, '').trim())
    .filter((f) => f.length > 0);
}

export type QuoteMatch = { ok: true } | { ok: false; reason: 'too_short' | 'not_found' };

/** Whether `quote` appears in `text` (both normalized), allowing ellipses for omissions. */
export function matchQuote(quote: string, text: string): QuoteMatch {
  const parts = fragments(quote);
  const total = parts.reduce((n, p) => n + p.length, 0);
  if (total < MIN_QUOTE_CHARS) return { ok: false, reason: 'too_short' };
  const hay = normalizeForMatch(text);
  let from = 0;
  for (const p of parts) {
    const at = hay.indexOf(p, from);
    if (at < 0) return { ok: false, reason: 'not_found' };
    from = at + p.length;
  }
  return { ok: true };
}

export function quoteInText(quote: string, text: string): boolean {
  return matchQuote(quote, text).ok;
}

/**
 * A comparison key for URLs: lowercase scheme and host, no fragment, no
 * default port, no trailing slash, no `www.`, and no common tracking parameters.
 */
export function urlKey(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    const q = u.searchParams.toString();
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${path}${q ? `?${q}` : ''}`;
  } catch {
    return raw.trim();
  }
}
