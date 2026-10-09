import { describe, expect, it } from 'vitest';
import { acknowledgeFactCheck, setBiasFlagStatus, setHardQuestionStatus, setOpenIssueResolved } from '@/lib/review-triage';
import {
  attentionReasons,
  caseLevelAttention,
  collectCaseLevelFlags,
  collectFactFlags,
  collectStepFlags,
  confidenceChanged,
  isNotableFactCheck,
  openIssueCount,
  parseTarget,
  publishCautions,
} from '@/lib/step-flags';
import { loadFixture, sampleReview } from './helpers';

const doc = () => ({ ...loadFixture(), review: sampleReview() });

describe('fact-check targets', () => {
  it('parses step, fact, layer and side targets', () => {
    expect(parseTarget('s1')).toEqual({ kind: 'step', id: 's1', layerId: null });
    expect(parseTarget('fact:f1')).toEqual({ kind: 'fact', id: 'f1', layerId: null });
    expect(parseTarget('layer:s2/t1')).toEqual({ kind: 'layer', id: 's2', layerId: 't1' });
    expect(parseTarget('side:a')).toEqual({ kind: 'side', id: 'a', layerId: null });
  });

  it('treats a plain pass as not notable, but a confidence change as notable', () => {
    expect(isNotableFactCheck({ target: 's1', claim: 'x', verdict: 'supported', round: 0 })).toBe(false);
    const changed = { target: 's1', claim: 'x', verdict: 'supported' as const, confidence_before: 'established' as const, confidence_after: 'reported' as const, round: 0 };
    expect(confidenceChanged(changed)).toBe(true);
    expect(isNotableFactCheck(changed)).toBe(true);
  });
});

describe('collectStepFlags', () => {
  it('puts each review item on the step it is about', () => {
    const flags = collectStepFlags(doc());
    const s1 = flags.get('s1')!;
    // The round-0 pass is dropped; the round-1 partial support stays.
    expect(s1.factCheck.map((f) => [f.row.verdict, f.row.round, f.latest])).toEqual([['partially_supported', 1, true]]);
    expect(s1.redTeam.map((r) => r.flag.id)).toEqual(['b1']);
    expect(s1.hardQuestions.map((q) => q.id)).toEqual(['hq1']);
    expect(s1.openIssues.map((o) => o.id)).toEqual(['oi1']);
    // partial support (latest) + unaddressed high flag + open question + unresolved issue
    expect(s1.attention).toBe(4);

    const s2 = flags.get('s2')!;
    expect(s2.factCheck.map((f) => [f.row.verdict, f.layerId])).toEqual([['unsupported', 't1']]);
    expect(s2.hardQuestions.map((q) => q.id)).toEqual(['hq1']);
    expect(s2.openIssues.map((o) => o.id)).toEqual(['oi3']);
    expect(s2.attention).toBe(2);

    const s3 = flags.get('s3')!;
    expect(s3.factCheck.map((f) => [f.row.confidence_before, f.row.confidence_after])).toEqual([['established', 'reported']]);
    expect(s3.redTeam.map((r) => r.flag.status)).toEqual(['addressed']);

    const s4 = flags.get('s4')!;
    expect(s4.factCheck).toEqual([]);
    expect(s4.hardQuestions.map((q) => q.id)).toEqual(['hq2']);
    expect(s4.attention).toBe(0);
  });

  it('counts a fact-checker downgrade the label does not reflect yet', () => {
    const d = doc();
    // s3 is labeled established in this test, but the latest round says reported.
    d.steps[2] = { ...d.steps[2]!, confidence: 'established' };
    expect(collectStepFlags(d).get('s3')!.attention).toBe(1);
    d.steps[2] = { ...d.steps[2]!, confidence: 'reported' };
    expect(collectStepFlags(d).get('s3')!.attention).toBe(0);
  });

  it('adds reader flags, flags by side and alerts for published versions', () => {
    const flags = collectStepFlags(doc(), {
      version: 1,
      flags: [{ step_id: 's2', open: 3, total: 4, by_reason: { unfair: 3, other: 1 }, notes: ['too harsh'] }],
      flagsBySide: [
        { step_id: 's2', side_id: 'council-responsible', flags: 1 },
        { step_id: 's2', side_id: 'unrated', flags: 3 },
      ],
      alerts: [
        { id: 7, case_id: 'c', case_version: 1, kind: 'flags', side_id: null, step_id: 's2', details: {}, pipeline_job_id: null, created_at: '2026-10-08T00:00:00Z', resolved_at: null, resolved_by: null, resolution: null },
        { id: 8, case_id: 'c', case_version: 1, kind: 'fairness', side_id: 'council-responsible', step_id: null, details: {}, pipeline_job_id: null, created_at: '2026-10-08T00:00:00Z', resolved_at: null, resolved_by: null, resolution: null },
      ],
    });
    const s2 = flags.get('s2')!;
    expect(s2.userFlags?.total).toBe(4);
    expect(s2.userFlagsBySide).toEqual([
      { sideId: 'council-responsible', flags: 1 },
      { sideId: 'unrated', flags: 3 },
    ]);
    expect(s2.alerts.map((a) => a.id)).toEqual([7]);
    expect(s2.attention).toBe(2 + 1 + 1);
  });

  it('ignores items about steps that no longer exist, and case-level items surface separately', () => {
    const d = doc();
    d.steps = d.steps.filter((s) => s.id !== 's1').map((s, i) => ({ ...s, order: i + 1 }));
    const flags = collectStepFlags(d);
    expect(flags.has('s1')).toBe(false);
    const caseLevel = collectCaseLevelFlags(d);
    expect(caseLevel.redTeam.map((r) => r.flag.id).sort()).toEqual(['b1', 'b3']);
    expect(caseLevel.hardQuestions.map((q) => q.id)).toEqual(['hq3']);
    expect(caseLevel.openIssues.map((o) => o.id).sort()).toEqual(['oi1', 'oi2']);
    expect(caseLevel.factCheck.map((f) => f.row.target)).toEqual(['s1', 'side:council-responsible']);
  });
});

describe('fact flags and issue counts', () => {
  it('collects starting-fact rows and counts open issues', () => {
    expect(collectFactFlags(doc()).get('f1')!.map((f) => f.row.verdict)).toEqual(['source_unavailable']);
    expect(openIssueCount(doc())).toBe(2);
  });
});

describe('admin triage clears attention', () => {
  it('a flag marked addressed, a question answered, an issue resolved and a fact-check acknowledged stop counting', () => {
    let d = doc();
    const s1 = collectStepFlags(d).get('s1')!;
    expect(s1.attention).toBe(4);
    expect(attentionReasons(s1, d.steps[0]!.confidence)).toEqual([
      'fact-check: partially supported',
      'red team: high loaded wording',
      'hard question open (blocking)',
      'open issue (high)',
    ]);
    // Indices point back into the review record for the edits.
    expect(s1.redTeam[0]).toMatchObject({ reportIndex: 0, flagIndex: 0 });
    expect(s1.hardQuestions[0]!.index).toBe(0);
    expect(s1.openIssues[0]!.index).toBe(0);
    const fc = s1.factCheck[0]!;

    d = setBiasFlagStatus(d, 0, 0, 'addressed', 'Reworded the headline.');
    d = setHardQuestionStatus(d, 0, 'answered', 'Step 2 now says who received the report.');
    d = setOpenIssueResolved(d, 0, true, 'Fixed with the headline.');
    d = acknowledgeFactCheck(d, fc.index, 'Narrowed the claim to what the report says.', 's1');
    const after = collectStepFlags(d).get('s1')!;
    expect(after.attention).toBe(0);
    expect(after.factCheck[0]!.ack?.description).toMatch(/Narrowed the claim/);
    // The acknowledgment is not shown as another open issue on the step, nor counted in the header.
    expect(after.openIssues.map((o) => o.id)).toEqual(['oi1']);
    expect(openIssueCount(d)).toBe(1);
  });

  it('lists what is still unresolved as cautions for the approve actions', () => {
    const d = doc();
    expect(publishCautions(d)).toEqual([
      '3 claims the latest fact-check failed (unsupported, uncited or source unavailable)',
      '1 unaddressed high-severity red-team flag',
      '1 blocking hard question still open',
      '2 unresolved open issues (1 high)',
    ]);
    let fixed = setBiasFlagStatus(d, 0, 0, 'wont_fix', 'The wording is a direct quote.');
    fixed = setHardQuestionStatus(fixed, 0, 'not_applicable', 'Out of scope.');
    fixed = setOpenIssueResolved(setOpenIssueResolved(fixed, 0, true, 'done'), 1, true, 'done');
    d.review.fact_check.forEach((r, i) => {
      if (['unsupported', 'uncited', 'source_unavailable'].includes(r.verdict)) fixed = acknowledgeFactCheck(fixed, i, 'Checked by hand.');
    });
    expect(publishCautions(fixed)).toEqual([]);
  });

  it('counts case-level items that need attention', () => {
    const d = doc();
    // hq3 (open, unlinked), oi2 (unresolved, case-level), the side-targeted uncited row (latest), b3 is wont_fix.
    expect(caseLevelAttention(collectCaseLevelFlags(d))).toBe(3);
  });
});
