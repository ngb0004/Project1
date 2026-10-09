# Agent research pipeline

The pipeline turns a one-line brief into a case package in the admin's review
queue, and keeps published cases current. It runs on the Claude Agent SDK. Each
agent is one file in `src/agents/` (scoper, researchers, records researcher,
drafter, hard-questions agent, red team, fact-checker, editor), and the
orchestrator (`src/orchestrator.ts`) runs the loop rules from `docs/SPEC.md`.

Three kinds of job come off the queue (`public.pipeline_jobs`):

| Kind | Queued by | Result |
| --- | --- | --- |
| `new_case` | the admin's brief (`admin_create_case`) | a new case, version 1, in review |
| `revision` | the admin's "Request changes" notes, or a fairness alert | a revision of that version, in review; the version sent back is superseded |
| `update` | the re-research schedule (pg_cron), or "Re-research now" | a revision of the live version, in review, or `no_changes` |

Nothing the pipeline writes is ever public. Row-level security lets the
pipeline account submit versions for review only; publishing is an admin action.

## Commands

```sh
pnpm --filter @sia/pipeline pipeline run --brief "Lindsay Clancy trial verdict"   # offline: writes a package directory, no database
pnpm --filter @sia/pipeline worker                                               # the service (see below)
pnpm --filter @sia/pipeline pipeline worker --once [--job <id>]                  # one job, then exit
pnpm --filter @sia/pipeline pipeline verify <job-id> [--out <dir>]               # audit a finished job from the database
pnpm --filter @sia/pipeline pipeline check case.json --snapshots <dir>           # re-check a saved package offline
```

Models: `PIPELINE_MODEL_STRONG` (scoper, drafter, critics, editor; default
`claude-opus-5-5`) and `PIPELINE_MODEL_FAST` (researchers; default
`claude-sonnet-5-5`). Spend: `PIPELINE_BUDGET_USD` or `--budget-usd` caps each
job across all its attempts (default $40; a measured three-round new case cost
$18.20, an update with nothing new costs only its research). The worker records
the job's spend in `pipeline_jobs.spent_usd` with every heartbeat, on release and
on finish, and a job that runs again gets only what is left. A call that ends
without its result (a timeout, a shutdown) is charged what its responses used,
at list price. Each call is also capped by tier (`src/runner/claude.ts`).

`open_source` fetches only public addresses: the connection's own DNS lookup is
checked (so a name cannot resolve to a public address for a check and a private
one for the fetch), a name that does not resolve is refused, and IPv6 forms
that embed an IPv4 address are checked by that address. Page text is extracted
in a worker thread with a time and memory limit (`src/research/extract.mjs`).

## Updates to a live case

> A scheduled job re-runs the researchers against a published case on a cadence
> the admin sets, daily while a story is hot. New developments produce a
> revision package against the current version, which goes through the same
> review. The live case never changes without approval. (`docs/SPEC.md`)

How it works, end to end:

1. **Cadence.** On the case page in the admin console (Live updates), the admin
   picks Off, every 6 hours, daily or weekly (`admin_set_update_cadence`), or
   presses "Re-research now" (`admin_request_update`).
2. **Schedule.** pg_cron runs `app.enqueue_due_updates()` every 15 minutes. For
   each live case whose `next_update_at` has passed it queues one `update` job
   against the live version and moves `next_update_at` on by the cadence. A
   unique index guarantees a case never has two update jobs queued or running;
   "Re-research now" is refused while one is.
3. **What the job researches against** (`planUpdate` in `src/worker.ts`), as the
   case is when the job runs:
   - the live version at that moment (the version may have changed since the job
     was queued);
   - or, when the pipeline's update for that live version is still waiting for
     review, that package: the job researches only what is new since its as-of
     date, builds on it, and replaces it in the queue (it is superseded), so the
     admin always has one current update per case, diffed against the live version;
   - the job is skipped (`no_changes`, `skipped: true`, with the reason) while a
     revision job for the case is queued or running, while the pending package is
     approved for a scheduled publish, or while the admin has an edit draft of it.
4. **Research.** Every researcher (one per side, plus the records researcher)
   looks only for developments dated after the base as-of date, is told what the
   case already states and which questions it lists as open, and must date each
   claim. The orchestrator then screens the verified claims (`src/update.ts`):
   a development is dated after the as-of date (by event or publication), is not
   low impact, and does not repeat a quote the case already carries.
5. **Nothing new.** With no development left, the job finishes `no_changes` and
   says why in the job result and the research log, for example *"No material
   developments since 2026-10-01 (version 3): 2 verified claim(s) found: 2 dated
   on or before 2026-10-01. Nothing was drafted or submitted."* If a researcher
   failed and the others found nothing, the job fails instead: an incomplete
   search cannot show that nothing is new. A stopped run never reports
   `no_changes`.
6. **Something new.** The must-answer list becomes one item per development
   ("does the draft report it, with its date and source, or is it immaterial?"),
   plus "keep unchanged facts, correct or retire superseded steps" and "resolve
   the open questions a new source answers". The open questions themselves are
   never blocking items. The drafter revises the live document: unchanged facts
   keep their ids and evidence, new steps get new ids, changed facts keep their
   id, retired steps and answered open questions are explained in its
   resolutions, and `as_of` moves to today. The same critic loop (hard
   questions, a red team per side, fact-checker, deterministic citation check)
   and the editor run as for a new case. A draft that ends up changing nothing
   but its as-of date is not submitted (`no_changes`).
   **Sources that changed since they were cited.** The run re-opens every
   source of the base version. A page can change after it was cited (a
   paywall, an edited or removed article). The facts the update leaves
   unchanged were checked against what the page said then, so the worker loads
   the snapshots earlier jobs took of those sources (the jobs behind the base
   version and the versions it came from, `src/archive.ts`) as fallback
   evidence: the citation check and the critics read the archived snapshot, the
   unchanged facts stay unchanged, and each such source becomes an open issue
   for the admin ("has changed since version N cited it … consider replacing
   the source"). Archived snapshots never count as opened in this run, and no
   new claim can cite one. (In a live run before this existed, one article
   cited by 8 of 14 steps had gone behind a paywall; the update rewrote 13 of
   the 14 steps to re-source them.)
7. **Package.** It is submitted with `parent_version` = the live version,
   `based_on_version` = the live version (or the pending update it replaces) and
   tags `['update']`. The review record carries the update summary as the
   editor's `update` report: what changed against the live version
   (`summarizeDiff`) and why (each development, its date, source and where it
   went in the draft, plus retired steps and answered open questions). The
   review screen shows it above the diff; the job result has it too.
8. **Review.** The revision appears in the queue ("updates vN") and its review
   screen diffs it against the live version. The live case, and everything the
   public API returns, stays exactly as it was until the admin approves the
   revision; publishing refuses a revision whose parent is no longer live.

## The worker as a service

`pipeline worker` (no `--once`) runs until it is stopped:

- It polls the queue (`PIPELINE_POLL_SECONDS`, default 30 s) and runs **one job at
  a time per process** (a second job in the same process is refused). After a
  job it checks the queue again at once; after an error it backs off (doubling,
  up to 10 minutes) and signs in again if the session was lost.
- While a job runs it **renews the job's lease** every `PIPELINE_HEARTBEAT_SECONDS`
  (default 60 s) through `pipeline_renew_lease`. A job whose heartbeat is 30
  minutes old can be reclaimed by another worker (up to 3 attempts; after that
  it fails as abandoned). A worker that finds it no longer holds its job stops
  without submitting anything, and only the holder can finish a job.
- On **SIGTERM or SIGINT** it stops claiming, gives the job in progress
  `PIPELINE_SHUTDOWN_GRACE_SECONDS` (default 10 s) to finish, then cancels its
  agent calls and **releases** the job back to the queue (`pipeline_release_job`;
  a job released on its third attempt fails instead). A second signal releases
  at once. Once a package is being submitted the job always finishes.
- More than one worker can run against the same queue; claims are row-locked.

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUPABASE_URL` | required | API URL of the Supabase project |
| `SUPABASE_ANON_KEY` | required | anon (publishable) key. Never the service-role key |
| `PIPELINE_EMAIL`, `PIPELINE_PASSWORD` | required | the pipeline account (`app_role = pipeline`) |
| `ANTHROPIC_API_KEY` | | Claude access for the Agent SDK (or another provider setting the SDK supports) |
| `PIPELINE_WORKER_ID` | `<hostname>:<pid>` | name recorded on claimed jobs |
| `PIPELINE_POLL_SECONDS` | 30 | wait between polls of an empty queue (`--poll-seconds`) |
| `PIPELINE_HEARTBEAT_SECONDS` | 60 | lease renewal while a job runs |
| `PIPELINE_SHUTDOWN_GRACE_SECONDS` | 10 | how long a job in progress may finish after SIGTERM before it is released |
| `PIPELINE_BUDGET_USD` | 40 | spend cap per job (`--budget-usd`) |
| `PIPELINE_MAX_ROUNDS` | 3 | critic-loop rounds per job, 1 to 3 (`--max-rounds`) |
| `PIPELINE_MODEL_STRONG`, `PIPELINE_MODEL_FAST` | see above | models |
| `PIPELINE_HEALTH_FILE` | unset (`/tmp/pipeline-worker.alive` in the image) | touched on every poll and heartbeat, for a health check |

`.env.example` lists them.

## Running it next to a hosted Supabase project

The database does the scheduling (pg_cron queues the update jobs every 15
minutes) and the admin sets each case's cadence in the console, so the worker
is the only process to run: one long-lived container.

1. **Database.** Enable the `pg_cron` extension in the project (Dashboard →
   Database → Extensions), then apply the migrations:
   `cd supabase && npx supabase link --project-ref <ref> && npx supabase db push`.
   Check the two schedules exist: `select jobname, schedule from cron.job;`
   should list `publish-due-versions` (every minute) and `enqueue-due-updates`
   (every 15 minutes). If pg_cron was enabled after the migrations ran, create
   them by hand with the two `cron.schedule(...)` calls in
   `supabase/migrations/20261008000005_schedules.sql`.
2. **Pipeline account.** Once, with the service-role key on your own machine
   (never on the worker):
   `SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... pnpm --filter @sia/supabase staff:create --role pipeline --email pipeline@example.com --password '<12+ chars>'`
3. **Image.** From the repository root:
   `docker build -f services/pipeline/Dockerfile -t sia-pipeline-worker .`
4. **Run.** Put the variables above in `pipeline.env` (the project's anon key,
   the pipeline account, Claude access), then
   ```sh
   docker run -d --name sia-pipeline-worker --restart unless-stopped \
     --stop-timeout 60 --env-file pipeline.env sia-pipeline-worker
   ```
   `--stop-timeout` must exceed `PIPELINE_SHUTDOWN_GRACE_SECONDS` by ~15 s so a
   stopped worker can release its job (otherwise the job is reclaimed after 30
   minutes). On a container platform (Fly.io, Render, ECS, Cloud Run jobs with
   always-on CPU, Kubernetes) run one always-on instance with the same image and
   variables, and keep the secrets in its secret store. The image has a health
   check on `PIPELINE_HEALTH_FILE`.
5. **Cadence.** In the admin console, open a live case → Live updates → choose a
   cadence (daily while the story is hot), or press "Re-research now". The
   case page lists the recent jobs, with the reason when one ended `no_changes`.
6. **Operations.** `pipeline worker --once --job <id>` runs one named job;
   `pipeline verify <job-id>` audits what a job wrote (sources opened, quotes in
   their snapshots, every agent logged; for revisions and updates it also reads
   the archive of the version they are based on). The queue page in the console lists
   queued, running and failed jobs.

## Tests

```sh
cd services/pipeline && npx tsc -p . && npx vitest run   # unit, scripted pipeline runs, and the worker against the local stack
PIPELINE_LIVE=1 npx vitest run test/live.test.ts          # real model calls (opt in)
cd supabase && npx vitest run                             # database: RLS, queue, schedules, leases
pnpm --filter @sia/admin e2e:live-update                  # phase 5 acceptance in the browser
```

`test/update.test.ts` is the phase 5 acceptance against the local Supabase
stack with scripted agents: a live case, a cadence forced due,
`app.enqueue_due_updates()`, the worker; a new development lands as an `update`
revision in the queue while the public still gets the old version, approval
moves the live version, nothing new ends `no_changes`, and two update jobs for a
case are never queued at once. `test/update-flow.test.ts` covers the update
rules without a database, and `test/worker-service.test.ts` the poll loop,
graceful shutdown, leases and one job per process.
