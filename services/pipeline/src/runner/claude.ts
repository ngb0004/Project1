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

/**
 * List prices in USD per million tokens (Oct 2026): input, output, cache write
 * (5-minute TTL, 1.25x input) and cache read. Used only to estimate what a call
 * spent when it ends without its result message (a timeout, a shutdown, an SDK
 * error): the result message's total_cost_usd is used whenever it arrives.
 */
export const MODEL_PRICES_PER_MTOK: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};

/** For a model not in the table: the highest known price of each kind, so an estimate errs high. */
const FALLBACK_PRICE = Object.values(MODEL_PRICES_PER_MTOK).reduce(
  (a, p) => ({ input: Math.max(a.input, p.input), output: Math.max(a.output, p.output), cacheWrite: Math.max(a.cacheWrite, p.cacheWrite), cacheRead: Math.max(a.cacheRead, p.cacheRead) }),
  { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
);

export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** What a set of API responses cost at list price (one usage per response). */
export function estimateCostUsd(model: string, usages: TokenUsage[]): number {
  const p = MODEL_PRICES_PER_MTOK[model] ?? FALLBACK_PRICE;
  let usd = 0;
  for (const u of usages) {
    usd += ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + (u.cache_read_input_tokens ?? 0) * p.cacheRead) / 1e6;
  }
  return usd;
}

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
    // Token usage per API response (several streamed assistant messages share one message id), so a call that
    // ends without its result message (a timeout, a shutdown, an SDK error) is still charged what it spent.
    const usage = new Map<string, { model: string; usage: TokenUsage }>();
    const spentSoFar = () => {
      let usd = 0;
      for (const u of usage.values()) usd += estimateCostUsd(u.model || (options.model ?? ''), [u.usage]);
      return usd;
    };
    try {
      const q = (this.opts.queryFn ?? sdkQuery)({ prompt, options: { ...options, abortController: abort } });
      for await (const msg of q) {
        this.opts.onMessage?.(spec.name, msg);
        if (msg.type === 'assistant' && msg.message?.usage) {
          const key = msg.message.id ?? `${usage.size}`;
          const prev = usage.get(key)?.usage;
          const u = msg.message.usage as TokenUsage;
          // Streamed messages carry usage that is not final yet: keep the largest count seen for each kind.
          usage.set(key, {
            model: msg.message.model ?? '',
            usage: {
              input_tokens: Math.max(prev?.input_tokens ?? 0, u.input_tokens ?? 0),
              output_tokens: Math.max(prev?.output_tokens ?? 0, u.output_tokens ?? 0),
              cache_creation_input_tokens: Math.max(prev?.cache_creation_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0),
              cache_read_input_tokens: Math.max(prev?.cache_read_input_tokens ?? 0, u.cache_read_input_tokens ?? 0),
            },
          });
        }
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
      const est = spentSoFar();
      throw new AgentRunError(`${spec.name} ended without a result${est ? ` (about $${est.toFixed(4)} spent, estimated from token usage)` : ''}`, spec.name, est);
    } catch (e) {
      if (e instanceof AgentRunError) throw e;
      const message = (e as Error).message;
      const reason: AgentFailureReason = abort.signal.aborted ? 'aborted' : isServiceUnavailable(message) ? 'unavailable' : 'execution';
      // No result message: charge what the responses so far used, at list price.
      const spent = Math.max(cost, spentSoFar());
      throw new AgentRunError(
        `${spec.name} failed: ${message}${spent > cost ? ` (about $${spent.toFixed(4)} spent, estimated from token usage)` : ''}`,
        spec.name,
        spent,
        reason,
      );
    } finally {
      clearTimeout(timer);
      runOpts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
