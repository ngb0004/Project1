import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Worker } from 'node:worker_threads';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { cleanText, extractHtml, extractPdf, type ExtractedText } from './extract.mjs';

export { cleanText, extractHtml, extractPdf, MAX_HTML_CHARS, nodeText } from './extract.mjs';

/**
 * Fetches one page and extracts its readable text: HTML through Readability,
 * PDF through unpdf, plain text as-is. It never throws for a bad URL, a network
 * error or an HTTP error; the result records what happened (status 0 when no
 * response came back) so the research log can say so honestly.
 *
 * Network guard (on unless `allowPrivateHosts`): a page cannot steer an agent
 * into the worker's own network. The address checked is the address connected
 * to: the connection's own DNS lookup resolves the name once, refuses it when
 * any answer is not a public address, and connects to exactly those answers
 * (no second lookup a rebinding name could answer differently). A name that
 * does not resolve is refused. IP literals are checked as written, with IPv6
 * forms that embed an IPv4 address (mapped, compatible, NAT64, 6to4) checked
 * by that address. Every redirect hop goes through the same connection path.
 *
 * Extraction runs in a worker thread with a time and memory limit, so one
 * pathological page fails its open instead of freezing the process.
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
  /** Bytes of the (decoded) response body that were read. */
  bytes: number;
  /** Why no usable text came back, when it did not. */
  error?: string;
}

/** Resolves a host name to its addresses (the connection's DNS lookup). */
export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;

export interface FetchOptions {
  /** Whole-request time limit, redirects and body included. */
  timeoutMs?: number;
  /** Body size limit (decoded bytes); larger responses are cut off and reported. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Extracted text is cut to this many characters. */
  maxChars?: number;
  /**
   * Allow loopback, private and link-local addresses. Off by default so a page
   * cannot steer an agent into the worker's own network; tests turn it on.
   */
  allowPrivateHosts?: boolean;
  /** Time limit for extracting the text of one page (HTML or PDF). */
  extractTimeoutMs?: number;
  /** Run extraction in a worker thread (default true); false runs it inline, with no time limit. */
  extractInWorker?: boolean;
  /** Replaces DNS resolution for the connection (tests). */
  resolve?: ResolveHost;
  /**
   * Replaces the network transport with a WHATWG fetch (tests). The address
   * guard then checks only IP literals and local names: there is no connection
   * of its own to check.
   */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_FETCH_OPTIONS = {
  timeoutMs: 30_000,
  maxBytes: 15 * 1024 * 1024,
  maxRedirects: 8,
  maxChars: 1_500_000,
  extractTimeoutMs: 20_000,
} as const;

/** Memory cap for an extraction worker's heap. */
const EXTRACT_HEAP_MB = 768;

/** Browser-like headers: some official sites refuse requests without them. */
export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Thrown inside the connection's lookup when a name resolves to an address the guard refuses. */
class BlockedAddressError extends Error {
  readonly code = 'ESIA_BLOCKED_ADDRESS';
  constructor(message: string) {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

/** One response, from either transport. */
interface RawResponse {
  status: number;
  header(name: string): string | null;
  /** The decoded body. */
  body: AsyncIterable<Uint8Array>;
  /** Stops reading and releases the connection. */
  cancel(): void;
}

export async function fetchSource(url: string, options: FetchOptions = {}): Promise<FetchedSource> {
  const opts = { ...DEFAULT_FETCH_OPTIONS, ...options };
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
  let res: RawResponse | undefined;
  try {
    for (let hop = 0; ; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        return empty(0, current.href, `unsupported scheme ${current.protocol}`);
      }
      if (!opts.allowPrivateHosts) {
        const blocked = literalHostReason(current.hostname);
        if (blocked) return empty(0, current.href, blocked);
      }
      res = opts.fetchImpl
        ? await viaFetch(opts.fetchImpl, current, signal)
        : await viaNode(current, signal, guardedLookup(opts.resolve ?? systemResolve, !!opts.allowPrivateHosts));
      const location = res.header('location');
      if (res.status >= 300 && res.status < 400 && location) {
        res.cancel();
        if (hop >= opts.maxRedirects) return empty(res.status, current.href, 'too many redirects');
        current = new URL(location, current);
        continue;
      }
      break;
    }

    const contentType = (res.header('content-type') ?? '').toLowerCase();
    const finalUrl = current.href;
    const body = await readLimited(res, opts.maxBytes);
    const base = { url, finalUrl, status: res.status, contentType, bytes: body.bytes.byteLength };
    if (res.status < 200 || res.status > 299) {
      return { ...base, title: '', text: '', error: `HTTP ${res.status}` };
    }

    const kind = sniffKind(contentType, finalUrl, body.bytes);
    let title = '';
    let text = '';
    if (kind === 'pdf') {
      if (body.truncated) return { ...base, title: '', text: '', error: `PDF larger than ${opts.maxBytes} bytes` };
      const r = await extract({ kind: 'pdf', bytes: body.bytes }, opts);
      if ('error' in r) return { ...base, title: '', text: '', error: r.error };
      ({ title, text } = r);
    } else if (kind === 'html') {
      const r = await extract({ kind: 'html', html: decode(body.bytes, contentType) }, opts);
      if ('error' in r) return { ...base, title: '', text: '', error: r.error };
      ({ title, text } = r);
    } else if (kind === 'text') {
      text = cleanText(decode(body.bytes, contentType));
    } else {
      return { ...base, title: '', text: '', error: `unsupported content type ${contentType || 'unknown'}` };
    }
    if (text.length > opts.maxChars) text = text.slice(0, opts.maxChars);
    const error = body.truncated ? `body cut off at ${opts.maxBytes} bytes` : undefined;
    return { ...base, title: title.trim().slice(0, 300), text, ...(error ? { error } : {}) };
  } catch (e) {
    res?.cancel();
    const err = e as Error & { code?: string; cause?: { code?: string; message?: string } };
    if (err instanceof BlockedAddressError || err.code === 'ESIA_BLOCKED_ADDRESS') return empty(0, current.href, err.message);
    const reason =
      err.name === 'TimeoutError' || err.name === 'AbortError' || signal.aborted
        ? `timed out after ${opts.timeoutMs} ms`
        : (err.cause?.code ?? err.code ?? err.cause?.message ?? err.message);
    return empty(0, current.href, `fetch failed: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** The production transport: node:http(s) with the guarded lookup, one connection per request. */
function viaNode(url: URL, signal: AbortSignal, lookup: GuardedLookup): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        ...(url.port ? { port: Number(url.port) } : {}),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { ...BROWSER_HEADERS, 'Accept-Encoding': 'gzip, deflate, br' },
        // A fresh connection per request: every connection runs the guarded lookup.
        agent: false,
        lookup,
        signal,
      },
      (res) => {
        const body = decodedBody(res);
        resolve({
          status: res.statusCode ?? 0,
          header: (name) => {
            const v = res.headers[name.toLowerCase()];
            return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
          },
          body,
          cancel: () => {
            res.destroy();
            req.destroy();
          },
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** The response body with its content encoding undone (gzip, deflate, br); an unknown encoding is passed through. */
function decodedBody(res: IncomingMessage): AsyncIterable<Uint8Array> {
  const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : null;
  if (!decoder) return res;
  res.on('error', (e) => decoder.destroy(e));
  decoder.on('close', () => res.destroy());
  return res.pipe(decoder);
}

/** A WHATWG fetch as the transport (tests). */
async function viaFetch(doFetch: typeof fetch, url: URL, signal: AbortSignal): Promise<RawResponse> {
  const r = await doFetch(url.href, { headers: BROWSER_HEADERS, redirect: 'manual', signal });
  const body: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      if (!r.body) return;
      const reader = r.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  };
  return { status: r.status, header: (n) => r.headers.get(n), body, cancel: () => void r.body?.cancel().catch(() => {}) };
}

// ---------------------------------------------------------------------------
// Body reading and type sniffing
// ---------------------------------------------------------------------------

async function readLimited(res: RawResponse, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for await (const value of res.body) {
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      res.cancel();
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
// Extraction (in a worker thread)
// ---------------------------------------------------------------------------

type ExtractJob = { kind: 'html'; html: string } | { kind: 'pdf'; bytes: Uint8Array };

async function extract(job: ExtractJob, opts: { extractTimeoutMs: number; extractInWorker?: boolean }): Promise<ExtractedText | { error: string }> {
  if (opts.extractInWorker === false) {
    try {
      return job.kind === 'pdf' ? await extractPdf(job.bytes) : extractHtml(job.html);
    } catch (e) {
      return { error: `text extraction failed: ${(e as Error).message}` };
    }
  }
  return extractInWorker(job, opts.extractTimeoutMs);
}

const EXTRACT_WORKER_URL = new URL('./extract-worker.mjs', import.meta.url);

/**
 * Extracts in a worker thread that is terminated after `timeoutMs` or when its
 * heap passes EXTRACT_HEAP_MB, so the main thread (heartbeat, agent timeouts,
 * other agents' tool calls) never stalls on one page.
 */
export function extractInWorker(job: ExtractJob, timeoutMs: number): Promise<ExtractedText | { error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(EXTRACT_WORKER_URL, {
      workerData: job,
      resourceLimits: { maxOldGenerationSizeMb: EXTRACT_HEAP_MB },
      // The extraction module is plain JavaScript; no loader is needed (or wanted) in the worker.
      execArgv: [],
    });
    const done = (r: ExtractedText | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const limit = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
    const timer = setTimeout(() => done({ error: `text extraction took longer than ${limit}` }), timeoutMs);
    worker.once('message', (m: { ok: boolean; title?: string; text?: string; error?: string }) =>
      done(m.ok ? { title: m.title ?? '', text: m.text ?? '' } : { error: `text extraction failed: ${m.error ?? 'unknown error'}` }),
    );
    worker.once('error', (e) =>
      done({ error: /ERR_WORKER_OUT_OF_MEMORY|heap/i.test(`${(e as { code?: string }).code ?? ''} ${e.message}`) ? 'text extraction ran out of memory' : `text extraction failed: ${e.message}` }),
    );
    worker.once('exit', (code) => done({ error: `text extraction stopped (exit code ${code})` }));
  });
}

// ---------------------------------------------------------------------------
// Address guard
// ---------------------------------------------------------------------------

const systemResolve: ResolveHost = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))),
  );

type GuardedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

/**
 * The lookup the connection itself uses: resolve once, refuse the connection
 * when any answer is not public (or when the name does not resolve), and hand
 * the connection exactly the answers that were checked.
 */
export function guardedLookup(resolve: ResolveHost, allowPrivate: boolean): GuardedLookup {
  return (hostname, options, callback) => {
    const host = hostname.replace(/^\[|\]$/g, '');
    resolve(host)
      .then((all) => {
        const family = typeof options.family === 'number' ? options.family : options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : 0;
        if (!all.length) throw Object.assign(new Error(`${host} did not resolve`), { code: 'ENOTFOUND' });
        if (!allowPrivate) {
          const bad = all.find((a) => !isPublicAddress(a.address));
          if (bad) throw new BlockedAddressError(`refusing to fetch ${host}: it resolves to a private address (${bad.address})`);
        }
        const usable = family ? all.filter((a) => a.family === family) : all;
        if (!usable.length) throw Object.assign(new Error(`${host} has no IPv${family} address`), { code: 'ENOTFOUND' });
        if (options.all) callback(null, usable);
        else callback(null, usable[0]!.address, usable[0]!.family);
      })
      .catch((e: NodeJS.ErrnoException) => callback(e, '', 0));
  };
}

/** Why a URL host is refused before any connection: a local name, or an IP literal that is not public. */
function literalHostReason(hostname: string): string | null {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return `refusing to fetch a local host (${host})`;
  }
  if (isIP(host)) return isPublicAddress(host) ? null : `refusing to fetch a private address (${host})`;
  return null;
}

/** IPv4 ranges that are not public (the IANA special-purpose registry, multicast and reserved): [network, prefix length]. */
const IPV4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function isPublicIPv4(n: number): boolean {
  for (const [net, prefix] of IPV4_BLOCKED) {
    const start = ipv4ToInt(net)!;
    if (n >= start && n < start + 2 ** (32 - prefix)) return false;
  }
  return true;
}

/** An IPv6 address as eight 16-bit groups (zone id dropped; a dotted IPv4 tail allowed), or null. */
export function parseIPv6(raw: string): number[] | null {
  let s = raw.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(':');
  if (lastColon < 0) return null;
  let tail: number[] = [];
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = ipv4ToInt(last);
    if (v4 === null) return null;
    tail = [v4 >>> 16, v4 & 0xffff];
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if ([...head, ...rest].some((x) => Number.isNaN(x))) return null;
  const fixed = head.length + rest.length + tail.length;
  if (halves.length === 1) return fixed === 8 ? [...head, ...tail] : null;
  if (fixed > 7) return null;
  return [...head, ...new Array<number>(8 - fixed).fill(0), ...rest, ...tail];
}

function isPublicIPv6(g: number[]): boolean {
  const v4 = (hi: number, lo: number) => isPublicIPv4(hi * 65536 + lo);
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped): by the embedded IPv4 address.
  if (zero(0, 6)) return v4(g[6]!, g[7]!);
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  // 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48 (local NAT64): by the embedded IPv4 address / never.
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false;
  // Only global unicast (2000::/3) is public; that excludes fc00::/7, fe80::/10, fec0::/10, ff00::/8 and the rest.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  // 2002::/16 (6to4): by the embedded IPv4 address.
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  // 2001::/23 (IETF protocol assignments: Teredo, ORCHID, benchmarking, ...), 2001:db8::/32 and 3fff::/20 (documentation).
  if (g[0] === 0x2001 && g[1]! < 0x200) return false;
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false;
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false;
  return true;
}

/** True only for a globally routable unicast address. Anything unparseable is not public. */
export function isPublicAddress(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, '');
  const v = isIP(host.split('%')[0]!);
  if (v === 4) {
    const n = ipv4ToInt(host);
    return n !== null && isPublicIPv4(n);
  }
  if (v === 6) {
    const g = parseIPv6(host);
    return g !== null && isPublicIPv6(g);
  }
  return false;
}
