// Worker-thread entry for text extraction (see extractInWorker in fetch.ts).
// The main thread kills this worker when it runs past its time or memory limit,
// so one pathological page fails its open instead of freezing the process
// (the heartbeat, agent timeouts and every other agent's tool calls).

import { parentPort, workerData } from 'node:worker_threads';
import { extractHtml, extractPdf } from './extract.mjs';

try {
  const { kind, html, bytes } = workerData;
  const result = kind === 'pdf' ? await extractPdf(bytes) : extractHtml(html);
  parentPort.postMessage({ ok: true, ...result });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
