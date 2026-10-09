-- =============================================================================
-- Fact votes and online takes (mirrored in @sia/dive-engine/local)
-- =============================================================================
--
-- 1. The main question is asked only Before and After. After each fact the
--    reader agrees, is not sure, or disagrees with one statement about it,
--    stored as 100, 50 or 0. A reaction to one fact no longer counts as a
--    change of the reader's whole position.
-- 2. A step's crowd result is the split of those votes. The final result keeps
--    the Before and After distributions, adds the vote split per fact and
--    names the fact the crowd split on most.
-- 3. Cases carry `takes`: how the left, the center and the right tell the
--    story online, each with its claims checked. They are public (the check
--    evidence is not).
-- 4. Seed profiles give a vote mix per fact and shift After from Before.

update app.json_schemas set schema = $schema${"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {"schema_version": {"default": 1, "type": "number", "const": 1}, "id": {"type": "string", "minLength": 1, "maxLength": 64}, "slug": {"type": "string", "maxLength": 80, "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$"}, "title": {"type": "string", "minLength": 1, "maxLength": 160}, "status": {"type": "string", "enum": ["draft", "in_review", "changes_requested", "rejected", "published", "archived"]}, "version": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}, "parent_version": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}, "as_of": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"}, "content_warning": {"type": "string", "minLength": 1, "maxLength": 400}, "question": {"type": "object", "properties": {"prompt": {"type": "string", "minLength": 1, "maxLength": 240}, "scale": {"type": "object", "properties": {"type": {"type": "string", "const": "slider"}, "min": {"type": "number", "const": 0}, "max": {"type": "number", "const": 100}, "left_label": {"type": "string", "minLength": 1, "maxLength": 80}, "right_label": {"type": "string", "minLength": 1, "maxLength": 80}}, "required": ["type", "min", "max", "left_label", "right_label"], "additionalProperties": false}}, "required": ["prompt", "scale"], "additionalProperties": false}, "starting_facts": {"minItems": 1, "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "text": {"type": "string", "minLength": 1, "maxLength": 400}, "source_ids": {"minItems": 1, "type": "array", "items": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}, "confidence": {"type": "string", "enum": ["established", "reported", "disputed", "alleged"]}, "evidence": {"type": "array", "items": {"type": "object", "properties": {"source_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "quote": {"type": "string", "minLength": 1, "maxLength": 1500}}, "required": ["source_id", "quote"], "additionalProperties": false}}}, "required": ["id", "text", "source_ids", "confidence"], "additionalProperties": false}}, "steps": {"minItems": 1, "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "order": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}, "headline": {"type": "string", "minLength": 1, "maxLength": 160}, "body": {"type": "string", "minLength": 1, "maxLength": 450}, "depth": {"default": [], "type": "array", "items": {"oneOf": [{"type": "object", "properties": {"kind": {"type": "string", "const": "document"}, "id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "title": {"type": "string", "minLength": 1, "maxLength": 200}, "summary": {"type": "string", "minLength": 1, "maxLength": 1200}, "source_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}, "required": ["kind", "id", "title", "summary", "source_id"], "additionalProperties": false}, {"type": "object", "properties": {"kind": {"type": "string", "const": "quote"}, "id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "text": {"type": "string", "minLength": 1, "maxLength": 1200}, "speaker": {"type": "string", "minLength": 1, "maxLength": 200}, "context": {"type": "string", "minLength": 1, "maxLength": 400}, "source_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}, "required": ["kind", "id", "text", "speaker", "source_id"], "additionalProperties": false}, {"type": "object", "properties": {"kind": {"type": "string", "const": "timeline"}, "id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "title": {"type": "string", "minLength": 1, "maxLength": 200}, "entries": {"minItems": 1, "type": "array", "items": {"type": "object", "properties": {"date": {"type": "string", "pattern": "^\\d{4}(-(0[1-9]|1[0-2])(-\\d{2})?)?$"}, "text": {"type": "string", "minLength": 1, "maxLength": 400}, "source_ids": {"minItems": 1, "type": "array", "items": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}}, "required": ["date", "text", "source_ids"], "additionalProperties": false}}}, "required": ["kind", "id", "title", "entries"], "additionalProperties": false}, {"type": "object", "properties": {"kind": {"type": "string", "const": "context"}, "id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "title": {"type": "string", "minLength": 1, "maxLength": 200}, "body": {"type": "string", "minLength": 1, "maxLength": 1500}, "source_ids": {"minItems": 1, "type": "array", "items": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}}, "required": ["kind", "id", "title", "body", "source_ids"], "additionalProperties": false}]}}, "favors": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "impact": {"type": "string", "enum": ["low", "medium", "high"]}, "source_ids": {"minItems": 1, "type": "array", "items": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}, "confidence": {"type": "string", "enum": ["established", "reported", "disputed", "alleged"]}, "evidence": {"type": "array", "items": {"type": "object", "properties": {"source_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "quote": {"type": "string", "minLength": 1, "maxLength": 1500}}, "required": ["source_id", "quote"], "additionalProperties": false}}, "micro_poll": {"type": "object", "properties": {"statement": {"type": "string", "minLength": 1, "maxLength": 200}}, "required": ["statement"], "additionalProperties": false}}, "required": ["id", "order", "headline", "body", "depth", "source_ids", "confidence", "micro_poll"], "additionalProperties": false}}, "sides": {"minItems": 2, "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "label": {"type": "string", "minLength": 1, "maxLength": 80}, "steelman": {"type": "string", "minLength": 1, "maxLength": 2000}}, "required": ["id", "label", "steelman"], "additionalProperties": false}}, "takes": {"default": [], "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "lens": {"type": "string", "enum": ["left", "center", "right"]}, "label": {"type": "string", "minLength": 1, "maxLength": 80}, "summary": {"type": "string", "minLength": 1, "maxLength": 600}, "seen_on": {"type": "string", "minLength": 1, "maxLength": 160}, "source_ids": {"minItems": 1, "type": "array", "items": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}, "checks": {"minItems": 1, "maxItems": 6, "type": "array", "items": {"type": "object", "properties": {"claim": {"type": "string", "minLength": 1, "maxLength": 300}, "verdict": {"type": "string", "enum": ["holds_up", "partly", "not_backed", "false", "unknown"]}, "note": {"type": "string", "minLength": 1, "maxLength": 400}, "source_ids": {"minItems": 1, "type": "array", "items": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}, "evidence": {"type": "array", "items": {"type": "object", "properties": {"source_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "quote": {"type": "string", "minLength": 1, "maxLength": 1500}}, "required": ["source_id", "quote"], "additionalProperties": false}}}, "required": ["claim", "verdict", "note", "source_ids"], "additionalProperties": false}}}, "required": ["id", "lens", "label", "summary", "source_ids", "checks"], "additionalProperties": false}}, "open_questions": {"default": [], "type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 400}}, "sources": {"minItems": 1, "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "title": {"type": "string", "minLength": 1, "maxLength": 300}, "publisher": {"type": "string", "minLength": 1, "maxLength": 200}, "url": {"type": "string", "maxLength": 2048, "format": "uri"}, "date": {"type": "string", "pattern": "^\\d{4}(-(0[1-9]|1[0-2])(-\\d{2})?)?$"}, "type": {"type": "string", "enum": ["court_record", "official", "primary", "news", "analysis", "social"]}, "accessed_at": {"type": "string", "format": "date-time", "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}, "quote_excerpt": {"type": "string", "minLength": 1, "maxLength": 1200}}, "required": ["id", "title", "publisher", "url", "date", "type", "accessed_at"], "additionalProperties": false}}, "review": {"default": {"agent_reports": [], "hard_questions": [], "bias_reports": [], "fact_check": [], "open_issues": [], "decisions": []}, "type": "object", "properties": {"pipeline_run_id": {"type": "string", "maxLength": 100}, "rounds": {"type": "integer", "minimum": 0, "maximum": 9007199254740991}, "agent_reports": {"default": [], "type": "array", "items": {"type": "object", "properties": {"agent": {"type": "string", "enum": ["scoper", "researcher", "records_researcher", "drafter", "hard_questions", "red_team", "fact_checker", "editor"]}, "scope": {"type": "string", "maxLength": 64}, "round": {"type": "integer", "minimum": 0, "maximum": 9007199254740991}, "at": {"type": "string", "format": "date-time", "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}, "summary": {"type": "string", "maxLength": 4000}}, "required": ["agent", "round", "at", "summary"], "additionalProperties": false}}, "hard_questions": {"default": [], "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "side_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "question": {"type": "string", "minLength": 1, "maxLength": 600}, "blocking": {"type": "boolean"}, "status": {"type": "string", "enum": ["answered", "open", "not_applicable"]}, "resolution": {"type": "string", "maxLength": 2000}, "step_ids": {"default": [], "type": "array", "items": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}}, "round": {"default": 0, "type": "integer", "minimum": 0, "maximum": 9007199254740991}}, "required": ["id", "question", "blocking", "status", "step_ids", "round"], "additionalProperties": false}}, "bias_reports": {"default": [], "type": "array", "items": {"type": "object", "properties": {"side_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "round": {"type": "integer", "minimum": 0, "maximum": 9007199254740991}, "summary": {"default": "", "type": "string", "maxLength": 4000}, "flags": {"default": [], "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "step_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "kind": {"type": "string", "enum": ["cherry_picking", "loaded_wording", "order_effect", "missing_exculpatory_fact", "missing_damning_fact", "other"]}, "severity": {"type": "string", "enum": ["low", "medium", "high"]}, "note": {"type": "string", "minLength": 1, "maxLength": 2000}, "status": {"type": "string", "enum": ["addressed", "unaddressed", "wont_fix"]}, "resolution": {"type": "string", "maxLength": 2000}}, "required": ["id", "kind", "severity", "note", "status"], "additionalProperties": false}}}, "required": ["side_id", "round", "summary", "flags"], "additionalProperties": false}}, "fact_check": {"default": [], "type": "array", "items": {"type": "object", "properties": {"target": {"type": "string", "minLength": 1, "maxLength": 160}, "claim": {"type": "string", "minLength": 1, "maxLength": 2000}, "source_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "verdict": {"type": "string", "enum": ["supported", "partially_supported", "unsupported", "source_unavailable", "uncited"]}, "quote": {"type": "string", "maxLength": 1500}, "note": {"type": "string", "maxLength": 2000}, "confidence_before": {"type": "string", "enum": ["established", "reported", "disputed", "alleged"]}, "confidence_after": {"type": "string", "enum": ["established", "reported", "disputed", "alleged"]}, "round": {"default": 0, "type": "integer", "minimum": 0, "maximum": 9007199254740991}}, "required": ["target", "claim", "verdict", "round"], "additionalProperties": false}}, "balance": {"type": "object", "properties": {"per_side": {"type": "object", "propertyNames": {"type": "string"}, "additionalProperties": {"type": "integer", "minimum": 0, "maximum": 9007199254740991}}, "neutral": {"type": "integer", "minimum": 0, "maximum": 9007199254740991}, "untagged": {"type": "integer", "minimum": 0, "maximum": 9007199254740991}, "order": {"type": "array", "items": {"type": "string"}}, "warnings": {"type": "array", "items": {"type": "string"}}}, "required": ["per_side", "neutral", "untagged", "order", "warnings"], "additionalProperties": false}, "open_issues": {"default": [], "type": "array", "items": {"type": "object", "properties": {"id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "source": {"type": "string", "enum": ["pipeline", "hard_questions", "red_team", "fact_checker", "editor", "validator", "admin", "user_flags", "fairness"]}, "severity": {"type": "string", "enum": ["low", "medium", "high"]}, "description": {"type": "string", "minLength": 1, "maxLength": 2000}, "step_id": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "resolved": {"default": false, "type": "boolean"}}, "required": ["id", "source", "severity", "description", "resolved"], "additionalProperties": false}}, "decisions": {"default": [], "type": "array", "items": {"type": "object", "properties": {"action": {"type": "string", "enum": ["submitted", "approve_publish", "approve_schedule", "request_changes", "admin_edit", "reject", "archive", "superseded", "scheduled_publish", "unschedule"]}, "actor": {"type": "string", "minLength": 1, "maxLength": 200}, "at": {"type": "string", "format": "date-time", "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}, "version": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}, "notes": {"type": "string", "maxLength": 8000}, "scheduled_for": {"type": "string", "format": "date-time", "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}}, "required": ["action", "actor", "at", "version"], "additionalProperties": false}}}, "required": ["agent_reports", "hard_questions", "bias_reports", "fact_check", "open_issues", "decisions"], "additionalProperties": false}}, "required": ["schema_version", "id", "slug", "title", "status", "version", "as_of", "question", "starting_facts", "steps", "sides", "takes", "open_questions", "sources", "review"], "additionalProperties": false}$schema$::json, updated_at = now() where name = 'case';
update app.json_schemas set schema = $schema${"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {"sessions": {"type": "integer", "minimum": 0, "maximum": 5000}, "before_bins": {"minItems": 10, "maxItems": 10, "type": "array", "items": {"type": "number", "minimum": 0}}, "steps": {"default": {}, "type": "object", "propertyNames": {"type": "string", "maxLength": 64, "pattern": "^[a-z0-9][a-z0-9_-]*$"}, "additionalProperties": {"type": "object", "properties": {"agree": {"type": "number", "minimum": 0}, "unsure": {"type": "number", "minimum": 0}, "disagree": {"type": "number", "minimum": 0}}, "required": ["agree", "unsure", "disagree"], "additionalProperties": false}}, "after": {"type": "object", "properties": {"move_share": {"type": "number", "minimum": 0, "maximum": 1}, "mean_shift": {"type": "number", "minimum": -100, "maximum": 100}, "spread": {"type": "number", "minimum": 0, "maximum": 50}}, "required": ["move_share", "mean_shift", "spread"], "additionalProperties": false}, "fade_after_real_completions": {"default": 500, "type": "integer", "minimum": 1, "maximum": 9007199254740991}, "rng_seed": {"default": 1, "type": "integer", "minimum": -9007199254740991, "maximum": 9007199254740991}, "note": {"type": "string", "maxLength": 2000}}, "required": ["sessions", "before_bins", "steps", "fade_after_real_completions", "rng_seed"], "additionalProperties": false}$schema$::json, updated_at = now() where name = 'seed_profile';

-- -----------------------------------------------------------------------------
-- Public projection: the fact-vote statement and the online takes
-- -----------------------------------------------------------------------------

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
            'micro_poll', app.pick(s -> 'micro_poll', array['statement']))
          order by ord)
        from jsonb_array_elements(case when jsonb_typeof(doc -> 'steps') = 'array' then doc -> 'steps' else '[]'::jsonb end)
             with ordinality as t(s, ord)), '[]'::jsonb),
      'sides', app.pick_each(doc -> 'sides', array['id', 'label', 'steelman']),
      'takes', coalesce((
        select jsonb_agg(
          app.pick(t, array['id', 'lens', 'label', 'summary', 'seen_on', 'source_ids'])
          || jsonb_build_object('checks', app.pick_each(t -> 'checks', array['claim', 'verdict', 'note', 'source_ids']))
          order by ord)
        from jsonb_array_elements(case when jsonb_typeof(doc -> 'takes') = 'array' then doc -> 'takes' else '[]'::jsonb end)
             with ordinality as x(t, ord)), '[]'::jsonb),
      'sources', app.pick_each(doc -> 'sources', array['id', 'title', 'publisher', 'url', 'date', 'type', 'accessed_at', 'quote_excerpt'])
    ))
$$;

alter table public.case_versions
  add column public_doc jsonb generated always as (public.case_public_projection(doc)) stored;
grant select (public_doc) on public.case_versions to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Crowd results
-- -----------------------------------------------------------------------------

/** The crowd's split on one fact: weighted shares of disagree (0), not sure (50) and agree (100). */
create or replace function app.step_crowd(p_case_id uuid, p_version int, p_step_id text, p_include_seed boolean default true)
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  with w as (select app.seed_weight_for(p_case_id, p_version, p_include_seed) as w),
  rows as (
    select r.value, r.is_seed,
           case when r.is_seed then (select w from w) else 1 end::numeric as wt
    from public.responses r
    join public.sessions s on s.id = r.session_id
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
           sum(wt) filter (where value = 100) as agree,
           sum(wt) filter (where value = 50) as unsure,
           sum(wt) filter (where value = 0) as disagree
    from rows
  )
  select jsonb_build_object(
    'step_id', p_step_id,
    'n_real', n_real,
    'n_seed', n_seed,
    'seed_weight', round((select w from w), 4),
    'seeded_share', case when coalesce(total, 0) > 0 then round(coalesce(seed_total, 0) / total, 4) else 0 end,
    'votes', case when coalesce(total, 0) > 0 then jsonb_build_object(
      'agree', round(coalesce(agree, 0) / total, 4),
      'unsure', round(coalesce(unsure, 0) / total, 4),
      'disagree', round(coalesce(disagree, 0) / total, 4)) end
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
           coalesce(sum(d.wt) filter (where r.value = 100), 0) / nullif(sum(d.wt), 0) as agree,
           coalesce(sum(d.wt) filter (where r.value = 50), 0) / nullif(sum(d.wt), 0) as unsure,
           coalesce(sum(d.wt) filter (where r.value = 0), 0) / nullif(sum(d.wt), 0) as disagree
    from done d
    join public.responses r on r.session_id = d.id and r.step_id not in ('before', 'after') and not r.excluded
    group by r.step_id
  ),
  steps as (
    select sl.step_id, sl.step_index, st.agree, st.unsure, st.disagree,
           -- 1 when agree and disagree are even, 0 when everyone is on one side
           case when st.agree is not null
                then 1 - abs(st.agree - st.disagree) end as split
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
                 'votes', case when agree is not null then jsonb_build_object(
                   'agree', round(agree, 4),
                   'unsure', round(unsure, 4),
                   'disagree', round(disagree, 4)) end) order by step_index) from steps), '[]'::jsonb),
    'most_split_step_id', (select step_id from steps where split is not null
                           order by round(split, 4) desc, step_index limit 1)
  )
$$;

/** One reader's answers in order. */
create or replace function app.session_path(p_session_id uuid) returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'answers', coalesce((select jsonb_agg(jsonb_build_object('step_id', step_id, 'value', value) order by step_index)
                         from public.responses where session_id = p_session_id), '[]'::jsonb)
  )
$$;

create or replace function app.reveal(p_session public.sessions, p_step_id text, p_locked boolean) returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  cur public.responses;
  before_value smallint;
begin
  select * into cur from public.responses where session_id = p_session.id and step_id = p_step_id;
  if p_step_id = 'before' then
    return jsonb_build_object('step_id', p_step_id, 'value', cur.value, 'locked', p_locked);
  elsif p_step_id = 'after' then
    -- The After answer is compared with Before, not with the last fact vote.
    select value into before_value from public.responses where session_id = p_session.id and step_id = 'before';
    return jsonb_build_object(
      'step_id', p_step_id, 'value', cur.value, 'previous_value', before_value, 'locked', p_locked,
      'you', app.session_path(p_session.id),
      'crowd', app.final_crowd(p_session.case_id, p_session.case_version, true),
      'version_note', app.version_note(p_session.case_id, p_session.case_version));
  else
    return jsonb_build_object(
      'step_id', p_step_id, 'value', cur.value, 'locked', p_locked,
      'crowd', app.step_crowd(p_session.case_id, p_session.case_version, p_step_id, true),
      'version_note', app.version_note(p_session.case_id, p_session.case_version));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Answers: fact votes are 0, 50 or 100
-- -----------------------------------------------------------------------------

create or replace function app.check_answer_value() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.step_id not in ('before', 'after') and new.value not in (0, 50, 100) then
    raise exception 'a fact vote must be 0 (disagree), 50 (not sure) or 100 (agree)' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger responses_answer_value
  before insert on public.responses
  for each row execute function app.check_answer_value();

-- -----------------------------------------------------------------------------
-- Seeds: a vote mix per fact; After shifts from Before
-- -----------------------------------------------------------------------------

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
  mixes jsonb[];
  sess uuid[];
  r_sess uuid[] := '{}';
  r_step text[] := '{}';
  r_idx int[] := '{}';
  r_val smallint[] := '{}';
  st bigint;
  r double precision;
  u double precision;
  w double precision;
  before_val double precision;
  val double precision;
  i int;
  j int;
  b int;
  mix jsonb;
  shift jsonb;
  vote_total double precision;
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
  -- Vote mix per step slot (even when the profile has no entry); null for before and after.
  mixes := array(
    select case when s in ('before', 'after') then null
                else coalesce(profile -> 'steps' -> s, '{"agree": 1, "unsure": 1, "disagree": 1}'::jsonb) end
    from unnest(slot_ids) with ordinality as t(s, o) order by o);
  shift := profile -> 'after';

  sess := array(select gen_random_uuid() from generate_series(1, n));
  insert into public.sessions (id, case_id, case_version, device_hash, is_seed, started_at, completed_at)
  select sess[k], p_case_id, p_version, 'seed:' || k, true, at, at from generate_series(1, n) k;

  st := (profile ->> 'rng_seed')::bigint & 4294967295;
  for i in 1..n loop
    -- Before: pick a bin by weight, then a value inside it (sampleBefore).
    st := app.m32_next(st); r := app.m32_value(st) * total;
    before_val := 50;
    for b in 1..10 loop
      r := r - bins[b];
      if r <= 0 then
        st := app.m32_next(st);
        before_val := app.js_round((b - 1) * 10 + app.m32_value(st) * (case when b = 10 then 10 else 9 end));
        exit;
      end if;
    end loop;

    for j in 1..cardinality(slot_ids) loop
      if slot_ids[j] = 'before' then
        val := before_val;
      elsif slot_ids[j] = 'after' then
        -- applyShift from Before: move with probability move_share, by mean_shift + N(0,1) * spread.
        val := before_val;
        if shift is not null and jsonb_typeof(shift) = 'object' then
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
      else
        -- sampleVote: pick disagree, not sure or agree by weight.
        mix := mixes[j];
        vote_total := (mix ->> 'agree')::double precision + (mix ->> 'unsure')::double precision
                      + (mix ->> 'disagree')::double precision;
        st := app.m32_next(st); r := app.m32_value(st) * vote_total;
        r := r - (mix ->> 'disagree')::double precision;
        if r <= 0 then val := 0;
        else
          r := r - (mix ->> 'unsure')::double precision;
          if r <= 0 then val := 50; else val := 100; end if;
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

revoke all on function app.check_answer_value() from public, anon, authenticated;
