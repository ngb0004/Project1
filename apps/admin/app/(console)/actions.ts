'use server';

import { refresh } from 'next/cache';
import { SeedProfile } from '@sia/case-schema';
import {
  adminCancelJob,
  adminCreateCase,
  adminRequestUpdate,
  adminResolveAlert,
  adminSetSeedProfile,
  adminSetUpdateCadence,
} from '@sia/case-store';
import { requireAdmin } from '@/lib/auth';
import { describeError } from '@/lib/errors';
import { cadenceInterval, isUuid } from '@/lib/format';
import { errorState, okState, type FormState } from '@/lib/form-state';

const str = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/** "New case from a one-line brief": queues a new_case pipeline job. */
export async function createCaseAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { db } = await requireAdmin();
  const brief = str(form, 'brief');
  if (!brief) return errorState('Write a one-line brief, e.g. "Harbor bridge closure: who is responsible?"');
  if (brief.length > 2000) return errorState('Keep the brief under 2,000 characters.');
  try {
    const jobId = await adminCreateCase(db, brief);
    refresh();
    return okState(`Queued pipeline job ${jobId.slice(0, 8)}. The package lands in the queue when the pipeline finishes.`);
  } catch (e) {
    return errorState(describeError(e));
  }
}

export async function resolveAlertAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { db, email } = await requireAdmin();
  const id = Number(str(form, 'alertId'));
  const resolution = str(form, 'resolution');
  if (!Number.isInteger(id) || id <= 0) return errorState('Unknown alert.');
  if (!resolution) return errorState('Write how the alert was resolved.');
  try {
    await adminResolveAlert(db, id, resolution, email);
    refresh();
    return okState('Alert resolved.');
  } catch (e) {
    return errorState(describeError(e));
  }
}

export async function cancelJobAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { db } = await requireAdmin();
  const id = str(form, 'jobId');
  if (!isUuid(id)) return errorState('Unknown job.');
  try {
    await adminCancelJob(db, id);
    refresh();
    return okState('Job cancelled.');
  } catch (e) {
    return errorState(describeError(e));
  }
}

export async function setCadenceAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { db } = await requireAdmin();
  const caseId = str(form, 'caseId');
  const interval = cadenceInterval(str(form, 'cadence'));
  if (!isUuid(caseId)) return errorState('Unknown case.');
  if (interval === undefined) return errorState('Pick a cadence.');
  try {
    await adminSetUpdateCadence(db, caseId, interval);
    refresh();
    return okState(interval ? `Re-research cadence set to every ${interval}.` : 'Scheduled re-research is off.');
  } catch (e) {
    return errorState(describeError(e));
  }
}

export async function requestUpdateAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { db } = await requireAdmin();
  const caseId = str(form, 'caseId');
  if (!isUuid(caseId)) return errorState('Unknown case.');
  try {
    const jobId = await adminRequestUpdate(db, caseId);
    refresh();
    return okState(`Queued re-research job ${jobId.slice(0, 8)} against the live version. Any revision comes back through review.`);
  } catch (e) {
    return errorState(describeError(e));
  }
}

/** Saves the seed profile (validated with the shared SeedProfile schema). An empty box clears it. */
export async function saveSeedProfileAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { db } = await requireAdmin();
  const caseId = str(form, 'caseId');
  const text = str(form, 'profile');
  if (!isUuid(caseId)) return errorState('Unknown case.');
  let profile: SeedProfile | null = null;
  if (text) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return errorState(`Not valid JSON: ${(e as Error).message}`);
    }
    const parsed = SeedProfile.safeParse(raw);
    if (!parsed.success) {
      return errorState(
        `The profile does not match the seed schema: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(profile)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    profile = parsed.data;
  }
  try {
    const r = await adminSetSeedProfile(db, caseId, profile);
    refresh();
    if (!profile) return okState('Seed profile cleared. Seeded rows no longer count.');
    return okState(
      r.live_version
        ? `Seed profile saved; ${r.seeded_sessions} seeded sessions generated for live v${r.live_version}.`
        : 'Seed profile saved. Seeds are generated when a version is published.',
    );
  } catch (e) {
    return errorState(describeError(e));
  }
}
