// Text extraction for fetched pages: HTML through Readability (linkedom DOM),
// PDF through unpdf, and the whitespace clean-up both share.
//
// Plain JavaScript on purpose: src/research/extract-worker.mjs runs these in a
// worker thread (see fetch.ts), and a worker loads its module with Node itself,
// whatever loader (tsx, vitest) the main thread uses. Types: extract.d.mts.

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tbody',
  'td', 'th', 'thead', 'tr', 'ul',
]);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'canvas']);

/** Most HTML characters handed to the parser; a longer page is cut (the readable part of a page is near its top). */
export const MAX_HTML_CHARS = 5_000_000;

/**
 * Text of a DOM subtree with line breaks at block boundaries.
 *
 * Linear in the size of the tree: children are walked with firstChild /
 * nextSibling. (linkedom builds a new `childNodes` array on every access, so
 * indexing `childNodes` in a loop is quadratic in the number of siblings, and
 * a page with thousands of sibling elements froze the process for minutes.)
 * Iterative, so a deeply nested page cannot overflow the stack.
 */
export function nodeText(root) {
  const out = [];
  // Each entry is a node to visit, or a string to emit once its children are done.
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (typeof n === 'string') {
      out.push(n);
      continue;
    }
    if (n.nodeType === 3) {
      out.push(n.textContent ?? '');
      continue;
    }
    if (n.nodeType !== 1 && n.nodeType !== 9 && n.nodeType !== 11) continue;
    const tag = String(n.nodeName).toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    const block = BLOCK_TAGS.has(tag);
    if (block) out.push('\n');
    stack.push(block ? '\n' : tag === 'td' || tag === 'th' ? ' ' : '');
    const kids = [];
    for (let c = n.firstChild; c; c = c.nextSibling) kids.push(c);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out.join('');
}

/** Collapses runs of spaces, trims lines and keeps at most one blank line. */
export function cleanText(s) {
  return s
    .replace(/\r\n?/g, '\n')
    // Control characters (NUL above all) cannot be stored in Postgres text.
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '')
    .replace(/[­​-‍﻿]/g, '')
    .replace(/[ \t\f\v  -   　]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Readable text and title of an HTML page. */
export function extractHtml(rawHtml) {
  const html = rawHtml.length > MAX_HTML_CHARS ? rawHtml.slice(0, MAX_HTML_CHARS) : rawHtml;
  const { document } = parseHTML(html);
  const pageTitle = cleanText(document.querySelector('title')?.textContent ?? '');
  let title = pageTitle;
  let text = '';
  try {
    const article = new Readability(document, { serializer: (node) => node, charThreshold: 200 }).parse();
    if (article?.content) text = cleanText(nodeText(article.content));
    if (article?.title) title = cleanText(article.title);
  } catch {
    // fall through to the whole-body text
  }
  if (text.length < 200) {
    // Readability changes the tree it reads, so the fallback parses a fresh copy.
    const fallbackDoc = parseHTML(html).document;
    const body = fallbackDoc.querySelector('body') ?? fallbackDoc.documentElement;
    for (const el of body?.querySelectorAll('nav, header, footer, aside, form') ?? []) el.remove();
    const whole = body ? cleanText(nodeText(body)) : '';
    if (whole.length > text.length) text = whole;
  }
  return { title, text };
}

/** Text and title of a PDF. */
export async function extractPdf(bytes) {
  const { getDocumentProxy, extractText, getMeta } = await import('unpdf');
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const meta = await getMeta(pdf).catch(() => ({ info: {} }));
    const title = typeof meta.info?.Title === 'string' ? meta.info.Title : '';
    return { title: cleanText(title), text: cleanText(text.join('\n\n')) };
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}
