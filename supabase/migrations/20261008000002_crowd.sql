-- =============================================================================
-- Crowd: sessions, responses, seeded data, aggregates, abuse floor, user signals
-- =============================================================================
--
-- The crowd numbers are the product, so real and seeded responses are kept
-- apart from the start (`is_seed`), every aggregate takes an `include_seed`
-- flag, and aggregates are always computed per case version.
--
-- The dive app never reads these tables. It calls the RPCs at the bottom, and
-- the only way to get a step's crowd result is to commit an answer for it.

-- -----------------------------------------------------------------------------
-- Tunables (rate limits and reading-time floor)
-- -----------------------------------------------------------------------------

insert into app.settings (key, value) values
  ('rate.sessions_per_hour', '30'),
  ('rate.responses_per_minute', '120'),
  ('rate.signals_per_hour', '60'),
  -- Reading-time floor: anything faster than this many words per second is not reading.
  ('floor.words_per_second', '15'),
  ('floor.min_step_seconds', '1.5'),
  ('flags.alert_min', '20');

create or replace function app.setting_num(p_key text, p_default numeric) returns numeric
language sql stable
security definer
set search_path = ''
as $$ select coalesce((select value::numeric from app.settings where key = p_key), p_default) $$;

-- -----------------------------------------------------------------------------
-- Sessions and responses
-- -----------------------------------------------------------------------------

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  case_version int not null,
  -- Salted hash of the device id: one session per device per case version.
  device_hash text not null,
  ip_hash text,
  is_seed boolean not null default false,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Dropped from aggregates (e.g. finished faster than the reading-time floor).
  excluded boolean not null default false,
  excluded_reason text,
  -- Room for verified-human accounts later: a session gets linked to a person, no schema rewrite.
  person_id uuid,
  foreign key (case_id, case_version) references public.case_versions (case_id, version),
  unique (device_hash, case_id, case_version)
);
create index sessions_version_idx on public.sessions (case_id, case_version) where not is_seed;

create table public.responses (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  case_id uuid not null,
  case_version int not null,
  -- 'before', 'after' or a step id
  step_id text not null,
  -- 0 = before, 1..n = steps in order, n+1 = after
  step_index int not null check (step_index >= 0),
  value smallint not null check (value between 0 and 100),
  is_seed boolean not null default false,
  excluded boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (case_id, case_version) references public.case_versions (case_id, version),
  -- An answer is locked once committed.
  unique (session_id, step_id),
  unique (session_id, step_index)
);
create index responses_step_idx on public.responses (case_id, case_version, step_id);

-- Responses never change once written (seed regeneration deletes whole seed sessions).
create or replace function app.responses_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'responses are locked once committed' using errcode = 'check_violation';
  end if;
  if not old.is_seed and not app.is_trusted_context() then
    raise exception 'real responses cannot be deleted' using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

create trigger responses_immutable
  before update or delete on public.responses
  for each row execute function app.responses_immutable();

-- -----------------------------------------------------------------------------
-- User signals: fact flags, fairness ratings, and the alerts they raise
-- -----------------------------------------------------------------------------

create table public.fact_flags (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  case_id uuid not null,
  case_version int not null,
  step_id text not null,
  reason text not null check (reason in ('unfair', 'cherry_picked', 'inaccurate', 'other')),
  note text check (length(note) <= 1000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  foreign key (case_id, case_version) references public.case_versions (case_id, version),
  unique (session_id, step_id)
);
create index fact_flags_version_idx on public.fact_flags (case_id, case_version, step_id);

create table public.fairness_ratings (
  id bigint generated always as identity primary key,
  session_id uuid not null unique references public.sessions (id) on delete cascade,
  case_id uuid not null,
  case_version int not null,
  side_id text not null,
  rating text not null check (rating in ('fair', 'somewhat_fair', 'unfair')),
  created_at timestamptz not null default now(),
  foreign key (case_id, case_version) references public.case_versions (case_id, version)
);
create index fairness_version_idx on public.fairness_ratings (case_id, case_version, side_id);

create table public.review_alerts (
  id bigint generated always as identity primary key,
  case_id uuid not null references public.cases (id),
  case_version int not null,
  kind text not null check (kind in ('fairness', 'flags')),
  side_id text,
  step_id text,
  details jsonb not null default '{}',
  pipeline_job_id uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution text
);
create unique index review_alerts_open_uniq on public.review_alerts
  (case_id, case_version, kind, coalesce(side_id, ''), coalesce(step_id, ''))
  where resolved_at is null;

-- -----------------------------------------------------------------------------
-- RLS: none of these tables is readable or writable by the public directly.
-- -----------------------------------------------------------------------------

alter table public.sessions enable row level security;
alter table public.responses enable row level security;
alter table public.fact_flags enable row level security;
alter table public.fairness_ratings enable row level security;
alter table public.review_alerts enable row level security;

revoke all on public.sessions, public.responses, public.fact_flags, public.fairness_ratings, public.review_alerts
  from anon, authenticated;

grant select on public.sessions, public.responses, public.fact_flags, public.fairness_ratings, public.review_alerts
  to authenticated;
grant update (resolved_at, resolved_by) on public.fact_flags to authenticated;
grant update (resolved_at, resolved_by, resolution) on public.review_alerts to authenticated;

create policy sessions_admin_read on public.sessions for select to authenticated using (public.is_admin());
create policy responses_admin_read on public.responses for select to authenticated using (public.is_admin());
create policy flags_admin_read on public.fact_flags for select to authenticated using (public.is_admin());
create policy flags_admin_resolve on public.fact_flags for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy fairness_admin_read on public.fairness_ratings for select to authenticated using (public.is_admin());
create policy alerts_staff_read on public.review_alerts for select to authenticated using (public.is_staff());
create policy alerts_admin_resolve on public.review_alerts for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- -----------------------------------------------------------------------------
-- Request context: IP hash and rate limits
-- -----------------------------------------------------------------------------

create or replace function app.request_ip_hash() returns text
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  headers json := nullif(current_setting('request.headers', true), '')::json;
  ip text;
begin
  ip := coalesce(
    nullif(trim(split_part(headers ->> 'x-forwarded-for', ',', 1)), ''),
    nullif(headers ->> 'cf-connecting-ip', ''),
    nullif(headers ->> 'x-real-ip', '')
  );
  return case when ip is null then null else app.hash_text('ip:' || ip) end;
end;
$$;

create table app.rate_counters (
  bucket text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (bucket, window_start)
);

/** Counts a hit and returns true when the bucket is over its limit for the current window. */
create or replace function app.rate_limited(p_bucket text, p_window interval, p_max numeric) returns boolean
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / extract(epoch from p_window)) * extract(epoch from p_window));
  n int;
begin
  insert into app.rate_counters as rc (bucket, window_start, hits) values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update set hits = rc.hits + 1
  returning hits into n;
  -- Opportunistic cleanup of old windows.
  if random() < 0.01 then
    delete from app.rate_counters where window_start < now() - interval '1 day';
  end if;
  return n > p_max;
end;
$$;

-- -----------------------------------------------------------------------------
-- Version structure helpers
-- -----------------------------------------------------------------------------

create or replace function app.word_count(p text) returns int
language sql immutable
set search_path = ''
as $$ select coalesce(array_length(regexp_split_to_array(nullif(trim(coalesce(p, '')), ''), '\s+'), 1), 0) $$;

/** Ordered answer slots of a version: before (0), each step (1..n), after (n+1), with word counts. */
create or replace function app.version_slots(p_case_id uuid, p_version int)
returns table (step_id text, step_index int, words int)
language sql stable
security definer
set search_path = ''
as $$
  with v as (
    select doc from public.case_versions where case_id = p_case_id and version = p_version
  ),
  steps as (
    select s ->> 'id' as step_id, ord::int as step_index,
           app.word_count(s ->> 'headline') + app.word_count(s ->> 'body') as words
    from v, jsonb_array_elements(v.doc -> 'steps') with ordinality as t(s, ord)
  ),
  facts as (
    select coalesce(sum(app.word_count(f ->> 'text')), 0)::int + app.word_count(v.doc #>> '{question,prompt}') as words
    from v left join lateral jsonb_array_elements(v.doc -> 'starting_facts') f on true
    group by v.doc
  )
  select 'before', 0, (select words from facts)
  union all
  select step_id, step_index, words from steps
  union all
  select 'after', (select count(*)::int + 1 from steps), 0
$$;

create or replace function app.version_is_published(p_case_id uuid, p_version int) returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.case_versions
                 where case_id = p_case_id and version = p_version and status = 'published')
$$;

-- -----------------------------------------------------------------------------
-- Seeds
-- -----------------------------------------------------------------------------

/** Mirrors seedWeight() in @sia/case-schema: 1 with no real completions, 0 at the admin's threshold. */
create or replace function public.seed_weight(p_real_completions bigint, p_threshold int) returns numeric
language sql immutable
set search_path = ''
as $$
  select case when coalesce(p_threshold, 0) <= 0 then 0
              else greatest(0, 1 - p_real_completions::numeric / p_threshold) end
$$;

create or replace function app.real_completions(p_case_id uuid, p_version int) returns bigint
language sql stable
security definer
set search_path = ''
as $$
  select count(*) from public.sessions
  where case_id = p_case_id and case_version = p_version
    and not is_seed and not excluded and completed_at is not null
$$;

create or replace function app.seed_weight_for(p_case_id uuid, p_version int, p_include_seed boolean) returns numeric
language sql stable
security definer
set search_path = ''
as $$
  select case when not coalesce(p_include_seed, true) then 0
    else public.seed_weight(
      app.real_completions(p_case_id, p_version),
      coalesce((select (seed_profile ->> 'fade_after_real_completions')::int from public.cases where id = p_case_id), 500))
  end
$$;

create or replace function app.clamp_slider(x double precision) returns smallint
language sql immutable
set search_path = ''
as $$ select greatest(0, least(100, round(x)))::smallint $$;

create or replace function app.seed_shift(p_value smallint, p_shift jsonb) returns smallint
language plpgsql volatile
set search_path = ''
as $$
declare u numeric; v numeric;
begin
  if p_shift is null or jsonb_typeof(p_shift) <> 'object' then return p_value; end if;
  if random() >= coalesce((p_shift ->> 'move_share')::numeric, 0) then return p_value; end if;
  u := greatest(random(), 1e-12);
  v := random();
  return app.clamp_slider(p_value + coalesce((p_shift ->> 'mean_shift')::numeric, 0)
                          + sqrt(-2 * ln(u)) * cos(2 * pi() * v) * coalesce((p_shift ->> 'spread')::numeric, 0));
end;
$$;

/**
 * (Re)generates the seeded sessions for a published version from the case's
 * seed profile. Seeded rows carry is_seed = true and never mix with real rows.
 */
create or replace function app.generate_seed_responses(p_case_id uuid, p_version int) returns int
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  profile jsonb;
  bins numeric[];
  total numeric;
  n int;
  i int;
  b int;
  r numeric;
  val smallint;
  sess uuid;
  slot record;
  at timestamptz;
begin
  select seed_profile into profile from public.cases where id = p_case_id;
  delete from public.sessions where case_id = p_case_id and case_version = p_version and is_seed;
  if profile is null or not app.version_is_published(p_case_id, p_version) then
    return 0;
  end if;

  n := least(coalesce((profile ->> 'sessions')::int, 0), 5000);
  select array_agg(x::numeric order by ord) into bins
    from jsonb_array_elements_text(profile -> 'before_bins') with ordinality as t(x, ord);
  total := coalesce((select sum(x) from unnest(bins) x), 0);
  if n <= 0 or total <= 0 then return 0; end if;

  perform setseed(((coalesce((profile ->> 'rng_seed')::bigint, 1) % 1999) - 999) / 1000.0);
  select published_at into at from public.case_versions where case_id = p_case_id and version = p_version;

  for i in 1..n loop
    insert into public.sessions (case_id, case_version, device_hash, is_seed, started_at, completed_at)
    values (p_case_id, p_version, 'seed:' || i, true, at, at)
    returning id into sess;

    -- Before: pick a bin by weight, then a value inside it.
    r := random() * total;
    b := 1;
    while b < 10 and r > bins[b] loop
      r := r - bins[b];
      b := b + 1;
    end loop;
    val := app.clamp_slider((b - 1) * 10 + random() * (case when b = 10 then 10 else 9 end));

    for slot in select * from app.version_slots(p_case_id, p_version) order by step_index loop
      if slot.step_id = 'before' then
        null;
      elsif slot.step_id = 'after' then
        val := app.seed_shift(val, profile -> 'after');
      else
        val := app.seed_shift(val, profile -> 'steps' -> slot.step_id);
      end if;
      insert into public.responses (session_id, case_id, case_version, step_id, step_index, value, is_seed, created_at)
      values (sess, p_case_id, p_version, slot.step_id, slot.step_index, val, true, at);
    end loop;
  end loop;
  return n;
end;
$$;

-- Generate seeds whenever a version is published (extends the core publish trigger).
create or replace function app.case_versions_after_publish() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published' and old.status <> 'published' then
    update public.cases set live_version = new.version where id = new.case_id;
    perform app.generate_seed_responses(new.case_id, new.version);
  elsif new.status = 'archived' and old.status = 'published' then
    update public.cases set live_version = null
      where id = new.case_id and live_version = new.version;
  end if;
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Aggregates (all per case version, all honoring include_seed)
-- -----------------------------------------------------------------------------

create or replace function app.histogram(p_values numeric[], p_weights numeric[]) returns jsonb
language sql immutable
set search_path = ''
as $$
  with v as (
    select least(floor(x / 10), 9)::int as bin, w
    from unnest(p_values, p_weights) as t(x, w)
  ),
  tot as (select nullif(sum(w), 0) as t from v)
  select jsonb_agg(coalesce(round((select sum(w) from v where v.bin = b) / (select t from tot), 4), 0) order by b)
  from generate_series(0, 9) b
$$;

/**
 * Crowd result for one step: how everyone who reached this step moved.
 * Movement is measured against each session's previous answer.
 */
create or replace function app.step_crowd(p_case_id uuid, p_version int, p_step_id text, p_include_seed boolean default true)
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  with w as (select app.seed_weight_for(p_case_id, p_version, p_include_seed) as w),
  rows as (
    select r.value::numeric as value, p.value::numeric as prev, r.is_seed,
           case when r.is_seed then (select w from w) else 1 end::numeric as wt
    from public.responses r
    join public.sessions s on s.id = r.session_id
    join public.responses p on p.session_id = r.session_id and p.step_index = r.step_index - 1
    where r.case_id = p_case_id and r.case_version = p_version and r.step_id = p_step_id
      and not r.excluded and not s.excluded
  ),
  agg as (
    select count(*) filter (where not is_seed) as n_real,
           count(*) filter (where is_seed) as n_seed,
           sum(wt) as total,
           sum(wt) filter (where is_seed) as seed_total,
           sum(wt * (value - prev)) as sum_delta,
           sum(wt * value) as sum_value,
           sum(wt * prev) as sum_prev,
           sum(wt) filter (where value <> prev) as moved,
           sum(wt) filter (where value - prev <= -15) as left_big,
           sum(wt) filter (where value - prev between -14 and -1) as left_small,
           sum(wt) filter (where value = prev) as none,
           sum(wt) filter (where value - prev between 1 and 14) as right_small,
           sum(wt) filter (where value - prev >= 15) as right_big,
           array_agg(value) as values, array_agg(prev) as prevs, array_agg(wt) as wts
    from rows
  )
  select jsonb_build_object(
    'step_id', p_step_id,
    'n_real', n_real,
    'n_seed', n_seed,
    'seed_weight', round((select w from w), 4),
    'seeded_share', case when coalesce(total, 0) > 0 then round(coalesce(seed_total, 0) / total, 4) else 0 end,
    'histogram', case when coalesce(total, 0) > 0 then app.histogram(values, wts) end,
    'previous_histogram', case when coalesce(total, 0) > 0 then app.histogram(prevs, wts) end,
    'mean_value', case when total > 0 then round(sum_value / total, 2) end,
    'mean_previous', case when total > 0 then round(sum_prev / total, 2) end,
    'mean_delta', case when total > 0 then round(sum_delta / total, 2) end,
    'moved_share', case when total > 0 then round(coalesce(moved, 0) / total, 4) end,
    'shift', case when total > 0 then jsonb_build_object(
      'left_big', round(coalesce(left_big, 0) / total, 4),
      'left', round(coalesce(left_small, 0) / total, 4),
      'none', round(coalesce(none, 0) / total, 4),
      'right', round(coalesce(right_small, 0) / total, 4),
      'right_big', round(coalesce(right_big, 0) / total, 4)) end
  )
  from agg
$$;

/** The crowd's before and after distributions and which step moved it most. */
create or replace function app.final_crowd(p_case_id uuid, p_version int, p_include_seed boolean default true)
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  with w as (select app.seed_weight_for(p_case_id, p_version, p_include_seed) as w),
  done as (
    select s.id, s.is_seed, case when s.is_seed then (select w from w) else 1 end::numeric as wt
    from public.sessions s
    where s.case_id = p_case_id and s.case_version = p_version and not s.excluded
      and exists (select 1 from public.responses a where a.session_id = s.id and a.step_id = 'after' and not a.excluded)
  ),
  ba as (
    select d.wt, d.is_seed,
           (select value from public.responses where session_id = d.id and step_id = 'before')::numeric as before,
           (select value from public.responses where session_id = d.id and step_id = 'after')::numeric as after
    from done d
  ),
  steps as (
    select r.step_id, min(r.step_index) as step_index,
           sum(d.wt * (r.value - p.value)) / nullif(sum(d.wt), 0) as mean_delta,
           sum(d.wt * abs(r.value - p.value)) / nullif(sum(d.wt), 0) as mean_abs_delta,
           sum(d.wt) filter (where r.value <> p.value) / nullif(sum(d.wt), 0) as moved_share
    from done d
    join public.responses r on r.session_id = d.id and r.step_id not in ('before', 'after') and not r.excluded
    join public.responses p on p.session_id = d.id and p.step_index = r.step_index - 1
    group by r.step_id
  )
  select jsonb_build_object(
    'n_real', (select count(*) from ba where not is_seed),
    'n_seed', (select count(*) from ba where is_seed),
    'seed_weight', round((select w from w), 4),
    'seeded_share', coalesce((select round(sum(wt) filter (where is_seed) / nullif(sum(wt), 0), 4) from ba), 0),
    'before_histogram', (select app.histogram(array_agg(before), array_agg(wt)) from ba where before is not null),
    'after_histogram', (select app.histogram(array_agg(after), array_agg(wt)) from ba where after is not null),
    'mean_before', (select round(sum(wt * before) / nullif(sum(wt), 0), 2) from ba),
    'mean_after', (select round(sum(wt * after) / nullif(sum(wt), 0), 2) from ba),
    'steps', coalesce((select jsonb_agg(jsonb_build_object(
                 'step_id', step_id,
                 'mean_delta', round(mean_delta, 2),
                 'mean_abs_delta', round(mean_abs_delta, 2),
                 'moved_share', round(coalesce(moved_share, 0), 4)) order by step_index) from steps), '[]'::jsonb),
    'top_step_id', (select step_id from steps order by mean_abs_delta desc nulls last, step_index limit 1)
  )
$$;

/** "Updated Oct 12; 3,104 people saw the earlier version." */
create or replace function app.version_note(p_case_id uuid, p_version int) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'version', v.version,
    'published_at', v.published_at,
    'parent_version', v.parent_version,
    'earlier_versions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'version', e.version,
               'published_at', e.published_at,
               'completions', app.real_completions(e.case_id, e.version)) order by e.version)
      from public.case_versions e
      where e.case_id = v.case_id and e.version < v.version and e.published_at is not null), '[]'::jsonb)
  )
  from public.case_versions v
  where v.case_id = p_case_id and v.version = p_version
$$;

create or replace function app.session_path(p_session_id uuid) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  with r as (
    select step_id, step_index, value,
           value - lag(value) over (order by step_index) as delta
    from public.responses where session_id = p_session_id
  )
  select jsonb_build_object(
    'answers', coalesce((select jsonb_agg(jsonb_build_object('step_id', step_id, 'value', value) order by step_index) from r), '[]'::jsonb),
    'top_step_id', (select step_id from r where step_id not in ('before', 'after') and delta <> 0
                    order by abs(delta) desc, step_index limit 1)
  )
$$;

create or replace function app.reveal(p_session public.sessions, p_step_id text, p_locked boolean) returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  cur public.responses;
  prev_value smallint;
begin
  select * into cur from public.responses where session_id = p_session.id and step_id = p_step_id;
  select value into prev_value from public.responses
    where session_id = p_session.id and step_index = cur.step_index - 1;
  if p_step_id = 'before' then
    return jsonb_build_object('step_id', p_step_id, 'value', cur.value, 'locked', p_locked);
  elsif p_step_id = 'after' then
    return jsonb_build_object(
      'step_id', p_step_id, 'value', cur.value, 'previous_value', prev_value, 'locked', p_locked,
      'you', app.session_path(p_session.id),
      'crowd', app.final_crowd(p_session.case_id, p_session.case_version, true),
      'version_note', app.version_note(p_session.case_id, p_session.case_version));
  else
    return jsonb_build_object(
      'step_id', p_step_id, 'value', cur.value, 'previous_value', prev_value, 'locked', p_locked,
      'crowd', app.step_crowd(p_session.case_id, p_session.case_version, p_step_id, true),
      'version_note', app.version_note(p_session.case_id, p_session.case_version));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Fairness and flag alerts ("a case where one side rates it unfair goes back into review")
-- -----------------------------------------------------------------------------

create or replace function app.check_fairness(p_case_id uuid, p_version int) returns void
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  c public.cases;
  side record;
  job uuid;
begin
  select * into c from public.cases where id = p_case_id;
  for side in
    select f.side_id, count(*) as n, count(*) filter (where f.rating = 'unfair') as unfair
    from public.fairness_ratings f
    join public.sessions s on s.id = f.session_id and not s.excluded
    where f.case_id = p_case_id and f.case_version = p_version
    group by f.side_id
  loop
    if side.n >= c.fairness_min_ratings and side.unfair::numeric / side.n >= c.fairness_unfair_threshold
       and not exists (select 1 from public.review_alerts a
                       where a.case_id = p_case_id and a.case_version = p_version and a.kind = 'fairness'
                         and a.side_id = side.side_id and a.resolved_at is null) then
      insert into public.pipeline_jobs (kind, case_id, base_version, instructions, created_by)
      values ('revision', p_case_id, p_version,
              format('Fairness review: %s of %s readers on side "%s" rated this dive unfair. '
                     'Re-check balance, wording and missing facts for that side.',
                     side.unfair, side.n, side.side_id),
              'system:fairness')
      returning id into job;
      insert into public.review_alerts (case_id, case_version, kind, side_id, details, pipeline_job_id)
      values (p_case_id, p_version, 'fairness', side.side_id,
              jsonb_build_object('ratings', side.n, 'unfair', side.unfair,
                                 'threshold', c.fairness_unfair_threshold), job);
    end if;
  end loop;
end;
$$;

create or replace function app.check_flags(p_case_id uuid, p_version int, p_step_id text) returns void
language plpgsql volatile
security definer
set search_path = ''
as $$
declare n int;
begin
  select count(*) into n from public.fact_flags
    where case_id = p_case_id and case_version = p_version and step_id = p_step_id and resolved_at is null;
  if n >= app.setting_num('flags.alert_min', 20) then
    insert into public.review_alerts (case_id, case_version, kind, step_id, details)
    values (p_case_id, p_version, 'flags', p_step_id, jsonb_build_object('open_flags', n))
    on conflict do nothing;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Public dive API
-- -----------------------------------------------------------------------------

/**
 * Starts (or resumes) the session for this device on a published version.
 * Returns the answers already locked so the app can resume where it left off.
 */
create or replace function public.start_session(p_case_id uuid, p_version int, p_device_id text)
returns jsonb
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  dev text;
  ip text := app.request_ip_hash();
  sess public.sessions;
  resumed boolean := true;
begin
  if p_device_id is null or length(p_device_id) < 16 or length(p_device_id) > 200 then
    raise exception 'invalid device id' using errcode = '22023';
  end if;
  if not app.version_is_published(p_case_id, p_version) then
    raise exception 'case version is not published' using errcode = 'PT404';
  end if;
  dev := app.hash_text('device:' || p_device_id);
  select * into sess from public.sessions
    where device_hash = dev and case_id = p_case_id and case_version = p_version;
  if not found then
    if app.rate_limited('sessions:' || coalesce(ip, 'none'), interval '1 hour',
                        app.setting_num('rate.sessions_per_hour', 30)) then
      raise exception 'too many new sessions from this network; try again later' using errcode = 'PT429';
    end if;
    insert into public.sessions (case_id, case_version, device_hash, ip_hash)
    values (p_case_id, p_version, dev, ip)
    on conflict (device_hash, case_id, case_version) do nothing;
    select * into sess from public.sessions
      where device_hash = dev and case_id = p_case_id and case_version = p_version;
    resumed := false;
  end if;
  return jsonb_build_object(
    'session_id', sess.id,
    'case_id', sess.case_id,
    'case_version', sess.case_version,
    'resumed', resumed,
    'completed', sess.completed_at is not null,
    'answers', (app.session_path(sess.id)) -> 'answers'
  );
end;
$$;

/**
 * Commits one answer. Answers are locked: a repeat call returns the stored
 * value unchanged. The crowd result for a step is only ever returned here,
 * after the answer is committed, or by get_reveal for an answered step.
 */
create or replace function public.submit_response(p_session_id uuid, p_step_id text, p_value int)
returns jsonb
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  sess public.sessions;
  slot record;
  answered int;
  prev_at timestamptz;
  too_fast boolean := false;
  floor_s numeric;
  wps numeric := app.setting_num('floor.words_per_second', 15);
  total_words int;
  fast_steps int;
  step_count int;
begin
  select * into sess from public.sessions where id = p_session_id and not is_seed;
  if not found then
    raise exception 'unknown session' using errcode = 'PT404';
  end if;
  if not app.version_is_published(sess.case_id, sess.case_version) then
    raise exception 'this case version is no longer published' using errcode = 'PT410';
  end if;
  select * into slot from app.version_slots(sess.case_id, sess.case_version) s where s.step_id = p_step_id;
  if not found then
    raise exception 'unknown step %', p_step_id using errcode = 'PT404';
  end if;

  if exists (select 1 from public.responses where session_id = sess.id and step_id = p_step_id) then
    return app.reveal(sess, p_step_id, true);
  end if;

  if p_value is null or p_value < 0 or p_value > 100 then
    raise exception 'value must be between 0 and 100' using errcode = '22023';
  end if;

  select count(*) into answered from public.responses where session_id = sess.id;
  if answered <> slot.step_index then
    raise exception 'answer the earlier steps first (expected slot %, got %)', answered, slot.step_index
      using errcode = 'PT409';
  end if;

  if app.rate_limited('responses:' || coalesce(sess.ip_hash, app.request_ip_hash(), 'none'), interval '1 minute',
                      app.setting_num('rate.responses_per_minute', 120)) then
    raise exception 'too many answers from this network; slow down' using errcode = 'PT429';
  end if;

  -- Reading-time floor for this slot (time since the previous answer, or since the session started).
  select coalesce(max(created_at), sess.started_at) into prev_at
    from public.responses where session_id = sess.id;
  floor_s := greatest(app.setting_num('floor.min_step_seconds', 1.5), slot.words / nullif(wps, 0));
  if p_step_id <> 'after' and extract(epoch from (now() - prev_at)) < floor_s then
    too_fast := true;
  end if;

  insert into public.responses (session_id, case_id, case_version, step_id, step_index, value, excluded)
  values (sess.id, sess.case_id, sess.case_version, p_step_id, slot.step_index, p_value, too_fast);

  if p_step_id = 'after' then
    select coalesce(sum(words), 0) into total_words from app.version_slots(sess.case_id, sess.case_version);
    select count(*) filter (where excluded), count(*) - 2 into fast_steps, step_count
      from public.responses where session_id = sess.id;
    update public.sessions s
      set completed_at = now(),
          excluded = (extract(epoch from (now() - s.started_at)) < total_words / nullif(wps, 0))
                     or (fast_steps * 2 > greatest(step_count, 1)),
          excluded_reason = case
            when extract(epoch from (now() - s.started_at)) < total_words / nullif(wps, 0) then 'finished faster than the reading-time floor'
            when fast_steps * 2 > greatest(step_count, 1) then 'most steps answered faster than the reading-time floor'
          end
      where s.id = sess.id
      returning * into sess;
  end if;

  return app.reveal(sess, p_step_id, false);
end;
$$;

/** Re-fetches the reveal for an answered step (e.g. after the app restarts). */
create or replace function public.get_reveal(p_session_id uuid, p_step_id text)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare sess public.sessions;
begin
  select * into sess from public.sessions where id = p_session_id and not is_seed;
  if not found then
    raise exception 'unknown session' using errcode = 'PT404';
  end if;
  if not exists (select 1 from public.responses where session_id = sess.id and step_id = p_step_id) then
    raise exception 'commit an answer before seeing the crowd' using errcode = 'PT403';
  end if;
  return app.reveal(sess, p_step_id, true);
end;
$$;

/** Flags a fact as unfair, cherry-picked or inaccurate, with an optional note. */
create or replace function public.flag_fact(p_session_id uuid, p_step_id text, p_reason text, p_note text default null)
returns jsonb
language plpgsql volatile
security definer
set search_path = ''
as $$
declare sess public.sessions;
begin
  select * into sess from public.sessions where id = p_session_id and not is_seed;
  if not found then
    raise exception 'unknown session' using errcode = 'PT404';
  end if;
  if not exists (select 1 from app.version_slots(sess.case_id, sess.case_version) s
                 where s.step_id = p_step_id and s.step_id not in ('before', 'after')) then
    raise exception 'unknown step %', p_step_id using errcode = 'PT404';
  end if;
  if p_reason not in ('unfair', 'cherry_picked', 'inaccurate', 'other') then
    raise exception 'unknown reason' using errcode = '22023';
  end if;
  if app.rate_limited('signals:' || coalesce(sess.ip_hash, app.request_ip_hash(), 'none'), interval '1 hour',
                      app.setting_num('rate.signals_per_hour', 60)) then
    raise exception 'too many flags from this network' using errcode = 'PT429';
  end if;
  insert into public.fact_flags (session_id, case_id, case_version, step_id, reason, note)
  values (sess.id, sess.case_id, sess.case_version, p_step_id, p_reason, nullif(trim(left(p_note, 1000)), ''))
  on conflict (session_id, step_id) do update set reason = excluded.reason, note = excluded.note, created_at = now();
  perform app.check_flags(sess.case_id, sess.case_version, p_step_id);
  return jsonb_build_object('ok', true);
end;
$$;

/** Optional end-of-dive question: "Was this fair to your side?" */
create or replace function public.rate_fairness(p_session_id uuid, p_side_id text, p_rating text)
returns jsonb
language plpgsql volatile
security definer
set search_path = ''
as $$
declare sess public.sessions;
begin
  select * into sess from public.sessions where id = p_session_id and not is_seed;
  if not found then
    raise exception 'unknown session' using errcode = 'PT404';
  end if;
  if sess.completed_at is null then
    raise exception 'finish the dive first' using errcode = 'PT409';
  end if;
  if p_rating not in ('fair', 'somewhat_fair', 'unfair') then
    raise exception 'unknown rating' using errcode = '22023';
  end if;
  if not exists (select 1 from public.case_versions v, jsonb_array_elements(v.doc -> 'sides') s
                 where v.case_id = sess.case_id and v.version = sess.case_version and s ->> 'id' = p_side_id) then
    raise exception 'unknown side %', p_side_id using errcode = 'PT404';
  end if;
  insert into public.fairness_ratings (session_id, case_id, case_version, side_id, rating)
  values (sess.id, sess.case_id, sess.case_version, p_side_id, p_rating)
  on conflict (session_id) do update set side_id = excluded.side_id, rating = excluded.rating, created_at = now();
  perform app.check_fairness(sess.case_id, sess.case_version);
  return jsonb_build_object('ok', true);
end;
$$;

/** Version history for the transparency page. */
create or replace function public.get_case_history(p_slug text)
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'case_id', c.id,
    'slug', c.slug,
    'live_version', c.live_version,
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'version', v.version,
               'title', v.title,
               'as_of', v.as_of,
               'status', v.status,
               'published_at', v.published_at,
               'parent_version', v.parent_version,
               'completions', app.real_completions(v.case_id, v.version)) order by v.version desc)
      from public.case_versions v
      where v.case_id = c.id and v.published_at is not null), '[]'::jsonb)
  )
  from public.cases c
  where c.slug = p_slug and c.live_version is not null
$$;

revoke all on function public.start_session(uuid, int, text) from public;
revoke all on function public.submit_response(uuid, text, int) from public;
revoke all on function public.get_reveal(uuid, text) from public;
revoke all on function public.flag_fact(uuid, text, text, text) from public;
revoke all on function public.rate_fairness(uuid, text, text) from public;
revoke all on function public.get_case_history(text) from public;
grant execute on function public.start_session(uuid, int, text) to anon, authenticated;
grant execute on function public.submit_response(uuid, text, int) to anon, authenticated;
grant execute on function public.get_reveal(uuid, text) to anon, authenticated;
grant execute on function public.flag_fact(uuid, text, text, text) to anon, authenticated;
grant execute on function public.rate_fairness(uuid, text, text) to anon, authenticated;
grant execute on function public.get_case_history(text) to anon, authenticated;

-- Internal helpers are not callable through the API.
revoke all on function app.step_crowd(uuid, int, text, boolean) from public, anon, authenticated;
revoke all on function app.final_crowd(uuid, int, boolean) from public, anon, authenticated;
revoke all on function app.generate_seed_responses(uuid, int) from public, anon, authenticated;
revoke all on function app.check_fairness(uuid, int) from public, anon, authenticated;
revoke all on function app.check_flags(uuid, int, text) from public, anon, authenticated;
revoke all on function app.reveal(public.sessions, text, boolean) from public, anon, authenticated;
revoke all on function app.rate_limited(text, interval, numeric) from public, anon, authenticated;
