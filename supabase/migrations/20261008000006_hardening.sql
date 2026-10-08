-- =============================================================================
-- Hardening after the phase 1 adversarial review
-- =============================================================================
--
-- 1. Only an admin decision can put a version live. The pipeline can no longer
--    set a publish time, edit a version after it was scheduled, forge admin_edit
--    drafts, or archive versions it does not own. Scheduled publishes require a
--    matching approve_schedule decision for the exact content that was approved.
-- 2. Status changes and in-place edits go through the review actions, so every
--    decision is logged.
-- 3. Publishing enforces the full case JSON Schema (generated from the Zod
--    schema) plus the cross-field rules, and the public projection is built from
--    an allowlist of keys.
-- 4. Rate limits key on an IP the platform sets, not the client-controlled
--    left-most X-Forwarded-For entry.
-- 5. Seed profiles are validated, seeds are generated in bulk with the same
--    PRNG as @sia/case-schema, and a bad profile can never block a publish.
-- 6. Internal functions are no longer executable by the public.

create extension if not exists pg_jsonschema with schema extensions;

-- -----------------------------------------------------------------------------
-- JSON Schemas generated from @sia/case-schema (pnpm --filter @sia/case-schema gen-json-schema)
-- -----------------------------------------------------------------------------

create table app.json_schemas (
  name text primary key,
  schema json not null,
  updated_at timestamptz not null default now()
);

insert into app.json_schemas (name, schema) values
  ('case', $schema${"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {"schema_version": {"default": 1, "type": "number", "const": 1}, "id": {"type": "string", "minLength": 1, "maxLength": 64}, "slug": {"type": "string", "maxLength": 80, "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$"}, "title": {"type": "string", "minLength": 1, "maxLength": 160}, "status": {"type": "string", "enum": ["draft", "in_review", "changes_requested", "rejected", "published", "archived"]}, "version": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}, "parent_version": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}, "as_of": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"}, "content_warning": {"type": "string", "minLength": 1, "maxLength": 400}, "question": {"type": "object", "properties": {"prompt": {"type": "string", "minLength": 1, "maxLength": 240}, "scale": {"type": "object", "properties": {"type": {"type": "string", "const": "slider"}, "min": {"type": "number", "const": 0}, "max": {"type": "number", "const": 100}, "left_label": {"type": "string", "minLength": 1, "maxLength": 80}, "right_label": {"type": "string", "minLength": 1, "maxLength": 80}}, "required": ["type", "min", "max", "left_label", "right_label"], "additionalProperties": false}}, "required": ["prompt", "scale"], "additionalProperties": false}, "starting_facts": {"minItems": 1, "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "text": {"type": "string", "minLength": 1, "maxLength": 400}, "source_ids": {"minItems": 1, "type": "array", "items": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}, "confidence": {"type": "string", "enum": ["established", "reported", "disputed", "alleged"]}, "evidence": {"type": "array", "items": {"type": "object", "properties": {"source_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "quote": {"type": "string", "minLength": 1, "maxLength": 1500}}, "required": ["source_id", "quote"], "additionalProperties": false}}}, "required": ["id", "text", "source_ids", "confidence"], "additionalProperties": false}}, "steps": {"minItems": 1, "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "order": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}, "headline": {"type": "string", "minLength": 1, "maxLength": 160}, "body": {"type": "string", "minLength": 1, "maxLength": 1000}, "depth": {"default": [], "type": "array", "items": {"oneOf": [{"type": "object", "properties": {"kind": {"type": "string", "const": "document"}, "id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "title": {"type": "string", "minLength": 1, "maxLength": 200}, "summary": {"type": "string", "minLength": 1, "maxLength": 1200}, "source_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}, "required": ["kind", "id", "title", "summary", "source_id"], "additionalProperties": false}, {"type": "object", "properties": {"kind": {"type": "string", "const": "quote"}, "id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "text": {"type": "string", "minLength": 1, "maxLength": 1200}, "speaker": {"type": "string", "minLength": 1, "maxLength": 200}, "context": {"type": "string", "minLength": 1, "maxLength": 400}, "source_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}, "required": ["kind", "id", "text", "speaker", "source_id"], "additionalProperties": false}, {"type": "object", "properties": {"kind": {"type": "string", "const": "timeline"}, "id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "title": {"type": "string", "minLength": 1, "maxLength": 200}, "entries": {"minItems": 1, "type": "array", "items": {"type": "object", "properties": {"date": {"type": "string", "pattern": "^\\d{4}(-(0[1-9]|1[0-2])(-\\d{2})?)?$"}, "text": {"type": "string", "minLength": 1, "maxLength": 400}, "source_ids": {"minItems": 1, "type": "array", "items": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}}, "required": ["date", "text", "source_ids"], "additionalProperties": false}}}, "required": ["kind", "id", "title", "entries"], "additionalProperties": false}, {"type": "object", "properties": {"kind": {"type": "string", "const": "context"}, "id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "title": {"type": "string", "minLength": 1, "maxLength": 200}, "body": {"type": "string", "minLength": 1, "maxLength": 1500}, "source_ids": {"minItems": 1, "type": "array", "items": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}}, "required": ["kind", "id", "title", "body", "source_ids"], "additionalProperties": false}]}}, "favors": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "impact": {"type": "string", "enum": ["low", "medium", "high"]}, "source_ids": {"minItems": 1, "type": "array", "items": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}, "confidence": {"type": "string", "enum": ["established", "reported", "disputed", "alleged"]}, "evidence": {"type": "array", "items": {"type": "object", "properties": {"source_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "quote": {"type": "string", "minLength": 1, "maxLength": 1500}}, "required": ["source_id", "quote"], "additionalProperties": false}}, "micro_poll": {"type": "object", "properties": {"prompt": {"type": "string", "minLength": 1, "maxLength": 200}, "re_ask_slider": {"type": "boolean", "const": true}}, "required": ["prompt", "re_ask_slider"], "additionalProperties": false}}, "required": ["id", "order", "headline", "body", "depth", "source_ids", "confidence", "micro_poll"], "additionalProperties": false}}, "sides": {"minItems": 2, "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "label": {"type": "string", "minLength": 1, "maxLength": 80}, "steelman": {"type": "string", "minLength": 1, "maxLength": 2000}}, "required": ["id", "label", "steelman"], "additionalProperties": false}}, "open_questions": {"default": [], "type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 400}}, "sources": {"minItems": 1, "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "title": {"type": "string", "minLength": 1, "maxLength": 300}, "publisher": {"type": "string", "minLength": 1, "maxLength": 200}, "url": {"type": "string", "maxLength": 2048, "format": "uri"}, "date": {"type": "string", "pattern": "^\\d{4}(-(0[1-9]|1[0-2])(-\\d{2})?)?$"}, "type": {"type": "string", "enum": ["court_record", "official", "primary", "news", "analysis"]}, "accessed_at": {"type": "string", "format": "date-time", "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}, "quote_excerpt": {"type": "string", "minLength": 1, "maxLength": 1200}}, "required": ["id", "title", "publisher", "url", "date", "type", "accessed_at"], "additionalProperties": false}}, "review": {"default": {"agent_reports": [], "hard_questions": [], "bias_reports": [], "fact_check": [], "open_issues": [], "decisions": []}, "type": "object", "properties": {"pipeline_run_id": {"type": "string", "maxLength": 100}, "rounds": {"type": "integer", "minimum": 0, "maximum": 9007199254740991}, "agent_reports": {"default": [], "type": "array", "items": {"type": "object", "properties": {"agent": {"type": "string", "enum": ["scoper", "researcher", "records_researcher", "drafter", "hard_questions", "red_team", "fact_checker", "editor"]}, "scope": {"type": "string", "maxLength": 64}, "round": {"type": "integer", "minimum": 0, "maximum": 9007199254740991}, "at": {"type": "string", "format": "date-time", "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}, "summary": {"type": "string", "maxLength": 4000}}, "required": ["agent", "round", "at", "summary"], "additionalProperties": false}}, "hard_questions": {"default": [], "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "side_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "question": {"type": "string", "minLength": 1, "maxLength": 600}, "blocking": {"type": "boolean"}, "status": {"type": "string", "enum": ["answered", "open", "not_applicable"]}, "resolution": {"type": "string", "maxLength": 2000}, "step_ids": {"default": [], "type": "array", "items": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}, "round": {"default": 0, "type": "integer", "minimum": 0, "maximum": 9007199254740991}}, "required": ["id", "question", "blocking", "status", "step_ids", "round"], "additionalProperties": false}}, "bias_reports": {"default": [], "type": "array", "items": {"type": "object", "properties": {"side_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "round": {"type": "integer", "minimum": 0, "maximum": 9007199254740991}, "summary": {"default": "", "type": "string", "maxLength": 4000}, "flags": {"default": [], "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "step_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "kind": {"type": "string", "enum": ["cherry_picking", "loaded_wording", "order_effect", "missing_exculpatory_fact", "missing_damning_fact", "other"]}, "severity": {"type": "string", "enum": ["low", "medium", "high"]}, "note": {"type": "string", "minLength": 1, "maxLength": 2000}, "status": {"type": "string", "enum": ["addressed", "unaddressed", "wont_fix"]}, "resolution": {"type": "string", "maxLength": 2000}}, "required": ["id", "kind", "severity", "note", "status"], "additionalProperties": false}}}, "required": ["side_id", "round", "summary", "flags"], "additionalProperties": false}}, "fact_check": {"default": [], "type": "array", "items": {"type": "object", "properties": {"target": {"type": "string", "minLength": 1, "maxLength": 160}, "claim": {"type": "string", "minLength": 1, "maxLength": 2000}, "source_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "verdict": {"type": "string", "enum": ["supported", "partially_supported", "unsupported", "source_unavailable", "uncited"]}, "quote": {"type": "string", "maxLength": 1500}, "note": {"type": "string", "maxLength": 2000}, "confidence_before": {"type": "string", "enum": ["established", "reported", "disputed", "alleged"]}, "confidence_after": {"type": "string", "enum": ["established", "reported", "disputed", "alleged"]}, "round": {"default": 0, "type": "integer", "minimum": 0, "maximum": 9007199254740991}}, "required": ["target", "claim", "verdict", "round"], "additionalProperties": false}}, "balance": {"type": "object", "properties": {"per_side": {"type": "object", "propertyNames": {"type": "string"}, "additionalProperties": {"type": "integer", "minimum": 0, "maximum": 9007199254740991}}, "neutral": {"type": "integer", "minimum": 0, "maximum": 9007199254740991}, "untagged": {"type": "integer", "minimum": 0, "maximum": 9007199254740991}, "order": {"type": "array", "items": {"type": "string"}}, "warnings": {"type": "array", "items": {"type": "string"}}}, "required": ["per_side", "neutral", "untagged", "order", "warnings"], "additionalProperties": false}, "open_issues": {"default": [], "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "source": {"type": "string", "enum": ["pipeline", "hard_questions", "red_team", "fact_checker", "editor", "validator", "admin", "user_flags", "fairness"]}, "severity": {"type": "string", "enum": ["low", "medium", "high"]}, "description": {"type": "string", "minLength": 1, "maxLength": 2000}, "step_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "resolved": {"default": false, "type": "boolean"}}, "required": ["id", "source", "severity", "description", "resolved"], "additionalProperties": false}}, "decisions": {"default": [], "type": "array", "items": {"type": "object", "properties": {"action": {"type": "string", "enum": ["submitted", "approve_publish", "approve_schedule", "request_changes", "admin_edit", "reject", "archive", "superseded", "scheduled_publish", "unschedule"]}, "actor": {"type": "string", "minLength": 1, "maxLength": 200}, "at": {"type": "string", "format": "date-time", "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}, "version": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}, "notes": {"type": "string", "maxLength": 8000}, "scheduled_for": {"type": "string", "format": "date-time", "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}}, "required": ["action", "actor", "at", "version"], "additionalProperties": false}}}, "required": ["agent_reports", "hard_questions", "bias_reports", "fact_check", "open_issues", "decisions"], "additionalProperties": false}}, "required": ["schema_version", "id", "slug", "title", "status", "version", "as_of", "question", "starting_facts", "steps", "sides", "open_questions", "sources", "review"], "additionalProperties": false}$schema$),
  ('seed_profile', $schema${"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {"sessions": {"type": "integer", "minimum": 0, "maximum": 5000}, "before_bins": {"minItems": 10, "maxItems": 10, "type": "array", "items": {"type": "number", "minimum": 0}}, "steps": {"default": {}, "type": "object", "propertyNames": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "additionalProperties": {"type": "object", "properties": {"move_share": {"type": "number", "minimum": 0, "maximum": 1}, "mean_shift": {"type": "number", "minimum": -100, "maximum": 100}, "spread": {"type": "number", "minimum": 0, "maximum": 50}}, "required": ["move_share", "mean_shift", "spread"], "additionalProperties": false}}, "after": {"type": "object", "properties": {"move_share": {"type": "number", "minimum": 0, "maximum": 1}, "mean_shift": {"type": "number", "minimum": -100, "maximum": 100}, "spread": {"type": "number", "minimum": 0, "maximum": 50}}, "required": ["move_share", "mean_shift", "spread"], "additionalProperties": false}, "fade_after_real_completions": {"default": 500, "type": "integer", "minimum": 1, "maximum": 9007199254740991}, "rng_seed": {"default": 1, "type": "integer", "minimum": -9007199254740991, "maximum": 9007199254740991}, "note": {"type": "string", "maxLength": 2000}}, "required": ["sessions", "before_bins", "steps", "fade_after_real_completions", "rng_seed"], "additionalProperties": false}$schema$);

create or replace function app.schema_problems(p_name text, p_doc jsonb) returns text[]
language sql stable
security definer
set search_path = ''
as $$
  select coalesce(extensions.jsonschema_validation_errors(s.schema, p_doc::json), '{}')
  from app.json_schemas s where s.name = p_name
$$;

-- -----------------------------------------------------------------------------
-- Content identity: what an approval is an approval of
-- -----------------------------------------------------------------------------

/** The document minus the fields the database manages or the review appends to. */
create or replace function app.doc_content(doc jsonb) returns jsonb
language sql immutable
set search_path = ''
as $$ select doc - 'review' - 'status' - 'id' - 'slug' - 'version' $$;

create or replace function app.doc_hash(doc jsonb) returns text
language sql immutable
set search_path = ''
as $$ select encode(sha256(convert_to(app.doc_content(doc)::text, 'UTF8')), 'hex') $$;

alter table public.review_decisions add column doc_sha256 text;
grant insert (doc_sha256) on public.review_decisions to authenticated;
alter table public.review_decisions drop constraint review_decisions_action_check;
alter table public.review_decisions add constraint review_decisions_action_check check (action in (
  'submitted', 'approve_publish', 'approve_schedule', 'request_changes', 'admin_edit',
  'reject', 'archive', 'superseded', 'scheduled_publish', 'unschedule'
));
-- The staff read policy existed but the privilege did not.
grant select on public.review_decisions to authenticated;

-- -----------------------------------------------------------------------------
-- Write privileges: publish times and seed profiles are set only by admin actions
-- -----------------------------------------------------------------------------

revoke insert (scheduled_publish_at), update (scheduled_publish_at) on public.case_versions from authenticated;
revoke update (seed_profile) on public.cases from authenticated;

-- NOT VALID: enforced for every new write; rows written before this migration are left as they are.
alter table public.case_versions
  add constraint case_versions_admin_edit_origin check (not ('admin_edit' = any (tags)) or origin = 'admin') not valid;

drop policy versions_pipeline_insert on public.case_versions;
create policy versions_pipeline_insert on public.case_versions
  for insert to authenticated
  with check (
    public.is_pipeline()
    and origin in ('pipeline', 'import')
    and status in ('draft', 'in_review')
    and scheduled_publish_at is null
  );

drop policy versions_pipeline_update on public.case_versions;
create policy versions_pipeline_update on public.case_versions
  for update to authenticated
  using (public.is_pipeline() and origin in ('pipeline', 'import') and status = 'draft' and scheduled_publish_at is null)
  with check (public.is_pipeline() and origin in ('pipeline', 'import') and status in ('draft', 'in_review')
              and scheduled_publish_at is null);

-- -----------------------------------------------------------------------------
-- Cross-field publish rules (mirrors checkCaseRules errors in @sia/case-schema)
-- -----------------------------------------------------------------------------

create or replace function app.case_doc_problems(doc jsonb) returns text[]
language plpgsql immutable
set search_path = ''
as $$
declare
  problems text[] := '{}';
  sources jsonb := case when jsonb_typeof(doc -> 'sources') = 'array' then doc -> 'sources' else '[]'::jsonb end;
  steps jsonb := case when jsonb_typeof(doc -> 'steps') = 'array' then doc -> 'steps' else '[]'::jsonb end;
  facts jsonb := case when jsonb_typeof(doc -> 'starting_facts') = 'array' then doc -> 'starting_facts' else '[]'::jsonb end;
  sides jsonb := case when jsonb_typeof(doc -> 'sides') = 'array' then doc -> 'sides' else '[]'::jsonb end;
  source_ids text[];
  secondary text[];
  side_ids text[];
  item jsonb;
  layer jsonb;
  entry jsonb;
  ids text[];
  sid text;
  label text;
  i int := 0;
begin
  select coalesce(array_agg(s ->> 'id'), '{}'),
         coalesce(array_agg(s ->> 'id') filter (where s ->> 'type' in ('news', 'analysis')), '{}')
    into source_ids, secondary
    from jsonb_array_elements(sources) s;
  select coalesce(array_agg(s ->> 'id'), '{}') into side_ids from jsonb_array_elements(sides) s;

  if jsonb_array_length(sources) = 0 then problems := problems || 'case has no sources'; end if;
  if jsonb_array_length(steps) = 0 then problems := problems || 'case has no steps'; end if;
  if jsonb_array_length(facts) = 0 then problems := problems || 'case has no starting facts'; end if;
  if jsonb_array_length(sides) < 2 then problems := problems || 'case needs at least two sides'; end if;
  if coalesce(doc #>> '{question,prompt}', '') = '' then problems := problems || 'case has no question'; end if;

  if (select count(*) <> count(distinct x) from unnest(source_ids) x) then problems := problems || 'duplicate source ids'; end if;
  if (select count(*) <> count(distinct x) from unnest(side_ids) x) then problems := problems || 'duplicate side ids'; end if;
  if (select count(*) <> count(distinct s ->> 'id') from jsonb_array_elements(steps) s) then problems := problems || 'duplicate step ids'; end if;
  if (select count(*) <> count(distinct f ->> 'id') from jsonb_array_elements(facts) f) then problems := problems || 'duplicate starting fact ids'; end if;
  if 'neutral' = any(side_ids) then problems := problems || '"neutral" cannot be a side id'; end if;

  -- Starting facts
  for item in select value from jsonb_array_elements(facts) loop
    label := format('starting fact %s', coalesce(item ->> 'id', '?'));
    ids := case when jsonb_typeof(item -> 'source_ids') = 'array'
                then array(select jsonb_array_elements_text(item -> 'source_ids')) else '{}' end;
    if cardinality(ids) = 0 then problems := problems || (label || ' has zero sources'); end if;
    foreach sid in array ids loop
      if not sid = any(source_ids) then problems := problems || format('%s cites unknown source %s', label, sid); end if;
    end loop;
    if item ->> 'confidence' = 'established' and cardinality(ids) > 0 and ids <@ secondary then
      problems := problems || (label || ' is "established" but cites only news or analysis sources');
    end if;
  end loop;

  -- Steps
  for item in select value from jsonb_array_elements(steps) loop
    i := i + 1;
    label := format('step %s (%s)', i, coalesce(item ->> 'id', '?'));
    if (item ->> 'order') is distinct from i::text then
      problems := problems || format('%s has order %s', label, coalesce(item ->> 'order', 'none'));
    end if;
    if item ->> 'id' in ('before', 'after') then problems := problems || (label || ' uses a reserved id'); end if;
    ids := case when jsonb_typeof(item -> 'source_ids') = 'array'
                then array(select jsonb_array_elements_text(item -> 'source_ids')) else '{}' end;
    if cardinality(ids) = 0 then problems := problems || (label || ' has zero sources'); end if;
    foreach sid in array ids loop
      if not sid = any(source_ids) then problems := problems || format('%s cites unknown source %s', label, sid); end if;
    end loop;
    if item ->> 'confidence' = 'established' and cardinality(ids) > 0 and ids <@ secondary then
      problems := problems || (label || ' is "established" but cites only news or analysis sources');
    end if;
    if item ? 'favors' and not (item ->> 'favors' = 'neutral' or item ->> 'favors' = any(side_ids)) then
      problems := problems || format('%s favors unknown side %s', label, item ->> 'favors');
    end if;
    for entry in select value from jsonb_array_elements(case when jsonb_typeof(item -> 'evidence') = 'array' then item -> 'evidence' else '[]'::jsonb end) loop
      if not (entry ->> 'source_id') = any(ids) then
        problems := problems || format('%s has evidence from %s, which it does not cite', label, entry ->> 'source_id');
      end if;
    end loop;
    for layer in select value from jsonb_array_elements(case when jsonb_typeof(item -> 'depth') = 'array' then item -> 'depth' else '[]'::jsonb end) loop
      if layer ? 'source_id' and not (layer ->> 'source_id') = any(source_ids) then
        problems := problems || format('%s layer %s cites unknown source %s', label, layer ->> 'id', layer ->> 'source_id');
      end if;
      for sid in select jsonb_array_elements_text(case when jsonb_typeof(layer -> 'source_ids') = 'array' then layer -> 'source_ids' else '[]'::jsonb end) loop
        if not sid = any(source_ids) then
          problems := problems || format('%s layer %s cites unknown source %s', label, layer ->> 'id', sid);
        end if;
      end loop;
      for entry in select value from jsonb_array_elements(case when jsonb_typeof(layer -> 'entries') = 'array' then layer -> 'entries' else '[]'::jsonb end) loop
        for sid in select jsonb_array_elements_text(case when jsonb_typeof(entry -> 'source_ids') = 'array' then entry -> 'source_ids' else '[]'::jsonb end) loop
          if not sid = any(source_ids) then
            problems := problems || format('%s timeline %s cites unknown source %s', label, layer ->> 'id', sid);
          end if;
        end loop;
      end loop;
    end loop;
  end loop;
  return problems;
end;
$$;

-- -----------------------------------------------------------------------------
-- Guard: immutability, transitions, review actions, publish rules, doc sync
-- -----------------------------------------------------------------------------

create or replace function app.case_versions_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  problems text[];
  live int;
  trusted boolean := app.is_trusted_context();
  -- Set (transaction-local) by the review actions in public.admin_* and submit_case_package.
  via_action boolean := coalesce(current_setting('app.review_action', true), '') = 'on';
  content_changed boolean;
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
    if new.scheduled_publish_at is not null and not trusted then
      raise exception 'only the schedule action can set a publish time' using errcode = 'insufficient_privilege';
    end if;
  else
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
      if not (trusted or (public.is_admin() and via_action)) then
        raise exception 'only an admin action can archive a published version'
          using errcode = 'insufficient_privilege';
      end if;
    elsif old.status in ('rejected', 'archived') then
      raise exception 'version %/% is %, which is final', old.case_id, old.version, old.status
        using errcode = 'check_violation';
    end if;

    if new.scheduled_publish_at is distinct from old.scheduled_publish_at and not trusted then
      raise exception 'only the schedule action can set or clear a publish time' using errcode = 'insufficient_privilege';
    end if;

    -- In-place content edits: only a draft's own author may make them. Everything
    -- else is edited by creating a new version (admin_save_edit).
    content_changed := app.doc_content(new.doc) is distinct from app.doc_content(old.doc);
    if content_changed and not trusted
       and not ((public.is_pipeline() and old.origin in ('pipeline', 'import') and old.status = 'draft')
             or (public.is_admin() and old.origin = 'admin' and old.status = 'draft')) then
      raise exception 'version %/% cannot be edited in place; edits create a new version', old.case_id, old.version
        using errcode = 'insufficient_privilege';
    end if;
    if content_changed and old.scheduled_publish_at is not null and new.scheduled_publish_at is not null then
      -- An approval covers the content that was approved; an edit cancels it.
      new.scheduled_publish_at := null;
      insert into public.review_decisions (case_id, version, action, notes)
      values (old.case_id, old.version, 'unschedule', 'Schedule cancelled because the version was edited after approval.');
    end if;

    if new.status = 'published' and old.status <> 'published' and not (public.is_admin() or trusted) then
      raise exception 'only an admin action can publish a case version'
        using errcode = 'insufficient_privilege';
    end if;

    if new.status is distinct from old.status then
      if not app.transition_allowed(old.status, new.status) then
        raise exception 'status change % -> % is not allowed', old.status, new.status
          using errcode = 'check_violation';
      end if;
      if not trusted and not via_action
         and not (public.is_pipeline() and old.status = 'draft' and new.status = 'in_review') then
        raise exception 'status changes go through the review actions so every decision is logged'
          using errcode = 'insufficient_privilege';
      end if;
    end if;

    if new.status = 'published' and old.status <> 'published' then
      problems := app.case_doc_problems(new.doc) || app.schema_problems('case', new.doc - 'status' || jsonb_build_object('status', 'published'));
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

/** Marks the current transaction as a logged review action (see the guard). */
create or replace function app.begin_review_action() returns void
language sql volatile
set search_path = ''
as $$ select set_config('app.review_action', 'on', true) $$;

-- -----------------------------------------------------------------------------
-- Public projection from an allowlist (mirrors toPublicCase in @sia/case-schema)
-- -----------------------------------------------------------------------------

create or replace function app.pick(obj jsonb, keys text[]) returns jsonb
language sql immutable
set search_path = ''
as $$
  select case when jsonb_typeof(obj) = 'object'
    then coalesce((select jsonb_object_agg(k, v) from jsonb_each(obj) as e(k, v) where k = any(keys)), '{}'::jsonb)
  end
$$;

create or replace function app.pick_each(arr jsonb, keys text[]) returns jsonb
language sql immutable
set search_path = ''
as $$
  select coalesce((select jsonb_agg(app.pick(x, keys) order by ord)
                   from jsonb_array_elements(case when jsonb_typeof(arr) = 'array' then arr else '[]'::jsonb end)
                        with ordinality as t(x, ord)), '[]'::jsonb)
$$;

create or replace function app.public_layer(layer jsonb) returns jsonb
language sql immutable
set search_path = ''
as $$
  select case layer ->> 'kind'
    when 'document' then app.pick(layer, array['kind', 'id', 'title', 'summary', 'source_id'])
    when 'quote' then app.pick(layer, array['kind', 'id', 'text', 'speaker', 'context', 'source_id'])
    when 'context' then app.pick(layer, array['kind', 'id', 'title', 'body', 'source_ids'])
    when 'timeline' then app.pick(layer, array['kind', 'id', 'title'])
      || jsonb_build_object('entries', app.pick_each(layer -> 'entries', array['date', 'text', 'source_ids']))
    else '{}'::jsonb
  end
$$;

-- The generated column depends on the projection; rebuild both.
alter table public.case_versions drop column public_doc;

create or replace function public.case_public_projection(doc jsonb) returns jsonb
language sql immutable parallel safe
set search_path = ''
as $$
  select jsonb_strip_nulls(
    app.pick(doc, array['schema_version', 'id', 'slug', 'title', 'version', 'parent_version', 'as_of',
                        'content_warning', 'open_questions'])
    || jsonb_build_object(
      'question', app.pick(doc -> 'question', array['prompt'])
        || jsonb_build_object('scale', app.pick(doc #> '{question,scale}', array['type', 'min', 'max', 'left_label', 'right_label'])),
      'starting_facts', app.pick_each(doc -> 'starting_facts', array['id', 'text', 'source_ids', 'confidence']),
      'steps', coalesce((
        select jsonb_agg(
          app.pick(s, array['id', 'order', 'headline', 'body', 'source_ids', 'confidence'])
          || jsonb_build_object(
            'depth', coalesce((select jsonb_agg(app.public_layer(l) order by lo)
                               from jsonb_array_elements(case when jsonb_typeof(s -> 'depth') = 'array' then s -> 'depth' else '[]'::jsonb end)
                                    with ordinality as d(l, lo)), '[]'::jsonb),
            'micro_poll', app.pick(s -> 'micro_poll', array['prompt', 're_ask_slider']))
          order by ord)
        from jsonb_array_elements(case when jsonb_typeof(doc -> 'steps') = 'array' then doc -> 'steps' else '[]'::jsonb end)
             with ordinality as t(s, ord)), '[]'::jsonb),
      'sides', app.pick_each(doc -> 'sides', array['id', 'label', 'steelman']),
      'sources', app.pick_each(doc -> 'sources', array['id', 'title', 'publisher', 'url', 'date', 'type', 'accessed_at', 'quote_excerpt'])
    ))
$$;

alter table public.case_versions
  add column public_doc jsonb generated always as (public.case_public_projection(doc)) stored;
grant select (public_doc) on public.case_versions to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Review actions
-- -----------------------------------------------------------------------------

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
  perform app.begin_review_action();
  v := app.staff_version(p_case_id, p_version);
  update public.case_versions
    set doc = app.with_decision(v.doc, 'approve_publish', p_version, p_notes),
        status = 'published'
    where case_id = p_case_id and version = p_version;
  insert into public.review_decisions (case_id, version, action, notes, doc_sha256)
  values (p_case_id, p_version, 'approve_publish', p_notes, app.doc_hash(v.doc));
  if 'admin_edit' = any(v.tags) and v.based_on_version is not null then
    perform app.supersede(p_case_id, v.based_on_version, p_version);
  end if;
  return jsonb_build_object('case_id', p_case_id, 'version', p_version,
                            'live_version', app.case_live_version(p_case_id));
end;
$$;

/** Approve and schedule. Definer so it alone can set the publish time; it checks for the admin itself. */
create or replace function public.admin_schedule(p_case_id uuid, p_version int, p_at timestamptz, p_notes text default null)
returns jsonb
language plpgsql volatile
security definer
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
  if not (v.status = 'in_review' or (v.status = 'draft' and v.origin = 'admin')) then
    raise exception 'only versions in review, or admin edit drafts, can be scheduled' using errcode = 'PT409';
  end if;
  problems := app.case_doc_problems(v.doc) || app.schema_problems('case', v.doc);
  if cardinality(problems) > 0 then
    raise exception 'version is not publishable: %', array_to_string(problems, '; ') using errcode = 'check_violation';
  end if;
  update public.case_versions
    set doc = app.with_decision(v.doc, 'approve_schedule', p_version, p_notes, p_at),
        scheduled_publish_at = p_at
    where case_id = p_case_id and version = p_version;
  insert into public.review_decisions (case_id, version, action, notes, scheduled_for, doc_sha256)
  values (p_case_id, p_version, 'approve_schedule', p_notes, p_at, app.doc_hash(v.doc));
  return jsonb_build_object('case_id', p_case_id, 'version', p_version, 'scheduled_publish_at', p_at);
end;
$$;

create or replace function public.admin_unschedule(p_case_id uuid, p_version int)
returns void
language plpgsql volatile
security definer
set search_path = ''
as $$
declare v public.staff_case_versions;
begin
  perform app.require_admin();
  v := app.staff_version(p_case_id, p_version);
  if v.scheduled_publish_at is null or v.status = 'published' then
    return;
  end if;
  update public.case_versions
    set doc = app.with_decision(v.doc, 'unschedule', p_version, 'Schedule cancelled by the admin.'),
        scheduled_publish_at = null
    where case_id = p_case_id and version = p_version;
  insert into public.review_decisions (case_id, version, action, notes)
  values (p_case_id, p_version, 'unschedule', 'Schedule cancelled by the admin.');
end;
$$;

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
  perform app.begin_review_action();
  if coalesce(trim(p_notes), '') = '' then
    raise exception 'write notes for the pipeline' using errcode = '22023';
  end if;
  v := app.staff_version(p_case_id, p_version);
  if v.scheduled_publish_at is not null then
    perform public.admin_unschedule(p_case_id, p_version);
    v := app.staff_version(p_case_id, p_version);
  end if;
  update public.case_versions
    set doc = app.with_decision(v.doc, 'request_changes', p_version, p_notes),
        status = 'changes_requested'
    where case_id = p_case_id and version = p_version;
  insert into public.review_decisions (case_id, version, action, notes)
  values (p_case_id, p_version, 'request_changes', p_notes);
  insert into public.pipeline_jobs (kind, case_id, base_version, instructions)
  values ('revision', p_case_id, p_version, p_notes)
  returning id into job;
  return jsonb_build_object('case_id', p_case_id, 'version', p_version, 'job_id', job);
end;
$$;

create or replace function public.admin_reject(p_case_id uuid, p_version int, p_reason text)
returns void
language plpgsql volatile
security invoker
set search_path = ''
as $$
declare v public.staff_case_versions;
begin
  perform app.require_admin();
  perform app.begin_review_action();
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  v := app.staff_version(p_case_id, p_version);
  if v.scheduled_publish_at is not null then
    perform public.admin_unschedule(p_case_id, p_version);
    v := app.staff_version(p_case_id, p_version);
  end if;
  update public.case_versions
    set doc = app.with_decision(v.doc, 'reject', p_version, p_reason),
        status = 'rejected'
    where case_id = p_case_id and version = p_version;
  insert into public.review_decisions (case_id, version, action, notes)
  values (p_case_id, p_version, 'reject', p_reason);
end;
$$;

create or replace function public.admin_archive(p_case_id uuid, p_version int, p_notes text default null)
returns void
language plpgsql volatile
security invoker
set search_path = ''
as $$
declare v public.staff_case_versions;
begin
  perform app.require_admin();
  perform app.begin_review_action();
  v := app.staff_version(p_case_id, p_version);
  update public.case_versions set status = 'archived'
    where case_id = p_case_id and version = p_version;
  insert into public.review_decisions (case_id, version, action, notes)
  values (p_case_id, p_version, 'archive', p_notes);
end;
$$;

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

  -- Continue the admin's own edit draft rather than piling up versions.
  if base.status = 'draft' and base.origin = 'admin' and 'admin_edit' = any(base.tags) then
    target := base;
  else
    select * into target from public.staff_case_versions
      where case_id = p_case_id and based_on_version = p_base_version and status = 'draft'
        and origin = 'admin' and 'admin_edit' = any(tags)
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

/**
 * Archives a version that a newer one replaces. The admin may supersede any
 * pending version; the pipeline only a version the admin sent back to it.
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
    if v.status <> 'changes_requested' or v.origin = 'admin' or v.scheduled_publish_at is not null then
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

  if based_status = 'changes_requested' then
    perform app.supersede(cid, p_based_on_version, v);
  end if;

  return jsonb_build_object('case_id', cid, 'slug', p_slug, 'version', v);
end;
$$;

-- -----------------------------------------------------------------------------
-- Scheduled publishing requires the matching approval of the exact content
-- -----------------------------------------------------------------------------

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
begin
  for r in
    select case_id, version, doc, scheduled_publish_at from public.case_versions
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

-- -----------------------------------------------------------------------------
-- Client IP for rate limits: a header the platform sets, never the client's
-- -----------------------------------------------------------------------------

insert into app.settings (key, value) values
  -- 'auto': cf-connecting-ip (set by the hosted edge), then x-real-ip (set by the
  -- API gateway), then the right-most X-Forwarded-For entry. Or name one header.
  ('ip.source', 'auto'),
  ('rate.reveals_per_minute', '240');

create or replace function app.request_ip_hash() returns text
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  headers json := nullif(current_setting('request.headers', true), '')::json;
  source text := coalesce((select value from app.settings where key = 'ip.source'), 'auto');
  xff text[];
  ip text;
begin
  if headers is null then
    return null;
  end if;
  xff := regexp_split_to_array(coalesce(headers ->> 'x-forwarded-for', ''), '\s*,\s*');
  if source = 'auto' then
    ip := coalesce(nullif(trim(headers ->> 'cf-connecting-ip'), ''),
                   nullif(trim(headers ->> 'x-real-ip'), ''),
                   nullif(trim(xff[cardinality(xff)]), ''));
  elsif source = 'x-forwarded-for-rightmost' then
    ip := nullif(trim(xff[cardinality(xff)]), '');
  else
    ip := nullif(trim(headers ->> source), '');
  end if;
  return case when ip is null then null else app.hash_text('ip:' || ip) end;
end;
$$;

-- -----------------------------------------------------------------------------
-- Seeds: validated profiles, the same PRNG as @sia/case-schema, bulk inserts
-- -----------------------------------------------------------------------------

/** mulberry32, bit-for-bit with createRng() in @sia/case-schema (uint32 math in bigint). */
create or replace function app.m32_imul(x bigint, y bigint) returns bigint
language sql immutable parallel safe
set search_path = ''
as $$ select ((x * (y & 65535)) + (((x * (y >> 16)) & 65535) << 16)) & 4294967295 $$;

create or replace function app.m32_next(state bigint) returns bigint
language sql immutable parallel safe
set search_path = ''
as $$ select (state + 1831565813) & 4294967295 $$;

create or replace function app.m32_value(state bigint) returns double precision
language plpgsql immutable parallel safe
set search_path = ''
as $$
declare t bigint := state;
begin
  t := app.m32_imul(t # (t >> 15), t | 1);
  t := t # ((t + app.m32_imul(t # (t >> 7), t | 61)) & 4294967295);
  return ((t # (t >> 14)) & 4294967295)::double precision / 4294967296.0;
end;
$$;

create or replace function app.js_round(x double precision) returns smallint
language sql immutable
set search_path = ''
as $$ select greatest(0, least(100, floor(x + 0.5)))::smallint $$;

/** Validates a seed profile against the SeedProfile JSON Schema. */
create or replace function app.seed_profile_problems(p jsonb) returns text[]
language plpgsql stable
set search_path = ''
as $$
declare problems text[];
begin
  if p is null then return '{}'; end if;
  problems := app.schema_problems('seed_profile', p);
  if cardinality(problems) = 0 and not exists (
    select 1 from jsonb_array_elements_text(p -> 'before_bins') b where b::numeric > 0) then
    problems := problems || 'at least one before bin must be positive';
  end if;
  return problems;
end;
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
     or cardinality(app.seed_profile_problems(profile)) > 0 then
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

create or replace function app.case_versions_after_publish() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published' and old.status <> 'published' then
    update public.cases set live_version = new.version where id = new.case_id;
    -- Seeding must never block a publish.
    begin
      perform app.generate_seed_responses(new.case_id, new.version);
    exception when others then
      raise warning 'seed generation failed for %/%: %', new.case_id, new.version, sqlerrm;
    end;
  elsif new.status = 'archived' and old.status = 'published' then
    update public.cases set live_version = null
      where id = new.case_id and live_version = new.version;
  end if;
  return null;
end;
$$;

create or replace function app.seed_weight_for(p_case_id uuid, p_version int, p_include_seed boolean) returns numeric
language sql stable
security definer
set search_path = ''
as $$
  select case when not coalesce(p_include_seed, true) then 0
    else public.seed_weight(
      app.real_completions(p_case_id, p_version),
      coalesce((select case when jsonb_typeof(seed_profile -> 'fade_after_real_completions') = 'number'
                            then greatest(1, floor((seed_profile ->> 'fade_after_real_completions')::numeric))::int end
                from public.cases where id = p_case_id), 500))
  end
$$;

create or replace function public.admin_set_seed_profile(p_case_id uuid, p_profile jsonb)
returns jsonb
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  live int;
  n int := 0;
  problems text[];
begin
  perform app.require_admin();
  problems := app.seed_profile_problems(p_profile);
  if cardinality(problems) > 0 then
    raise exception 'invalid seed profile: %', array_to_string(problems, '; ') using errcode = '22023';
  end if;
  update public.cases set seed_profile = p_profile where id = p_case_id returning live_version into live;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'PT404';
  end if;
  if live is not null then
    n := app.generate_seed_responses(p_case_id, live);
  end if;
  return jsonb_build_object('case_id', p_case_id, 'live_version', live, 'seeded_sessions', n);
end;
$$;

-- -----------------------------------------------------------------------------
-- User signals: flags need a reached step; alerts count only new evidence
-- -----------------------------------------------------------------------------

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
  -- A reader can flag a step once they have reached it (answered the slot before it).
  if not exists (select 1 from public.responses r
                 join app.version_slots(sess.case_id, sess.case_version) s on s.step_id = p_step_id
                 where r.session_id = sess.id and r.step_index = s.step_index - 1) then
    raise exception 'reach this step before flagging it' using errcode = 'PT409';
  end if;
  if p_reason not in ('unfair', 'cherry_picked', 'inaccurate', 'other') then
    raise exception 'unknown reason' using errcode = '22023';
  end if;
  if app.rate_limited('signals:' || coalesce(app.request_ip_hash(), sess.ip_hash, 'none'), interval '1 hour',
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

create or replace function app.check_flags(p_case_id uuid, p_version int, p_step_id text) returns void
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  n int;
  since timestamptz;
begin
  select max(resolved_at) into since from public.review_alerts
    where case_id = p_case_id and case_version = p_version and kind = 'flags' and step_id = p_step_id;
  select count(*) into n
    from public.fact_flags f
    join public.sessions s on s.id = f.session_id and not s.excluded
    where f.case_id = p_case_id and f.case_version = p_version and f.step_id = p_step_id
      and f.resolved_at is null and f.created_at > coalesce(since, '-infinity');
  if n >= app.setting_num('flags.alert_min', 20) then
    insert into public.review_alerts (case_id, case_version, kind, step_id, details)
    values (p_case_id, p_version, 'flags', p_step_id, jsonb_build_object('open_flags', n))
    on conflict do nothing;
  end if;
end;
$$;

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
    with last_resolved as (
      select side_id, max(resolved_at) as at from public.review_alerts
      where case_id = p_case_id and case_version = p_version and kind = 'fairness' and resolved_at is not null
      group by side_id
    )
    select f.side_id, count(*) as n, count(*) filter (where f.rating = 'unfair') as unfair
    from public.fairness_ratings f
    join public.sessions s on s.id = f.session_id and not s.excluded
    left join last_resolved lr on lr.side_id = f.side_id
    where f.case_id = p_case_id and f.case_version = p_version
      -- after an alert is resolved, only new ratings count toward the next one
      and f.created_at > coalesce(lr.at, '-infinity')
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
  if app.rate_limited('signals:' || coalesce(app.request_ip_hash(), sess.ip_hash, 'none'), interval '1 hour',
                      app.setting_num('rate.signals_per_hour', 60)) then
    raise exception 'too many ratings from this network' using errcode = 'PT429';
  end if;
  insert into public.fairness_ratings (session_id, case_id, case_version, side_id, rating)
  values (sess.id, sess.case_id, sess.case_version, p_side_id, p_rating)
  on conflict (session_id) do update set side_id = excluded.side_id, rating = excluded.rating, created_at = now();
  perform app.check_fairness(sess.case_id, sess.case_version);
  return jsonb_build_object('ok', true);
end;
$$;

/** Re-fetches the reveal for an answered step (rate limited: each call recomputes aggregates). */
create or replace function public.get_reveal(p_session_id uuid, p_step_id text)
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
  if not exists (select 1 from public.responses where session_id = sess.id and step_id = p_step_id) then
    raise exception 'commit an answer before seeing the crowd' using errcode = 'PT403';
  end if;
  if app.rate_limited('reveals:' || coalesce(app.request_ip_hash(), sess.ip_hash, 'none'), interval '1 minute',
                      app.setting_num('rate.reveals_per_minute', 240)) then
    raise exception 'too many requests from this network; slow down' using errcode = 'PT429';
  end if;
  return app.reveal(sess, p_step_id, true);
end;
$$;

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
  ip text := app.request_ip_hash();
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
    if app.rate_limited('reveals:' || coalesce(ip, sess.ip_hash, 'none'), interval '1 minute',
                        app.setting_num('rate.reveals_per_minute', 240)) then
      raise exception 'too many requests from this network; slow down' using errcode = 'PT429';
    end if;
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

  if app.rate_limited('responses:' || coalesce(ip, sess.ip_hash, 'none'), interval '1 minute',
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
    -- Only step slots count toward "most steps were too fast".
    select count(*) filter (where excluded and step_id not in ('before', 'after')),
           count(*) filter (where step_id not in ('before', 'after'))
      into fast_steps, step_count
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

-- Fact flags per side: group each step's flags by the flagger's own side (from
-- the fairness question), so the console can show them per side.
create or replace function public.admin_flags_by_side(p_case_id uuid, p_version int)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  perform app.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('step_id', step_id, 'side_id', side_id, 'flags', n) order by step_id, side_id)
    from (
      select f.step_id, coalesce(fr.side_id, 'unrated') as side_id, count(*) as n
      from public.fact_flags f
      join public.sessions s on s.id = f.session_id and not s.excluded
      left join public.fairness_ratings fr on fr.session_id = f.session_id
      where f.case_id = p_case_id and f.case_version = p_version
      group by 1, 2) t), '[]'::jsonb);
end;
$$;
revoke all on function public.admin_flags_by_side(uuid, int) from public, anon;
grant execute on function public.admin_flags_by_side(uuid, int) to authenticated;

-- -----------------------------------------------------------------------------
-- Internal functions are not callable by API roles, except the helpers that
-- RLS-checked (invoker) code paths and column defaults need.
-- -----------------------------------------------------------------------------

revoke execute on all functions in schema app from public, anon, authenticated;
alter default privileges in schema app revoke execute on functions from public;

grant execute on function
  app.actor(),
  app.is_trusted_context(),
  app.next_version(uuid),
  app.case_slug(uuid),
  app.case_live_version(uuid),
  app.transition_allowed(public.case_status, public.case_status),
  app.case_doc_problems(jsonb),
  app.schema_problems(text, jsonb),
  app.doc_content(jsonb),
  app.doc_hash(jsonb),
  app.begin_review_action(),
  app.require_admin(),
  app.staff_version(uuid, int),
  app.with_decision(jsonb, text, int, text, timestamptz),
  app.supersede(uuid, int, int),
  -- used by the generated public_doc column, evaluated as the writing role
  app.pick(jsonb, text[]),
  app.pick_each(jsonb, text[]),
  app.public_layer(jsonb)
to authenticated, service_role;

revoke execute on function public.get_reveal(uuid, text) from public;
grant execute on function public.get_reveal(uuid, text) to anon, authenticated;
