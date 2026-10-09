-- =============================================================================
-- Job spend across attempts
-- =============================================================================
--
-- A job can run up to three times (a stale heartbeat, a worker shutdown, a lost
-- lease). Without a record of what earlier attempts spent, each attempt started
-- with the full per-job budget, so a job could cost about three times
-- PIPELINE_BUDGET_USD. The worker now records the job's cumulative spend with
-- every heartbeat, on release and on finish, and gives each attempt only what is
-- left of the budget.

alter table public.pipeline_jobs
  add column spent_usd numeric(12, 4) not null default 0 check (spent_usd >= 0);

comment on column public.pipeline_jobs.spent_usd is
  'Model spend in USD across all attempts of the job, as the worker last reported it (never lowered).';

-- -----------------------------------------------------------------------------
-- Heartbeat, release and finish take the job's spend so far
-- -----------------------------------------------------------------------------

drop function public.pipeline_renew_lease(uuid, text);

/**
 * Heartbeat with ownership: renews the job's heartbeat if this worker still
 * holds it, records the job's spend so far (never lowering it), and returns
 * false when the worker does not hold the job (it finished, was released, or
 * another worker reclaimed it), so the worker can stop. Pipeline only.
 */
create or replace function public.pipeline_renew_lease(p_job_id uuid, p_worker text, p_spent_usd numeric default null)
returns boolean
language plpgsql volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_pipeline() then
    raise exception 'pipeline only' using errcode = 'insufficient_privilege';
  end if;
  if p_spent_usd is not null and p_spent_usd < 0 then
    raise exception 'spend cannot be negative' using errcode = '22023';
  end if;
  update public.pipeline_jobs
     set heartbeat_at = now(),
         spent_usd = greatest(spent_usd, coalesce(p_spent_usd, spent_usd))
   where id = p_job_id and status = 'running' and claimed_by = left(p_worker, 200);
  return found;
end;
$$;
revoke all on function public.pipeline_renew_lease(uuid, text, numeric) from public, anon;
grant execute on function public.pipeline_renew_lease(uuid, text, numeric) to authenticated;

drop function public.pipeline_release_job(uuid, text, text);

/**
 * Gives a running job back to the queue (a worker shutting down mid-job),
 * recording what it spent so far. After its third attempt the job fails
 * instead. Returns the job's new status. Only the worker that holds the job can
 * release it. Pipeline only.
 */
create or replace function public.pipeline_release_job(p_job_id uuid, p_worker text, p_reason text default null, p_spent_usd numeric default null)
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
  if p_spent_usd is not null and p_spent_usd < 0 then
    raise exception 'spend cannot be negative' using errcode = '22023';
  end if;
  update public.pipeline_jobs
     set status = case when attempts >= 3 then 'failed' else 'queued' end,
         claimed_by = null,
         claimed_at = null,
         heartbeat_at = null,
         finished_at = case when attempts >= 3 then now() end,
         spent_usd = greatest(spent_usd, coalesce(p_spent_usd, spent_usd)),
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
revoke all on function public.pipeline_release_job(uuid, text, text, numeric) from public, anon;
grant execute on function public.pipeline_release_job(uuid, text, text, numeric) to authenticated;

drop function public.pipeline_finish_job(uuid, text, jsonb, text, text);

/**
 * Finishes a running job, recording its total spend. With p_worker, only the
 * worker that holds the job can finish it, so a worker that lost its job to
 * another cannot overwrite the outcome. Pipeline only.
 */
create or replace function public.pipeline_finish_job(
  p_job_id uuid,
  p_status text,
  p_result jsonb default null,
  p_error text default null,
  p_worker text default null,
  p_spent_usd numeric default null
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
  if p_spent_usd is not null and p_spent_usd < 0 then
    raise exception 'spend cannot be negative' using errcode = '22023';
  end if;
  update public.pipeline_jobs
    set status = p_status, finished_at = now(), result = p_result, error = left(p_error, 20000),
        spent_usd = greatest(spent_usd, coalesce(p_spent_usd, spent_usd))
    where id = p_job_id and status = 'running'
      and (p_worker is null or claimed_by = left(p_worker, 200));
  if not found then
    raise exception 'job % is not running%', p_job_id,
      case when p_worker is null then '' else format(' for worker %s', p_worker) end
      using errcode = 'PT409';
  end if;
end;
$$;
revoke all on function public.pipeline_finish_job(uuid, text, jsonb, text, text, numeric) from public, anon;
grant execute on function public.pipeline_finish_job(uuid, text, jsonb, text, text, numeric) to authenticated;
