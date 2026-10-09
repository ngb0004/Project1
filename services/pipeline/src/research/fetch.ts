import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

/**
 * Fetches one page and extracts its readable text: HTML through Readability,
 * PDF through unpdf, plain text as-is. It never throws for a bad URL, a network
 * error or an HTTP error; the result records what happened (status 0 when no
 * response came back) so the research log can say so honestly.
 */

export interface FetchedSource {
  /** The URL that was asked for. */
  url: string;
  /** Where the content came from after redirects. */
  finalUrl: string;
  /** HTTP status of the final response; 0 when no response came back. */
  status: number;
  contentType: string;
  title: string;
  text: string;
  /** Bytes of the response body that were read. */
  bytes: number;
  /** Why no usable text came back, when it did not. */
  error?: string;
}

export interface FetchOptions {
  /** Whole-request time limit, redirects and body included. */
  timeoutMs?: number;
  /** Body size limit; larger responses are cut off and reported. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Extracted text is cut to this many characters. */
  maxChars?: number;
  /**
   * Allow loopback, private and link-local addresses. Off by default so a page
   * cannot steer an agent into the worker's own network; tests turn it on.
   */
  allowPrivateHosts?: boolean;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_FETCH_OPTIONS = {
  timeoutMs: 30_000,
  maxBytes: 15 * 1024 * 1024,
  maxRedirects: 8,
  maxChars: 1_500_000,
} as const;

/** Browser-like headers: some official sites refuse requests without them. */
export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
};

export async function fetchSource(url: string, options: FetchOptions = {}): Promise<FetchedSource> {
  const opts = { ...DEFAULT_FETCH_OPTIONS, ...options };
  const doFetch = opts.fetchImpl ?? fetch;
  const empty = (status: number, finalUrl: string, error: string, contentType = ''): FetchedSource => ({
    url,
    finalUrl,
    status,
    contentType,
    title: '',
    text: '',
    bytes: 0,
    error,
  });

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return empty(0, url, 'not a valid URL');
  }

  const signal = AbortSignal.timeout(opts.timeoutMs);
  try {
    let res: Response | undefined;
    for (let hop = 0; ; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        return empty(0, current.href, `unsupported scheme ${current.protocol}`);
      }
      if (!opts.allowPrivateHosts) {
        const blocked = await privateHostReason(current.hostname);
        if (blocked) return empty(0, current.href, blocked);
      }
      res = await doFetch(current.href, { headers: BROWSER_HEADERS, redirect: 'manual', signal });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= opts.maxRedirects) return empty(res.status, current.href, 'too many redirects');
        current = new URL(location, current);
        continue;
      }
      break;
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const finalUrl = current.href;
    const body = await readLimited(res, opts.maxBytes);
    const base = { url, finalUrl, status: res.status, contentType, bytes: body.bytes.byteLength };
    if (!res.ok) {
      return { ...base, title: '', text: '', error: `HTTP ${res.status}` };
    }

    const kind = sniffKind(contentType, finalUrl, body.bytes);
    let title = '';
    let text = '';
    if (kind === 'pdf') {
      if (body.truncated) return { ...base, title: '', text: '', error: `PDF larger than ${opts.maxBytes} bytes` };
      ({ title, text } = await extractPdf(body.bytes));
    } else if (kind === 'html') {
      ({ title, text } = extractHtml(decode(body.bytes, contentType)));
    } else if (kind === 'text') {
      text = cleanText(decode(body.bytes, contentType));
    } else {
      return { ...base, title: '', text: '', error: `unsupported content type ${contentType || 'unknown'}` };
    }
    if (text.length > opts.maxChars) text = text.slice(0, opts.maxChars);
    const error = body.truncated ? `body cut off at ${opts.maxBytes} bytes` : undefined;
    return { ...base, title: title.trim().slice(0, 300), text, ...(error ? { error } : {}) };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const reason =
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `timed out after ${opts.timeoutMs} ms`
        : err.cause?.code ?? err.cause?.message ?? err.message;
    return empty(0, current.href, `fetch failed: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Body reading and type sniffing
// ---------------------------------------------------------------------------

async function readLimited(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes, truncated };
}

function sniffKind(contentType: string, url: string, bytes: Uint8Array): 'html' | 'pdf' | 'text' | 'other' {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (contentType.includes('application/pdf') || head.startsWith('%pdf-')) return 'pdf';
  if (contentType.includes('html') || contentType.includes('xhtml')) return 'html';
  if (contentType.startsWith('text/plain') || contentType.includes('markdown') || contentType.includes('csv')) return 'text';
  if (contentType.includes('json') || contentType.includes('xml')) return 'text';
  if (!contentType || contentType.includes('octet-stream')) {
    if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<body')) return 'html';
    if (/\.pdf($|\?)/i.test(url)) return 'pdf';
    if (/\.(txt|md)($|\?)/i.test(url)) return 'text';
  }
  return 'other';
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=([^;\s]+)/.exec(contentType)?.[1]?.replace(/["']/g, '');
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tbody',
  'td', 'th', 'thead', 'tr', 'ul',
]);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'canvas']);

interface MinimalNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<MinimalNode>;
}

/** Text of a DOM subtree with line breaks at block boundaries. */
function nodeText(root: MinimalNode): string {
  const out: string[] = [];
  const walk = (n: MinimalNode) => {
    if (n.nodeType === 3) {
      out.push(n.textContent ?? '');
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 9 && n.nodeType !== 11) return;
    const tag = n.nodeName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    const block = BLOCK_TAGS.has(tag);
    if (block) out.push('\n');
    for (let i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i]!);
    if (block) out.push('\n');
    else if (tag === 'td' || tag === 'th') out.push(' ');
  };
  walk(root);
  return out.join('');
}

/** Collapses runs of spaces, trims lines and keeps at most one blank line. */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    // Control characters (NUL above all) cannot be stored in Postgres text.
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '')
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/[ \t\f\v\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractHtml(html: string): { title: string; text: string } {
  const { document } = parseHTML(html);
  const pageTitle = cleanText(document.querySelector('title')?.textContent ?? '');
  // Readability changes the tree it reads, so keep a second copy for the fallback.
  const fallbackDoc = parseHTML(html).document;
  let title = pageTitle;
  let text = '';
  try {
    const article = new Readability<MinimalNode>(document as unknown as Document, {
      serializer: (node) => node as unknown as MinimalNode,
      charThreshold: 200,
    }).parse();
    if (article?.content) text = cleanText(nodeText(article.content));
    if (article?.title) title = cleanText(article.title);
  } catch {
    // fall through to the whole-body text
  }
  if (text.length < 200) {
    const body = fallbackDoc.querySelector('body') ?? fallbackDoc.documentElement;
    for (const el of body?.querySelectorAll('nav, header, footer, aside, form') ?? []) el.remove();
    const whole = body ? cleanText(nodeText(body as unknown as MinimalNode)) : '';
    if (whole.length > text.length) text = whole;
  }
  return { title, text };
}

export async function extractPdf(bytes: Uint8Array): Promise<{ title: string; text: string }> {
  const { getDocumentProxy, extractText, getMeta } = await import('unpdf');
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const meta = await getMeta(pdf).catch(() => ({ info: {} as Record<string, unknown> }));
    const title = typeof meta.info?.Title === 'string' ? meta.info.Title : '';
    return { title: cleanText(title), text: cleanText(text.join('\n\n')) };
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Private-address guard
// ---------------------------------------------------------------------------

function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('ff');
  }
  return false;
}

async function privateHostReason(hostname: string): Promise<string | null> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return `refusing to fetch a local host (${host})`;
  }
  if (isIP(host)) return isPrivateAddress(host) ? `refusing to fetch a private address (${host})` : null;
  try {
    const addrs = await lookup(host, { all: true });
    const bad = addrs.find((a) => isPrivateAddress(a.address));
    return bad ? `refusing to fetch ${host}: it resolves to a private address (${bad.address})` : null;
  } catch {
    // Let the fetch itself report hosts that do not resolve.
    return null;
  }
}
