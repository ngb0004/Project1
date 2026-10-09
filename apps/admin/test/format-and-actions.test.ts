import { describe, expect, it } from 'vitest';
import { cadenceChoiceOf, cadenceInterval, formatDateTime, intervalSeconds, isUuid, parseVersion, safeHref } from '@/lib/format';
import { isEditable, reviewActions, staleReason, type ActionContext } from '@/lib/review-actions';

describe('intervals and cadence', () => {
  it('reads Postgres interval text', () => {
    expect(intervalSeconds('06:00:00')).toBe(21600);
    expect(intervalSeconds('1 day')).toBe(86400);
    expect(intervalSeconds('7 days')).toBe(604800);
    expect(intervalSeconds('1 day 02:00:00')).toBe(93600);
    expect(intervalSeconds('PT6H')).toBe(21600);
    expect(intervalSeconds('P7D')).toBe(604800);
    expect(intervalSeconds('soon')).toBeNull();
    expect(intervalSeconds(null)).toBeNull();
  });

  it('maps stored cadences to the choices the console offers', () => {
    expect(cadenceChoiceOf(null)).toBe('off');
    expect(cadenceChoiceOf('06:00:00')).toBe('6h');
    expect(cadenceChoiceOf('1 day')).toBe('daily');
    expect(cadenceChoiceOf('7 days')).toBe('weekly');
    expect(cadenceChoiceOf('02:00:00')).toBe('custom');
    expect(cadenceInterval('daily')).toBe('1 day');
    expect(cadenceInterval('off')).toBeNull();
    expect(cadenceInterval('bogus')).toBeUndefined();
  });
});

describe('request parameters', () => {
  it('accepts only uuids and positive versions', () => {
    expect(isUuid('5f1c2b9e-1d2c-4b5a-9e8f-0123456789ab')).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(parseVersion('3')).toBe(3);
    expect(parseVersion('0')).toBeNull();
    expect(parseVersion('03')).toBeNull();
    expect(parseVersion('1e3')).toBeNull();
  });

  it('links only http(s) URLs from pipeline output', () => {
    expect(safeHref('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
    expect(safeHref('http://example.org')).toBe('http://example.org/');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,hi')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });

  it('formats times in UTC', () => {
    expect(formatDateTime('2026-10-08T14:05:09.123Z')).toBe('2026-10-08 14:05 UTC');
    expect(formatDateTime(null)).toBe('—');
  });
});

const base: ActionContext = {
  status: 'in_review',
  origin: 'pipeline',
  tags: [],
  version: 2,
  scheduledAt: null,
  isLive: false,
  parentVersion: null,
  liveVersion: null,
  errors: 0,
  savedErrors: 0,
  dirty: false,
};

describe('review actions', () => {
  it('offers the full set for a clean package in review', () => {
    const a = reviewActions(base);
    expect(a.publish).toEqual({ shown: true, enabled: true, reason: null });
    expect(a.schedule.enabled).toBe(true);
    expect(a.request_changes.enabled).toBe(true);
    expect(a.reject.enabled).toBe(true);
    // With nothing edited, Edit then approve would only make an admin_edit copy of the same content.
    expect(a.edit_then_approve).toMatchObject({ shown: true, enabled: false });
    expect(a.edit_then_approve.reason).toMatch(/Approve and publish/);
    expect(a.save_edit).toMatchObject({ shown: true, enabled: false, reason: 'No unsaved edits.' });
    expect(a.archive.shown).toBe(false);
    expect(a.unschedule.shown).toBe(false);
  });

  it('blocks publishing while there are validation errors, but not requesting changes or rejecting', () => {
    const a = reviewActions({ ...base, errors: 2, savedErrors: 2 });
    expect(a.publish.enabled).toBe(false);
    expect(a.publish.reason).toMatch(/2 validation errors/);
    expect(a.schedule.enabled).toBe(false);
    expect(a.edit_then_approve.enabled).toBe(false);
    expect(a.save_edit.enabled).toBe(false);
    expect(a.request_changes.enabled).toBe(true);
    expect(a.reject.enabled).toBe(true);
  });

  it('sends unsaved edits through Save or Edit then approve', () => {
    const a = reviewActions({ ...base, dirty: true });
    expect(a.publish.enabled).toBe(false);
    expect(a.publish.reason).toMatch(/unsaved edits/);
    expect(a.save_edit.enabled).toBe(true);
    expect(a.edit_then_approve).toEqual({ shown: true, enabled: true, reason: null });
  });

  it('a broken working copy blocks Edit then approve even when the saved version is fine', () => {
    const a = reviewActions({ ...base, dirty: true, errors: 1 });
    expect(a.edit_then_approve.enabled).toBe(false);
    expect(a.save_edit.enabled).toBe(false);
  });

  it('warns when a revision is stale against the live version', () => {
    expect(staleReason(3, 3)).toBeNull();
    expect(staleReason(null, null)).toBeNull();
    expect(staleReason(2, 3)).toMatch(/v3 is live/);
    expect(staleReason(null, 3)).toMatch(/v3 is live/);
    const a = reviewActions({ ...base, parentVersion: 2, liveVersion: 3 });
    expect(a.publish.enabled).toBe(false);
    expect(a.edit_then_approve.enabled).toBe(false);
  });

  it('the live version is edited inline: Save and Edit then approve make a new admin_edit draft', () => {
    const live = { ...base, status: 'published' as const, isLive: true, liveVersion: 2, parentVersion: null };
    const clean = reviewActions(live);
    const shown = Object.entries(clean).filter(([, s]) => s.shown).map(([k]) => k).sort();
    expect(shown).toEqual(['archive', 'edit_then_approve', 'save_edit']);
    expect(clean.save_edit.enabled).toBe(false);
    expect(clean.save_edit.reason).toMatch(/never changes/);
    expect(clean.edit_then_approve.enabled).toBe(false);
    expect(clean.archive.reason).toMatch(/offline/);

    const edited = reviewActions({ ...live, dirty: true });
    expect(edited.save_edit.enabled).toBe(true);
    expect(edited.save_edit.reason).toMatch(/new draft version tagged admin_edit/);
    expect(edited.edit_then_approve).toEqual({ shown: true, enabled: true, reason: null });
    expect(edited.publish.shown).toBe(false);

    const broken = reviewActions({ ...live, dirty: true, errors: 1 });
    expect(broken.save_edit.enabled).toBe(false);
    expect(broken.edit_then_approve.enabled).toBe(false);
  });

  it('an older published version is read-only and only offers Archive', () => {
    const a = reviewActions({ ...base, status: 'published', isLive: false, liveVersion: 3, dirty: false });
    const shown = Object.entries(a).filter(([, s]) => s.shown).map(([k]) => k);
    expect(shown).toEqual(['archive']);
    expect(isEditable('published', false)).toBe(false);
    expect(isEditable('published', true)).toBe(true);
    expect(isEditable('in_review', false)).toBe(true);
    expect(isEditable('rejected', false)).toBe(false);
    expect(isEditable('archived', false)).toBe(false);
  });

  it('admin edit drafts can be approved, scheduled and discarded but not sent to the pipeline', () => {
    const a = reviewActions({ ...base, status: 'draft', origin: 'admin', tags: ['admin_edit'] });
    expect(a.publish.enabled).toBe(true);
    expect(a.request_changes.shown).toBe(false);
    expect(a.reject.shown).toBe(true);
  });

  it('a scheduled version can be unscheduled but not scheduled twice', () => {
    const a = reviewActions({ ...base, scheduledAt: '2026-12-01T00:00:00Z' });
    expect(a.unschedule.enabled).toBe(true);
    expect(a.schedule.enabled).toBe(false);
  });

  it('final statuses offer nothing', () => {
    for (const status of ['rejected', 'archived'] as const) {
      const a = reviewActions({ ...base, status });
      expect(Object.values(a).some((s) => s.shown)).toBe(false);
    }
  });

  it('changes_requested offers saving edits and rejecting only', () => {
    const a = reviewActions({ ...base, status: 'changes_requested', dirty: true });
    const shown = Object.entries(a).filter(([, s]) => s.shown).map(([k]) => k).sort();
    expect(shown).toEqual(['reject', 'save_edit']);
  });
});
