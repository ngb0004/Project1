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

## Live run (real Claude Agent SDK runner), Oct 9 2026

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
