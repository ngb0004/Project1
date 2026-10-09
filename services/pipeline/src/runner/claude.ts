import { query as sdkQuery, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentContext, AgentSpec } from '../agents/types';
import type { ResearchTools } from '../research/tools';
import { MCP_SERVER_NAME } from '../research/tools';
import { AGENT_STANDARDS } from '../standards';
import { AgentRunError, isServiceUnavailable, type AgentFailureReason, type AgentRunResult, type AgentRunner, type RunOptions } from './types';

/**
 * Runs agents with the Claude Agent SDK. Each call is a fresh query with no
 * saved session, no settings files and only the tools the agent's access level
 * allows, so a red team never sees what the drafter was thinking. The answer
 * comes back as structured output against the agent's Zod schema and is parsed
 * with that schema.
 */

export const DEFAULT_MODELS = {
  strong: 'claude-opus-5-5',
  fast: 'claude-sonnet-5-5',
} as const;

/**
 * Per-call spend caps by tier (USD). The orchestrator's share of the run budget
 * can lower a call's cap further; it never raises it above these.
 *
 * Measured on two live Clancy runs (43 calls, Oct 2026): the most expensive
 * strong-tier calls were the drafter ($2.47), the fact-checker ($1.74) and the
 * editor ($1.24); fast-tier researchers peaked at $0.57. The caps leave about
 * 2.5x (strong) and 3.5x (fast) headroom for larger cases while still stopping
 * a runaway call. A full three-round run cost $18.20 (budget default: $40).
 */
export const DEFAULT_CALL_BUDGET_USD = {
  strong: 6,
  fast: 2,
} as const;

export interface ClaudeRunnerOptions {
  models?: Partial<Record<'strong' | 'fast', string>>;
  callBudgetUsd?: Partial<Record<'strong' | 'fast', number>>;
  /** Hard time limit per call. */
  timeoutMs?: number;
  /** Working directory for the agent process (it has no file tools). */
  cwd?: string;
  /** Replaces the SDK's query function (tests). */
  queryFn?: typeof sdkQuery;
  /** Called with each SDK message, e.g. for progress output. */
  onMessage?: (agent: string, msg: SDKMessage) => void;
}

export function modelsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<'strong' | 'fast', string> {
  return {
    strong: env.PIPELINE_MODEL_STRONG || DEFAULT_MODELS.strong,
    fast: env.PIPELINE_MODEL_FAST || DEFAULT_MODELS.fast,
  };
}

/** The JSON Schema the model must answer with: the input side of the agent's Zod schema. */
export function outputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export class ClaudeAgentRunner implements AgentRunner {
  private readonly models: Record<'strong' | 'fast', string>;
  private readonly budgets: Record<'strong' | 'fast', number>;

  constructor(private readonly opts: ClaudeRunnerOptions = {}) {
    const env = modelsFromEnv();
    this.models = { strong: opts.models?.strong ?? env.strong, fast: opts.models?.fast ?? env.fast };
    this.budgets = { ...DEFAULT_CALL_BUDGET_USD, ...opts.callBudgetUsd };
  }

  /** The SDK options for one call (exported for tests and for auditing what an agent may do). */
  buildOptions<I, O>(spec: AgentSpec<I, O>, ctx: AgentContext, tools: ResearchTools, runOpts: RunOptions = {}): Options {
    const system = spec.system(ctx);
    if (!system.includes(AGENT_STANDARDS)) {
      throw new AgentRunError(`the ${spec.name} system prompt does not include the agent standards`, spec.name);
    }
    if (tools.access !== spec.tools) {
      throw new AgentRunError(`${spec.name} expects "${spec.tools}" tools but was given "${tools.access}"`, spec.name);
    }
    const server = tools.mcpServer();
    const budget = Math.min(runOpts.maxBudgetUsd ?? Infinity, this.budgets[spec.tier]);
    return {
      systemPrompt: system,
      model: this.models[spec.tier],
      maxTurns: spec.maxTurns,
      ...(Number.isFinite(budget) ? { maxBudgetUsd: Math.max(0.01, budget) } : {}),
      outputFormat: { type: 'json_schema', schema: outputJsonSchema(spec.output as z.ZodType) },
      tools: tools.builtinTools(),
      allowedTools: tools.allowedTools(),
      mcpServers: server ? { [MCP_SERVER_NAME]: server } : {},
      hooks: tools.hooks(),
      permissionMode: 'dontAsk',
      settingSources: [],
      persistSession: false,
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
    };
  }

  async run<I, O>(spec: AgentSpec<I, O>, input: I, ctx: AgentContext, tools: ResearchTools, runOpts: RunOptions = {}): Promise<AgentRunResult<O>> {
    const options = this.buildOptions(spec, ctx, tools, runOpts);
    const prompt = spec.prompt(input, ctx);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('agent call timed out')), this.opts.timeoutMs ?? 30 * 60_000);
    const onOuterAbort = () => abort.abort(runOpts.signal?.reason);
    runOpts.signal?.addEventListener('abort', onOuterAbort, { once: true });

    let cost = 0;
    try {
      const q = (this.opts.queryFn ?? sdkQuery)({ prompt, options: { ...options, abortController: abort } });
      for await (const msg of q) {
        this.opts.onMessage?.(spec.name, msg);
        if (msg.type !== 'result') continue;
        cost = msg.total_cost_usd ?? 0;
        if (msg.subtype !== 'success') {
          const detail = msg.errors?.length ? ` (${msg.errors.join('; ')})` : '';
          const reason: AgentFailureReason =
            msg.subtype === 'error_max_budget_usd'
              ? 'budget'
              : msg.subtype === 'error_max_turns'
                ? 'max_turns'
                : msg.subtype === 'error_max_structured_output_retries'
                  ? 'output'
                  : isServiceUnavailable(detail)
                    ? 'unavailable'
                    : 'execution';
          throw new AgentRunError(`${spec.name} stopped: ${msg.subtype}${detail}`, spec.name, cost, reason);
        }
        if (msg.is_error) {
          throw new AgentRunError(`${spec.name} failed: ${msg.result}`, spec.name, cost, isServiceUnavailable(msg.result) ? 'unavailable' : 'execution');
        }
        if (msg.structured_output === undefined) {
          throw new AgentRunError(`${spec.name} returned no structured output`, spec.name, cost, 'output');
        }
        const parsed = spec.output.safeParse(msg.structured_output);
        if (!parsed.success) {
          throw new AgentRunError(`${spec.name} output does not match its schema: ${z.prettifyError(parsed.error)}`, spec.name, cost, 'output');
        }
        return { output: parsed.data, costUsd: cost, turns: msg.num_turns };
      }
      throw new AgentRunError(`${spec.name} ended without a result`, spec.name, cost);
    } catch (e) {
      if (e instanceof AgentRunError) throw e;
      const message = (e as Error).message;
      const reason: AgentFailureReason = abort.signal.aborted ? 'aborted' : isServiceUnavailable(message) ? 'unavailable' : 'execution';
      throw new AgentRunError(`${spec.name} failed: ${message}`, spec.name, cost, reason);
    } finally {
      clearTimeout(timer);
      runOpts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
