import { describe, expect, it } from 'vitest';
import { matchQuote, normalizeForMatch, urlKey } from '../src/research/text';
import { ResearchTools, ToolAccessError, mcpToolName, searchResultLinks } from '../src/research/tools';
import { PAGES, URLS, memoryStore } from './helpers';

describe('SourceStore', () => {
  it('snapshots a page it opened, logs the open, and finds it again by URL', async () => {
    const { store, log } = memoryStore();
    const r = await store.open(URLS.minutes, 'researcher', 'side-a', 0);
    expect(r.ok).toBe(true);
    const snap = r.snapshot!;
    expect(snap.text).toBe(PAGES[URLS.minutes]!.text);
    expect(snap.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.get(snap.id)).toBe(snap);
    expect(log.snapshots).toHaveLength(1);
    expect(log.entries).toEqual([
      expect.objectContaining({ agent: 'researcher', scope: 'side-a', round: 0, kind: 'open', url: URLS.minutes, snapshot_id: snap.id, http_status: 200 }),
    ]);
    // URL variants that point at the same page
    for (const u of [`${URLS.minutes}/`, `${URLS.minutes}#item-7`, `${URLS.minutes}?utm_source=x`, URLS.minutes.replace('https://', 'https://www.')]) {
      expect(store.findByUrl(u)?.id, u).toBe(snap.id);
    }
    expect(store.findByUrl(URLS.grants)).toBeUndefined();
  });

  it('does not count a page as opened when it errors or has almost no text, but still logs the attempt', async () => {
    const { store, log } = memoryStore();
    const gone = await store.open('https://news.example.com/gone', 'researcher', null, 1);
    expect(gone).toMatchObject({ ok: false, status: 404, error: 'HTTP 404' });
    const wall = await store.open('https://news.example.com/paywalled', 'researcher', null, 1);
    expect(wall.ok).toBe(false);
    expect(wall.error).toMatch(/characters of readable text/);
    expect(store.opened()).toEqual([]);
    expect(store.findByUrl('https://news.example.com/paywalled')).toBeUndefined();
    expect(log.snapshots).toEqual([]);
    expect(log.entries.map((e) => [e.kind, e.http_status, e.snapshot_id])).toEqual([
      ['open', 404, null],
      ['open', 200, null],
    ]);
    expect(log.entries[1]!.excerpt).toMatch(/^Not usable/);
  });

  it('reuses one snapshot when the same text is opened twice, and logs both opens', async () => {
    const { store, log } = memoryStore();
    const a = await store.open(URLS.grants, 'researcher', 'side-b', 0);
    const b = await store.open(URLS.grants, 'fact_checker', null, 1);
    expect(b.snapshot!.id).toBe(a.snapshot!.id);
    expect(store.opened()).toHaveLength(1);
    expect(log.snapshots).toHaveLength(1);
    expect(log.entries.filter((e) => e.kind === 'open').map((e) => e.agent)).toEqual(['researcher', 'fact_checker']);
  });

  it('summarizes the log per agent, scope, round and kind', async () => {
    const { store, log } = memoryStore();
    await store.open(URLS.grants, 'researcher', 'side-b', 0);
    await store.open(URLS.minutes, 'researcher', 'side-b', 0);
    await store.open(URLS.minutes, 'fact_checker', null, 2);
    expect(log.summary()).toEqual({
      total: 3,
      groups: [
        { agent: 'researcher', scope: 'side-b', round: 0, counts: { open: 2 }, total: 2 },
        { agent: 'fact_checker', scope: null, round: 2, counts: { open: 1 }, total: 1 },
      ],
    });
  });
});

describe('ResearchTools', () => {
  it('gives each access level only its tools', () => {
    const { store } = memoryStore();
    const research = new ResearchTools(store, { agent: 'researcher', scope: 'side-a', round: 0 }, 'research');
    expect(research.builtinTools()).toEqual(['WebSearch']);
    expect(research.allowedTools()).toEqual(['WebSearch', ...['open_source', 'read_source', 'find_in_source', 'log_claim'].map(mcpToolName)]);
    expect(research.hooks()?.PostToolUse?.[0]?.matcher).toBe('WebSearch');
    expect(research.mcpServer()).toMatchObject({ type: 'sdk', name: 'research' });

    const redTeam = new ResearchTools(store, { agent: 'red_team', scope: 'side-a', round: 1 }, 'read_sources');
    expect(redTeam.builtinTools()).toEqual([]);
    expect(redTeam.allowedTools()).toEqual(['read_source', 'find_in_source'].map(mcpToolName));
    expect(redTeam.hooks()).toEqual({});

    const factChecker = new ResearchTools(store, { agent: 'fact_checker', round: 1 }, 'read_sources');
    expect(factChecker.allowedTools()).toEqual(['open_source', 'read_source', 'find_in_source'].map(mcpToolName));

    const editor = new ResearchTools(store, { agent: 'editor', round: 1 }, 'none');
    expect(editor.allowedTools()).toEqual([]);
    expect(editor.mcpServer()).toBeNull();
  });

  it('refuses tools outside the access level', async () => {
    const { store } = memoryStore();
    const redTeam = new ResearchTools(store, { agent: 'red_team', round: 1 }, 'read_sources');
    await expect(redTeam.openSource(URLS.grants)).rejects.toBeInstanceOf(ToolAccessError);
    await expect(redTeam.logClaim('x', 'y', 'z')).rejects.toBeInstanceOf(ToolAccessError);
    const editor = new ResearchTools(store, { agent: 'editor', round: 1 }, 'none');
    expect(() => editor.readSource('x')).toThrow(ToolAccessError);
  });

  it('reads snapshots in pieces and finds phrases in them', async () => {
    const { store } = memoryStore();
    const tools = new ResearchTools(store, { agent: 'researcher', scope: 'side-a', round: 0 }, 'research');
    const opened = await tools.openSource(URLS.breakNews);
    const id = opened.snapshot!.id;
    const all = PAGES[URLS.breakNews]!.text;
    const first = tools.readSource(id, 0, 20);
    expect(first).toMatchObject({ offset: 0, length: 20, total: all.length, text: all.slice(0, 20) });
    expect(tools.readSource(id, 20, 30).text).toBe(all.slice(20, 50));
    // Straight quotes in the search phrase match the page's curly quotes.
    const found = tools.findInSource(id, '"We made the best choice');
    expect(found.offsets).toEqual([all.indexOf('“We made the best choice')]);
    expect(() => tools.readSource('not-a-snapshot')).toThrow(/was not taken in this run/);
  });

  it('logs a claim only when its quote is in the snapshot', async () => {
    const { store, log } = memoryStore();
    const tools = new ResearchTools(store, { agent: 'researcher', scope: 'side-b', round: 0 }, 'research');
    const opened = await tools.openSource(URLS.grants);
    const id = opened.snapshot!.id;
    await expect(tools.logClaim('Grants were cut.', 'The state increased grants by 40 percent.', id)).rejects.toThrow(/does not appear verbatim/);
    await expect(tools.logClaim('Grants were cut.', 'reduced', id)).rejects.toThrow(/too short/);
    const claim = await tools.logClaim('Grants were cut 40 percent.', 'reduced local water infrastructure grants by 40 percent', id);
    expect(claim.url).toBe(URLS.grants);
    expect(log.entries.filter((e) => e.kind === 'claim')).toEqual([
      expect.objectContaining({ agent: 'researcher', scope: 'side-b', round: 0, snapshot_id: id, claims: [{ text: 'Grants were cut 40 percent.', quote: 'reduced local water infrastructure grants by 40 percent' }] }),
    ]);
  });

  it('logs every WebSearch query with its result links through the PostToolUse hook', async () => {
    const { store, log } = memoryStore();
    const tools = new ResearchTools(store, { agent: 'records_researcher', scope: 'records', round: 2 }, 'research');
    await tools.webSearchHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'WebSearch',
        tool_input: { query: 'maple county water main minutes' },
        tool_response: { query: 'maple county water main minutes', results: [{ tool_use_id: 't', content: [{ title: 'Minutes', url: URLS.minutes }] }, 'commentary'], durationSeconds: 1 },
        tool_use_id: 't',
        session_id: 's',
        transcript_path: '',
        cwd: '/',
      } as never,
      't',
      { signal: new AbortController().signal },
    );
    expect(log.entries).toEqual([
      expect.objectContaining({ agent: 'records_researcher', scope: 'records', round: 2, kind: 'query', query: 'maple county water main minutes', excerpt: `Minutes — ${URLS.minutes}` }),
    ]);
    expect(tools.queries).toEqual(['maple county water main minutes']);
  });

  it('pulls result links out of any search response shape', () => {
    expect(searchResultLinks({ results: [{ content: [{ title: 'A', url: 'https://a.example/' }, { url: 'https://b.example/' }] }] })).toEqual([
      { title: 'A', url: 'https://a.example/' },
      { url: 'https://b.example/' },
    ]);
    expect(searchResultLinks('plain text')).toEqual([]);
  });
});

describe('quote and URL matching', () => {
  it('normalizes whitespace, curly quotes, dashes and invisible characters', () => {
    expect(normalizeForMatch('\u201cHello\u201d\u00a0 world \u2014 it\u2019s\u200b fine\n\n')).toBe('"Hello" world - it\'s fine');
  });

  it('matches quotes verbatim after normalization, with ellipses as omissions', () => {
    const text = 'Councilmember Ortiz said “the county could not fund\nthe work this year,” after the vote.';
    expect(matchQuote('"the county could not fund the work this year,"', text).ok).toBe(true);
    expect(matchQuote('Ortiz said “the county … this year,”', text).ok).toBe(true);
    expect(matchQuote('the county could fund the work this year', text)).toEqual({ ok: false, reason: 'not_found' });
    expect(matchQuote('this year ... Councilmember Ortiz', text)).toEqual({ ok: false, reason: 'not_found' });
    expect(matchQuote('the vote', text)).toEqual({ ok: false, reason: 'too_short' });
  });

  it('builds the same key for equivalent URLs', () => {
    expect(urlKey('https://www.Example.com:443/a/b/?utm_source=x&b=2&a=1#frag')).toBe(urlKey('http://example.com/a/b?a=1&b=2'));
    expect(urlKey('https://example.com/a')).not.toBe(urlKey('https://example.com/b'));
  });
});
