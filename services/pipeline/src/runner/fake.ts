import type { AgentContext, AgentSpec } from '../agents/types';
import type { ResearchTools } from '../research/tools';
import { AGENT_STANDARDS } from '../standards';
import { AgentRunError, type AgentRunResult, type AgentRunner, type RunOptions } from './types';

/**
 * A scripted runner for tests. Outputs are looked up by agent name, scope and
 * round, most specific first:
 *
 *   `red_team#side-a@2`, `red_team#side-a`, `red_team@2`, `red_team`
 *
 * A script is a value, a function of (input, ctx, tools, call), or an array
 * consumed one entry per call (the last entry repeats). Functions get the real
 * ResearchTools for the call, so any page a script "opens" goes through the
 * source store and the research log exactly as a model's would. Every output is
 * parsed with the agent's schema, as structured output would be.
 */

export interface FakeCall {
  agent: string;
  scope: string | undefined;
  round: number;
  input: unknown;
  system: string;
  prompt: string;
  output?: unknown;
  access: ResearchTools['access'];
}

export type FakeScriptFn = (input: any, ctx: AgentContext, tools: ResearchTools, call: FakeCall) => unknown;
export type FakeScript = FakeScriptFn | unknown[] | Record<string, unknown> | string | number | boolean | null;

export interface FakeRunnerOptions {
  costPerCall?: number;
  /** Check that every system prompt includes AGENT_STANDARDS (default true). */
  requireStandards?: boolean;
}

export class FakeRunner implements AgentRunner {
  readonly calls: FakeCall[] = [];
  private readonly used = new Map<string, number>();

  constructor(
    private readonly scripts: Record<string, FakeScript>,
    private readonly opts: FakeRunnerOptions = {},
  ) {}

  /** Calls made to one agent, optionally narrowed to a scope or round. */
  callsTo(agent: string, filter: { scope?: string; round?: number } = {}): FakeCall[] {
    return this.calls.filter(
      (c) => c.agent === agent && (filter.scope === undefined || c.scope === filter.scope) && (filter.round === undefined || c.round === filter.round),
    );
  }

  private lookup(name: string, ctx: AgentContext): { key: string; script: FakeScript } {
    const keys = [
      ...(ctx.scope !== undefined ? [`${name}#${ctx.scope}@${ctx.round}`, `${name}#${ctx.scope}`] : []),
      `${name}@${ctx.round}`,
      name,
    ];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(this.scripts, key)) return { key, script: this.scripts[key] as FakeScript };
    }
    throw new AgentRunError(`FakeRunner has no script for ${keys[0]}`, name);
  }

  async run<I, O>(spec: AgentSpec<I, O>, input: I, ctx: AgentContext, tools: ResearchTools, runOpts: RunOptions = {}): Promise<AgentRunResult<O>> {
    const signal = runOpts.signal;
    if (signal?.aborted) throw new AgentRunError(`${spec.name} failed: aborted before it started`, spec.name, 0, 'aborted');
    const system = spec.system(ctx);
    if ((this.opts.requireStandards ?? true) && !system.includes(AGENT_STANDARDS)) {
      throw new AgentRunError(`the ${spec.name} system prompt does not include the agent standards`, spec.name);
    }
    if (tools.access !== spec.tools) {
      throw new AgentRunError(`${spec.name} expects "${spec.tools}" tools but was given "${tools.access}"`, spec.name);
    }
    const call: FakeCall = {
      agent: spec.name,
      scope: ctx.scope,
      round: ctx.round,
      input: structuredClone(input),
      system,
      prompt: spec.prompt(input, ctx),
      access: tools.access,
    };
    this.calls.push(call);

    const { key, script } = this.lookup(spec.name, ctx);
    let step: FakeScript = script;
    if (Array.isArray(script)) {
      const n = this.used.get(key) ?? 0;
      this.used.set(key, n + 1);
      step = script[Math.min(n, script.length - 1)] as FakeScript;
    }
    // Like the SDK runner, an abort ends the call at once with reason "aborted", whatever the script is doing.
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new AgentRunError(`${spec.name} failed: ${(signal?.reason as Error | undefined)?.message ?? 'aborted'}`, spec.name, 0, 'aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => {});
    let raw: unknown;
    try {
      raw = typeof step === 'function' ? await Promise.race([Promise.resolve((step as FakeScriptFn)(input, ctx, tools, call)), aborted]) : structuredClone(step);
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
    const parsed = spec.output.safeParse(raw);
    if (!parsed.success) {
      throw new AgentRunError(`${spec.name} (scripted) output does not match its schema: ${parsed.error.message}`, spec.name, 0, 'output');
    }
    call.output = parsed.data;
    return { output: parsed.data, costUsd: this.opts.costPerCall ?? 0, turns: 1 };
  }
}
