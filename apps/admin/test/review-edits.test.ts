import { describe, expect, it } from 'vitest';
import { validateCase, type Case } from '@sia/case-schema';
import { humanMessage, humanizeValidation, issueLabel, issueTargetPath, CASE_FLAGS_ID } from '@/lib/issues';
import { combineNotes, describeTriage, setBiasFlagStatus, setHardQuestionStatus, setOpenIssueResolved, acknowledgeFactCheck, unacknowledgeFactCheck, factCheckAck } from '@/lib/review-triage';
import { collectCaseLevelFlags, collectStepFlags } from '@/lib/step-flags';
import { isContentDirty, isDirty, removeAt, renameSideId, renameStepId, renameSourceId, setAt, sideReviewReferences, withManagedFields } from '@/lib/working-copy';
import { loadFixture, sampleReview } from './helpers';

/** A saved package as the review screen gets it: fixture content plus a pipeline review record and a decision. */
const savedDoc = (): Case => ({
  ...loadFixture(),
  review: {
    ...sampleReview(),
    decisions: [{ action: 'submitted', actor: 'pipeline', at: '2026-10-08T00:00:00.000Z', version: 1 }],
  },
});

describe('renames reach the review record the screen validates, previews and saves', () => {
  it('renaming a side keeps the document valid (the review keeps pointing at it)', () => {
    const saved = savedDoc();
    expect(validateCase(saved).errors).toEqual([]);
    const working = renameSideId(saved, 'council-responsible', 'council-yes');
    const effective = withManagedFields(working, saved);
    expect(validateCase(effective).errors).toEqual([]);
    expect(effective.review.hard_questions[0]!.side_id).toBe('council-yes');
    // Decisions and pipeline metadata still come from the saved document.
    expect(effective.review.decisions).toBe(saved.review.decisions);
    expect(effective.review.pipeline_run_id).toBe(saved.review.pipeline_run_id);
  });

  it('a later decision on the saved document is kept alongside the working copy’s renamed references', () => {
    const saved = savedDoc();
    const working = renameSideId(saved, 'council-not-responsible', 'council-no');
    const decided: Case = {
      ...saved,
      review: { ...saved.review, decisions: [...saved.review.decisions, { action: 'unschedule', actor: 'owner', at: '2026-10-08T01:00:00.000Z', version: 1 }] },
    };
    const merged = withManagedFields(working, decided);
    expect(merged.review.decisions).toHaveLength(2);
    expect(merged.review.bias_reports[0]!.side_id).toBe('council-no');
    expect(validateCase(merged).errors).toEqual([]);
  });

  it('renaming a step keeps its fact-check, red-team, question and issue flags on it', () => {
    const saved = savedDoc();
    const before = collectStepFlags(saved).get('s1')!;
    const effective = withManagedFields(renameStepId(saved, 's1', 's1-renamed'), saved);
    const after = collectStepFlags(effective).get('s1-renamed')!;
    expect(after.attention).toBe(before.attention);
    expect(after.redTeam.map((r) => r.flag.id)).toEqual(['b1']);
    expect(after.factCheck).toHaveLength(before.factCheck.length);
    const caseLevel = collectCaseLevelFlags(effective);
    expect(caseLevel.factCheck.map((f) => f.row.target)).toEqual(['side:council-responsible']);
    expect(validateCase(effective).warnings.filter((w) => w.code === 'unknown_reference')).toEqual([]);
  });

  it('renaming a source carries over to fact-check rows', () => {
    const saved = savedDoc();
    const effective = withManagedFields(renameSourceId(saved, 'src-inspection', 'src-insp'), saved);
    expect(effective.review.fact_check[0]!.source_id).toBe('src-insp');
    expect(validateCase(effective).warnings.filter((w) => w.code === 'unknown_reference')).toEqual([]);
  });

  it('knows which sides the review record names (so removing them is refused)', () => {
    const saved = savedDoc();
    expect(sideReviewReferences(saved, 'council-responsible')).toEqual(['1 hard question', '1 fact-check row']);
    expect(sideReviewReferences(saved, 'council-not-responsible')).toEqual(['1 red-team report']);
    // What removal would do: errors the editor has no field for.
    const three = setAt(setAt(saved, ['sides', 2], { id: 'third', label: 'Third', steelman: 'A third view.' }), ['review', 'hard_questions', 2, 'side_id'], 'third');
    expect(validateCase(three).errors).toEqual([]);
    const removed = withManagedFields(removeAt(three, ['sides'], 2), three);
    expect(validateCase(removed).errors.map((e) => e.path)).toEqual(['review.hard_questions.2.side_id']);
  });
});

describe('triage of review items', () => {
  it('is an unsaved edit, but not a content change', () => {
    const saved = savedDoc();
    const triaged = setOpenIssueResolved(saved, 1, true, 'Handled in the steelman.');
    expect(isDirty(saved, triaged)).toBe(true);
    expect(isContentDirty(saved, triaged)).toBe(false);
    expect(withManagedFields(triaged, saved).review.open_issues[1]!.resolved).toBe(true);
  });

  it('sets statuses and resolutions, and reopens', () => {
    const saved = savedDoc();
    const d = setBiasFlagStatus(saved, 0, 0, 'wont_fix', 'Direct quote from the filing.');
    expect(d.review.bias_reports[0]!.flags[0]).toMatchObject({ status: 'wont_fix', resolution: 'Direct quote from the filing.' });
    const reopened = setBiasFlagStatus(d, 0, 0, 'unaddressed');
    expect(reopened.review.bias_reports[0]!.flags[0]!.status).toBe('unaddressed');
    const q = setHardQuestionStatus(saved, 0, 'answered', 'See step 2.');
    expect(q.review.hard_questions[0]).toMatchObject({ status: 'answered', resolution: 'See step 2.' });
    const oi = setOpenIssueResolved(saved, 0, true, 'Fixed.');
    expect(oi.review.open_issues[0]!.description).toBe('Unresolved wording on s1\n\nResolved by the admin: Fixed.');
    expect(setOpenIssueResolved(oi, 0, false).review.open_issues[0]!.description).toBe('Unresolved wording on s1');
  });

  it('acknowledges a fact-check row without touching the fact-checker’s row', () => {
    const saved = savedDoc();
    const d = acknowledgeFactCheck(saved, 3, 'Removed the date from the timeline.', 's2');
    expect(d.review.fact_check).toBe(saved.review.fact_check);
    expect(factCheckAck(d, 3)).toMatchObject({ id: 'ack-fc-3', source: 'admin', resolved: true, step_id: 's2' });
    expect(validateCase(withManagedFields(d, saved)).errors).toEqual([]);
    expect(unacknowledgeFactCheck(d, 3).review.open_issues).toEqual(saved.review.open_issues);
  });

  it('summarizes the triage for the decision log', () => {
    const saved = savedDoc();
    let d = setBiasFlagStatus(saved, 0, 0, 'addressed', 'Reworded.');
    d = setHardQuestionStatus(d, 0, 'not_applicable', 'Out of scope.');
    d = setOpenIssueResolved(d, 1, true, 'Covered.');
    d = acknowledgeFactCheck(d, 3, 'Removed the date.', 's2');
    const lines = describeTriage(saved, d);
    expect(lines).toEqual([
      'Red-team flag b1 (as The council is not responsible) marked addressed: Reworded.',
      'Hard question hq1 marked not applicable: Out of scope.',
      'Open issue oi2 marked resolved: Covered.',
      'Admin addressed the fact-check (round 1, unsupported) on layer:s2/t1: Removed the date.',
    ]);
    expect(combineNotes('Fixed wording.', lines)).toBe(`Fixed wording.\n\nReview items:\n${lines.map((l) => `- ${l}`).join('\n')}`);
    expect(combineNotes('  ', [])).toBeUndefined();
    expect(combineNotes('x'.repeat(9000), [])!.length).toBe(7000);
  });
});

describe('issues as the admin reads them', () => {
  it('labels paths with what the editor shows', () => {
    const doc = savedDoc();
    expect(issueLabel('steps.1.body', doc)).toBe('Step 2 › Body');
    expect(issueLabel(`sources.0.url`, doc)).toBe(`Source ${doc.sources[0]!.id} › URL`);
    expect(issueLabel('question.scale.left_label', doc)).toBe('Question › Slider left label');
    expect(issueLabel('review.fact_check.3.verdict', doc)).toBe('Review record › Fact-check row 4 › Verdict');
    expect(issueLabel('steps.0.depth.0.entries.1.date', doc)).toBe('Step 1 › Go deeper layer 1 › Entry 2 › Date');
    expect(issueLabel('', doc)).toBe('Whole case');
  });

  it('turns Zod wording into plain words and keeps one message per empty field', () => {
    expect(humanMessage('Too small: expected string to have >=1 characters')).toBe('Required.');
    expect(humanMessage('Invalid ISO datetime')).toMatch(/2026-10-08T12:00:00Z/);
    const doc = setAt(savedDoc(), ['as_of'], '');
    const v = humanizeValidation(validateCase(doc), doc);
    const asOf = v.errors.filter((e) => e.path === 'as_of');
    expect(asOf).toHaveLength(1);
    expect(asOf[0]!.message).toBe('Required.');
    const noHeadline = setAt(savedDoc(), ['steps', 0, 'headline'], '');
    expect(humanizeValidation(validateCase(noHeadline), noHeadline).errors.find((e) => e.path === 'steps.0.headline')?.message).toBe('Required.');
  });

  it('jumps from review-record issues to what they are about', () => {
    const doc = savedDoc();
    expect(issueTargetPath('steps.2.body', doc)).toBe('steps.2.body');
    expect(issueTargetPath('review.fact_check.3.verdict', doc)).toMatch(/^steps\.1(\.depth\.\d+)?$/);
    expect(issueTargetPath('review.fact_check.4.verdict', doc)).toBe('starting_facts.0');
    expect(issueTargetPath('review.fact_check.6.verdict', doc)).toBe('sides.0');
    expect(issueTargetPath('review.bias_reports.0.flags.0.step_id', doc)).toBe('steps.0');
    expect(issueTargetPath('review.bias_reports.0.side_id', doc)).toBe('sides');
    expect(issueTargetPath('review.open_issues.1.step_id', doc)).toBe(CASE_FLAGS_ID);
    expect(issueTargetPath('review.hard_questions.0.step_ids.1', doc)).toBe('steps.1');
  });
});
