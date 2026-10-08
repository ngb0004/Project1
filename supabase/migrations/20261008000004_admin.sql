-- =============================================================================
-- Admin console: review actions, queue, crowd and fairness readouts
-- =============================================================================
--
-- The admin is the human gate. Every action below runs as the caller
-- (SECURITY INVOKER) where it writes case versions, so row-level security and
-- the guard trigger both check it. Each decision is appended to
-- public.review_decisions and, while the version is still mutable, to the
-- document's own review.decisions.

create or replace function app.require_admin() returns void
language plpgsql stable
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

/** Appends a decision to doc.review.decisions (pure). */
create or replace function app.with_decision(p_doc jsonb, p_action text, p_version int, p_notes text,
                                             p_scheduled_for timestamptz default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_set(
    case when jsonb_typeof(p_doc -> 'review') = 'object' then p_doc
         else jsonb_set(p_doc, '{review}', '{}'::jsonb) end,
    '{review,decisions}',
    coalesce(p_doc #> '{review,decisions}', '[]'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
           'action', p_action,
           'actor', app.actor(),
           'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'version', p_version,
           'notes', nullif(p_notes, ''),
           'scheduled_for', case when p_scheduled_for is null then null
                                 else to_char(p_scheduled_for at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end))
  )
$$;

create or replace function app.staff_version(p_case_id uuid, p_version int)
returns public.staff_case_versions
language plpgsql stable
set search_path = ''
as $$
declare r public.staff_case_versions;
begin
  select * into r from public.staff_case_versions where case_id = p_case_id and version = p_version;
  if not found then
    raise exception 'version %/% not found', p_case_id, p_version using errcode = 'PT404';
  end if;
  return r;
end;
$$;

-- -----------------------------------------------------------------------------
-- Review actions
-- -----------------------------------------------------------------------------

/** Approve and publish: creates the immutable published version and makes it live. */
create or replace function public.admin_publish(p_case_id uuid, p_version int, p_notes text default null)
returns jsonb
language plpgsql volatile
security invoker
set search_path = ''
as $$
declare
  v public.staff_case_versions;
begin
  perform app.require_admin();
  v := app.staff_version(p_case_id, p_version);
  update public.case_versions
    set doc = app.with_decision(v.doc, 'approve_publish', p_version, p_notes),
        status = 'published'
    where case_id = p_case_id and version = p_version;
  insert into public.review_decisions (case_id, version, action, notes)
  values (p_case_id, p_version, 'approve_publish', p_notes);
  if 'admin_edit' = any(v.tags) and v.based_on_version is not null then
    perform app.supersede(p_case_id, v.based_on_version, p_version);
  end if;
  return jsonb_build_object('case_id', p_case_id, 'version', p_version,
                            'live_version', app.case_live_version(p_case_id));
end;
$$;

/** Approve and schedule: same as publish, but the cron job makes it live at p_at. */
create or replace function public.admin_schedule(p_case_id uuid, p_version int, p_at timestamptz, p_notes text default null)
returns jsonb
language plpgsql volatile
security invoker
set search_path = ''
as $$
declare
  v public.staff_case_versions;
  problems text[];
begin
  perform app.require_admin();
  if p_at is null or p_at <= now() then
    raise exception 'schedule time must be in the future' using errcode = '22023';
  end if;
  v := app.staff_version(p_case_id, p_version);
  if v.status not in ('in_review', 'draft') then
    raise exception 'only versions in review (or admin edit drafts) can be scheduled' using errcode = 'PT409';
  end if;
  problems := app.case_doc_problems(v.doc);
  if cardinality(problems) > 0 then
    raise exception 'version is not publishable: %', array_to_string(problems, '; ') using errcode = 'check_violation';
  end if;
  update public.case_versions
    set doc = app.with_decision(v.doc, 'approve_schedule', p_version, p_notes, p_at),
        scheduled_publish_at = p_at
    where case_id = p_case_id and version = p_version;
  insert into public.review_decisions (case_id, version, action, notes, scheduled_for)
  values (p_case_id, p_version, 'approve_schedule', p_notes, p_at);
  return jsonb_build_object('case_id', p_case_id, 'version', p_version, 'scheduled_publish_at', p_at);
end;
$$;

create or replace function public.admin_unschedule(p_case_id uuid, p_version int)
returns void
language plpgsql volatile
security invoker
set search_path = ''
as $$
begin
  perform app.require_admin();
  update public.case_versions set scheduled_publish_at = null
    where case_id = p_case_id and version = p_version and status <> 'published';
end;
$$;

/** Request changes: written notes go back to the pipeline as instructions for a revision round. */
create or replace function public.admin_request_changes(p_case_id uuid, p_version int, p_notes text)
returns jsonb
language plpgsql volatile
security invoker
set search_path = ''
as $$
declare
  v public.staff_case_versions;
  job uuid;
begin
  perform app.require_admin();
  if coalesce(trim(p_notes), '') = '' then
    raise exception 'write notes for the pipeline' using errcode = '22023';
  end if;
  v := app.staff_version(p_case_id, p_version);
  update public.case_versions
    set doc = app.with_decision(v.doc, 'request_changes', p_version, p_notes),
        status = 'changes_requested',
        scheduled_publish_at = null
    where case_id = p_case_id and version = p_version;
  insert into public.review_decisions (case_id, version, action, notes)
  values (p_case_id, p_version, 'request_changes', p_notes);
  insert into public.pipeline_jobs (kind, case_id, base_version, instructions)
  values ('revision', p_case_id, p_version, p_notes)
  returning id into job;
  return jsonb_build_object('case_id', p_case_id, 'version', p_version, 'job_id', job);
end;
$$;

/** Reject: archives the package and stores the reason. */
create or replace function public.admin_reject(p_case_id uuid, p_version int, p_reason text)
returns void
language plpgsql volatile
security invoker
set search_path = ''
as $$
declare v public.staff_case_versions;
begin
  perform app.require_admin();
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  v := app.staff_version(p_case_id, p_version);
  update public.case_versions
    set doc = app.with_decision(v.doc, 'reject', p_version, p_reason),
        status = 'rejected',
        scheduled_publish_at = null
    where case_id = p_case_id and version = p_version;
  insert into public.review_decisions (case_id, version, action, notes)
  values (p_case_id, p_version, 'reject', p_reason);
end;
$$;

/** Retires a published version (takes it offline if it is live). The document itself never changes. */
create or replace function public.admin_archive(p_case_id uuid, p_version int, p_notes text default null)
returns void
language plpgsql volatile
security invoker
set search_path = ''
as $$
declare v public.staff_case_versions;
begin
  perform app.require_admin();
  v := app.staff_version(p_case_id, p_version);
  update public.case_versions set status = 'archived'
    where case_id = p_case_id and version = p_version;
  insert into public.review_decisions (case_id, version, action, notes)
  values (p_case_id, p_version, 'archive', p_notes);
end;
$$;

/**
 * Edit then approve, step one: admin edits are saved as a draft version tagged
 * admin_edit. Repeated saves update the same draft until it is published.
 * Returns the draft's version number.
 */
create or replace function public.admin_save_edit(p_case_id uuid, p_base_version int, p_doc jsonb, p_notes text default null)
returns jsonb
language plpgsql volatile
security invoker
set search_path = ''
as $$
declare
  base public.staff_case_versions;
  target public.staff_case_versions;
  parent int;
  new_doc jsonb;
  note text := coalesce(p_notes, format('Edited from version %s.', p_base_version));
  v int;
begin
  perform app.require_admin();
  if jsonb_typeof(p_doc) <> 'object' then
    raise exception 'doc must be a JSON object' using errcode = '22023';
  end if;
  base := app.staff_version(p_case_id, p_base_version);
  if base.status in ('rejected', 'archived') then
    raise exception 'version % is %, edit a live or pending version instead', p_base_version, base.status
      using errcode = 'PT409';
  end if;

  -- An edit updates whatever the base updates; an edit of a published version updates that version.
  parent := case when base.status = 'published' then base.version else base.parent_version end;
  new_doc := p_doc - 'parent_version';
  if parent is not null then
    new_doc := new_doc || jsonb_build_object('parent_version', parent);
  end if;

  -- Continue an existing admin_edit draft rather than piling up versions.
  if base.status = 'draft' and 'admin_edit' = any(base.tags) then
    target := base;
  else
    select * into target from public.staff_case_versions
      where case_id = p_case_id and based_on_version = p_base_version and status = 'draft'
        and 'admin_edit' = any(tags)
      order by version desc limit 1;
  end if;

  if target.version is not null then
    v := target.version;
    update public.case_versions
      set doc = app.with_decision(new_doc, 'admin_edit', v, note)
      where case_id = p_case_id and version = v;
  else
    insert into public.case_versions (case_id, status, origin, based_on_version, tags, doc)
    values (p_case_id, 'draft', 'admin', p_base_version, array['admin_edit'], new_doc)
    returning version into v;
    update public.case_versions
      set doc = app.with_decision(new_doc, 'admin_edit', v, note)
      where case_id = p_case_id and version = v;
  end if;

  insert into public.review_decisions (case_id, version, action, notes)
  values (p_case_id, v, 'admin_edit', note);
  return jsonb_build_object('case_id', p_case_id, 'version', v, 'based_on_version', p_base_version,
                            'parent_version', parent);
end;
$$;

/** Starts a new case from a one-line brief. The pipeline worker picks up the job. */
create or replace function public.admin_create_case(p_brief text)
returns uuid
language plpgsql volatile
security invoker
set search_path = ''
as $$
declare job uuid;
begin
  perform app.require_admin();
  if coalesce(trim(p_brief), '') = '' then
    raise exception 'brief is required' using errcode = '22023';
  end if;
  insert into public.pipeline_jobs (kind, brief) values ('new_case', trim(p_brief)) returning id into job;
  return job;
end;
$$;

/** Re-research cadence for a live case, e.g. '1 day' while a story is hot. Null turns it off. */
create or replace function public.admin_set_update_cadence(p_case_id uuid, p_cadence interval)
returns void
language plpgsql volatile
security invoker
set search_path = ''
as $$
begin
  perform app.require_admin();
  update public.cases
    set update_cadence = p_cadence,
        next_update_at = case when p_cadence is null then null else now() + p_cadence end
    where id = p_case_id;
end;
$$;

/** Queue a re-research run against the live version now. */
create or replace function public.admin_request_update(p_case_id uuid)
returns uuid
language plpgsql volatile
security invoker
set search_path = ''
as $$
declare
  live int := app.case_live_version(p_case_id);
  job uuid;
begin
  perform app.require_admin();
  if live is null then
    raise exception 'case has no live version' using errcode = 'PT409';
  end if;
  insert into public.pipeline_jobs (kind, case_id, base_version, instructions)
  values ('update', p_case_id, live, 'Manual update requested by the admin.')
  returning id into job;
  return job;
end;
$$;

-- -----------------------------------------------------------------------------
-- Seeds and crowd readouts (definer: they read tables the admin cannot write)
-- -----------------------------------------------------------------------------

/** Saves the seed profile and regenerates seeded rows for the live version. */
create or replace function public.admin_set_seed_profile(p_case_id uuid, p_profile jsonb)
returns jsonb
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  live int;
  n int := 0;
begin
  perform app.require_admin();
  if p_profile is not null and jsonb_typeof(p_profile) <> 'object' then
    raise exception 'profile must be an object' using errcode = '22023';
  end if;
  update public.cases set seed_profile = p_profile where id = p_case_id returning live_version into live;
  if live is not null then
    n := app.generate_seed_responses(p_case_id, live);
  end if;
  return jsonb_build_object('case_id', p_case_id, 'live_version', live, 'seeded_sessions', n);
end;
$$;

create or replace function public.admin_step_crowd(p_case_id uuid, p_version int, p_step_id text, p_include_seed boolean default true)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  perform app.require_admin();
  return app.step_crowd(p_case_id, p_version, p_step_id, p_include_seed);
end;
$$;

create or replace function public.admin_final_crowd(p_case_id uuid, p_version int, p_include_seed boolean default true)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  perform app.require_admin();
  return app.final_crowd(p_case_id, p_version, p_include_seed) || jsonb_build_object(
    'real_completions', app.real_completions(p_case_id, p_version),
    'version_note', app.version_note(p_case_id, p_version));
end;
$$;

/** Fairness signals per side, plus flags per step, for one version. */
create or replace function public.admin_fairness_signals(p_case_id uuid, p_version int)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'sides', coalesce((
      select jsonb_agg(jsonb_build_object(
        'side_id', side_id, 'ratings', n, 'fair', fair, 'somewhat_fair', somewhat, 'unfair', unfair,
        'unfair_share', round(unfair::numeric / nullif(n, 0), 4)) order by side_id)
      from (
        select f.side_id, count(*) as n,
               count(*) filter (where rating = 'fair') as fair,
               count(*) filter (where rating = 'somewhat_fair') as somewhat,
               count(*) filter (where rating = 'unfair') as unfair
        from public.fairness_ratings f
        join public.sessions s on s.id = f.session_id and not s.excluded
        where f.case_id = p_case_id and f.case_version = p_version
        group by f.side_id) t), '[]'::jsonb),
    'flags', coalesce((
      select jsonb_agg(jsonb_build_object(
        'step_id', step_id, 'open', open, 'total', total, 'by_reason', by_reason, 'notes', notes) order by total desc)
      from (
        select step_id,
               count(*) filter (where resolved_at is null) as open,
               count(*) as total,
               jsonb_object_agg_strict(reason, cnt) as by_reason,
               (select jsonb_agg(note order by created_at desc) from (
                  select note, created_at from public.fact_flags n
                  where n.case_id = p_case_id and n.case_version = p_version and n.step_id = g.step_id
                    and note is not null
                  order by created_at desc limit 20) x) as notes
        from (
          select step_id, reason, resolved_at, count(*) over (partition by step_id, reason) as cnt
          from public.fact_flags
          where case_id = p_case_id and case_version = p_version) g
        group by step_id) t), '[]'::jsonb),
    'alerts', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.created_at desc)
      from public.review_alerts a
      where a.case_id = p_case_id and a.case_version = p_version), '[]'::jsonb)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Scheduled jobs (run by pg_cron as a trusted role)
-- -----------------------------------------------------------------------------

/** Publishes versions whose approved schedule time has passed. */
create or replace function app.publish_due_versions()
returns int
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select case_id, version, doc from public.case_versions
    where scheduled_publish_at <= now() and status in ('in_review', 'draft')
    order by scheduled_publish_at
    for update skip locked
  loop
    begin
      update public.case_versions
        set doc = app.with_decision(r.doc, 'scheduled_publish', r.version, 'Published on the approved schedule.'),
            status = 'published'
        where case_id = r.case_id and version = r.version;
      insert into public.review_decisions (case_id, version, action, actor, notes)
      values (r.case_id, r.version, 'scheduled_publish', 'system:schedule', 'Published on the approved schedule.');
      n := n + 1;
    exception when others then
      update public.case_versions set scheduled_publish_at = null
        where case_id = r.case_id and version = r.version;
      insert into public.review_decisions (case_id, version, action, actor, notes)
      values (r.case_id, r.version, 'scheduled_publish', 'system:schedule',
              'Scheduled publish failed and was cancelled: ' || sqlerrm);
    end;
  end loop;
  return n;
end;
$$;

/** Queues re-research runs for live cases whose update cadence is due. */
create or replace function app.enqueue_due_updates()
returns int
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  c record;
  n int := 0;
begin
  for c in
    select id, live_version, update_cadence from public.cases
    where update_cadence is not null and live_version is not null
      and coalesce(next_update_at, now()) <= now()
    for update skip locked
  loop
    if not exists (select 1 from public.pipeline_jobs j
                   where j.case_id = c.id and j.kind = 'update' and j.status in ('queued', 'running')) then
      insert into public.pipeline_jobs (kind, case_id, base_version, instructions, created_by)
      values ('update', c.id, c.live_version, 'Scheduled re-research of the live version.', 'system:schedule');
      n := n + 1;
    end if;
    update public.cases set next_update_at = now() + c.update_cadence where id = c.id;
  end loop;
  return n;
end;
$$;

revoke all on function app.publish_due_versions() from public, anon, authenticated;
revoke all on function app.enqueue_due_updates() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Review queue
-- -----------------------------------------------------------------------------

create view public.staff_queue
with (security_barrier = true)
as
select v.case_id, v.slug, v.version, v.status, v.origin, v.tags, v.title, v.as_of,
       v.parent_version, v.based_on_version, v.live_version, v.is_live,
       v.created_at, v.submitted_at, v.scheduled_publish_at, v.pipeline_job_id,
       (select count(*) from jsonb_array_elements(coalesce(v.doc #> '{review,open_issues}', '[]'::jsonb)) i
         where not coalesce((i ->> 'resolved')::boolean, false)) as open_issue_count,
       jsonb_array_length(coalesce(v.doc -> 'steps', '[]'::jsonb)) as step_count
from public.staff_case_versions v
where v.status in ('in_review', 'changes_requested')
   or (v.status = 'draft' and 'admin_edit' = any(v.tags))
   or v.scheduled_publish_at is not null;

revoke all on public.staff_queue from anon, authenticated;
grant select on public.staff_queue to authenticated;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'public.admin_publish(uuid, int, text)',
    'public.admin_schedule(uuid, int, timestamptz, text)',
    'public.admin_unschedule(uuid, int)',
    'public.admin_request_changes(uuid, int, text)',
    'public.admin_reject(uuid, int, text)',
    'public.admin_archive(uuid, int, text)',
    'public.admin_save_edit(uuid, int, jsonb, text)',
    'public.admin_create_case(text)',
    'public.admin_set_update_cadence(uuid, interval)',
    'public.admin_request_update(uuid)',
    'public.admin_set_seed_profile(uuid, jsonb)',
    'public.admin_step_crowd(uuid, int, text, boolean)',
    'public.admin_final_crowd(uuid, int, boolean)',
    'public.admin_fairness_signals(uuid, int)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
