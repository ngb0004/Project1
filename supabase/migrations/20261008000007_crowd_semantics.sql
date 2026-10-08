-- =============================================================================
-- Crowd semantics after the phase 1 review (mirrored in @sia/dive-engine/local)
-- =============================================================================
--
-- 1. Seeds fade case-wide: the admin's threshold counts real completions across
--    every version of the case, and a new version published after the case has
--    its real crowd gets no seeds.
-- 2. Seeded rows that carry no weight (faded, or include_seed = false) are not
--    counted at all, so n_seed reflects what the numbers are made of.
-- 3. The final crowd reports null distributions and means when nobody counts,
--    lists every step (nulls where nobody answered), and names the step that
--    moved the crowd most only when somebody moved.

create or replace function app.case_real_completions(p_case_id uuid) returns bigint
language sql stable
security definer
set search_path = ''
as $$
  select count(*) from public.sessions
  where case_id = p_case_id and not is_seed and not excluded and completed_at is not null
$$;

create or replace function app.seed_weight_for(p_case_id uuid, p_version int, p_include_seed boolean) returns numeric
language sql stable
security definer
set search_path = ''
as $$
  select case when not coalesce(p_include_seed, true) then 0
    else public.seed_weight(
      app.case_real_completions(p_case_id),
      coalesce((select case when jsonb_typeof(seed_profile -> 'fade_after_real_completions') = 'number'
                            then greatest(1, floor((seed_profile ->> 'fade_after_real_completions')::numeric))::int end
                from public.cases where id = p_case_id), 500))
  end
$$;

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
      -- seeded rows that carry no weight (faded or left out) are not counted at all
      and (not r.is_seed or (select w from w) > 0)
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
      and (not s.is_seed or (select w from w) > 0)
      and exists (select 1 from public.responses a where a.session_id = s.id and a.step_id = 'after' and not a.excluded)
  ),
  ba as (
    select d.wt, d.is_seed,
           (select value from public.responses where session_id = d.id and step_id = 'before')::numeric as before,
           (select value from public.responses where session_id = d.id and step_id = 'after')::numeric as after
    from done d
  ),
  tot as (select coalesce(sum(wt), 0) as t from ba),
  stats as (
    select r.step_id,
           sum(d.wt * (r.value - p.value)) / nullif(sum(d.wt), 0) as mean_delta,
           sum(d.wt * abs(r.value - p.value)) / nullif(sum(d.wt), 0) as mean_abs_delta,
           sum(d.wt) filter (where r.value <> p.value) / nullif(sum(d.wt), 0) as moved_share
    from done d
    join public.responses r on r.session_id = d.id and r.step_id not in ('before', 'after') and not r.excluded
    join public.responses p on p.session_id = d.id and p.step_index = r.step_index - 1
    group by r.step_id
  ),
  steps as (
    select sl.step_id, sl.step_index, st.mean_delta, st.mean_abs_delta, st.moved_share
    from app.version_slots(p_case_id, p_version) sl
    left join stats st on st.step_id = sl.step_id
    where sl.step_id not in ('before', 'after')
  )
  select jsonb_build_object(
    'n_real', (select count(*) from ba where not is_seed),
    'n_seed', (select count(*) from ba where is_seed),
    'seed_weight', round((select w from w), 4),
    'seeded_share', coalesce((select round(sum(wt) filter (where is_seed) / nullif(sum(wt), 0), 4) from ba), 0),
    'before_histogram', case when (select t from tot) > 0
      then (select app.histogram(array_agg(before), array_agg(wt)) from ba where before is not null) end,
    'after_histogram', case when (select t from tot) > 0
      then (select app.histogram(array_agg(after), array_agg(wt)) from ba where after is not null) end,
    'mean_before', (select round(sum(wt * before) / nullif(sum(wt), 0), 2) from ba),
    'mean_after', (select round(sum(wt * after) / nullif(sum(wt), 0), 2) from ba),
    'steps', coalesce((select jsonb_agg(jsonb_build_object(
                 'step_id', step_id,
                 'mean_delta', round(mean_delta, 2),
                 'mean_abs_delta', round(mean_abs_delta, 2),
                 'moved_share', round(coalesce(moved_share, 0), 4)) order by step_index) from steps), '[]'::jsonb),
    'top_step_id', (select step_id from steps where mean_abs_delta > 0
                    order by mean_abs_delta desc, step_index limit 1)
  )
$$;

create or replace function app.generate_seed_responses(p_case_id uuid, p_version int) returns int
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  profile jsonb;
  bins double precision[];
  total double precision;
  n int;
  at timestamptz;
  slot_ids text[];
  slot_idx int[];
  shifts jsonb[];
  sess uuid[];
  r_sess uuid[] := '{}';
  r_step text[] := '{}';
  r_idx int[] := '{}';
  r_val smallint[] := '{}';
  st bigint;
  r double precision;
  u double precision;
  w double precision;
  val double precision;
  i int;
  j int;
  b int;
  shift jsonb;
begin
  select seed_profile into profile from public.cases where id = p_case_id;
  delete from public.sessions where case_id = p_case_id and case_version = p_version and is_seed;
  if profile is null or not app.version_is_published(p_case_id, p_version)
     or cardinality(app.seed_profile_problems(profile)) > 0
     -- Seeds fade case-wide: once the case has its real crowd, new versions get none.
     or app.seed_weight_for(p_case_id, p_version, true) <= 0 then
    return 0;
  end if;

  n := (profile ->> 'sessions')::int;
  if n <= 0 then return 0; end if;
  select array_agg(x::double precision order by ord) into bins
    from jsonb_array_elements_text(profile -> 'before_bins') with ordinality as t(x, ord);
  select sum(x) into total from unnest(bins) x;
  select published_at into at from public.case_versions where case_id = p_case_id and version = p_version;

  select array_agg(s.step_id order by s.step_index), array_agg(s.step_index order by s.step_index)
    into slot_ids, slot_idx
    from app.version_slots(p_case_id, p_version) s;
  -- Shift per slot: none for before, the step's entry, then the after shift.
  shifts := array(
    select case when s = 'before' then null
                when s = 'after' then profile -> 'after'
                else profile -> 'steps' -> s end
    from unnest(slot_ids) with ordinality as t(s, o) order by o);

  sess := array(select gen_random_uuid() from generate_series(1, n));
  insert into public.sessions (id, case_id, case_version, device_hash, is_seed, started_at, completed_at)
  select sess[k], p_case_id, p_version, 'seed:' || k, true, at, at from generate_series(1, n) k;

  st := (profile ->> 'rng_seed')::bigint & 4294967295;
  for i in 1..n loop
    -- Before: pick a bin by weight, then a value inside it (sampleBefore).
    st := app.m32_next(st); r := app.m32_value(st) * total;
    val := 50;
    for b in 1..10 loop
      r := r - bins[b];
      if r <= 0 then
        st := app.m32_next(st);
        val := app.js_round((b - 1) * 10 + app.m32_value(st) * (case when b = 10 then 10 else 9 end));
        exit;
      end if;
    end loop;

    for j in 1..cardinality(slot_ids) loop
      shift := shifts[j];
      if shift is not null and jsonb_typeof(shift) = 'object' then
        -- applyShift: move with probability move_share, by mean_shift + N(0,1) * spread.
        st := app.m32_next(st);
        if app.m32_value(st) < (shift ->> 'move_share')::double precision then
          u := 0;
          while u = 0 loop
            st := app.m32_next(st); u := app.m32_value(st);
          end loop;
          st := app.m32_next(st); w := app.m32_value(st);
          val := app.js_round(val + (shift ->> 'mean_shift')::double precision
                              + sqrt(-2 * ln(u)) * cos(2 * pi() * w) * (shift ->> 'spread')::double precision);
        end if;
      end if;
      r_sess := r_sess || sess[i];
      r_step := r_step || slot_ids[j];
      r_idx := r_idx || slot_idx[j];
      r_val := r_val || val::smallint;
    end loop;
  end loop;

  insert into public.responses (session_id, case_id, case_version, step_id, step_index, value, is_seed, created_at)
  select x.s, p_case_id, p_version, x.step, x.idx, x.v, true, at
  from unnest(r_sess, r_step, r_idx, r_val) as x(s, step, idx, v);
  return n;
end;
$$;

revoke execute on function app.case_real_completions(uuid) from public, anon, authenticated;
