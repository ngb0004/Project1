-- =============================================================================
-- Live updates: one re-research job per case at a time; worker leases
-- =============================================================================
--
-- A scheduled job (pg_cron, every 15 minutes) queues an 'update' job for each
-- live case whose re-research cadence is due; the admin can also queue one by
-- hand. This migration makes that queue safe to run as a service:
--
--   * At most one update job per case is queued or running, enforced by a
--     unique index (the cron, the admin and a second cron run can race).
--   * A worker claims a job, renews its lease with every heartbeat, and learns
--     when it lost the job (another worker reclaimed it after its heartbeat went
--     stale), so it stops instead of submitting a second package.
--   * A worker that shuts down mid-job releases the job back to the queue
--     instead of failing it. After three attempts a released job fails.
--   * Finishing a job can name the worker, so a worker that lost the job
--     cannot overwrite the outcome of the worker that holds it now.
--   * A job abandoned after three attempts (no heartbeat for 30 minutes) is
--     marked failed, so it cannot block the case's next update forever.
--   * pipeline_claim_job can claim one named job (`pipeline worker --job <id>`).
--   * An update package built on the pipeline's earlier update still in review
--     supersedes it, so the queue holds one current update per live case.

-- -----------------------------------------------------------------------------
-- One active update job per case
-- -----------------------------------------------------------------------------

-- Duplicates from before this migration (none are expected) are retired first:
-- the running one (or else the oldest) is kept.
with ranked as (
  select id, status,
         row_number() over (partition by case_id order by (status = 'running') desc, created_at) as n
  from public.pipeline_jobs
  where kind = 'update' and status in ('queued', 'running')
)
update public.pipeline_jobs j
   set status = case when r.status = 'queued' then 'cancelled' else 'failed' end,
       finished_at = case when r.status = 'running' then now() else j.finished_at end,
       error = case when r.status = 'running' then 'Stopped: another update job for this case was already active.' else j.error end
  from ranked r
 where r.id = j.id and r.n > 1;

create unique index pipeline_jobs_one_active_update
  on public.pipeline_jobs (case_id)
  where kind = 'update' and status in ('queued', 'running');

-- -----------------------------------------------------------------------------
-- Abandoned jobs
-- -----------------------------------------------------------------------------

/**
 * Fails running jobs whose worker vanished (no heartbeat for 30 minutes) after
 * their last allowed attempt. Earlier attempts stay reclaimable by
 * pipeline_claim_job. Returns how many jobs it failed.
 */
create or replace function app.expire_abandoned_jobs()
returns int
language plpgsql volatile
security definer
set search_path = ''
as $$
declare n int;
begin
  update public.pipeline_jobs
     set status = 'failed',
         finished_at = now(),
         error = left(format('Abandoned: no heartbeat from %s since %s, after %s attempt(s).',
                             coalesce(claimed_by, 'its worker'), heartbeat_at, attempts), 20000)
   where status = 'running'
     and heartbeat_at < now() - interval '30 minutes'
     and attempts >= 3;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function app.expire_abandoned_jobs() from public, anon;
grant execute on function app.expire_abandoned_jobs() to authenticated;

-- -----------------------------------------------------------------------------
-- Queuing updates: the schedule and the admin
-- -----------------------------------------------------------------------------

/** Queues re-research runs for live cases whose update cadence is due (pg_cron, every 15 minutes). */
create or replace function app.enqueue_due_updates()
returns int
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  c record;
  n int := 0;
  added int;
begin
  perform app.expire_abandoned_jobs();
  for c in
    select id, live_version, update_cadence from public.cases
    where update_cadence is not null and live_version is not null
      and coalesce(next_update_at, now()) <= now()
    for update skip locked
  loop
    -- A case with an update already queued or running gets no second one.
    insert into public.pipeline_jobs (kind, case_id, base_version, instructions, created_by)
    values ('update', c.id, c.live_version, 'Scheduled re-research of the live version.', 'system:schedule')
    on conflict (case_id) where kind = 'update' and status in ('queued', 'running') do nothing;
    get diagnostics added = row_count;
    n := n + added;
    update public.cases set next_update_at = now() + c.update_cadence where id = c.id;
  end loop;
  return n;
end;
$$;
revoke all on function app.enqueue_due_updates() from public, anon, authenticated;

/** Queue a re-research run against the live version now. Refused while one is queued or running. */
create or replace function public.admin_request_update(p_case_id uuid)
returns uuid
language plpgsql volatile
security invoker
set search_path = ''
as $$
declare
  live int := app.case_live_version(p_case_id);
  active uuid;
  job uuid;
begin
  perform app.require_admin();
  if live is null then
    raise exception 'case has no live version' using errcode = 'PT409';
  end if;
  perform app.expire_abandoned_jobs();
  select id into active from public.pipeline_jobs
    where case_id = p_case_id and kind = 'update' and status in ('queued', 'running')
    limit 1;
  if active is not null then
    raise exception 'a re-research job for this case is already queued or running (job %)', left(active::text, 8)
      using errcode = 'PT409';
  end if;
  begin
    insert into public.pipeline_jobs (kind, case_id, base_version, instructions)
    values ('update', p_case_id, live, 'Manual update requested by the admin.')
    returning id into job;
  exception when unique_violation then
    raise exception 'a re-research job for this case is already queued or running' using errcode = 'PT409';
  end;
  return job;
end;
$$;
revoke all on function public.admin_request_update(uuid) from public, anon;
grant execute on function public.admin_request_update(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Worker RPCs: claim (optionally one named job), lease, release
-- -----------------------------------------------------------------------------

drop function public.pipeline_claim_job(text);

/**
 * Claims the oldest queued job (or a stale running one), or with p_job_id that
 * job only. Returns nothing when there is no claimable job. Pipeline only.
 */
create or replace function public.pipeline_claim_job(p_worker text, p_job_id uuid default null)
returns setof public.pipeline_jobs
language plpgsql volatile
security definer
set search_path = ''
as $$
declare j public.pipeline_jobs;
begin
  if not public.is_pipeline() then
    raise exception 'pipeline only' using errcode = 'insufficient_privilege';
  end if;
  select * into j from public.pipeline_jobs
    where (p_job_id is null or id = p_job_id)
      and (status = 'queued'
           or (status = 'running' and heartbeat_at < now() - interval '30 minutes' and attempts < 3))
    order by created_at
    limit 1
    for update skip locked;
  if not found then
    return;
  end if;
  update public.pipeline_jobs
    set status = 'running', claimed_by = left(p_worker, 200), claimed_at = now(), heartbeat_at = now(),
        attempts = attempts + 1
    where id = j.id
    returning * into j;
  return next j;
end;
$$;
revoke all on function public.pipeline_claim_job(text, uuid) from public, anon;
grant execute on function public.pipeline_claim_job(text, uuid) to authenticated;

/**
 * Heartbeat with ownership: renews the job's heartbeat if this worker still
 * holds it, and returns false when it does not (the job finished, was released,
 * or another worker reclaimed it), so the worker can stop. Pipeline only.
 */
create or replace function public.pipeline_renew_lease(p_job_id uuid, p_worker text)
returns boolean
language plpgsql volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_pipeline() then
    raise exception 'pipeline only' using errcode = 'insufficient_privilege';
  end if;
  update public.pipeline_jobs set heartbeat_at = now()
    where id = p_job_id and status = 'running' and claimed_by = left(p_worker, 200);
  return found;
end;
$$;
revoke all on function public.pipeline_renew_lease(uuid, text) from public, anon;
grant execute on function public.pipeline_renew_lease(uuid, text) to authenticated;

drop function public.pipeline_finish_job(uuid, text, jsonb, text);

/**
 * Finishes a running job. With p_worker, only the worker that holds the job can
 * finish it, so a worker that lost its job to another cannot overwrite the
 * outcome. Pipeline only.
 */
create or replace function public.pipeline_finish_job(
  p_job_id uuid,
  p_status text,
  p_result jsonb default null,
  p_error text default null,
  p_worker text default null
)
returns void
language plpgsql volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_pipeline() then
    raise exception 'pipeline only' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('succeeded', 'no_changes', 'failed') then
    raise exception 'bad status %', p_status using errcode = '22023';
  end if;
  update public.pipeline_jobs
    set status = p_status, finished_at = now(), result = p_result, error = left(p_error, 20000)
    where id = p_job_id and status = 'running'
      and (p_worker is null or claimed_by = left(p_worker, 200));
  if not found then
    raise exception 'job % is not running%', p_job_id,
      case when p_worker is null then '' else format(' for worker %s', p_worker) end
      using errcode = 'PT409';
  end if;
end;
$$;
revoke all on function public.pipeline_finish_job(uuid, text, jsonb, text, text) from public, anon;
grant execute on function public.pipeline_finish_job(uuid, text, jsonb, text, text) to authenticated;

/**
 * Gives a running job back to the queue (a worker shutting down mid-job). After
 * its third attempt the job fails instead. Returns the job's new status.
 * Only the worker that holds the job can release it. Pipeline only.
 */
create or replace function public.pipeline_release_job(p_job_id uuid, p_worker text, p_reason text default null)
returns text
language plpgsql volatile
security definer
set search_path = ''
as $$
declare j public.pipeline_jobs;
begin
  if not public.is_pipeline() then
    raise exception 'pipeline only' using errcode = 'insufficient_privilege';
  end if;
  update public.pipeline_jobs
     set status = case when attempts >= 3 then 'failed' else 'queued' end,
         claimed_by = null,
         claimed_at = null,
         heartbeat_at = null,
         finished_at = case when attempts >= 3 then now() end,
         error = case when attempts >= 3
                      then left(format('Released after attempt %s and not retried: %s', attempts, coalesce(p_reason, 'no reason given')), 20000)
                      else error end
   where id = p_job_id and status = 'running' and claimed_by = left(p_worker, 200)
   returning * into j;
  if not found then
    raise exception 'job % is not running for worker %', p_job_id, p_worker using errcode = 'PT409';
  end if;
  return j.status;
end;
$$;
revoke all on function public.pipeline_release_job(uuid, text, text) from public, anon;
grant execute on function public.pipeline_release_job(uuid, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- An update package replaces the pipeline's earlier update still in review
-- -----------------------------------------------------------------------------
--
-- While the admin has not yet reviewed an update package, the next scheduled
-- update builds on it (researching only what is new since its as-of date) and
-- submits a package based on it. That package carries everything the earlier
-- one did, so the earlier one is superseded: the queue keeps one current
-- update per live case. The pipeline may supersede only its own package in
-- review, only one that is not approved for a scheduled publish, and only from
-- an 'update' package based on it that updates the same live version. Admin
-- edits and imports are never superseded by the pipeline.

/**
 * Archives a version that a newer one replaces. The admin may supersede any
 * pending version. The pipeline may supersede a version the admin sent back to
 * it, or its own update package in review that a newer update builds on.
 */
create or replace function app.supersede(p_case_id uuid, p_version int, p_by_version int)
returns void
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  v public.case_versions;
  note text := format('Superseded by version %s.', p_by_version);
begin
  select * into v from public.case_versions where case_id = p_case_id and version = p_version for update;
  if not found then return; end if;
  if public.is_admin() then
    if v.status not in ('changes_requested', 'in_review', 'draft') then return; end if;
  elsif public.is_pipeline() then
    if v.origin = 'admin' or v.scheduled_publish_at is not null then
      return;
    end if;
    if v.status = 'changes_requested' then
      null;
    elsif v.status = 'in_review' and v.origin = 'pipeline' and exists (
      select 1 from public.case_versions b
      where b.case_id = p_case_id and b.version = p_by_version
        and b.origin = 'pipeline' and 'update' = any(b.tags)
        and b.based_on_version = p_version
        and b.parent_version is not distinct from v.parent_version
        and v.parent_version is not null) then
      note := format('Superseded by version %s, a newer update of live version %s built on this one.', p_by_version, v.parent_version);
    else
      return;
    end if;
  else
    raise exception 'staff only' using errcode = 'insufficient_privilege';
  end if;
  update public.case_versions
    set doc = app.with_decision(v.doc, 'superseded', p_version, note),
        status = 'archived',
        scheduled_publish_at = null
    where case_id = p_case_id and version = p_version;
  insert into public.review_decisions (case_id, version, action, notes)
  values (p_case_id, p_version, 'superseded', note);
end;
$$;
revoke all on function app.supersede(uuid, int, int) from public, anon;
grant execute on function app.supersede(uuid, int, int) to authenticated;

/** The single import path for case packages (pipeline output and seed cases). Lands in review, never published. */
create or replace function public.submit_case_package(
  p_slug text,
  p_doc jsonb,
  p_job_id uuid default null,
  p_based_on_version int default null,
  p_tags text[] default '{}',
  p_origin public.version_origin default 'pipeline'
)
returns jsonb
language plpgsql volatile
security invoker
set search_path = ''
as $$
declare
  cid uuid;
  v int;
  based_status public.case_status;
  note text;
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = 'insufficient_privilege';
  end if;
  if p_origin = 'admin' then
    raise exception 'admin edits use admin_save_edit' using errcode = '22023';
  end if;
  perform app.begin_review_action();

  select id into cid from public.cases where slug = p_slug;
  if cid is null then
    insert into public.cases (slug) values (p_slug) returning id into cid;
  end if;

  if p_based_on_version is not null then
    select status into based_status from public.staff_case_versions
      where case_id = cid and version = p_based_on_version;
    if based_status is null then
      raise exception 'based_on_version % does not exist', p_based_on_version using errcode = 'PT404';
    end if;
  end if;

  if (p_doc ->> 'parent_version') is not null and not exists (
    select 1 from public.staff_case_versions
    where case_id = cid and version = (p_doc ->> 'parent_version')::int and published_at is not null) then
    raise exception 'parent_version % is not a published version of case %', p_doc ->> 'parent_version', p_slug
      using errcode = '22023';
  end if;

  note := case when p_job_id is null then format('Imported (%s).', p_origin)
               else format('Submitted by pipeline job %s.', p_job_id) end;
  insert into public.case_versions (case_id, status, origin, based_on_version, tags, doc, pipeline_job_id)
  values (cid, 'draft', p_origin, p_based_on_version, coalesce(p_tags, '{}'), p_doc, p_job_id)
  returning version into v;
  update public.case_versions
    set doc = app.with_decision(p_doc, 'submitted', v, note),
        status = 'in_review'
    where case_id = cid and version = v;

  insert into public.review_decisions (case_id, version, action, notes)
  values (cid, v, 'submitted', note);

  -- A revision supersedes the version the admin sent back; an update supersedes the update it builds on
  -- (app.supersede decides what the caller may archive).
  if based_status = 'changes_requested'
     or (based_status = 'in_review' and p_origin = 'pipeline' and 'update' = any(coalesce(p_tags, '{}'))) then
    perform app.supersede(cid, p_based_on_version, v);
  end if;

  return jsonb_build_object('case_id', cid, 'slug', p_slug, 'version', v);
end;
$$;
revoke all on function public.submit_case_package(text, jsonb, uuid, int, text[], public.version_origin) from public, anon;
grant execute on function public.submit_case_package(text, jsonb, uuid, int, text[], public.version_origin) to authenticated;
