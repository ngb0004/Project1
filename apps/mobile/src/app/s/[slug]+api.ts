import { journeyText, parseSharedPosition } from '@sia/dive-engine';
import { config } from '@/lib/config';

/**
 * GET /s/<slug>?b=<before>&a=<after>: the link a reader shares.
 *
 * Link previews (iMessage, WhatsApp, X, Slack, Facebook) do not run the app's
 * JavaScript, so this answers with a small HTML page whose Open Graph tags carry
 * the case title, the sharer's Before and After, and a preview image. People
 * are sent straight on to /case/<slug>, which greets them with where the sharer
 * landed.
 */
export async function GET(request: Request, { slug }: { slug: string }) {
  const url = new URL(request.url);
  const origin = (config.shareBaseUrl ?? url.origin).replace(/\/+$/, '');
  const from = parseSharedPosition(url.searchParams.get('b'), url.searchParams.get('a'));
  const target = `/case/${encodeURIComponent(slug)}${from ? `?b=${from.before}&a=${from.after}` : ''}`;

  const doc = await fetchCase(slug);
  const title = doc?.title ?? 'Dive';
  const question = doc?.question.prompt;
  const journey = doc && from ? journeyText(from, doc.question.scale.left_label, doc.question.scale.right_label) : null;
  const description = [
    journey,
    question ? `Do you agree: "${question}"` : null,
    'Read the facts one at a time, then see where you land.',
  ]
    .filter(Boolean)
    .join(' ');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Dive">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(origin + url.pathname + url.search)}">
<meta property="og:image" content="${esc(origin)}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Dive: read the facts, then see where you land.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(origin)}/og.png">
<meta http-equiv="refresh" content="0; url=${esc(target)}">
<style>body{margin:0;padding:32px 16px;background:#F6F2EA;color:#1D1B18;font:18px/1.5 Georgia,serif}a{color:#B04A2E}</style>
</head>
<body>
<p><a href="${esc(target)}">Open “${esc(title)}”</a></p>
<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')});</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Short, so a corrected or newly published case shows up in fresh previews.
      'cache-control': 'public, max-age=300',
    },
  });
}

interface PreviewDoc {
  title: string;
  question: { prompt: string; scale: { left_label: string; right_label: string } };
}

/** The live published case, read with the public key; null when there is none or it can't be reached. */
async function fetchCase(slug: string): Promise<PreviewDoc | null> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) return null;
  try {
    const res = await fetch(`${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/get_published_case`, {
      method: 'POST',
      headers: { apikey: config.supabaseAnonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ p_slug: slug, p_version: null }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as { doc?: PreviewDoc }[];
    const doc = rows[0]?.doc;
    return doc && typeof doc.title === 'string' && doc.question?.scale ? doc : null;
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
