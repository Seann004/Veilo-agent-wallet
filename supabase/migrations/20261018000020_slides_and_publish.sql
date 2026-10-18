-- Slide rendering and public TikTok publishing as provider tools. `publish_external` names a tool
-- that publishes publicly with no human step; like a drafting tool it needs a safety promise. The
-- slide renderer and the publisher are workflow-only: they take their inputs only from earlier
-- steps and are never hired on their own.

alter table public.tool_profiles drop constraint tool_profiles_provider_check;
alter table public.tool_profiles add constraint tool_profiles_provider_check
  check (provider in ('higgsfield', 'makeugc', 'zernio', 'slides', 'zernio_publish'));
alter table public.tool_profiles drop constraint tool_profiles_effect_check;
alter table public.tool_profiles add constraint tool_profiles_effect_check
  check (effect in ('read_only', 'draft_external', 'publish_external'));

create or replace function private.workflow_decision(p_steps jsonb, p_total numeric, p_safety text, p_network text, p_mint text) returns text
language plpgsql stable set search_path = '' as $$
declare
  s jsonb;
  pending boolean := false;
  drafts boolean := false;
  total numeric := 0;
  price numeric;
  c public.catalog_entries;
  lv public.listing_versions;
  e public.external_tools;
  tp public.tool_profiles;
  workflow_only boolean := false;
  other_steps integer := 0;
  cd public.connector_definitions;
begin
  for s in select * from jsonb_array_elements(p_steps) loop
    if s->>'toolKind' = 'listing' then
      select * into lv from public.listing_versions where id = (s->>'toolId')::uuid;
      if lv.id is null then perform private.raise_code('INVALID_REQUEST', 'step tool not found'); end if;
      select * into c from public.catalog_entries where listing_version_id = lv.id;
      if c.listing_id is null then
        if lv.review_status <> 'pending' then perform private.raise_code('SERVICE_NOT_ALLOWED', 'step tool version is unpublished or superseded'); end if;
        pending := true;
      end if;
      select * into tp from public.tool_profiles where listing_version_id = lv.id;
      if tp.provider_status = 'manifest_changed' then perform private.raise_code('SERVICE_NOT_ALLOWED', 'step tool manifest changed; awaiting re-review'); end if;
      if tp.effect in ('draft_external', 'publish_external') then drafts := true; end if;
      if tp.mcp_connector_id is not null then
        select * into cd from public.connector_definitions where id = tp.mcp_connector_id;
        if cd.id is null or cd.review_status <> 'approved' or cd.risk <> 'read_only' then
          perform private.raise_code('SERVICE_NOT_ALLOWED', 'step uses an MCP connector that is not approved and read-only');
        end if;
      end if;
      if tp.provider in ('higgsfield', 'slides', 'zernio_publish') then
        workflow_only := true;
        -- Its inputs must come from an earlier step's output, never straight from the buyer or fixed text.
        if exists (select 1 from jsonb_each(coalesce(s->'inputs', '{}'::jsonb)) as i(k, v) where v->>'from' is distinct from 'step')
           or jsonb_typeof(s->'inputs') is distinct from 'object' or s->'inputs' = '{}'::jsonb then
          perform private.raise_code('INVALID_REQUEST', 'a workflow-only provider takes its inputs only from earlier steps');
        end if;
      else
        other_steps := other_steps + 1;
      end if;
      price := lv.price_base_units;
      if lv.network <> p_network or lv.mint <> p_mint then perform private.raise_code('WRONG_NETWORK', 'step tool uses another network or mint'); end if;
    elsif s->>'toolKind' = 'external' then
      select * into e from public.external_tools where id = (s->>'toolId')::uuid;
      if e.id is null or e.status = 'suspended' then perform private.raise_code('SERVICE_NOT_ALLOWED', 'external tool is not available'); end if;
      if e.status = 'pending' then pending := true; end if;
      other_steps := other_steps + 1;
      price := e.unit_price_base_units * e.calls_per_step;
      if e.network <> p_network or e.mint <> p_mint then perform private.raise_code('WRONG_NETWORK', 'external tool uses another network or mint'); end if;
    else
      perform private.raise_code('INVALID_REQUEST', 'unknown step tool kind');
    end if;
    if (s->>'maxBaseUnits')::numeric <> price then perform private.raise_code('PRICE_CHANGED', 'step maximum must equal the tool price'); end if;
    total := total + price;
  end loop;
  if total <> p_total then perform private.raise_code('PRICE_CHANGED', 'total must equal the sum of step maxima'); end if;
  if workflow_only and other_steps = 0 then
    perform private.raise_code('INVALID_REQUEST', 'a workflow-only provider needs at least one other step in the workflow');
  end if;
  if drafts and char_length(trim(p_safety)) < 10 then perform private.raise_code('INVALID_REQUEST', 'a drafting or publishing step needs a safety promise'); end if;
  return case when pending then 'review' else 'live' end;
end $$;
