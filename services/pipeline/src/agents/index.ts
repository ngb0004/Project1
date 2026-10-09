import type { PipelineAgent } from '@sia/case-schema';
import scoper from './scoper';
import researcher from './researcher';
import recordsResearcher from './recordsResearcher';
import drafter from './drafter';
import hardQuestions from './hardQuestions';
import redTeam from './redTeam';
import factChecker from './factChecker';
import editor from './editor';
import type { AgentSpec } from './types';

export * from './types';
export * from './shared';
export * from './scoper';
export * from './researcher';
export * from './recordsResearcher';
export * from './drafter';
export * from './hardQuestions';
export * from './redTeam';
export * from './factChecker';
export * from './editor';

export { scoper, researcher, recordsResearcher, drafter, hardQuestions, redTeam, factChecker, editor };

/** Every agent spec, keyed by the agent name the review record uses. */
export const AGENT_SPECS = {
  scoper,
  researcher,
  records_researcher: recordsResearcher,
  drafter,
  hard_questions: hardQuestions,
  red_team: redTeam,
  fact_checker: factChecker,
  editor,
} as const satisfies Record<PipelineAgent, AgentSpec<never, unknown>>;
