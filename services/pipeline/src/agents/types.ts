import type { z } from 'zod';
import type { PipelineAgent } from '@sia/case-schema';

/**
 * What an agent may touch while it runs:
 * - `research`: web search plus open_source, read_source and log_claim
 * - `read_sources`: read_source on snapshots taken in this run (the fact-checker also gets open_source)
 * - `none`: no tools; the agent works only from its input
 */
export type ToolAccess = 'research' | 'read_sources' | 'none';

export interface AgentContext {
  /** The pipeline run (the job id when a worker runs it). */
  runId: string;
  /** Today's date for the run, `YYYY-MM-DD`; facts are current as of this date. */
  asOf: string;
  /** 0 for the first pass; loop rounds count up from 1. */
  round: number;
  /** e.g. the side a researcher or red team works for. */
  scope?: string;
}

/**
 * One agent: its prompts, its tools and the shape of its answer. The runner
 * turns `output` into a JSON Schema for structured output and parses the reply
 * with it, so `O` is what the orchestrator receives.
 */
export interface AgentSpec<I, O> {
  name: PipelineAgent;
  tools: ToolAccess;
  tier: 'strong' | 'fast';
  maxTurns: number;
  /** Must include AGENT_STANDARDS from ../standards. */
  system(ctx: AgentContext): string;
  prompt(input: I, ctx: AgentContext): string;
  output: z.ZodType<O>;
}

export type AgentInput<S> = S extends AgentSpec<infer I, unknown> ? I : never;
export type AgentOutput<S> = S extends AgentSpec<unknown, infer O> ? O : never;
