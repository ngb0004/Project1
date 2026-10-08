-- =============================================================================
-- Agent pipeline: jobs, research log, source snapshots, package submission
-- =============================================================================
--
-- The pipeline worker signs in as a user whose app_metadata.app_role is
-- 'pipeline'. It can create cases, write research logs and submit draft
-- versions for review. Row-level security stops it from publishing.

create table public.pipeline_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('new_case', 'revision', 'update')),
  case_id uuid references public.cases (id),
  -- revision: the version to revise; update: the live version to re-research
  base_version int,
  -- new_case: the one-line brief from the admin
  brief text check (length(brief) <= 2000),
  -- revision: admin notes, used as instructions
  instructions text check (length(instructions) <= 20000),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'no_changes', 'failed', 'cancelled')),
  attempts int not null default 0,
  claimed_by text,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  -- e.g. {"case_id": ..., "version": ..., "rounds": 2, "open_issues": 1}
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  created_by text not null default app.actor(),
  check (
    (kind = 'new_case' and brief is not null)
    or (kind <> 'new_case' and case_id is not null and base_version is not null)
  ),
  foreign key (case_id, base_version) references public.case_versions (case_id, version)
);
create index pipeline_jobs_queue_idx on public.pipeline_jobs (status, created_at);

alter table public.case_versions
  add constraint case_versions_pipeline_job_fk foreign key (pipeline_job_id) references public.pipeline_jobs (id);
alter table public.review_alerts
  add constraint review_alerts_job_fk foreign key (pipeline_job_id) references public.pipeline_jobs (id);

/** Text of every page an agent opened, so the fact-checker and the admin can re-read it. */
create table public.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.pipeline_jobs (id),
  url text not null,
  final_url text,
  http_status int,
  content_type text,
  title text,
  sha256 text not null,
  text_content text not null,
  fetched_at timestamptz not null default now(),
  unique (job_id, sha256)
);

/** Every query run, page opened and claim extracted, so the admin can audit how a fact got in. */
create table public.research_log (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.pipeline_jobs (id),
  case_id uuid references public.cases (id),
  agent text not null,
  -- e.g. the side a researcher works for
  scope text,
  round int not null default 0,
  kind text not null check (kind in ('query', 'open', 'claim', 'note')),
  query text,
  url text,
  title text,
  snapshot_id uuid references public.source_snapshots (id),
  http_status int,
  excerpt text check (length(excerpt) <= 4000),
  claims jsonb,
  created_at timestamptz not null default now()
);
create index research_log_job_idx on public.research_log (job_id, id);
create index research_log_case_idx on public.research_log (case_id);

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table public.pipeline_jobs enable row level security;
alter table public.source_snapshots enable row level security;
alter table public.research_log enable row level security;

revoke all on public.pipeline_jobs, public.source_snapshots, public.research_log from anon, authenticated;

grant select on public.pipeline_jobs, public.source_snapshots, public.research_log to authenticated;
grant insert (kind, case_id, base_version, brief, instructions) on public.pipeline_jobs to authenticated;
grant update (status) on public.pipeline_jobs to authenticated;
grant insert (job_id, url, final_url, http_status, content_type, title, sha256, text_content, fetched_at)
  on public.source_snapshots to authenticated;
grant insert (job_id, case_id, agent, scope, round, kind, query, url, title, snapshot_id, http_status, excerpt, claims)
  on public.research_log to authenticated;

create policy jobs_staff_read on public.pipeline_jobs for select to authenticated using (public.is_staff());
create policy jobs_admin_insert on public.pipeline_jobs for insert to authenticated with check (public.is_admin());
create policy jobs_admin_cancel on public.pipeline_jobs for update to authenticated
  using (public.is_admin() and status = 'queued') with check (public.is_admin() and status = 'cancelled');

create policy snapshots_staff_read on public.source_snapshots for select to authenticated using (public.is_staff());
create policy snapshots_pipeline_insert on public.source_snapshots for insert to authenticated
  with check (public.is_pipeline());

create policy research_log_staff_read on public.research_log for select to authenticated using (public.is_staff());
create policy research_log_pipeline_insert on public.research_log for insert to authenticated
  with check (public.is_pipeline());

-- Research logs and snapshots are evidence; they never change.
create trigger research_log_append_only
  before update or delete on public.research_log
  for each row execute function app.append_only();
create trigger source_snapshots_append_only
  before update or delete on public.source_snapshots
  for each row execute function app.append_only();

-- -----------------------------------------------------------------------------
-- Worker RPCs
-- -----------------------------------------------------------------------------

/** Claims the oldest queued job (or a stale running one). Pipeline only. */
create or replace function public.pipeline_claim_job(p_worker text)
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
    where status = 'queued'
       or (status = 'running' and heartbeat_at < now() - interval '30 minutes' and attempts < 3)
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

create or replace function public.pipeline_heartbeat(p_job_id uuid)
returns void
language plpgsql volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_pipeline() then
    raise exception 'pipeline only' using errcode = 'insufficient_privilege';
  end if;
  update public.pipeline_jobs set heartbeat_at = now() where id = p_job_id and status = 'running';
end;
$$;

create or replace function public.pipeline_finish_job(p_job_id uuid, p_status text, p_result jsonb default null, p_error text default null)
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
    where id = p_job_id and status = 'running';
  if not found then
    raise exception 'job % is not running', p_job_id using errcode = 'PT409';
  end if;
end;
$$;

/** Marks the version a revision replaces as superseded. Only pending versions qualify. */
create or replace function app.supersede(p_case_id uuid, p_version int, p_by_version int)
returns void
language plpgsql volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = 'insufficient_privilege';
  end if;
  update public.case_versions set status = 'archived'
    where case_id = p_case_id and version = p_version and status in ('changes_requested', 'in_review', 'draft');
  if found then
    insert into public.review_decisions (case_id, version, action, notes)
    values (p_case_id, p_version, 'superseded', format('Superseded by version %s.', p_by_version));
  end if;
end;
$$;
revoke all on function app.supersede(uuid, int, int) from public, anon;
grant execute on function app.supersede(uuid, int, int) to authenticated;

/**
 * The single import path for case packages. The pipeline's package writer and
 * the seed import script both call this. It runs as the caller, so row-level
 * security decides what may be written: a package always lands in review,
 * never published.
 */
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
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = 'insufficient_privilege';
  end if;
  if p_origin = 'admin' then
    raise exception 'admin edits use admin_save_edit' using errcode = '22023';
  end if;

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

  insert into public.case_versions (case_id, status, origin, based_on_version, tags, doc, pipeline_job_id)
  values (cid, 'in_review', p_origin, p_based_on_version, coalesce(p_tags, '{}'), p_doc, p_job_id)
  returning version into v;

  insert into public.review_decisions (case_id, version, action, notes)
  values (cid, v, 'submitted',
          case when p_job_id is null then format('Imported (%s).', p_origin)
               else format('Submitted by pipeline job %s.', p_job_id) end);

  if based_status in ('changes_requested', 'in_review', 'draft') then
    perform app.supersede(cid, p_based_on_version, v);
  end if;

  return jsonb_build_object('case_id', cid, 'slug', p_slug, 'version', v);
end;
$$;

revoke all on function public.pipeline_claim_job(text) from public;
revoke all on function public.pipeline_heartbeat(uuid) from public;
revoke all on function public.pipeline_finish_job(uuid, text, jsonb, text) from public;
revoke all on function public.submit_case_package(text, jsonb, uuid, int, text[], public.version_origin) from public;
revoke execute on function public.pipeline_claim_job(text) from anon;
revoke execute on function public.pipeline_heartbeat(uuid) from anon;
revoke execute on function public.pipeline_finish_job(uuid, text, jsonb, text) from anon;
revoke execute on function public.submit_case_package(text, jsonb, uuid, int, text[], public.version_origin) from anon;
grant execute on function public.pipeline_claim_job(text) to authenticated;
grant execute on function public.pipeline_heartbeat(uuid) to authenticated;
grant execute on function public.pipeline_finish_job(uuid, text, jsonb, text) to authenticated;
grant execute on function public.submit_case_package(text, jsonb, uuid, int, text[], public.version_origin) to authenticated;
