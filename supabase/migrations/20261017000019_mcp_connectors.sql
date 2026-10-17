-- Remote MCP connectors. The operator approves a connector's pinned tools (name, description and
-- input schema digests); a seller sells one pinned tool as a remote listing run on its own seller
-- host, which re-reads tools/list before every call and refuses on any drift. Only read-only
-- connectors can be chained in workflows.

alter table public.tool_profiles add column mcp_connector_id text references public.connector_definitions (id);
alter table public.tool_profiles add column mcp_tool_sha256 text check (mcp_tool_sha256 is null or mcp_tool_sha256 ~ '^[0-9a-f]{64}$');
alter table public.tool_profiles add column mcp_args_template jsonb check (mcp_args_template is null or jsonb_typeof(mcp_args_template) = 'object');
alter table public.tool_profiles add constraint tool_profiles_mcp_consistent check (
  (mcp_connector_id is null) = (mcp_tool_sha256 is null)
  and (mcp_connector_id is null) = (mcp_args_template is null)
  and (mcp_connector_id is null or (tool_kind = 'remote_endpoint' and provider is null and tool_name is not null))
);
create index tool_profiles_connector_idx on public.tool_profiles (mcp_connector_id);

alter table public.connector_definitions add column proposed_by uuid references auth.users (id);
alter table public.connector_definitions add column review_note text;
alter table public.connector_definitions add column updated_at timestamptz not null default now();
create policy connectors_own on public.connector_definitions for select to authenticated using (proposed_by = (select auth.uid()));

create or replace function private.guard_tool_profile() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.listing_version_id, new.seller_id, new.tool_kind, new.provider, new.tool_name, new.manifest_sha256, new.effect, new.io,
      new.mcp_connector_id, new.mcp_tool_sha256, new.mcp_args_template)
     is distinct from (old.listing_version_id, old.seller_id, old.tool_kind, old.provider, old.tool_name, old.manifest_sha256, old.effect, old.io,
      old.mcp_connector_id, old.mcp_tool_sha256, old.mcp_args_template) then
    raise exception 'tool profile terms are immutable';
  end if;
  return new;
end $$;

-- Connector terms are fixed once proposed; a changed server is a new connector id.
create function private.guard_connector() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.id, new.endpoint, new.transport, new.manifest_sha256, new.tools, new.risk, new.proposed_by, new.created_at)
     is distinct from (old.id, old.endpoint, old.transport, old.manifest_sha256, old.tools, old.risk, old.proposed_by, old.created_at) then
    raise exception 'connector terms are immutable; propose a new connector';
  end if;
  return new;
end $$;
create trigger connector_definitions_guard before update on public.connector_definitions for each row execute function private.guard_connector();

create function public.mk_propose_connector(p_user uuid, c jsonb, p_manifest text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.connector_definitions (id, title, endpoint, transport, manifest_sha256, tools, risk, review_status, proposed_by)
  values (c->>'id', c->>'title', c->>'endpoint', 'mcp_http', p_manifest, c->'tools', 'read_only', 'pending', p_user);
  return c->>'id';
end $$;

-- Withdrawing a connector removes every listing and live workflow that uses it from the catalogue.
create function public.mk_review_connector(p_id text, p_approve boolean, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.tool_profiles;
begin
  update public.connector_definitions set review_status = case when p_approve then 'approved' else 'withdrawn' end,
    review_note = coalesce(p_note, review_note), updated_at = now() where id = p_id;
  if not found then perform private.raise_code('NOT_FOUND', 'connector not found'); end if;
  if not p_approve then
    for r in select * from public.tool_profiles where mcp_connector_id = p_id loop
      delete from public.catalog_entries where listing_version_id = r.listing_version_id;
      update public.listings l set status = 'suspended', updated_at = now() from public.listing_versions v where v.id = r.listing_version_id and l.id = v.listing_id;
      delete from public.workflow_catalog c using public.workflow_versions v
       where c.version_id = v.id and exists (select 1 from jsonb_array_elements(v.steps) s where s->>'toolKind' = 'listing' and s->>'toolId' = r.listing_version_id::text);
    end loop;
  end if;
end $$;

create function public.mk_set_mcp_tool_profile(p_user uuid, p_version uuid, t jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  lv public.listing_versions;
  cd public.connector_definitions;
  pinned jsonb;
begin
  select v.* into lv from public.listing_versions v join public.seller_profiles s on s.id = v.seller_id
   where v.id = p_version and s.owner_user_id = p_user;
  if lv.id is null then perform private.raise_code('NOT_FOUND', 'listing version not found'); end if;
  if lv.review_status <> 'pending' then perform private.raise_code('INVALID_TRANSITION', 'tool facts are fixed once a version is reviewed'); end if;
  if lv.runtime_kind <> 'remote_endpoint' then perform private.raise_code('INVALID_REQUEST', 'MCP tools run on the seller''s own host'); end if;
  select * into cd from public.connector_definitions where id = t->>'connectorId';
  if cd.id is null or cd.review_status <> 'approved' or cd.risk <> 'read_only' then perform private.raise_code('SERVICE_NOT_ALLOWED', 'connector is not approved and read-only'); end if;
  select x into pinned from jsonb_array_elements(cd.tools) x where x->>'name' = t->>'toolName';
  if pinned is null then perform private.raise_code('INVALID_REQUEST', 'tool is not in the approved connector'); end if;
  insert into public.tool_profiles (listing_version_id, seller_id, tool_kind, provider, tool_name, manifest_sha256, effect, io, mcp_connector_id, mcp_tool_sha256, mcp_args_template)
  values (lv.id, lv.seller_id, 'remote_endpoint', null, t->>'toolName', null, 'read_only', t->'io', cd.id, t->>'toolSha256', t->'argsTemplate');
end $$;

-- A seller host reports the digest of the tool it actually sees; drift disables the tool at once.
create function public.mk_report_mcp_status(p_seller uuid, p_connector text, p_tool text, p_sha text, p_reachable boolean) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r public.tool_profiles;
  changed integer := 0;
begin
  for r in select * from public.tool_profiles where seller_id = p_seller and mcp_connector_id = p_connector and tool_name = p_tool for update loop
    if r.provider_status = 'manifest_changed' then continue; end if;
    if r.mcp_tool_sha256 <> p_sha then
      update public.tool_profiles set provider_status = 'manifest_changed', provider_checked_at = now() where listing_version_id = r.listing_version_id;
      delete from public.catalog_entries where listing_version_id = r.listing_version_id;
      update public.listings l set status = 'suspended', updated_at = now() from public.listing_versions v where v.id = r.listing_version_id and l.id = v.listing_id;
      delete from public.workflow_catalog c using public.workflow_versions v
       where c.version_id = v.id and exists (select 1 from jsonb_array_elements(v.steps) s where s->>'toolKind' = 'listing' and s->>'toolId' = r.listing_version_id::text);
      changed := changed + 1;
    else
      update public.tool_profiles set provider_status = case when p_reachable then 'configured' else 'not_configured' end, provider_checked_at = now()
       where listing_version_id = r.listing_version_id;
    end if;
  end loop;
  return changed;
end $$;

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
      if tp.effect = 'draft_external' then drafts := true; end if;
      if tp.mcp_connector_id is not null then
        select * into cd from public.connector_definitions where id = tp.mcp_connector_id;
        if cd.id is null or cd.review_status <> 'approved' or cd.risk <> 'read_only' then
          perform private.raise_code('SERVICE_NOT_ALLOWED', 'step uses an MCP connector that is not approved and read-only');
        end if;
      end if;
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


do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'mk\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
