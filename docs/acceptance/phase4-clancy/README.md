# Phase 4 acceptance: "Lindsay Clancy trial verdict"

A live run of the agent pipeline on the spec's second case, from a one-line
brief to the review queue, with no code changes.

How it ran: the admin queued the brief with `admin_create_case('Lindsay Clancy
trial verdict')`; `pipeline worker --once` (real Claude Agent SDK runner)
claimed the job, ran the scoper, a researcher per side and the records
researcher, the drafter, three critique rounds (hard questions, a fresh-context
red team per side, the fact-checker plus the deterministic citation check), the
editor, and submitted the package as the pipeline account.

- `job.json`: the finished job row (status `succeeded`, 3 rounds).
- `audit.json`: the verification run against the database afterwards
  (`services/pipeline/src/verify.ts`): the version is `in_review` in the queue;
  0 schema errors; every source in the case has a `source_snapshots` row for
  this job with HTTP 200; all 163 evidence quotes appear verbatim in their
  snapshots; research-log counts per agent and scope.
- `case.json`: the submitted case document (14 steps, 25 sources, 2 open
  issues raised by the fact-checker for the admin).

Nothing here is published; the owner decides in the admin console.
