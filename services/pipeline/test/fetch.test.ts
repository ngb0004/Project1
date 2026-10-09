import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractHtml, fetchSource, isPublicAddress, parseIPv6, type ResolveHost } from '../src/research/fetch';

/** A one-page PDF with a title and the given lines of text (Helvetica), built by hand. */
export function makePdf(lines: string[], title: string): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    `<< /Title (${esc(title)}) /Producer (pipeline tests) >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const ARTICLE = `<!doctype html>
<html><head>
<title>County votes to delay water main repair | Example News</title>
<script>var tracking = "SCRIPT-SHOULD-NOT-APPEAR";</script>
<style>.x { color: red }</style>
</head><body>
<nav><a href="/">Home</a> <a href="/news">NAVLINK-SHOULD-NOT-APPEAR</a></nav>
<article>
<h1>County votes to delay water main repair</h1>
<p>The county council voted 5-4 on Tuesday to postpone the Elm Street water main replacement to the 2027 budget.
The main was rated poor in a 2024 inspection that recommended replacement within two years.</p>
<p>Councilmember Ortiz said “the county could not fund the work this year,” pointing to a 40 percent cut in state grants.
Residents who spoke at the meeting asked the council to reconsider before the next budget cycle.</p>
<p>The vote followed a two-hour public hearing. Staff told the council that the main had 14 documented leaks since 2020,
and that a failure could close several blocks of Elm Street for days.</p>
</article>
<footer>FOOTER-SHOULD-NOT-APPEAR copyright</footer>
</body></html>`;

const PDF_LINES = ['Maple County Superior Court', 'Order on motion to dismiss, filed March 3, 2026.', 'The motion is denied in part and granted in part.'];

let server: Server;
let base: string;

function handler(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? '/';
  switch (url) {
    case '/article.html':
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(ARTICLE);
    case '/order.pdf':
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(makePdf(PDF_LINES, 'Order on motion to dismiss'));
    case '/download':
      // A PDF served without a useful content type.
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(makePdf(PDF_LINES, 'Order'));
    case '/statement.txt':
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Statement from the county.\r\n\r\n\r\nThe county   will review   the vote.\n');
    case '/nul.txt':
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('Line one\u0000 with a NUL.\u0007\nLine two.');
    case '/redirect':
      res.writeHead(302, { location: '/article.html' });
      return res.end();
    case '/loop':
      res.writeHead(302, { location: '/loop' });
      return res.end();
    case '/forbidden':
      res.writeHead(403, { 'content-type': 'text/html' });
      return res.end('<html><body>Forbidden</body></html>');
    case '/headers':
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(req.headers));
    case '/big':
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('x'.repeat(300_000));
    case '/binary':
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    case '/slow':
      return; // never answers
    case '/gzip':
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'gzip' });
      return res.end(gzipSync('Compressed statement from the county about the water main vote.'));
    case '/bomb':
      // 20 MB of zeros, gzipped to about 20 KB.
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      return res.end(gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x30)));
    default:
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<html><body>Not found</body></html>');
  }
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const local = { allowPrivateHosts: true };

describe('fetchSource', () => {
  it('extracts the readable text of an HTML article, without scripts, styles, navigation or footer', async () => {
    const r = await fetchSource(`${base}/article.html`, local);
    expect(r.status).toBe(200);
    expect(r.error).toBeUndefined();
    expect(r.contentType).toContain('text/html');
    expect(r.title).toContain('County votes to delay water main repair');
    expect(r.text).toContain('The county council voted 5-4 on Tuesday to postpone the Elm Street water main replacement');
    expect(r.text).toContain('“the county could not fund the work this year,”');
    expect(r.text).toContain('14 documented leaks since 2020');
    for (const junk of ['SCRIPT-SHOULD-NOT-APPEAR', 'NAVLINK-SHOULD-NOT-APPEAR', 'FOOTER-SHOULD-NOT-APPEAR', 'color: red']) {
      expect(r.text).not.toContain(junk);
    }
    // Paragraphs stay apart; runs of spaces collapse.
    expect(r.text).toMatch(/budget\.\s*\nThe main|two years\.\n+Councilmember/);
    expect(r.text).not.toMatch(/ {2,}/);
  });

  it('extracts text and title from a PDF', async () => {
    const r = await fetchSource(`${base}/order.pdf`, local);
    expect(r.status).toBe(200);
    expect(r.title).toBe('Order on motion to dismiss');
    for (const line of PDF_LINES) expect(r.text.replace(/\s+/g, ' ')).toContain(line);
  });

  it('recognizes a PDF served as application/octet-stream', async () => {
    const r = await fetchSource(`${base}/download`, local);
    expect(r.status).toBe(200);
    expect(r.text.replace(/\s+/g, ' ')).toContain('The motion is denied in part and granted in part.');
  });

  it('keeps plain text as-is, with whitespace tidied', async () => {
    const r = await fetchSource(`${base}/statement.txt`, local);
    expect(r.status).toBe(200);
    expect(r.text).toBe('Statement from the county.\n\nThe county will review the vote.');
  });

  it('drops control characters that the database cannot store', async () => {
    const r = await fetchSource(`${base}/nul.txt`, local);
    expect(r.text).toBe('Line one with a NUL.\nLine two.');
  });

  it('follows redirects and records the final URL', async () => {
    const r = await fetchSource(`${base}/redirect`, local);
    expect(r.status).toBe(200);
    expect(r.url).toBe(`${base}/redirect`);
    expect(r.finalUrl).toBe(`${base}/article.html`);
    expect(r.text).toContain('voted 5-4');
  });

  it('stops after too many redirects', async () => {
    const r = await fetchSource(`${base}/loop`, { ...local, maxRedirects: 3 });
    expect(r.status).toBe(302);
    expect(r.text).toBe('');
    expect(r.error).toMatch(/too many redirects/);
  });

  it('records HTTP errors honestly, with no text', async () => {
    const r = await fetchSource(`${base}/forbidden`, local);
    expect(r).toMatchObject({ status: 403, text: '', error: 'HTTP 403' });
    const missing = await fetchSource(`${base}/nope`, local);
    expect(missing).toMatchObject({ status: 404, text: '', error: 'HTTP 404' });
  });

  it('sends browser-like headers', async () => {
    const r = await fetchSource(`${base}/headers`, local);
    const h = JSON.parse(r.text) as Record<string, string>;
    expect(h['user-agent']).toMatch(/^Mozilla\/5\.0/);
    expect(h.accept).toContain('text/html');
    expect(h['accept-language']).toContain('en');
  });

  it('cuts off bodies over the size limit and says so', async () => {
    const r = await fetchSource(`${base}/big`, { ...local, maxBytes: 100_000 });
    expect(r.status).toBe(200);
    expect(r.bytes).toBe(100_000);
    expect(r.text.length).toBe(100_000);
    expect(r.error).toMatch(/cut off at 100000 bytes/);
  });

  it('gives up after the time limit', async () => {
    const r = await fetchSource(`${base}/slow`, { ...local, timeoutMs: 300 });
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/timed out after 300 ms/);
  });

  it('does not pretend to read unsupported content', async () => {
    const r = await fetchSource(`${base}/binary`, local);
    expect(r.status).toBe(200);
    expect(r.text).toBe('');
    expect(r.error).toMatch(/unsupported content type image\/png/);
  });

  it('refuses private and local addresses unless allowed, including after a redirect', async () => {
    const direct = await fetchSource(`${base}/article.html`);
    expect(direct.status).toBe(0);
    expect(direct.error).toMatch(/private address/);
    const named = await fetchSource('http://localhost:9/x');
    expect(named.error).toMatch(/local host/);

    // A public address that redirects into the private network.
    const seen: string[] = [];
    const fetchImpl = (async (u: string | URL | Request) => {
      seen.push(String(u));
      return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/admin' } });
    }) as typeof fetch;
    const hop = await fetchSource('http://93.184.216.34/start', { fetchImpl });
    expect(seen).toEqual(['http://93.184.216.34/start']);
    expect(hop.status).toBe(0);
    expect(hop.finalUrl).toBe('http://10.0.0.5/admin');
    expect(hop.error).toMatch(/private address \(10\.0\.0\.5\)/);
  });

  it('rejects bad URLs and non-http schemes without throwing', async () => {
    expect((await fetchSource('not a url')).error).toBe('not a valid URL');
    expect((await fetchSource('file:///etc/passwd')).error).toMatch(/unsupported scheme file:/);
  });

  it('decodes gzip bodies and applies the size limit to the decoded bytes (a gzip bomb is cut off)', async () => {
    const r = await fetchSource(`${base}/gzip`, local);
    expect(r.text).toBe('Compressed statement from the county about the water main vote.');
    const bomb = await fetchSource(`${base}/bomb`, { ...local, maxBytes: 100_000 });
    expect(bomb.bytes).toBe(100_000);
    expect(bomb.error).toMatch(/cut off at 100000 bytes/);
  });
});

describe('address guard', () => {
  const port = () => Number(new URL(base).port);

  it('refuses IPv6 literals that embed a private IPv4 address, in every spelling the URL parser produces', async () => {
    const blocked = [
      'http://[::ffff:127.0.0.1]/x',
      'http://[::ffff:7f00:1]/x',
      'http://[0:0:0:0:0:ffff:127.0.0.1]/x',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::7f00:1]/x',
      'http://[::127.0.0.1]/x',
      'http://[64:ff9b::7f00:1]/x',
      'http://[2002:7f00:1::]/x',
      'http://[2002:a9fe:a9fe::1]/x',
      'http://[fec0::1]/x',
      'http://[fd00::1]/x',
      'http://[fe80::1]/x',
      'http://[2001:db8::1]/x',
      'http://[2001::1]/x',
      'http://[::]/x',
      'http://192.0.0.1/x',
      'http://198.18.0.1/x',
      'http://100.64.1.1/x',
      'http://2130706433/x',
    ];
    for (const url of blocked) {
      const r = await fetchSource(url, { timeoutMs: 2000 });
      expect(r.status, url).toBe(0);
      expect(r.error, url).toMatch(/private address/);
    }
  });

  it('classifies addresses: only global unicast is public', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', '::', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'fc00::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::5', 'not-an-ip']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6('1:2:3:4:5:6:7.8.9.10')).toEqual([1, 2, 3, 4, 5, 6, 0x0708, 0x090a]);
    expect(parseIPv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  });

  it('checks the address the connection uses: a name that resolves to a private address is refused at connect time', async () => {
    const calls: string[] = [];
    const resolve: ResolveHost = async (host) => {
      calls.push(host);
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const r = await fetchSource(`http://rebind.test:${port()}/article.html`, { resolve, timeoutMs: 2000 });
    expect(r.status).toBe(0);
    expect(r.text).toBe('');
    expect(r.error).toMatch(/rebind\.test: it resolves to a private address \(127\.0\.0\.1\)/);
    // One lookup per connection: there is no separate check whose answer a rebinding name could change.
    expect(calls).toEqual(['rebind.test']);
  });

  it('refuses when any answer is private, even if another is public', async () => {
    const resolve: ResolveHost = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ];
    const r = await fetchSource(`http://mixed.test:${port()}/article.html`, { resolve, timeoutMs: 2000 });
    expect(r.error).toMatch(/private address \(10\.0\.0\.7\)/);
  });

  it('fails closed when the lookup fails', async () => {
    const resolve: ResolveHost = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND broken.test'), { code: 'ENOTFOUND' });
    };
    const r = await fetchSource(`http://broken.test:${port()}/article.html`, { resolve, timeoutMs: 2000 });
    expect(r.status).toBe(0);
    expect(r.text).toBe('');
    expect(r.error).toMatch(/fetch failed: ENOTFOUND/);
  });

  it('connects to exactly the address its lookup returned', async () => {
    // "pipeline-test.invalid" cannot resolve through system DNS, so a successful fetch proves the
    // connection used the guarded lookup's answer (and asked only once).
    let n = 0;
    const resolve: ResolveHost = async () => {
      n++;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const r = await fetchSource(`http://pipeline-test.invalid:${port()}/article.html`, { ...local, resolve });
    expect(r.status).toBe(200);
    expect(r.text).toContain('voted 5-4');
    expect(n).toBe(1);
  });
});

describe('extraction', () => {
  const flat = (kb: number) => {
    const para = '<p>Paragraph text, with commas, that Readability will score as content. Lorem ipsum dolor sit amet.</p>\n';
    return `<!doctype html><html><head><title>big</title></head><body><article>${para.repeat(Math.floor((kb * 1024) / para.length))}</article></body></html>`;
  };

  it('is linear in the number of sibling elements: 1 MB of flat paragraphs extracts in about a second', () => {
    const t0 = performance.now();
    const r = extractHtml(flat(1024));
    const ms = performance.now() - t0;
    expect(r.text.length).toBeGreaterThan(500_000);
    expect(ms).toBeLessThan(3000);
  });

  it('runs in a worker with a time limit: a page that takes too long fails its open instead of stalling', async () => {
    const big = flat(1024);
    const server2 = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(big);
    });
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server2.address() as AddressInfo).port}/big.html`;
      // The heartbeat keeps ticking while the worker extracts.
      let ticks = 0;
      const tick = setInterval(() => ticks++, 5);
      const slow = await fetchSource(url, { ...local, extractTimeoutMs: 50 });
      clearInterval(tick);
      expect(slow.status).toBe(200);
      expect(slow.text).toBe('');
      expect(slow.error).toMatch(/text extraction took longer than 50 ms/);
      expect(ticks).toBeGreaterThan(3);
      const ok = await fetchSource(url, local);
      expect(ok.error).toBeUndefined();
      expect(ok.text.length).toBeGreaterThan(500_000);
    } finally {
      server2.closeAllConnections();
      await new Promise<void>((r) => server2.close(() => r()));
    }
  });
});
