-- =============================================================================
-- Core: cases, versioned case documents, roles, immutability, row-level security
-- =============================================================================
--
-- Everything about a case lives here as versioned data. The app renders whatever
-- published version it receives; the pipeline writes only draft versions; only
-- an admin action publishes.
--
-- Roles (all signed-in staff use the Postgres role `authenticated`; their job is
-- carried in the JWT's app_metadata, which only the service role can set):
--   anon                      the dive app (no login in v1)
--   authenticated + app_role=admin     the owner, via the admin console
--   authenticated + app_role=pipeline  the agent pipeline worker
--
-- The service role key must never be given to the pipeline. Even so, the
-- publish guard below refuses publishes that do not come from an admin JWT or
-- from a trusted (definer) context.

create schema if not exists app;
revoke all on schema app from public, anon, authenticated;
grant usage on schema app to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Identity helpers
-- -----------------------------------------------------------------------------

create or replace function public.app_role() returns text
language sql stable
set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'app_role', '')
$$;

create or replace function public.is_admin() returns boolean
language sql stable
set search_path = ''
as $$ select public.app_role() = 'admin' $$;

create or replace function public.is_pipeline() returns boolean
language sql stable
set search_path = ''
as $$ select public.app_role() = 'pipeline' $$;

create or replace function public.is_staff() returns boolean
language sql stable
set search_path = ''
as $$ select public.app_role() in ('admin', 'pipeline') $$;

/** True inside SECURITY DEFINER functions, cron jobs and migrations; false for API callers. */
create or replace function app.is_trusted_context() returns boolean
language sql stable
set search_path = ''
as $$ select current_user not in ('anon', 'authenticated', 'service_role', 'authenticator') $$;

/** Who did it, for decision logs. */
create or replace function app.actor() returns text
language sql stable
set search_path = ''
as $$
  select coalesce(
    nullif(auth.jwt() ->> 'email', ''),
    case when public.app_role() <> '' then public.app_role() || ':' || coalesce(auth.uid()::text, '?') end,
    'system:' || current_user
  )
$$;

-- -----------------------------------------------------------------------------
-- Settings (salt for hashing device ids and IPs)
-- -----------------------------------------------------------------------------

create table app.settings (
  key text primary key,
  value text not null
);
insert into app.settings (key, value)
values ('hash_salt', encode(extensions.gen_random_bytes(32), 'hex'));

create or replace function app.hash_text(p text) returns text
language sql stable
security definer
set search_path = ''
as $$
  select encode(
    extensions.digest(coalesce(p, '') || (select value from app.settings where key = 'hash_salt'), 'sha256'),
    'hex'
  )
$$;
revoke all on function app.hash_text(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Statuses
-- -----------------------------------------------------------------------------

create type public.case_status as enum (
  'draft', 'in_review', 'changes_requested', 'rejected', 'published', 'archived'
);

create type public.version_origin as enum ('pipeline', 'admin', 'import');

-- -----------------------------------------------------------------------------
-- Cases
-- -----------------------------------------------------------------------------

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  -- The published version users currently get. Null until first publish.
  live_version int,
  -- v1 shows one featured live case; the column keeps room for more.
  featured boolean not null default true,
  -- Re-research cadence for live updates (null = off). Set by the admin.
  update_cadence interval check (update_cadence is null or update_cadence >= interval '1 hour'),
  next_update_at timestamptz,
  -- Admin-written seed profile (validated by @sia/case-schema SeedProfile).
  seed_profile jsonb,
  -- A side whose "unfair" share reaches this (with enough ratings) sends the case back into review.
  fairness_unfair_threshold numeric not null default 0.4 check (fairness_unfair_threshold > 0 and fairness_unfair_threshold <= 1),
  fairness_min_ratings int not null default 30 check (fairness_min_ratings >= 1),
  created_at timestamptz not null default now(),
  created_by text not null default app.actor()
);

comment on column public.cases.live_version is 'Published version served to users. Moves only when an admin publishes.';

-- -----------------------------------------------------------------------------
-- Case versions
-- -----------------------------------------------------------------------------

/**
 * Client-facing projection of a case document: drops review, status and the
 * admin-only step/fact fields. Mirrors toPublicCase() in @sia/case-schema.
 */
create or replace function public.case_public_projection(doc jsonb) returns jsonb
language sql immutable parallel safe
set search_path = ''
as $$
  select (doc - 'review' - 'status')
    || jsonb_build_object(
      'steps', coalesce(
        (select jsonb_agg(s - 'favors' - 'impact' - 'evidence' order by ord)
           from jsonb_array_elements(case when jsonb_typeof(doc -> 'steps') = 'array' then doc -> 'steps' else '[]'::jsonb end)
                with ordinality as t(s, ord)),
        '[]'::jsonb),
      'starting_facts', coalesce(
        (select jsonb_agg(f - 'evidence' order by ord)
           from jsonb_array_elements(case when jsonb_typeof(doc -> 'starting_facts') = 'array' then doc -> 'starting_facts' else '[]'::jsonb end)
                with ordinality as t(f, ord)),
        '[]'::jsonb)
    )
$$;

create table public.case_versions (
  case_id uuid not null references public.cases (id) on delete restrict,
  version int not null check (version >= 1),
  status public.case_status not null default 'draft',
  origin public.version_origin not null,
  -- The live version this revision updates (mirrors doc.parent_version).
  parent_version int,
  -- The version this one was derived from (an admin edit or a revision round).
  based_on_version int,
  -- e.g. {admin_edit}, {revision}, {update}
  tags text[] not null default '{}',
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  public_doc jsonb generated always as (public.case_public_projection(doc)) stored,
  title text generated always as (doc ->> 'title') stored,
  as_of text generated always as (doc ->> 'as_of') stored,
  pipeline_job_id uuid,
  created_at timestamptz not null default now(),
  created_by text not null default app.actor(),
  submitted_at timestamptz,
  published_at timestamptz,
  published_by text,
  scheduled_publish_at timestamptz,
  primary key (case_id, version),
  check (parent_version is null or parent_version < version),
  check (based_on_version is null or based_on_version < version)
);

create index case_versions_status_idx on public.case_versions (status);
create index case_versions_scheduled_idx on public.case_versions (scheduled_publish_at)
  where scheduled_publish_at is not null;

alter table public.cases
  add constraint cases_live_version_fk
  foreign key (id, live_version) references public.case_versions (case_id, version)
  deferrable initially deferred;

-- -----------------------------------------------------------------------------
-- Review decisions (append-only audit log; also mirrored into doc.review.decisions
-- while a version is still mutable)
-- -----------------------------------------------------------------------------

create table public.review_decisions (
  id bigint generated always as identity primary key,
  case_id uuid not null,
  version int not null,
  action text not null check (action in (
    'submitted', 'approve_publish', 'approve_schedule', 'request_changes', 'admin_edit',
    'reject', 'archive', 'superseded', 'scheduled_publish'
  )),
  actor text not null default app.actor(),
  at timestamptz not null default now(),
  notes text check (length(notes) <= 8000),
  scheduled_for timestamptz,
  foreign key (case_id, version) references public.case_versions (case_id, version)
);
create index review_decisions_case_idx on public.review_decisions (case_id, version);

-- -----------------------------------------------------------------------------
-- Structural publish check (defense in depth; the admin console also runs the
-- full Zod validator and refuses to publish on any schema error)
-- -----------------------------------------------------------------------------

create or replace function app.case_doc_problems(doc jsonb) returns text[]
language plpgsql immutable
set search_path = ''
as $$
declare
  problems text[] := '{}';
  source_ids text[];
  item jsonb;
  ids jsonb;
  sid text;
  i int := 0;
begin
  if jsonb_typeof(doc -> 'sources') <> 'array' or jsonb_array_length(doc -> 'sources') = 0 then
    problems := problems || 'case has no sources';
    source_ids := '{}';
  else
    select coalesce(array_agg(s ->> 'id'), '{}') into source_ids from jsonb_array_elements(doc -> 'sources') s;
  end if;

  if jsonb_typeof(doc -> 'steps') <> 'array' or jsonb_array_length(doc -> 'steps') = 0 then
    problems := problems || 'case has no steps';
  else
    for item in select value from jsonb_array_elements(doc -> 'steps') loop
      i := i + 1;
      ids := item -> 'source_ids';
      if jsonb_typeof(ids) <> 'array' or jsonb_array_length(ids) = 0 then
        problems := problems || format('step %s (%s) has zero sources', i, coalesce(item ->> 'id', '?'));
      else
        for sid in select jsonb_array_elements_text(ids) loop
          if not sid = any(source_ids) then
            problems := problems || format('step %s (%s) cites unknown source %s', i, coalesce(item ->> 'id', '?'), sid);
          end if;
        end loop;
      end if;
      if (item ->> 'order')::int is distinct from i then
        problems := problems || format('step %s has order %s', i, item ->> 'order');
      end if;
    end loop;
  end if;

  if jsonb_typeof(doc -> 'starting_facts') <> 'array' or jsonb_array_length(doc -> 'starting_facts') = 0 then
    problems := problems || 'case has no starting facts';
  else
    for item in select value from jsonb_array_elements(doc -> 'starting_facts') loop
      ids := item -> 'source_ids';
      if jsonb_typeof(ids) <> 'array' or jsonb_array_length(ids) = 0 then
        problems := problems || format('starting fact %s has zero sources', coalesce(item ->> 'id', '?'));
      else
        for sid in select jsonb_array_elements_text(ids) loop
          if not sid = any(source_ids) then
            problems := problems || format('starting fact %s cites unknown source %s', coalesce(item ->> 'id', '?'), sid);
          end if;
        end loop;
      end if;
    end loop;
  end if;

  if jsonb_typeof(doc -> 'sides') <> 'array' or jsonb_array_length(doc -> 'sides') < 2 then
    problems := problems || 'case needs at least two sides';
  end if;
  if coalesce(doc #>> '{question,prompt}', '') = '' then
    problems := problems || 'case has no question';
  end if;
  return problems;
end;
$$;

-- -----------------------------------------------------------------------------
-- Version allocation (definer, so it sees every version regardless of caller)
-- -----------------------------------------------------------------------------

create or replace function app.next_version(p_case_id uuid) returns int
language plpgsql volatile
security definer
set search_path = ''
as $$
declare v int;
begin
  perform pg_advisory_xact_lock(hashtextextended('case_versions:' || p_case_id::text, 0));
  select coalesce(max(version), 0) + 1 into v from public.case_versions where case_id = p_case_id;
  return v;
end;
$$;
revoke all on function app.next_version(uuid) from public, anon;
grant execute on function app.next_version(uuid) to authenticated;

create or replace function app.case_slug(p_case_id uuid) returns text
language sql stable
security definer
set search_path = ''
as $$ select slug from public.cases where id = p_case_id $$;
revoke all on function app.case_slug(uuid) from public, anon;
grant execute on function app.case_slug(uuid) to authenticated;

create or replace function app.case_live_version(p_case_id uuid) returns int
language sql stable
security definer
set search_path = ''
as $$ select live_version from public.cases where id = p_case_id $$;
revoke all on function app.case_live_version(uuid) from public, anon;
grant execute on function app.case_live_version(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Status transitions
-- -----------------------------------------------------------------------------

create or replace function app.transition_allowed(old_status public.case_status, new_status public.case_status)
returns boolean
language sql immutable
set search_path = ''
as $$
  select old_status = new_status and old_status not in ('published', 'rejected', 'archived')
      or (old_status, new_status) in (
        ('draft', 'in_review'),
        ('draft', 'published'),
        ('draft', 'rejected'),
        ('draft', 'archived'),
        ('in_review', 'changes_requested'),
        ('in_review', 'rejected'),
        ('in_review', 'published'),
        ('in_review', 'archived'),
        ('changes_requested', 'in_review'),
        ('changes_requested', 'archived'),
        ('changes_requested', 'rejected'),
        ('published', 'archived')
      )
$$;

-- -----------------------------------------------------------------------------
-- Guard trigger: immutability, transitions, publish rules, doc sync
-- -----------------------------------------------------------------------------

create or replace function app.case_versions_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  problems text[];
  live int;
begin
  if tg_op = 'DELETE' then
    if old.status = 'published' then
      raise exception 'published versions are immutable and cannot be deleted'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Version numbers are always allocated here, never chosen by the caller.
    new.version := app.next_version(new.case_id);
    if new.status = 'published' then
      raise exception 'a version cannot be inserted as published; publish it with an admin action'
        using errcode = 'insufficient_privilege';
    end if;
  else
    -- UPDATE
    if new.case_id <> old.case_id or new.version <> old.version or new.origin <> old.origin
       or new.created_at <> old.created_at then
      raise exception 'case_id, version, origin and created_at never change'
        using errcode = 'check_violation';
    end if;

    if old.status = 'published' then
      -- The only change allowed to a published version is retiring it.
      if new.status <> 'archived'
         or (new.doc - 'status') is distinct from (old.doc - 'status')
         or new.tags is distinct from old.tags
         or new.parent_version is distinct from old.parent_version
         or new.based_on_version is distinct from old.based_on_version
         or new.published_at is distinct from old.published_at then
        raise exception 'published version %/% is immutable; edits create a new version', old.case_id, old.version
          using errcode = 'check_violation';
      end if;
      if not (public.is_admin() or app.is_trusted_context()) then
        raise exception 'only an admin can archive a published version'
          using errcode = 'insufficient_privilege';
      end if;
    elsif old.status in ('rejected', 'archived') then
      raise exception 'version %/% is %, which is final', old.case_id, old.version, old.status
        using errcode = 'check_violation';
    end if;

    if not app.transition_allowed(old.status, new.status) then
      raise exception 'status change % -> % is not allowed', old.status, new.status
        using errcode = 'check_violation';
    end if;

    if new.status = 'published' and old.status <> 'published' then
      if not (public.is_admin() or app.is_trusted_context()) then
        raise exception 'only an admin action can publish a case version'
          using errcode = 'insufficient_privilege';
      end if;
      problems := app.case_doc_problems(new.doc);
      if cardinality(problems) > 0 then
        raise exception 'version is not publishable: %', array_to_string(problems, '; ')
          using errcode = 'check_violation';
      end if;
      live := app.case_live_version(new.case_id);
      if (new.doc ->> 'parent_version')::int is distinct from live then
        raise exception 'stale revision: it updates version % but the live version is %',
          coalesce(new.doc ->> 'parent_version', 'none'), coalesce(live::text, 'none')
          using errcode = 'check_violation';
      end if;
      new.published_at := now();
      new.published_by := app.actor();
      new.scheduled_publish_at := null;
    end if;
  end if;

  -- Keep the document's identity fields in sync with the row.
  new.doc := new.doc || jsonb_build_object(
    'id', new.case_id::text,
    'slug', app.case_slug(new.case_id),
    'version', new.version,
    'status', new.status::text
  );
  new.parent_version := (new.doc ->> 'parent_version')::int;
  if new.status = 'in_review' and new.submitted_at is null then
    new.submitted_at := now();
  end if;
  return new;
end;
$$;

create trigger case_versions_guard
  before insert or update or delete on public.case_versions
  for each row execute function app.case_versions_guard();

-- After publish: move the live pointer (definer, so it works for the cron job and admin alike).
create or replace function app.case_versions_after_publish() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published' and old.status <> 'published' then
    update public.cases set live_version = new.version where id = new.case_id;
  elsif new.status = 'archived' and old.status = 'published' then
    update public.cases set live_version = null
      where id = new.case_id and live_version = new.version;
  end if;
  return null;
end;
$$;

create trigger case_versions_after_publish
  after update of status on public.case_versions
  for each row execute function app.case_versions_after_publish();

-- Cases: the live pointer moves only through the publish trigger.
create or replace function app.cases_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id then
    raise exception 'case id never changes' using errcode = 'check_violation';
  end if;
  if new.slug <> old.slug and old.live_version is not null then
    raise exception 'slug of a live case cannot change (deep links depend on it)' using errcode = 'check_violation';
  end if;
  if new.live_version is distinct from old.live_version and not app.is_trusted_context() then
    raise exception 'live_version moves only when a version is published or archived'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger cases_guard
  before update on public.cases
  for each row execute function app.cases_guard();

-- Review decisions are append-only.
create or replace function app.append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'check_violation';
end;
$$;

create trigger review_decisions_append_only
  before update or delete on public.review_decisions
  for each row execute function app.append_only();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------

alter table public.cases enable row level security;
alter table public.case_versions enable row level security;
alter table public.review_decisions enable row level security;

-- Privileges. The public may only ever read the projected document, never `doc`.
revoke all on public.cases, public.case_versions, public.review_decisions from anon, authenticated;

grant select (id, slug, live_version, featured, created_at) on public.cases to anon, authenticated;
grant select (case_id, version, status, parent_version, public_doc, title, as_of, published_at)
  on public.case_versions to anon, authenticated;

-- Staff write through these column privileges, filtered by the policies below.
grant insert (slug, featured) on public.cases to authenticated;
grant update (slug, featured, update_cadence, next_update_at, seed_profile,
              fairness_unfair_threshold, fairness_min_ratings) on public.cases to authenticated;
grant insert (case_id, status, origin, based_on_version, tags, doc, pipeline_job_id, scheduled_publish_at)
  on public.case_versions to authenticated;
grant update (status, tags, doc, scheduled_publish_at, based_on_version)
  on public.case_versions to authenticated;
grant delete on public.case_versions to authenticated;
grant insert (case_id, version, action, notes, scheduled_for) on public.review_decisions to authenticated;

-- cases ---------------------------------------------------------------------
create policy cases_public_read on public.cases
  for select to anon, authenticated
  using (live_version is not null);

create policy cases_staff_read on public.cases
  for select to authenticated
  using (public.is_staff());

create policy cases_staff_insert on public.cases
  for insert to authenticated
  with check (public.is_staff());

create policy cases_admin_update on public.cases
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- case_versions ---------------------------------------------------------------
-- The public client can read published versions only.
create policy versions_public_read_published on public.case_versions
  for select to anon, authenticated
  using (status = 'published');

create policy versions_staff_read on public.case_versions
  for select to authenticated
  using (public.is_staff());

-- The pipeline writes drafts and submits them for review. It can never publish.
create policy versions_pipeline_insert on public.case_versions
  for insert to authenticated
  with check (
    public.is_pipeline()
    and origin in ('pipeline', 'import')
    and status in ('draft', 'in_review')
  );

create policy versions_pipeline_update on public.case_versions
  for update to authenticated
  using (public.is_pipeline() and origin in ('pipeline', 'import') and status = 'draft')
  with check (public.is_pipeline() and status in ('draft', 'in_review'));

-- The admin creates edit drafts and imports, and moves versions through review.
create policy versions_admin_insert on public.case_versions
  for insert to authenticated
  with check (public.is_admin() and status in ('draft', 'in_review'));

create policy versions_admin_update on public.case_versions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy versions_admin_delete_drafts on public.case_versions
  for delete to authenticated
  using (public.is_admin() and status = 'draft');

-- review_decisions --------------------------------------------------------------
create policy decisions_staff_read on public.review_decisions
  for select to authenticated
  using (public.is_staff());

create policy decisions_admin_insert on public.review_decisions
  for insert to authenticated
  with check (public.is_admin() or (public.is_pipeline() and action = 'submitted'));

-- -----------------------------------------------------------------------------
-- Staff read access to full documents.
-- The public role cannot read `doc` (column privileges), so staff read full
-- documents through this view, which only returns rows to staff.
-- -----------------------------------------------------------------------------

create view public.staff_case_versions
with (security_barrier = true)
as
select v.case_id, c.slug, v.version, v.status, v.origin, v.parent_version, v.based_on_version,
       v.tags, v.doc, v.title, v.as_of, v.pipeline_job_id, v.created_at, v.created_by,
       v.submitted_at, v.published_at, v.published_by, v.scheduled_publish_at,
       (c.live_version = v.version) as is_live, c.live_version
from public.case_versions v
join public.cases c on c.id = v.case_id
where public.is_staff();

revoke all on public.staff_case_versions from anon, authenticated;
grant select on public.staff_case_versions to authenticated;

create view public.staff_cases
with (security_barrier = true)
as
select c.*,
       (select count(*) from public.case_versions v where v.case_id = c.id and v.status = 'in_review') as in_review_count
from public.cases c
where public.is_staff();

revoke all on public.staff_cases from anon, authenticated;
grant select on public.staff_cases to authenticated;

-- -----------------------------------------------------------------------------
-- Public read API
-- -----------------------------------------------------------------------------

/** Featured live cases for the home screen. Runs as the caller, so RLS applies. */
create or replace function public.list_live_cases()
returns table (case_id uuid, slug text, version int, title text, as_of text, published_at timestamptz,
               content_warning text, step_count int)
language sql stable
security invoker
set search_path = ''
as $$
  select c.id, c.slug, v.version, v.title, v.as_of, v.published_at,
         v.public_doc ->> 'content_warning',
         jsonb_array_length(v.public_doc -> 'steps')
  from public.cases c
  join public.case_versions v on v.case_id = c.id and v.version = c.live_version
  where c.featured and v.status = 'published'
  order by v.published_at desc
$$;

/**
 * A published case by slug: the live version, or a specific published version.
 * Runs as the caller, so RLS guarantees only published versions come back.
 */
create or replace function public.get_published_case(p_slug text, p_version int default null)
returns table (case_id uuid, slug text, version int, published_at timestamptz, doc jsonb, is_live boolean)
language sql stable
security invoker
set search_path = ''
as $$
  select c.id, c.slug, v.version, v.published_at, v.public_doc, v.version = c.live_version
  from public.cases c
  join public.case_versions v on v.case_id = c.id
  where c.slug = p_slug
    and v.status = 'published'
    and v.version = coalesce(p_version, c.live_version)
$$;

grant execute on function public.list_live_cases() to anon, authenticated;
grant execute on function public.get_published_case(text, int) to anon, authenticated;
grant execute on function public.case_public_projection(jsonb) to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_pipeline() to anon, authenticated;
grant execute on function public.is_staff() to anon, authenticated;
grant execute on function public.app_role() to anon, authenticated;
