-- =============================================================================
-- Scheduled jobs (pg_cron)
-- =============================================================================
--   every minute       publish versions whose approved schedule time has passed
--   every 15 minutes   queue re-research runs for live cases whose cadence is due

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('publish-due-versions', '* * * * *', 'select app.publish_due_versions()');
    perform cron.schedule('enqueue-due-updates', '*/15 * * * *', 'select app.enqueue_due_updates()');
  else
    raise notice 'pg_cron is not available; scheduled publishing and updates must be triggered externally';
  end if;
end;
$$;
