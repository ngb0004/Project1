# Phase 5 acceptance: updates to a live case

> A scheduled job that produces revision packages against a live case. Done
> when a revision appears in the queue as a diff, and the live case is
> unchanged until it is approved. (`docs/SPEC.md`)

## Scripted acceptance (repeatable, no model calls)

`services/pipeline/test/update.test.ts`, against the local Supabase stack with
the scripted FakeRunner agents and the real worker, source store, research log
and database functions:

1. The worker researches a brief into a case; the admin publishes it.
2. The admin sets a 1-day cadence; `app.enqueue_due_updates()` (the pg_cron job)
   queues nothing until the cadence is forced due, then queues exactly one
   `update` job, however often it fires and even when the admin asks too.
3. `pipeline worker --once --job <id>` (as `runWorker({ once: true })`) runs it:
   - with a scripted new development: a new `in_review` version with
     `parent_version` = `based_on_version` = the live version, tags `['update']`,
     in `staff_queue`; `diffCases(live, revision)` is the as-of date, one step
     and one source added; the update summary is in the review record; anon
     `get_published_case` still returns the old live version, byte for byte;
   - with a second development while the first waits for review: the new
     package builds on it and supersedes it (one current update per case);
   - with nothing new: the job ends `no_changes` and says why; no version is added;
   - after the admin approves, the live version moves; the old one stays as it was;
   - with a source page changed since it was cited: the unchanged facts are
     checked against the archived snapshot and the admin gets an open issue.
4. Two update jobs for one case are never queued at once (unique index).

`pnpm --filter @sia/admin e2e:live-update` runs the same flow and then checks
it in the console (production build, anon key): the update is in the queue
("v2 updates v1 … update"), its review screen shows the update summary and
the diff against the live version, the public still gets v1, and Approve and
publish makes v2 live.

### Pipeline end-to-end acceptance (`pnpm --filter @sia/pipeline e2e:update`)

`services/pipeline/e2e/update.e2e.mts` proves the phase 5 criterion in one
deterministic run (scripted agents over a fictional web, no model calls; the
database, pg_cron function, worker, package writer and a production build of
the admin console are real):

1. `cases/fixtures/fixture-harbor-bridge.json` under a fresh slug
   (`e2e-update-<id>`), submitted as the pipeline and published by the admin.
   The copy adds an evidence quote for every cited source and drops the
   "(fictional)" note from its quote-layer speaker, which the citation check
   would otherwise fail on the unchanged facts.
2. One anonymous reader plays the dive at reading pace (6 counted responses on v1).
3. `admin_set_update_cadence('1 day')`; the command pg_cron runs (read from
   `cron.job`) queues nothing; `next_update_at` is forced into the past as
   postgres; the same command queues exactly one `update` job (system:schedule).
4. `runWorker({ once: true })` claims that job; the scripted researchers report
   one development dated after the as-of date (and one old fact, screened out);
   the drafter adds s5, revises s4 and drops the open question it answers.
   The run is clean: 1 critic round, 0 open issues, `pipeline verify` passes.
5. v2 is `in_review`, `parent_version` = `based_on_version` = 1, tags
   `['update']`; anon `get_published_case` still returns v1 byte for byte; the
   reader's responses keep `case_version` 1.
6. In Chromium the admin finds v2 in the queue, its diff against "Live version
   v1" shows exactly s4 (changed), s5 (added), the new source, the as-of date
   and the removed open question, with the update summary; Approve and publish
   makes v2 live, and v1 stays published and byte-identical (v1's crowd keeps
   the reader; v2's version note counts them).

## Live run on a Cornell test copy (real runner), Oct 9 2026

`cases/seed/cornell.json` was submitted under `cornell-update-test-f65968`
(as the pipeline), published by the admin, and an update was queued with
`admin_request_update`; `pipeline worker --once --job <id> --budget-usd 22`
ran it. Records: `cornell-live-update/job.json` and `research-log.json`.

- Outcome: `no_changes` in 40 s for $0.34. "No material developments since
  2026-10-08 (version 1): the researchers found no verifiable claims."
- The three researchers ran 8 searches for developments after Oct. 8 and
  opened no page. Their notes say the newest items were dated Oct. 8 or
  earlier (the Oct. 7 petition, Trump's comments, the Title IX dismissal, all
  already in the case). That is correct for this case, but the call rested on
  search-result dates: one researcher saw the Title IX ruling with "no date I
  could confirm" and did not open it.
- `pipeline verify` reports the job as not verified, because it checks
  packages and a `no_changes` job has none.
- No version was added; the copy's v1 is still live and unchanged.

## Live run on a Clancy test copy (real Claude Agent SDK runner), Oct 9 2026

A test copy of the phase 4 Clancy package (fresh slug
`clancy-live-update-485327`, linked to the phase 4 job so its snapshots form
the archive) was published with its as-of date set back to 2026-09-20, and
an update was queued (`admin_request_update`). `pipeline worker --once --job
<id> --budget-usd 15 --max-rounds 2` ran it.

- `job.json`: the finished job (succeeded, 2 rounds, $11.60, 3 open issues).
- `update-summary.txt`: the update summary recorded in the review record.
- `audit.json`: `pipeline verify` against the database: in the queue,
  schema-valid, 187 quotes verbatim in their snapshots, every agent logged.
- `case.json`: the submitted revision (v2, parent v1, tagged `update`).

What it showed:

- The researchers found 13 verified claims after 2026-09-20; the screen kept 7
  (mostly the Oct. 1, 2026 ruling denying the Rule 25 motion) and dropped 5 low
  impact and 1 already in the case. The drafter added step s15 for the ruling,
  updated s14 (that motion is no longer pending), and narrowed the open
  question about pending motions to the ones still pending.
- One source (the Washington Examiner article cited by 8 of 14 steps) had gone
  behind a paywall since it was cited: re-opened, it had 1,158 characters and
  21 of 22 quoted passages were gone. The archive kept those facts checkable
  (0 citation failures in round 1), and the admin gets an open issue naming
  the source.
- An earlier live run of the same setup, before the archive existed, had 21
  citation failures and 18 fact-check failures in round 1 from that one source
  and rewrote 13 of 14 steps (and counted claims researched for the critics
  as developments, a bug since fixed).
- Remaining churn: the critic loop still reworded several unchanged steps
  (9 of 14 changed in the final diff). The drafter and editor have since been
  told to leave unchanged live facts alone unless a blocking finding requires
  a change; that prompt change has not been re-run live.

Nothing here is published. The test copies live only in the local database.
