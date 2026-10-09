import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateCase } from '@sia/case-schema';
import { DraftCase } from '../src/agents/shared';
import type { AgentContext, AgentSpec } from '../src/agents/types';
import { MemoryResearchLog } from '../src/research/log';
import { SourceStore } from '../src/research/store';
import { matchQuote } from '../src/research/text';
import { ResearchTools } from '../src/research/tools';
import { ClaudeAgentRunner } from '../src/runner/claude';
import { AGENT_STANDARDS } from '../src/standards';

/**
 * One real Agent SDK call (opt-in: PIPELINE_LIVE=1, or the older PIPELINE_LIVE_TEST=1; about $0.05-0.30).
 * It proves the wiring the scripted tests cannot: web search runs and is logged
 * by the PostToolUse hook, the in-process MCP tools open and snapshot a real
 * page and log a claim, and the answer comes back as schema-checked structured
 * output.
 */

const live = process.env.PIPELINE_LIVE === '1' || !!process.env.PIPELINE_LIVE_TEST;

const probe: AgentSpec<{ topic: string }, { url: string; snapshot_id: string; quote: string }> = {
  name: 'researcher',
  tools: 'research',
  tier: 'fast',
  maxTurns: 12,
  system: () =>
    [
      'You are a test probe for a research pipeline. Work quickly and use as few turns as you can.',
      AGENT_STANDARDS,
    ].join('\n\n'),
  prompt: (i) =>
    [
      `1. Run one WebSearch for: ${i.topic}`,
      '2. Call open_source on one result URL from an official or encyclopedia site (if it fails, try one other URL).',
      '3. Call log_claim with a one-sentence claim, a verbatim quote of 8 to 25 words copied from the open_source text, and the snapshot_id.',
      '4. Return the opened URL, the snapshot_id and the quote.',
    ].join('\n'),
  output: z.object({ url: z.string().url(), snapshot_id: z.string().min(1), quote: z.string().min(10) }).strict(),
};

describe.skipIf(!live)('ClaudeAgentRunner (live)', () => {
  it('searches, opens, snapshots and logs a claim through the real Agent SDK', { timeout: 300_000 }, async () => {
    const log = new MemoryResearchLog();
    const store = new SourceStore({ log });
    const ctx: AgentContext = { runId: 'live-probe', asOf: new Date().toISOString().slice(0, 10), round: 0, scope: 'probe' };
    const tools = new ResearchTools(store, { agent: 'researcher', scope: 'probe', round: 0 }, 'research');
    const runner = new ClaudeAgentRunner({ callBudgetUsd: { fast: 0.75 } });
    const r = await runner.run(probe, { topic: 'Golden Gate Bridge opening date 1937' }, ctx, tools);

    const snap = store.get(r.output.snapshot_id);
    expect(snap, 'the returned snapshot was taken in this run').toBeDefined();
    expect(matchQuote(r.output.quote, snap!.text).ok).toBe(true);
    const kinds = log.entries.map((e) => e.kind);
    expect(kinds).toContain('query');
    expect(kinds).toContain('open');
    expect(kinds).toContain('claim');
    expect(log.entries.every((e) => e.agent === 'researcher' && e.scope === 'probe')).toBe(true);
    process.stderr.write(`live probe: $${r.costUsd.toFixed(4)}, ${r.turns} turns, ${tools.queries.length} searches, opened ${snap!.url}\n`);
  });

  it('round-trips the full draft-case schema through structured output', { timeout: 300_000 }, async () => {
    const spec: AgentSpec<Record<string, never>, z.output<typeof DraftCase>> = {
      name: 'editor',
      tools: 'none',
      tier: 'fast',
      maxTurns: 4,
      system: () => ['You are a test probe for a JSON schema. Answer only through the structured output.', AGENT_STANDARDS].join('\n\n'),
      prompt: () =>
        'Return a minimal fictional case about a made-up town council vote, clearly labeled FICTIONAL in the title: ' +
        'id "probe", slug "probe-case", status "draft", version 1, as_of "2026-01-01", one starting fact, two steps (order 1 and 2), ' +
        'two sides with ids "side-a" and "side-b", one source with id "src-1" (url https://example.org/probe, type "official", date "2026", ' +
        'accessed_at "2026-01-01T00:00:00Z") cited by every fact and step, and micro_poll {"prompt": "Does this change your position?", "re_ask_slider": true}.',
      output: DraftCase,
    };
    const store = new SourceStore({ log: new MemoryResearchLog() });
    const tools = new ResearchTools(store, { agent: 'editor', round: 0 }, 'none');
    const r = await new ClaudeAgentRunner({ callBudgetUsd: { fast: 0.75 } }).run(spec, {}, { runId: 'live-schema', asOf: '2026-01-01', round: 0 }, tools);
    expect(r.output.slug).toBe('probe-case');
    expect(validateCase(r.output).errors).toEqual([]);
    process.stderr.write(`live schema probe: $${r.costUsd.toFixed(4)}, ${r.turns} turns\n`);
  });
});
