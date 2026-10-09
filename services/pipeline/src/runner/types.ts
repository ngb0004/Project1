import type { AgentContext, AgentSpec } from '../agents/types';
import type { ResearchTools } from '../research/tools';

export interface RunOptions {
  /** Spend cap for this one call, in USD. */
  maxBudgetUsd?: number;
  signal?: AbortSignal;
}

export interface AgentRunResult<O> {
  output: O;
  costUsd: number;
  turns: number;
}

/** Runs one agent call: the real Agent SDK (ClaudeAgentRunner) or a script (FakeRunner). */
export interface AgentRunner {
  run<I, O>(spec: AgentSpec<I, O>, input: I, ctx: AgentContext, tools: ResearchTools, opts?: RunOptions): Promise<AgentRunResult<O>>;
}

/** An agent call that did not produce a usable answer. `costUsd` is what it spent anyway. */
export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly agent: string,
    readonly costUsd = 0,
    readonly reason: 'budget' | 'max_turns' | 'output' | 'execution' | 'aborted' = 'execution',
  ) {
    super(message);
    this.name = 'AgentRunError';
  }
}
