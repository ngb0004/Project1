import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_SPECS } from '../src/agents';
import type { AgentContext, AgentSpec } from '../src/agents/types';
import { ResearchTools } from '../src/research/tools';
import { ClaudeAgentRunner, DEFAULT_MODELS, outputJsonSchema } from '../src/runner/claude';
import { FakeRunner } from '../src/runner/fake';
import { AgentRunError, isServiceUnavailable } from '../src/runner/types';
import { AGENT_STANDARDS, STANDARD_RULES, UNTRUSTED_DATA_RULE } from '../src/standards';
import { memoryStore } from './helpers';

const ctx: AgentContext = { runId: 'r', asOf: '2026-10-01', round: 1, scope: 'side-a' };

const EXPECTED_ACCESS: Record<string, string> = {
  scoper: 'research',
  researcher: 'research',
  records_researcher: 'research',
  drafter: 'read_sources',
  hard_questions: 'none',
  red_team: 'read_sources',
  fact_checker: 'read_sources',
  editor: 'none',
};

function toolsFor(spec: AgentSpec<never, unknown>) {
  const { store } = memoryStore();
  return new ResearchTools(store, { agent: spec.name, scope: 'side-a', round: 1 }, spec.tools);
}

/** A query() stand-in that records its arguments and yields the given messages. */
function fakeQuery(messages: unknown[]) {
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  const fn = ((args: { prompt: string; options: Record<string, unknown> }) => {
    calls.push(args);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  }) as unknown as typeof query;
  return { fn, calls };
}

const success = (structured: unknown, cost = 0.02) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 3,
  result: '',
  total_cost_usd: cost,
  structured_output: structured,
});

const tinySpec: AgentSpec<{ q: string }, { answer: string }> = {
  name: 'hard_questions',
  tools: 'none',
  tier: 'fast',
  maxTurns: 2,
  system: () => `You answer.\n\n${AGENT_STANDARDS}`,
  prompt: (i) => `Question: ${i.q}`,
  output: z.object({ answer: z.string().min(1) }).strict(),
};

describe('agent specs', () => {
  it.each(Object.entries(AGENT_SPECS))('%s carries the standards, its name and its tool access', (key, spec) => {
    expect(spec.name).toBe(key);
    expect(spec.tools).toBe(EXPECTED_ACCESS[key]);
    const system = spec.system(ctx);
    expect(system).toContain(AGENT_STANDARDS);
    for (const rule of [...STANDARD_RULES, UNTRUSTED_DATA_RULE]) expect(system).toContain(rule);
    expect(spec.maxTurns).toBeGreaterThan(0);
    // The structured-output schema must be expressible as JSON Schema.
    const schema = outputJsonSchema(spec.output as z.ZodType);
    expect(schema.type).toBe('object');
  });

  it('the standards are the spec\'s four bullets, word for word', () => {
    expect(STANDARD_RULES).toEqual([
      'Use only facts from sources you opened in this run, and cite each one.',
      "Mark anything disputed or alleged as such, and never present one side's claim as fact.",
      'Use no judging adjectives in user-facing copy, such as "shocking," "clearly," or "brutal."',
      'For cases involving minors or victims, use no names of private individuals beyond what court records and major outlets already publish.',
    ]);
    expect(UNTRUSTED_DATA_RULE).toMatch(/untrusted data/);
  });
});

describe('ClaudeAgentRunner options', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('gives research agents web search, the research tools and the query-logging hook, and nothing else', () => {
    const runner = new ClaudeAgentRunner();
    const spec = AGENT_SPECS.researcher as AgentSpec<never, unknown>;
    const o = runner.buildOptions(spec, ctx, toolsFor(spec), { maxBudgetUsd: 0.5 });
    expect(o.tools).toEqual(['WebSearch']);
    expect(o.allowedTools).toEqual(['WebSearch', 'mcp__research__open_source', 'mcp__research__read_source', 'mcp__research__find_in_source', 'mcp__research__log_claim']);
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['research']);
    expect(o.hooks?.PostToolUse?.[0]?.matcher).toBe('WebSearch');
    expect(o).toMatchObject({ permissionMode: 'dontAsk', settingSources: [], persistSession: false, model: DEFAULT_MODELS.fast, maxTurns: spec.maxTurns, maxBudgetUsd: 0.5 });
    expect(o.systemPrompt).toContain(AGENT_STANDARDS);
    expect(o.outputFormat).toMatchObject({ type: 'json_schema', schema: { type: 'object' } });
  });

  it('gives red teams only read access, the fact-checker read plus re-open, and no-tool agents nothing', () => {
    const runner = new ClaudeAgentRunner();
    const red = AGENT_SPECS.red_team as AgentSpec<never, unknown>;
    const ro = runner.buildOptions(red, ctx, toolsFor(red));
    expect(ro.tools).toEqual([]);
    expect(ro.allowedTools).toEqual(['mcp__research__read_source', 'mcp__research__find_in_source']);
    expect(ro.hooks).toEqual({});
    expect(ro.model).toBe(DEFAULT_MODELS.strong);

    const fc = AGENT_SPECS.fact_checker as AgentSpec<never, unknown>;
    expect(runner.buildOptions(fc, ctx, toolsFor(fc)).allowedTools).toEqual([
      'mcp__research__open_source',
      'mcp__research__read_source',
      'mcp__research__find_in_source',
    ]);

    const editor = AGENT_SPECS.editor as AgentSpec<never, unknown>;
    const eo = runner.buildOptions(editor, ctx, toolsFor(editor));
    expect(eo).toMatchObject({ tools: [], allowedTools: [], mcpServers: {} });
  });

  it('maps tiers to models from the environment and caps each call', () => {
    vi.stubEnv('PIPELINE_MODEL_STRONG', 'model-strong-x');
    vi.stubEnv('PIPELINE_MODEL_FAST', 'model-fast-y');
    const runner = new ClaudeAgentRunner({ callBudgetUsd: { strong: 1 } });
    const drafter = AGENT_SPECS.drafter as AgentSpec<never, unknown>;
    const o = runner.buildOptions(drafter, ctx, toolsFor(drafter), { maxBudgetUsd: 5 });
    expect(o.model).toBe('model-strong-x');
    expect(o.maxBudgetUsd).toBe(1);
    const researcher = AGENT_SPECS.researcher as AgentSpec<never, unknown>;
    expect(runner.buildOptions(researcher, ctx, toolsFor(researcher)).model).toBe('model-fast-y');
  });

  it('refuses a spec without the standards, or tools of the wrong access level', () => {
    const runner = new ClaudeAgentRunner();
    const bad = { ...tinySpec, system: () => 'No standards here.' };
    expect(() => runner.buildOptions(bad, ctx, toolsFor(tinySpec as AgentSpec<never, unknown>))).toThrow(/does not include the agent standards/);
    const { store } = memoryStore();
    const wrong = new ResearchTools(store, { agent: 'hard_questions', round: 1 }, 'research');
    expect(() => runner.buildOptions(tinySpec, ctx, wrong)).toThrow(/expects "none" tools/);
  });
});

describe('ClaudeAgentRunner.run', () => {
  it('parses the structured output with the agent schema and reports cost and turns', async () => {
    const { fn, calls } = fakeQuery([{ type: 'assistant' }, success({ answer: 'yes' }, 0.031)]);
    const runner = new ClaudeAgentRunner({ queryFn: fn });
    const tools = toolsFor(tinySpec as AgentSpec<never, unknown>);
    const r = await runner.run(tinySpec, { q: 'why?' }, ctx, tools);
    expect(r).toEqual({ output: { answer: 'yes' }, costUsd: 0.031, turns: 3 });
    expect(calls[0]!.prompt).toBe('Question: why?');
    expect(calls[0]!.options.abortController).toBeInstanceOf(AbortController);
  });

  it('turns SDK error results into AgentRunError with the cost spent', async () => {
    const { fn } = fakeQuery([{ type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 9, total_cost_usd: 0.7, errors: ['over budget'] }]);
    const runner = new ClaudeAgentRunner({ queryFn: fn });
    const err = await runner.run(tinySpec, { q: 'x' }, ctx, toolsFor(tinySpec as AgentSpec<never, unknown>)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRunError);
    expect(err).toMatchObject({ reason: 'budget', costUsd: 0.7, agent: 'hard_questions' });
  });

  it('marks a refused account (usage limit, auth) as unavailable, and other failures as execution errors', async () => {
    const throwing = (message: string) =>
      ((() =>
        (async function* () {
          yield* [];
          throw new Error(message);
        })()) as unknown as typeof query);
    const tools = () => toolsFor(tinySpec as AgentSpec<never, unknown>);
    const limit = await new ClaudeAgentRunner({ queryFn: throwing("You've hit your session limit · resets 3:10am (UTC)") }).run(tinySpec, { q: 'x' }, ctx, tools()).catch((e: unknown) => e);
    expect(limit).toMatchObject({ name: 'AgentRunError', reason: 'unavailable' });
    const crash = await new ClaudeAgentRunner({ queryFn: throwing('socket hang up') }).run(tinySpec, { q: 'x' }, ctx, tools()).catch((e: unknown) => e);
    expect(crash).toMatchObject({ reason: 'execution' });
    const { fn } = fakeQuery([{ type: 'result', subtype: 'success', is_error: true, num_turns: 1, total_cost_usd: 0, result: 'Invalid API key · Please run /login' }]);
    const auth = await new ClaudeAgentRunner({ queryFn: fn }).run(tinySpec, { q: 'x' }, ctx, tools()).catch((e: unknown) => e);
    expect(auth).toMatchObject({ reason: 'unavailable' });
    expect(isServiceUnavailable('The fact-checker found a rate limit of 30 mph in the source')).toBe(false);
  });

  it('rejects structured output that does not match the schema', async () => {
    const { fn } = fakeQuery([success({ answer: '' })]);
    const runner = new ClaudeAgentRunner({ queryFn: fn });
    const err = await runner.run(tinySpec, { q: 'x' }, ctx, toolsFor(tinySpec as AgentSpec<never, unknown>)).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AgentRunError', reason: 'output', costUsd: 0.02 });
  });

  it('rejects a run that ends with no result', async () => {
    const { fn } = fakeQuery([{ type: 'assistant' }]);
    const err = await new ClaudeAgentRunner({ queryFn: fn }).run(tinySpec, { q: 'x' }, ctx, toolsFor(tinySpec as AgentSpec<never, unknown>)).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/ended without a result/);
  });
});

describe('FakeRunner', () => {
  it('picks the most specific script, consumes arrays in order, and parses outputs with the schema', async () => {
    const runner = new FakeRunner({
      'hard_questions#side-a@1': { answer: 'specific' },
      'hard_questions@2': [{ answer: 'first' }, { answer: 'second' }],
      hard_questions: { answer: 'default' },
    });
    const tools = toolsFor(tinySpec as AgentSpec<never, unknown>);
    expect((await runner.run(tinySpec, { q: '' }, ctx, tools)).output.answer).toBe('specific');
    const r2 = { ...ctx, round: 2 };
    expect((await runner.run(tinySpec, { q: '' }, r2, tools)).output.answer).toBe('first');
    expect((await runner.run(tinySpec, { q: '' }, r2, tools)).output.answer).toBe('second');
    expect((await runner.run(tinySpec, { q: '' }, r2, tools)).output.answer).toBe('second');
    expect((await runner.run(tinySpec, { q: '' }, { ...ctx, round: 5, scope: 'side-b' }, tools)).output.answer).toBe('default');
    await expect(new FakeRunner({ hard_questions: { answer: '' } }).run(tinySpec, { q: '' }, ctx, tools)).rejects.toThrow(/does not match its schema/);
    expect(runner.calls).toHaveLength(5);
  });
});
