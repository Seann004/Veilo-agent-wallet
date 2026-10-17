-- Tool library and workflow agents. Additive only: existing listings, jobs and catalogue rows are
-- unchanged. Workflows are recipes over published tools; every step is still its own purchase
-- made and authorized by the buyer's local controller.

-- ---- tools ----------------------------------------------------------------------------------

-- Tool facts for a listing version. A provider adapter pins its manifest digest at review; a host
-- reporting a different manifest disables the tool until it is reviewed again.
create table public.tool_profiles (
  listing_version_id uuid primary key references public.listing_versions (id),
  seller_id uuid not null references public.seller_profiles (id),
  tool_kind text not null check (tool_kind in ('managed_template', 'remote_endpoint', 'provider_adapter')),
  provider text check (provider in ('higgsfield', 'makeugc', 'zernio')),
  tool_name text check (tool_name ~ '^[a-z][a-z0-9_]{0,39}$'),
  manifest_sha256 text check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  effect text not null check (effect in ('read_only', 'draft_external')),
  io jsonb not null check (jsonb_typeof(io) = 'object'),
  provider_status text not null default 'unknown' check (provider_status in ('unknown', 'configured', 'not_configured', 'manifest_changed')),
  provider_checked_at timestamptz,
  created_at timestamptz not null default now(),
  check ((tool_kind = 'provider_adapter') = (provider is not null and tool_name is not null and manifest_sha256 is not null))
);
create index tool_profiles_seller_idx on public.tool_profiles (seller_id);

create function private.guard_tool_profile() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.listing_version_id, new.seller_id, new.tool_kind, new.provider, new.tool_name, new.manifest_sha256, new.effect, new.io)
     is distinct from (old.listing_version_id, old.seller_id, old.tool_kind, old.provider, old.tool_name, old.manifest_sha256, old.effect, old.io) then
    raise exception 'tool profile terms are immutable';
  end if;
  return new;
end $$;
create trigger tool_profiles_guard before update on public.tool_profiles for each row execute function private.guard_tool_profile();

-- Operator-approved external x402 resources (for example a paid RPC). They pay the resource's own
-- recipient, never a Veilo seller, and each step buys a fixed number of calls at a fixed unit price.
create table public.external_tools (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  title text not null check (char_length(title) between 3 and 80),
  summary text not null check (char_length(summary) between 10 and 300),
  origin text not null check (origin ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  resource_path text not null check (resource_path ~ '^/[A-Za-z0-9._~/-]{0,200}(/\*)?$' and resource_path !~ '(^|/)\.\.?(/|$)'),
  network text not null,
  mint text not null,
  decimals smallint not null check (decimals between 0 and 18),
  pay_to text not null,
  pay_to_ata text not null,
  unit_price_base_units public.base_units not null check (unit_price_base_units > 0),
  calls_per_step integer not null check (calls_per_step between 1 and 100),
  fee_payers text[] not null check (cardinality(fee_payers) between 1 and 4),
  rpc_methods text[],
  io jsonb not null check (jsonb_typeof(io) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'suspended')),
  proposed_by uuid references auth.users (id),
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function private.guard_external_tool() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.id, new.origin, new.resource_path, new.network, new.mint, new.decimals, new.pay_to, new.pay_to_ata, new.unit_price_base_units,
      new.calls_per_step, new.fee_payers, new.rpc_methods, new.io, new.proposed_by, new.created_at)
     is distinct from (old.id, old.origin, old.resource_path, old.network, old.mint, old.decimals, old.pay_to, old.pay_to_ata,
      old.unit_price_base_units, old.calls_per_step, old.fee_payers, old.rpc_methods, old.io, old.proposed_by, old.created_at) then
    raise exception 'external tool terms are immutable; propose a new tool';
  end if;
  return new;
end $$;
create trigger external_tools_guard before update on public.external_tools for each row execute function private.guard_external_tool();

-- ---- workflows ------------------------------------------------------------------------------

create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  creator_user_id uuid not null references auth.users (id),
  seller_id uuid not null references public.seller_profiles (id),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  category text not null check (category in ('research', 'content', 'media', 'social', 'data', 'developer', 'operations')),
  status text not null default 'draft' check (status in ('draft', 'in_review', 'live', 'suspended')),
  current_version_id uuid,
  demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, seller_id)
);
create index workflows_seller_idx on public.workflows (seller_id);

create table public.workflow_versions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null,
  seller_id uuid not null,
  version_no integer not null check (version_no >= 1),
  title text not null,
  summary text not null,
  description text not null,
  safety_promise text not null,
  run_inputs jsonb not null check (jsonb_typeof(run_inputs) = 'array'),
  steps jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 8),
  total_max_base_units public.base_units not null,
  network text not null,
  mint text not null,
  decimals smallint not null,
  payout_version_id uuid not null,
  sample_output text,
  publish_decision text not null check (publish_decision in ('live', 'review')),
  review_status text not null check (review_status in ('not_required', 'pending', 'approved', 'rejected')),
  review_note text,
  created_at timestamptz not null default now(),
  unique (workflow_id, version_no),
  unique (id, workflow_id),
  foreign key (workflow_id, seller_id) references public.workflows (id, seller_id),
  foreign key (payout_version_id, seller_id) references public.seller_payout_versions (id, seller_id)
);
create index workflow_versions_seller_idx on public.workflow_versions (seller_id);

alter table public.workflows
  add constraint workflows_current_version_fk foreign key (current_version_id, id) references public.workflow_versions (id, workflow_id);

create function private.guard_workflow_version() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.review_status, new.review_note) is distinct from (old.review_status, old.review_note) and old.review_status = 'pending'
     and (new.id, new.workflow_id, new.seller_id, new.version_no, new.title, new.summary, new.description, new.safety_promise, new.run_inputs,
          new.steps, new.total_max_base_units, new.network, new.mint, new.decimals, new.payout_version_id, new.sample_output, new.publish_decision)
     is not distinct from (old.id, old.workflow_id, old.seller_id, old.version_no, old.title, old.summary, old.description, old.safety_promise,
          old.run_inputs, old.steps, old.total_max_base_units, old.network, old.mint, old.decimals, old.payout_version_id, old.sample_output,
          old.publish_decision) then
    return new;
  end if;
  raise exception 'workflow versions are immutable';
end $$;
create trigger workflow_versions_guard before update on public.workflow_versions for each row execute function private.guard_workflow_version();

-- Sanitized public catalogue of live workflows, written only by the publish transition.
create table public.workflow_catalog (
  workflow_id uuid primary key references public.workflows (id),
  version_id uuid not null references public.workflow_versions (id),
  slug text not null unique,
  creator_name text not null,
  demo boolean not null,
  category text not null,
  title text not null,
  summary text not null,
  description text not null,
  safety_promise text not null,
  total_base_units public.base_units not null,
  fee_bps integer not null default 0 check (fee_bps = 0),
  network text not null,
  mint text not null,
  decimals smallint not null,
  steps jsonb not null,
  run_inputs jsonb not null,
  sample_output text,
  paid_runs integer not null default 0 check (paid_runs >= 0),
  published_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('english', title || ' ' || summary || ' ' || creator_name || ' ' || description)) stored
);
create index workflow_catalog_search_idx on public.workflow_catalog using gin (search);
create index workflow_catalog_category_idx on public.workflow_catalog (category);

-- A buyer's run of one workflow version under one owner approval. The local controller is the
-- authority; these rows are its outbound projection.
create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_version_id uuid not null references public.workflow_versions (id),
  buyer_workspace_id uuid not null references public.workspaces (id),
  requested_by_agent_id uuid references public.agents (id),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 128),
  approval_digest text not null check (approval_digest ~ '^[0-9a-f]{64}$'),
  terms jsonb not null,
  is_test boolean not null default false,
  status text not null default 'awaiting_approval' check (status in ('awaiting_approval', 'approved', 'running', 'halted', 'failed', 'completed', 'rejected')),
  stop_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (buyer_workspace_id, idempotency_key)
);
create index workflow_runs_workspace_idx on public.workflow_runs (buyer_workspace_id, created_at desc);

create table public.workflow_run_steps (
  run_id uuid not null references public.workflow_runs (id),
  step_index integer not null check (step_index between 0 and 7),
  tool_kind text not null check (tool_kind in ('listing', 'external')),
  tool_id uuid not null,
  max_base_units public.base_units not null,
  job_id uuid unique references public.jobs (id),
  payment_status text not null default 'not_started' check (payment_status in ('not_started', 'quoted', 'paying', 'paid', 'not_paid', 'uncertain')),
  execution_status text not null default 'not_started' check (execution_status in ('not_started', 'running', 'delivered', 'failed', 'not_run')),
  paid_base_units public.base_units,
  funding_signature text,
  merchant_signatures text[] not null default '{}',
  artifact_sha256 text check (artifact_sha256 is null or artifact_sha256 ~ '^[0-9a-f]{64}$'),
  stop_reason text,
  updated_at timestamptz not null default now(),
  primary key (run_id, step_index)
);

-- An owner's "Add to agent": the agent may propose runs of this workflow within its budget. The
-- assignment never authorizes spending; local control still approves each run.
create table public.workflow_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  agent_id uuid not null references public.agents (id),
  workflow_id uuid not null references public.workflows (id),
  budget_base_units public.base_units not null check (budget_base_units > 0),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now()
);
create unique index workflow_assignments_active on public.workflow_assignments (agent_id, workflow_id) where status = 'active';

create function private.guard_assignment() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'revoked' or (new.id, new.workspace_id, new.agent_id, new.workflow_id, new.budget_base_units, new.created_at)
     is distinct from (old.id, old.workspace_id, old.agent_id, old.workflow_id, old.budget_base_units, old.created_at) then
    raise exception 'assignments only move from active to revoked; a new budget is a new assignment';
  end if;
  return new;
end $$;
create trigger workflow_assignments_guard before update on public.workflow_assignments for each row execute function private.guard_assignment();

-- ---- RLS ------------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['tool_profiles', 'external_tools', 'workflows', 'workflow_versions', 'workflow_catalog', 'workflow_runs',
    'workflow_run_steps', 'workflow_assignments']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

grant select on public.tool_profiles, public.external_tools, public.workflow_catalog to anon, authenticated;
grant select on public.workflows, public.workflow_versions, public.workflow_runs, public.workflow_run_steps, public.workflow_assignments to authenticated;

create policy tool_profiles_public on public.tool_profiles for select to anon, authenticated
  using (exists (select 1 from public.catalog_entries c where c.listing_version_id = tool_profiles.listing_version_id));
create policy tool_profiles_own on public.tool_profiles for select to authenticated using (private.is_seller(seller_id));
create policy external_tools_public on public.external_tools for select to anon, authenticated using (status = 'approved');
create policy external_tools_own on public.external_tools for select to authenticated using (proposed_by = (select auth.uid()));
create policy workflow_catalog_public on public.workflow_catalog for select to anon, authenticated using (true);
create policy workflows_own on public.workflows for select to authenticated using (creator_user_id = (select auth.uid()));
create policy workflow_versions_own on public.workflow_versions for select to authenticated using (private.is_seller(seller_id));
create policy workflow_runs_own on public.workflow_runs for select to authenticated using (private.owns_workspace(buyer_workspace_id));
create policy workflow_run_steps_own on public.workflow_run_steps for select to authenticated
  using (exists (select 1 from public.workflow_runs r where r.id = run_id and private.owns_workspace(r.buyer_workspace_id)));
create policy workflow_assignments_own on public.workflow_assignments for select to authenticated using (private.owns_workspace(workspace_id));

-- ---- transitions ----------------------------------------------------------------------------

-- Public description of a version's chain, built from the published tool facts.
create function private.workflow_steps_public(p_steps jsonb) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(
    case when s->>'toolKind' = 'listing' then jsonb_build_object(
      'index', i - 1, 'toolKind', 'listing', 'toolId', s->>'toolId', 'title', c.title, 'sellerName', c.seller_name, 'slug', c.slug,
      'kind', coalesce(tp.tool_kind, c.runtime_kind), 'provider', tp.provider, 'effect', coalesce(tp.effect, 'read_only'),
      'priceBaseUnits', (s->>'maxBaseUnits'), 'recipient', c.recipient, 'inputs', s->'inputs', 'output', tp.io->'output')
    else jsonb_build_object(
      'index', i - 1, 'toolKind', 'external', 'toolId', s->>'toolId', 'title', e.title, 'sellerName', e.origin, 'slug', e.slug,
      'kind', 'external_x402', 'provider', null, 'effect', 'read_only', 'priceBaseUnits', (s->>'maxBaseUnits'), 'recipient', e.pay_to,
      'inputs', s->'inputs', 'output', e.io->'output')
    end order by i), '[]'::jsonb)
  from jsonb_array_elements(p_steps) with ordinality as t(s, i)
  left join public.catalog_entries c on s->>'toolKind' = 'listing' and c.listing_version_id = (s->>'toolId')::uuid
  left join public.tool_profiles tp on s->>'toolKind' = 'listing' and tp.listing_version_id = (s->>'toolId')::uuid
  left join public.external_tools e on s->>'toolKind' = 'external' and e.id = (s->>'toolId')::uuid;
$$;

create function private.publish_workflow_version(p_version uuid) returns void language plpgsql set search_path = '' as $$
declare
  v public.workflow_versions;
  w public.workflows;
  s public.seller_profiles;
begin
  select * into v from public.workflow_versions where id = p_version;
  update public.workflows set status = 'live', current_version_id = v.id, updated_at = now() where id = v.workflow_id returning * into w;
  select * into s from public.seller_profiles where id = w.seller_id;
  insert into public.workflow_catalog (workflow_id, version_id, slug, creator_name, demo, category, title, summary, description, safety_promise,
    total_base_units, network, mint, decimals, steps, run_inputs, sample_output)
  values (w.id, v.id, w.slug, s.public_name, w.demo, w.category, v.title, v.summary, v.description, v.safety_promise, v.total_max_base_units,
    v.network, v.mint, v.decimals, private.workflow_steps_public(v.steps), v.run_inputs, v.sample_output)
  on conflict (workflow_id) do update set version_id = excluded.version_id, slug = excluded.slug, creator_name = excluded.creator_name,
    demo = excluded.demo, category = excluded.category, title = excluded.title, summary = excluded.summary, description = excluded.description,
    safety_promise = excluded.safety_promise, total_base_units = excluded.total_base_units, network = excluded.network, mint = excluded.mint,
    decimals = excluded.decimals, steps = excluded.steps, run_inputs = excluded.run_inputs, sample_output = excluded.sample_output,
    published_at = now();
end $$;

-- Money and tool invariants re-checked in the database. Returns 'live' when every step is a current,
-- approved, published tool; 'review' when one is still pending review. Raises otherwise.
create function private.workflow_decision(p_steps jsonb, p_total numeric, p_safety text, p_network text, p_mint text) returns text
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
      price := lv.price_base_units;
      if lv.network <> p_network or lv.mint <> p_mint then perform private.raise_code('WRONG_NETWORK', 'step tool uses another network or mint'); end if;
    elsif s->>'toolKind' = 'external' then
      select * into e from public.external_tools where id = (s->>'toolId')::uuid;
      if e.id is null or e.status = 'suspended' then perform private.raise_code('SERVICE_NOT_ALLOWED', 'external tool is not available'); end if;
      if e.status = 'pending' then pending := true; end if;
      price := e.unit_price_base_units * e.calls_per_step;
      if e.network <> p_network or e.mint <> p_mint then perform private.raise_code('WRONG_NETWORK', 'external tool uses another network or mint'); end if;
    else
      perform private.raise_code('INVALID_REQUEST', 'unknown step tool kind');
    end if;
    if (s->>'maxBaseUnits')::numeric <> price then perform private.raise_code('PRICE_CHANGED', 'step maximum must equal the tool price'); end if;
    total := total + price;
  end loop;
  if total <> p_total then perform private.raise_code('PRICE_CHANGED', 'total must equal the sum of step maxima'); end if;
  if drafts and char_length(trim(p_safety)) < 10 then perform private.raise_code('INVALID_REQUEST', 'a drafting step needs a safety promise'); end if;
  return case when pending then 'review' else 'live' end;
end $$;

create function public.mk_create_workflow(p_user uuid, p_slug text, p_category text, p_demo boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
  wid uuid;
begin
  select id into sid from public.seller_profiles where owner_user_id = p_user and status <> 'suspended';
  if sid is null then perform private.raise_code('POLICY_DENIED', 'create a creator profile and verify a payout wallet first'); end if;
  insert into public.workflows (creator_user_id, seller_id, slug, category, demo) values (p_user, sid, p_slug, p_category, coalesce(p_demo, false))
  returning id into wid;
  return wid;
end $$;

create function public.mk_create_workflow_version(p_user uuid, p_workflow uuid, v jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  w public.workflows;
  pv public.seller_payout_versions;
  decision text;
  next_no integer;
  vid uuid;
begin
  select * into w from public.workflows where id = p_workflow and creator_user_id = p_user for update;
  if w.id is null then perform private.raise_code('NOT_FOUND', 'workflow not found'); end if;
  if w.status = 'suspended' then perform private.raise_code('POLICY_DENIED', 'workflow is suspended'); end if;
  select * into pv from public.seller_payout_versions where id = (v->>'payoutVersionId')::uuid and seller_id = w.seller_id;
  if pv.id is null or pv.verified_at is null then perform private.raise_code('POLICY_DENIED', 'creator payout wallet is not verified'); end if;
  decision := private.workflow_decision(v->'steps', (v->>'totalMaxBaseUnits')::numeric, v->>'safetyPromise', pv.network, pv.mint);
  select coalesce(max(version_no), 0) + 1 into next_no from public.workflow_versions where workflow_id = w.id;
  insert into public.workflow_versions (workflow_id, seller_id, version_no, title, summary, description, safety_promise, run_inputs, steps,
    total_max_base_units, network, mint, decimals, payout_version_id, sample_output, publish_decision, review_status)
  values (w.id, w.seller_id, next_no, v->>'title', v->>'summary', v->>'description', v->>'safetyPromise', v->'runInputs', v->'steps',
    (v->>'totalMaxBaseUnits')::numeric, pv.network, pv.mint, (v->>'decimals')::smallint, pv.id, v->>'sampleOutput', decision,
    case when decision = 'live' then 'not_required' else 'pending' end)
  returning id into vid;
  return jsonb_build_object('versionId', vid, 'versionNo', next_no, 'decision', decision);
end $$;

-- Publishes a draft version: live immediately when every tool is approved, otherwise into review.
-- A live workflow keeps serving its current version while a newer one waits for review.
create function public.mk_publish_workflow_version(p_user uuid, p_version uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v public.workflow_versions;
  w public.workflows;
  decision text;
begin
  select * into v from public.workflow_versions where id = p_version;
  select * into w from public.workflows where id = v.workflow_id and creator_user_id = p_user for update;
  if w.id is null then perform private.raise_code('NOT_FOUND', 'workflow version not found'); end if;
  if w.status = 'suspended' then perform private.raise_code('POLICY_DENIED', 'workflow is suspended'); end if;
  if v.review_status = 'rejected' then perform private.raise_code('INVALID_TRANSITION', 'version was rejected'); end if;
  decision := private.workflow_decision(v.steps, v.total_max_base_units, v.safety_promise, v.network, v.mint);
  if decision = 'live' and v.review_status in ('not_required', 'approved') then
    perform private.publish_workflow_version(v.id);
    return 'live';
  end if;
  update public.workflows set status = case when status = 'live' then status else 'in_review' end, updated_at = now() where id = w.id;
  return 'in_review';
end $$;

create function public.mk_review_workflow_version(p_version uuid, p_approve boolean, p_note text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v public.workflow_versions;
begin
  select * into v from public.workflow_versions where id = p_version for update;
  if v.id is null then perform private.raise_code('NOT_FOUND', 'workflow version not found'); end if;
  if v.review_status <> 'pending' then perform private.raise_code('INVALID_TRANSITION', 'version is not awaiting review'); end if;
  update public.workflow_versions set review_status = case when p_approve then 'approved' else 'rejected' end, review_note = p_note where id = v.id;
  if not p_approve then
    update public.workflows set status = case when status = 'live' then status else 'draft' end, updated_at = now() where id = v.workflow_id;
    return 'rejected';
  end if;
  if private.workflow_decision(v.steps, v.total_max_base_units, v.safety_promise, v.network, v.mint) = 'live' then
    perform private.publish_workflow_version(v.id);
    return 'live';
  end if;
  return 'approved_waiting_for_tools';
end $$;

create function public.mk_set_workflow_status(p_workflow uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  w public.workflows;
begin
  if p_status not in ('suspended', 'live') then perform private.raise_code('INVALID_REQUEST', 'operator may suspend or restore'); end if;
  select * into w from public.workflows where id = p_workflow for update;
  if w.id is null then perform private.raise_code('NOT_FOUND', 'workflow not found'); end if;
  if p_status = 'suspended' then
    update public.workflows set status = 'suspended', updated_at = now() where id = w.id;
    delete from public.workflow_catalog where workflow_id = w.id;
    update public.workflow_runs set status = 'halted', stop_reason = 'workflow suspended by the operator', updated_at = now()
     where workflow_version_id in (select id from public.workflow_versions where workflow_id = w.id) and status in ('awaiting_approval', 'approved', 'running');
  else
    if w.current_version_id is null then perform private.raise_code('INVALID_TRANSITION', 'workflow has no published version'); end if;
    perform private.publish_workflow_version(w.current_version_id);
  end if;
end $$;

create function public.mk_propose_external_tool(p_user uuid, t jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare tid uuid;
begin
  insert into public.external_tools (slug, title, summary, origin, resource_path, network, mint, decimals, pay_to, pay_to_ata, unit_price_base_units,
    calls_per_step, fee_payers, rpc_methods, io, proposed_by)
  values (t->>'slug', t->>'title', t->>'summary', t->>'origin', t->>'resourcePath', t->>'network', t->>'mint', (t->>'decimals')::smallint,
    t->>'payTo', t->>'payToAta', (t->>'unitPriceBaseUnits')::numeric, (t->>'callsPerStep')::integer,
    array(select jsonb_array_elements_text(t->'feePayers')),
    case when t ? 'rpcMethods' and jsonb_typeof(t->'rpcMethods') = 'array' then array(select jsonb_array_elements_text(t->'rpcMethods')) else null end,
    t->'io', p_user)
  returning id into tid;
  return tid;
end $$;

-- Suspending a tool removes every live workflow that uses it from the catalogue at once.
create function public.mk_set_external_tool_status(p_tool uuid, p_status text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.external_tools set status = p_status, review_note = coalesce(p_note, review_note), updated_at = now() where id = p_tool;
  if not found then perform private.raise_code('NOT_FOUND', 'external tool not found'); end if;
  if p_status = 'suspended' then
    delete from public.workflow_catalog c using public.workflow_versions v
     where c.version_id = v.id and exists (select 1 from jsonb_array_elements(v.steps) s where s->>'toolKind' = 'external' and s->>'toolId' = p_tool::text);
  end if;
end $$;

create function public.mk_set_tool_profile(p_user uuid, p_version uuid, t jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare lv public.listing_versions;
begin
  select v.* into lv from public.listing_versions v join public.seller_profiles s on s.id = v.seller_id
   where v.id = p_version and s.owner_user_id = p_user;
  if lv.id is null then perform private.raise_code('NOT_FOUND', 'listing version not found'); end if;
  if lv.review_status <> 'pending' then perform private.raise_code('INVALID_TRANSITION', 'tool facts are fixed once a version is reviewed'); end if;
  insert into public.tool_profiles (listing_version_id, seller_id, tool_kind, provider, tool_name, manifest_sha256, effect, io)
  values (lv.id, lv.seller_id, t->>'toolKind', t->>'provider', t->>'toolName', t->>'manifestSha256', t->>'effect', t->'io');
end $$;

-- A seller host reports the manifest it actually runs. A digest that differs from the reviewed one
-- disables the tool (and removes its listing and the workflows that use it from the catalogue).
create function public.mk_report_tool_status(p_seller uuid, p_provider text, p_manifest text, p_configured boolean) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r public.tool_profiles;
  changed integer := 0;
begin
  for r in select * from public.tool_profiles where seller_id = p_seller and provider = p_provider for update loop
    if r.provider_status = 'manifest_changed' then continue; end if;
    if r.manifest_sha256 <> p_manifest then
      update public.tool_profiles set provider_status = 'manifest_changed', provider_checked_at = now() where listing_version_id = r.listing_version_id;
      delete from public.catalog_entries where listing_version_id = r.listing_version_id;
      update public.listings l set status = 'suspended', updated_at = now() from public.listing_versions v where v.id = r.listing_version_id and l.id = v.listing_id;
      delete from public.workflow_catalog c using public.workflow_versions v
       where c.version_id = v.id and exists (select 1 from jsonb_array_elements(v.steps) s where s->>'toolKind' = 'listing' and s->>'toolId' = r.listing_version_id::text);
      changed := changed + 1;
    else
      update public.tool_profiles set provider_status = case when p_configured then 'configured' else 'not_configured' end, provider_checked_at = now()
       where listing_version_id = r.listing_version_id;
    end if;
  end loop;
  return changed;
end $$;

-- ---- runs and assignments -------------------------------------------------------------------

create function public.mk_create_workflow_run(p_workspace uuid, p_version uuid, p_agent uuid, p_idem text, p_terms jsonb, p_digest text, p_test boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  existing public.workflow_runs;
  v public.workflow_versions;
  w public.workflows;
  rid uuid;
  s jsonb;
  i integer := 0;
begin
  select * into existing from public.workflow_runs where buyer_workspace_id = p_workspace and idempotency_key = p_idem;
  if existing.id is not null then
    if existing.approval_digest <> p_digest then perform private.raise_code('IDEMPOTENCY_CONFLICT', 'idempotency key reused with different terms'); end if;
    return jsonb_build_object('runId', existing.id, 'existing', true);
  end if;
  if not exists (select 1 from public.workspaces where id = p_workspace and status = 'active') then
    perform private.raise_code('ACCOUNT_STOPPED', 'workspace is not active');
  end if;
  select * into v from public.workflow_versions where id = p_version;
  select * into w from public.workflows where id = v.workflow_id;
  if v.id is null then perform private.raise_code('NOT_FOUND', 'workflow version not found'); end if;
  if coalesce(p_test, false) then
    -- A creator's test run of their own version, before or after publication.
    if not exists (select 1 from public.workspaces ws where ws.id = p_workspace and ws.owner_user_id = w.creator_user_id) then
      perform private.raise_code('POLICY_DENIED', 'only the creator can test-run an unpublished version');
    end if;
  elsif not exists (select 1 from public.workflow_catalog c where c.version_id = v.id) then
    perform private.raise_code('SERVICE_NOT_ALLOWED', 'workflow version is not live');
  end if;
  if p_agent is not null and not exists (
      select 1 from public.workflow_assignments a where a.agent_id = p_agent and a.workflow_id = w.id and a.status = 'active'
        and a.workspace_id = p_workspace and a.budget_base_units >= v.total_max_base_units) then
    perform private.raise_code('BUDGET_EXCEEDED', 'agent has no assignment covering this workflow total');
  end if;
  if (p_terms->>'workflowVersionId')::uuid <> v.id or (p_terms->>'totalMaxBaseUnits')::numeric <> v.total_max_base_units
     or jsonb_array_length(p_terms->'steps') <> jsonb_array_length(v.steps) then
    perform private.raise_code('PRICE_CHANGED', 'approval terms do not match the workflow version');
  end if;
  insert into public.workflow_runs (workflow_version_id, buyer_workspace_id, requested_by_agent_id, idempotency_key, approval_digest, terms, is_test)
  values (v.id, p_workspace, p_agent, p_idem, p_digest, p_terms, coalesce(p_test, false)) returning id into rid;
  for s in select * from jsonb_array_elements(v.steps) loop
    if (p_terms->'steps'->i->>'toolId') <> s->>'toolId' or (p_terms->'steps'->i->>'maxBaseUnits')::numeric <> (s->>'maxBaseUnits')::numeric then
      perform private.raise_code('PRICE_CHANGED', 'approval step terms do not match the workflow version');
    end if;
    insert into public.workflow_run_steps (run_id, step_index, tool_kind, tool_id, max_base_units)
    values (rid, i, s->>'toolKind', (s->>'toolId')::uuid, (s->>'maxBaseUnits')::numeric);
    i := i + 1;
  end loop;
  return jsonb_build_object('runId', rid, 'existing', false);
end $$;

-- Controller-reported run progress. Steps advance only forward and a terminal run never reopens.
create function public.mk_report_workflow_run(p_workspace uuid, p_run uuid, p_status text, p_stop text, p_steps jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.workflow_runs;
  s jsonb;
begin
  select * into r from public.workflow_runs where id = p_run and buyer_workspace_id = p_workspace for update;
  if r.id is null then perform private.raise_code('NOT_FOUND', 'workflow run not found'); end if;
  if r.status in ('completed', 'failed', 'rejected') and p_status <> r.status then perform private.raise_code('INVALID_TRANSITION', 'run is final'); end if;
  if r.status = 'halted' and p_status not in ('halted', 'approved', 'running', 'failed') then perform private.raise_code('INVALID_TRANSITION', 'halted runs resume only after approval'); end if;
  for s in select * from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb)) loop
    update public.workflow_run_steps set
      payment_status = s->>'paymentStatus',
      execution_status = s->>'executionStatus',
      job_id = coalesce(job_id, nullif(s->>'jobId', '')::uuid),
      paid_base_units = coalesce(nullif(s->>'paidBaseUnits', '')::numeric, paid_base_units),
      funding_signature = coalesce(funding_signature, nullif(s->>'fundingSignature', '')),
      merchant_signatures = case when jsonb_typeof(s->'merchantSignatures') = 'array'
        then array(select jsonb_array_elements_text(s->'merchantSignatures')) else merchant_signatures end,
      artifact_sha256 = coalesce(artifact_sha256, nullif(s->>'artifactSha256', '')),
      stop_reason = nullif(s->>'stopReason', ''),
      updated_at = now()
    where run_id = r.id and step_index = (s->>'index')::integer
      and not (payment_status = 'paid' and s->>'paymentStatus' <> 'paid');
  end loop;
  update public.workflow_runs set status = p_status, stop_reason = p_stop, updated_at = now() where id = r.id;
  if p_status = 'completed' and r.status <> 'completed' and not r.is_test then
    update public.workflow_catalog c set paid_runs = paid_runs + 1 from public.workflow_versions v
     where v.id = r.workflow_version_id and c.workflow_id = v.workflow_id;
  end if;
end $$;

create function public.mk_assign_workflow(p_user uuid, p_agent uuid, p_workflow uuid, p_budget numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  aid uuid;
begin
  select ag.* into a from public.agents ag join public.workspaces w on w.id = ag.workspace_id where ag.id = p_agent and w.owner_user_id = p_user;
  if a.id is null then perform private.raise_code('NOT_FOUND', 'agent not found'); end if;
  if not exists (select 1 from public.workflow_catalog where workflow_id = p_workflow) then perform private.raise_code('SERVICE_NOT_ALLOWED', 'workflow is not live'); end if;
  update public.workflow_assignments set status = 'revoked' where agent_id = p_agent and workflow_id = p_workflow and status = 'active';
  insert into public.workflow_assignments (workspace_id, agent_id, workflow_id, budget_base_units) values (a.workspace_id, a.id, p_workflow, p_budget)
  returning id into aid;
  return aid;
end $$;

create function public.mk_revoke_assignment(p_user uuid, p_assignment uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.workflow_assignments a set status = 'revoked' from public.workspaces w
   where a.id = p_assignment and w.id = a.workspace_id and w.owner_user_id = p_user and a.status = 'active';
  if not found then perform private.raise_code('NOT_FOUND', 'active assignment not found'); end if;
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

revoke all on function private.workflow_steps_public(jsonb), private.publish_workflow_version(uuid),
  private.workflow_decision(jsonb, numeric, text, text, text) from public, anon, authenticated;
