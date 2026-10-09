-- =============================================================================
-- A scheduled admin edit supersedes the package it was edited from
-- =============================================================================
--
-- admin_publish archives the base version of an admin_edit draft when the edit
-- goes live. A scheduled publish must do the same, or the base package is left
-- pending in the queue after its edit is already live.

create or replace function app.publish_due_versions()
returns int
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
  approved boolean;
  base public.case_versions;
  note text;
begin
  for r in
    select case_id, version, doc, tags, based_on_version, scheduled_publish_at from public.case_versions
    where scheduled_publish_at <= now() and status in ('in_review', 'draft')
    order by scheduled_publish_at
    for update skip locked
  loop
    select exists (
      select 1 from public.review_decisions d
      where d.case_id = r.case_id and d.version = r.version and d.action = 'approve_schedule'
        and d.scheduled_for = r.scheduled_publish_at and d.doc_sha256 = app.doc_hash(r.doc)
    ) into approved;
    begin
      if not approved then
        raise exception 'no admin approval matches this schedule and content';
      end if;
      update public.case_versions
        set doc = app.with_decision(r.doc, 'scheduled_publish', r.version, 'Published on the approved schedule.'),
            status = 'published'
        where case_id = r.case_id and version = r.version;
      insert into public.review_decisions (case_id, version, action, actor, notes, doc_sha256)
      values (r.case_id, r.version, 'scheduled_publish', 'system:schedule', 'Published on the approved schedule.',
              app.doc_hash(r.doc));

      -- Same as admin_publish: the edited package is replaced by its edit.
      if 'admin_edit' = any(r.tags) and r.based_on_version is not null then
        select * into base from public.case_versions
          where case_id = r.case_id and version = r.based_on_version
            and status in ('changes_requested', 'in_review', 'draft')
          for update;
        if found then
          note := format('Superseded by version %s.', r.version);
          update public.case_versions
            set doc = app.with_decision(base.doc, 'superseded', base.version, note),
                status = 'archived',
                scheduled_publish_at = null
            where case_id = base.case_id and version = base.version;
          insert into public.review_decisions (case_id, version, action, actor, notes)
          values (base.case_id, base.version, 'superseded', 'system:schedule', note);
        end if;
      end if;
      n := n + 1;
    exception when others then
      update public.case_versions set scheduled_publish_at = null
        where case_id = r.case_id and version = r.version;
      insert into public.review_decisions (case_id, version, action, actor, notes)
      values (r.case_id, r.version, 'unschedule', 'system:schedule',
              'Scheduled publish failed and was cancelled: ' || sqlerrm);
    end;
  end loop;
  return n;
end;
$$;

revoke all on function app.publish_due_versions() from public, anon, authenticated;
