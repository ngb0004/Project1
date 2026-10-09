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

/**
 * Why an agent call failed. `unavailable` means the model service refused the
 * account itself (a usage or rate limit, failed authentication, no credit): every
 * later call would fail the same way, so the run stops instead of degrading.
 */
export type AgentFailureReason = 'budget' | 'max_turns' | 'output' | 'execution' | 'aborted' | 'unavailable';

/** Messages that mean the account cannot make calls right now, whatever the agent asks. */
const UNAVAILABLE_PATTERNS = [
  /hit your (?:session|usage|weekly|daily|monthly) limit/i,
  /\b(?:usage|session) limit\b/i,
  /\brate[_ ]limit(?:ed|_error|[ _]exceeded|[ _]reached)/i,
  /credit balance is too low/i,
  /invalid (?:api|x-api) key|authentication[_ ](?:error|failed)|not logged in|please run \/login/i,
  /\b(?:401|403)\b.*(?:unauthorized|forbidden)/i,
];

/** Whether an error message says the model service is unavailable to this account (see `AgentFailureReason`). */
export function isServiceUnavailable(message: string): boolean {
  return UNAVAILABLE_PATTERNS.some((re) => re.test(message));
}

/** An agent call that did not produce a usable answer. `costUsd` is what it spent anyway. */
export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly agent: string,
    readonly costUsd = 0,
    readonly reason: AgentFailureReason = 'execution',
  ) {
    super(message);
    this.name = 'AgentRunError';
  }
}
