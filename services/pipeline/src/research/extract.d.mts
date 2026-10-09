/** Types for extract.mjs (plain JavaScript so a worker thread can load it with Node alone). */

export declare const MAX_HTML_CHARS: number;

export interface ExtractedText {
  title: string;
  text: string;
}

/** Text of a DOM subtree with line breaks at block boundaries (linear in the size of the tree). */
export declare function nodeText(root: unknown): string;

/** Collapses runs of spaces, trims lines and keeps at most one blank line. */
export declare function cleanText(s: string): string;

/** Readable text and title of an HTML page (HTML longer than MAX_HTML_CHARS is cut first). */
export declare function extractHtml(html: string): ExtractedText;

/** Text and title of a PDF. */
export declare function extractPdf(bytes: Uint8Array): Promise<ExtractedText>;
