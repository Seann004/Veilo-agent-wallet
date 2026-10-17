-- A workflow-only provider step (Higgsfield) receives only earlier steps' outputs, so a cheap filler
-- step cannot wrap a bare pass-through of the buyer's own text.

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
      if tp.effect = 'draft_external' then drafts := true; end if;
      if tp.provider = 'higgsfield' then
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
  if drafts and char_length(trim(p_safety)) < 10 then perform private.raise_code('INVALID_REQUEST', 'a drafting step needs a safety promise'); end if;
  return case when pending then 'review' else 'live' end;
end $$;
