import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchSource } from '../src/research/fetch';

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
});
