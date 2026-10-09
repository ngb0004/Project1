/**
 * The /s/<slug> link-preview page. Messengers read its Open Graph tags without
 * running any JavaScript; people are sent on to the case.
 */
const DOC = {
  title: 'The <Harbor> Bridge & the vote',
  question: { prompt: 'The city should have built it.', scale: { left_label: 'Disagree', right_label: 'Agree' } },
};

type Route = typeof import('../src/app/s/[slug]+api');

function loadRoute(env: Record<string, string | undefined>): Route {
  let route!: Route;
  jest.isolateModules(() => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    route = require('../src/app/s/[slug]+api');
    process.env = saved;
  });
  return route;
}

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

const meta = (html: string, key: string) =>
  new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html)?.[1];

const SUPABASE = {
  EXPO_PUBLIC_SUPABASE_URL: 'https://db.test',
  EXPO_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  EXPO_PUBLIC_SHARE_BASE_URL: 'https://dive.test',
};

it('gives link previews the case, where the sharer landed, and an image, then opens the case', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify([{ doc: DOC }]), { status: 200 }));
  const { GET } = loadRoute(SUPABASE);
  const res = await GET(new Request('https://dive.test/s/harbor?b=80&a=30'), { slug: 'harbor' });
  const html = await res.text();

  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(fetchMock).toHaveBeenCalledWith(
    'https://db.test/rest/v1/rpc/get_published_case',
    expect.objectContaining({ body: JSON.stringify({ p_slug: 'harbor', p_version: null }) }),
  );
  expect(meta(html, 'og:title')).toBe('The &#60;Harbor&#62; Bridge &#38; the vote');
  expect(meta(html, 'og:description')).toBe(
    'I started at 80 (Agree) and ended at 30 (Leaning disagree). Do you agree: &#34;The city should have built it.&#34; ' +
      'Read the facts one at a time, then see where you land.',
  );
  expect(meta(html, 'og:image')).toBe('https://dive.test/og.png');
  expect(meta(html, 'twitter:card')).toBe('summary_large_image');
  expect(html).toContain('<meta http-equiv="refresh" content="0; url=/case/harbor?b=80&#38;a=30">');
  expect(html).toContain('location.replace("/case/harbor?b=80&a=30")');
  expect(html).not.toContain('<Harbor>');
});

it('drops a Before and After that are not whole numbers from 0 to 100', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify([{ doc: DOC }]), { status: 200 }));
  const { GET } = loadRoute(SUPABASE);
  const res = await GET(new Request('https://dive.test/s/harbor?b=80&a=<script>'), { slug: 'harbor' });
  const html = await res.text();
  expect(html).toContain('location.replace("/case/harbor")');
  expect(meta(html, 'og:description')).not.toContain('I started');
  expect(html).not.toContain('<script>"');
});

it('falls back to a plain preview when the case is not live or the database cannot be reached', async () => {
  const { GET } = loadRoute(SUPABASE);
  for (const outcome of [
    () => fetchMock.mockResolvedValue(new Response('[]', { status: 200 })),
    () => fetchMock.mockRejectedValue(new Error('offline')),
  ]) {
    outcome();
    const html = await (await GET(new Request('https://dive.test/s/gone?b=1&a=2'), { slug: 'gone' })).text();
    expect(meta(html, 'og:title')).toBe('Dive');
    expect(html).toContain('location.replace("/case/gone?b=1&a=2")');
  }
});
