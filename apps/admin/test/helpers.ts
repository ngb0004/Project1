import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertValidCase, type Case, type ReviewRecord } from '@sia/case-schema';

const fixtures = fileURLToPath(new URL('../../../cases/fixtures/', import.meta.url));

export function loadFixture(name = 'fixture-harbor-bridge'): Case {
  return assertValidCase(JSON.parse(readFileSync(`${fixtures}${name}.json`, 'utf8')));
}

/** A review record touching every kind of flag the step list shows. */
export function sampleReview(): ReviewRecord {
  return {
    pipeline_run_id: '00000000-0000-4000-8000-000000000001',
    rounds: 2,
    agent_reports: [{ agent: 'editor', round: 1, at: '2026-10-01T12:00:00Z', summary: 'Applied fixes.' }],
    hard_questions: [
      { id: 'hq1', side_id: 'council-responsible', question: 'Was the inspection report shared?', blocking: true, status: 'open', step_ids: ['s1', 's2'], round: 1 },
      { id: 'hq2', question: 'Who paid for repairs?', blocking: false, status: 'answered', resolution: 'Added s4.', step_ids: ['s4'], round: 0 },
      { id: 'hq3', question: 'Unlinked question', blocking: false, status: 'open', step_ids: [], round: 1 },
    ],
    bias_reports: [
      {
        side_id: 'council-not-responsible',
        round: 1,
        summary: 'Order favors the other side.',
        flags: [
          { id: 'b1', step_id: 's1', kind: 'loaded_wording', severity: 'high', note: 'Headline implies blame.', status: 'unaddressed' },
          { id: 'b2', step_id: 's3', kind: 'order_effect', severity: 'low', note: 'Fine now.', status: 'addressed', resolution: 'Moved.' },
          { id: 'b3', kind: 'missing_exculpatory_fact', severity: 'medium', note: 'No budget context.', status: 'wont_fix' },
        ],
      },
    ],
    fact_check: [
      { target: 's1', claim: 'Inspection found cracks', source_id: 'src-inspection', verdict: 'supported', round: 0 },
      { target: 's1', claim: 'Inspection found cracks', source_id: 'src-inspection', verdict: 'partially_supported', round: 1 },
      { target: 's3', claim: 'State said X', verdict: 'supported', confidence_before: 'established', confidence_after: 'reported', round: 1 },
      { target: 'layer:s2/t1', claim: 'Timeline date', verdict: 'unsupported', round: 1 },
      { target: 'fact:f1', claim: 'Fact one', verdict: 'source_unavailable', round: 1 },
      { target: 's4', claim: 'Fine', verdict: 'supported', round: 1 },
      { target: 'side:council-responsible', claim: 'Steelman claim', verdict: 'uncited', round: 1 },
    ],
    open_issues: [
      { id: 'oi1', source: 'red_team', severity: 'high', description: 'Unresolved wording on s1', step_id: 's1', resolved: false },
      { id: 'oi2', source: 'pipeline', severity: 'low', description: 'Case-level note', resolved: false },
      { id: 'oi3', source: 'editor', severity: 'low', description: 'Done', step_id: 's2', resolved: true },
    ],
    decisions: [],
  };
}
