-- Veilo marketplace product records. Supabase holds identity, catalogue, jobs and receipt
-- indexes only; spending reservations, notes and signing stay in the owner's local services.
-- Clients get SELECT through RLS; every write goes through the marketplace API.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

create domain public.base_units as numeric(78, 0) check (value >= 0);

-- ---- identity ------------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now()
);

create table public.wallet_links (
  user_id uuid not null references auth.users (id) on delete cascade,
  chain text not null check (chain = 'solana'),
  address text not null check (address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  verified_at timestamptz not null,
  primary key (user_id, chain, address),
  -- One account per verified wallet address; accounts are never merged implicitly.
  unique (chain, address)
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users (id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  controller_key text check (controller_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  controller_key_id text unique,
  controller_registered_at timestamptz,
  controller_last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---- sellers and catalogue -----------------------------------------------------------------

create table public.seller_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users (id) on delete restrict,
  public_name text not null check (char_length(public_name) between 2 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'suspended')),
  created_at timestamptz not null default now()
);

create table public.seller_payout_versions (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.seller_profiles (id),
  network text not null,
  mint text not null,
  address text not null check (address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  ata text not null check (ata ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  proof_message_digest text not null check (proof_message_digest ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, seller_id)
);

create table public.runtime_versions (
  id text primary key,
  kind text not null check (kind in ('managed_template', 'remote_endpoint')),
  template text,
  model_id text,
  max_output_tokens integer check (max_output_tokens between 1 and 8000),
  max_seconds integer not null check (max_seconds between 1 and 3600),
  description text not null,
  created_at timestamptz not null default now()
);

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.seller_profiles (id),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  status text not null default 'draft' check (status in ('draft', 'in_review', 'published', 'rejected', 'suspended', 'archived')),
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, seller_id)
);

create table public.listing_versions (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null,
  seller_id uuid not null,
  version_no integer not null check (version_no >= 1),
  title text not null,
  summary text not null,
  description text not null,
  runtime_kind text not null check (runtime_kind in ('managed_template', 'remote_endpoint')),
  template text,
  remote_origin text,
  runtime_version_id text not null references public.runtime_versions (id),
  input_schema jsonb not null,
  output_schema jsonb not null,
  price_base_units public.base_units not null,
  network text not null,
  mint text not null,
  decimals smallint not null check (decimals between 0 and 18),
  payout_version_id uuid not null,
  turnaround_minutes integer not null check (turnaround_minutes between 1 and 10080),
  refund_terms text not null,
  data_handling text not null,
  terms_version text not null,
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  review_note text,
  created_at timestamptz not null default now(),
  unique (listing_id, version_no),
  unique (id, listing_id),
  foreign key (listing_id, seller_id) references public.listings (id, seller_id),
  foreign key (payout_version_id, seller_id) references public.seller_payout_versions (id, seller_id)
);

alter table public.listings
  add constraint listings_current_version_fk foreign key (current_version_id, id) references public.listing_versions (id, listing_id);

-- Seller-only runtime instructions never enter the public catalogue projection.
create table private.listing_runtime (
  listing_version_id uuid primary key references public.listing_versions (id),
  seller_instructions text not null default ''
);

-- Sanitized public catalogue, written only by the publish transition.
create table public.catalog_entries (
  listing_id uuid primary key references public.listings (id),
  listing_version_id uuid not null references public.listing_versions (id),
  slug text not null unique,
  seller_name text not null,
  title text not null,
  summary text not null,
  description text not null,
  runtime_kind text not null,
  template text,
  price_base_units public.base_units not null,
  fee_bps integer not null default 0 check (fee_bps = 0),
  network text not null,
  mint text not null,
  decimals smallint not null,
  recipient text not null,
  turnaround_minutes integer not null,
  refund_terms text not null,
  data_handling text not null,
  input_hint text not null,
  output_format text not null,
  published_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('english', title || ' ' || summary || ' ' || description)) stored
);
create index catalog_entries_search_idx on public.catalog_entries using gin (search);

create table public.listing_samples (
  id uuid primary key default gen_random_uuid(),
  listing_version_id uuid not null references public.listing_versions (id),
  title text not null,
  content text not null check (char_length(content) <= 20000),
  published boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---- owner agents (configuration proposals; local control is authoritative) -----------------

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  name text not null check (char_length(name) between 1 and 64),
  purpose text not null check (char_length(purpose) between 1 and 500),
  instructions text not null default '' check (char_length(instructions) <= 8000),
  template text not null default 'generic',
  tools text[] not null default '{}',
  status text not null default 'inactive' check (status in ('inactive', 'active', 'paused', 'revoked', 'archived')),
  discovery_enabled boolean not null default false,
  auto_hire_enabled boolean not null default false,
  config_version integer not null default 1,
  local_agent_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);

create table public.agent_policy_proposals (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null,
  workspace_id uuid not null,
  version integer not null check (version >= 1),
  per_task_cap public.base_units not null,
  per_agent_cap public.base_units not null,
  max_payment public.base_units not null,
  period_hours integer not null check (period_hours between 1 and 8760),
  allowed_listing_ids uuid[] not null default '{}',
  allowed_recipients text[] not null default '{}',
  status text not null default 'proposed' check (status in ('proposed', 'acknowledged', 'rejected', 'superseded')),
  acknowledged_at timestamptz,
  local_policy_version integer,
  created_at timestamptz not null default now(),
  unique (agent_id, version),
  foreign key (agent_id, workspace_id) references public.agents (id, workspace_id)
);

create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null,
  workspace_id uuid not null,
  interval_minutes integer not null check (interval_minutes between 5 and 10080),
  timezone text not null default 'UTC',
  next_run_at timestamptz not null,
  paused boolean not null default false,
  max_concurrent integer not null default 1 check (max_concurrent between 1 and 3),
  created_at timestamptz not null default now(),
  foreign key (agent_id, workspace_id) references public.agents (id, workspace_id)
);

create table public.schedule_occurrences (
  schedule_id uuid not null references public.schedules (id),
  scheduled_for timestamptz not null,
  job_id uuid,
  created_at timestamptz not null default now(),
  primary key (schedule_id, scheduled_for)
);

-- ---- quotes, jobs and execution -------------------------------------------------------------

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  buyer_workspace_id uuid not null references public.workspaces (id),
  seller_id uuid not null references public.seller_profiles (id),
  listing_version_id uuid not null references public.listing_versions (id),
  requesting_agent_id uuid,
  operation_id text not null unique,
  idempotency_key text not null,
  state text not null default 'created' check (state in ('created', 'awaiting_approval', 'awaiting_payment', 'queued', 'running',
    'input_required', 'cancel_requested', 'succeeded', 'cancelled', 'failed', 'delivery_uncertain', 'expired')),
  financial_state text not null default 'quoted' check (financial_state in ('free', 'quoted', 'approval_pending', 'reserved',
    'funding_pending', 'funded', 'settlement_pending', 'settled', 'rejected', 'expired_unpaid', 'funding_uncertain',
    'settlement_uncertain', 'failed_unpaid', 'refund_requested', 'partially_refunded', 'refunded')),
  brief_digest text not null check (brief_digest ~ '^[0-9a-f]{64}$'),
  current_quote_id uuid,
  current_attempt integer not null default 0,
  input_deadline timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (buyer_workspace_id, idempotency_key),
  unique (id, buyer_workspace_id),
  foreign key (requesting_agent_id, buyer_workspace_id) references public.agents (id, workspace_id)
);
create index jobs_buyer_idx on public.jobs (buyer_workspace_id, created_at desc);
create index jobs_seller_idx on public.jobs (seller_id, created_at desc);
create index jobs_state_idx on public.jobs (state) where state in ('queued', 'running', 'awaiting_payment', 'delivery_uncertain');

create table public.quotes (
  id uuid primary key,
  job_id uuid not null,
  buyer_workspace_id uuid not null,
  listing_version_id uuid not null references public.listing_versions (id),
  fields jsonb not null,
  quote_digest text not null unique check (quote_digest ~ '^[0-9a-f]{64}$'),
  base_units public.base_units not null,
  fee_units public.base_units not null check (fee_units = 0),
  total_units public.base_units not null,
  recipient text not null,
  recipient_ata text not null,
  network text not null,
  mint text not null,
  expires_at timestamptz not null,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  check (total_units = base_units + fee_units),
  foreign key (job_id, buyer_workspace_id) references public.jobs (id, buyer_workspace_id)
);
alter table public.jobs add constraint jobs_current_quote_fk foreign key (current_quote_id) references public.quotes (id);

create table public.job_inputs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id),
  kind text not null check (kind in ('brief', 'question', 'response', 'attachment')),
  body text not null default '' check (char_length(body) <= 16000),
  storage_key text,
  created_by text not null check (created_by in ('buyer', 'seller', 'runtime')),
  created_at timestamptz not null default now()
);

create table public.job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id),
  seq integer not null,
  kind text not null,
  from_state text,
  to_state text,
  actor_type text not null check (actor_type in ('buyer', 'seller', 'controller', 'worker', 'operator', 'system')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (job_id, seq)
);

create table private.job_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id),
  attempt_no integer not null,
  lease_generation integer not null,
  lease_token_hash text not null,
  worker_id text not null,
  lease_expires_at timestamptz not null,
  heartbeat_at timestamptz not null,
  state text not null default 'running' check (state in ('running', 'succeeded', 'failed', 'superseded', 'paused')),
  tool_calls integer not null default 0 check (tool_calls <= 8),
  created_at timestamptz not null default now(),
  unique (job_id, attempt_no)
);
-- At most one live attempt per job.
create unique index job_attempts_one_live on private.job_attempts (job_id) where state = 'running';

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id),
  attempt_id uuid not null references private.job_attempts (id),
  bucket text not null,
  object_key text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check (mime_type in ('text/markdown', 'application/json', 'text/plain')),
  bytes integer not null check (bytes between 0 and 20971520),
  validation_state text not null default 'validated' check (validation_state in ('quarantined', 'validated', 'rejected')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (bucket, object_key)
);

-- ---- payments, receipts and earnings --------------------------------------------------------

create table public.payment_operations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.jobs (id),
  quote_id uuid not null unique references public.quotes (id),
  operation_id text not null unique,
  status text not null default 'awaiting_controller' check (status in ('awaiting_controller', 'controller_accepted',
    'controller_rejected', 'paying', 'evidence_submitted', 'settled', 'uncertain', 'failed_unpaid')),
  controller_ref text,
  reject_code text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.chain_receipts (
  id uuid primary key default gen_random_uuid(),
  operation_id text not null unique references public.payment_operations (operation_id),
  job_id uuid not null unique references public.jobs (id),
  network text not null,
  signature text not null,
  instruction_index integer not null check (instruction_index >= 0),
  mint text not null,
  source_owner text,
  recipient_ata text not null,
  amount public.base_units not null,
  finalized_slot bigint not null,
  verified_at timestamptz not null default now(),
  unique (network, signature, instruction_index),
  -- This release forbids one settlement signature funding more than one purchase.
  unique (network, signature)
);

create table public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id),
  receipt_id uuid not null references public.chain_receipts (id),
  amount public.base_units not null check (amount > 0),
  return_address text not null,
  status text not null default 'requested' check (status in ('requested', 'declined', 'approved', 'submitted', 'uncertain', 'finalized')),
  reason text not null check (char_length(reason) between 1 and 2000),
  refund_signature text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.earnings_events (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.seller_profiles (id),
  job_id uuid not null references public.jobs (id),
  receipt_id uuid unique references public.chain_receipts (id),
  refund_id uuid unique references public.refund_requests (id),
  event_type text not null check (event_type in ('payment', 'refund')),
  gross public.base_units not null,
  fee public.base_units not null check (fee = 0),
  refund public.base_units not null,
  network text not null,
  mint text not null,
  created_at timestamptz not null default now(),
  check ((event_type = 'payment' and receipt_id is not null and refund_id is null and refund = 0)
      or (event_type = 'refund' and refund_id is not null and receipt_id is null and gross = 0 and refund > 0))
);

-- ---- connectors -----------------------------------------------------------------------------

create table public.connector_definitions (
  id text primary key,
  title text not null,
  endpoint text not null,
  transport text not null check (transport in ('mcp_http', 'api_adapter')),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  tools jsonb not null,
  risk text not null check (risk in ('read_only', 'mutating')),
  review_status text not null default 'approved' check (review_status in ('pending', 'approved', 'withdrawn')),
  created_at timestamptz not null default now()
);

create table public.connector_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  agent_id uuid,
  connector_id text not null references public.connector_definitions (id),
  tools text[] not null,
  manifest_sha256 text not null,
  credential_ref text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (agent_id, workspace_id) references public.agents (id, workspace_id)
);

-- ---- operational (unexposed) ----------------------------------------------------------------

create table private.idempotency_records (
  principal text not null,
  endpoint text not null,
  key text not null,
  body_digest text not null,
  status integer not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (principal, endpoint, key)
);

create table private.controller_nonces (
  key_id text not null,
  nonce text not null,
  seen_at timestamptz not null default now(),
  primary key (key_id, nonce)
);

create table private.outbox (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  aggregate_id text not null,
  payload jsonb not null,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create table private.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null,
  actor_id text,
  action text not null,
  target text,
  correlation_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- ---- immutability --------------------------------------------------------------------------

create function private.reject_update() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'immutable record: %', tg_table_name using errcode = 'P0001';
end $$;

-- A listing version's content is fixed at creation; review may record one decision while pending.
create function private.guard_listing_version_update() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.review_status <> 'pending' then
    raise exception 'reviewed listing versions are immutable' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'review_status' - 'review_note') is distinct from (to_jsonb(old) - 'review_status' - 'review_note') then
    raise exception 'listing version content is immutable' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger listing_versions_guard before update on public.listing_versions for each row execute function private.guard_listing_version_update();
create trigger listing_versions_no_delete before delete on public.listing_versions for each row execute function private.reject_update();
create trigger seller_payout_versions_immutable before update or delete on public.seller_payout_versions for each row execute function private.reject_update();
create trigger quotes_immutable before delete on public.quotes for each row execute function private.reject_update();
create trigger job_events_immutable before update or delete on public.job_events for each row execute function private.reject_update();
create trigger chain_receipts_immutable before update or delete on public.chain_receipts for each row execute function private.reject_update();
create trigger earnings_events_immutable before update or delete on public.earnings_events for each row execute function private.reject_update();

-- Quote money and recipient fields never change; only retirement may be recorded.
create function private.guard_quote_update() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.fields, new.quote_digest, new.base_units, new.fee_units, new.total_units, new.recipient, new.recipient_ata,
      new.network, new.mint, new.expires_at, new.job_id, new.buyer_workspace_id, new.listing_version_id)
     is distinct from
     (old.fields, old.quote_digest, old.base_units, old.fee_units, old.total_units, old.recipient, old.recipient_ata,
      old.network, old.mint, old.expires_at, old.job_id, old.buyer_workspace_id, old.listing_version_id) then
    raise exception 'quote fields are immutable' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger quotes_guard before update on public.quotes for each row execute function private.guard_quote_update();

-- Participants and listing of a job are fixed at creation.
create function private.guard_job_update() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.buyer_workspace_id, new.seller_id, new.listing_version_id, new.operation_id, new.brief_digest, new.requesting_agent_id)
     is distinct from
     (old.buyer_workspace_id, old.seller_id, old.listing_version_id, old.operation_id, old.brief_digest, old.requesting_agent_id) then
    raise exception 'job participants are immutable' using errcode = 'P0001';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'job version must advance by one' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger jobs_guard before update on public.jobs for each row execute function private.guard_job_update();

-- Cumulative refunds (finalized plus in-flight) never exceed the original receipt.
create function private.guard_refund_capacity() returns trigger language plpgsql set search_path = '' as $$
declare
  paid numeric;
  claimed numeric;
begin
  select amount into paid from public.chain_receipts where id = new.receipt_id for update;
  select coalesce(sum(amount), 0) into claimed from public.refund_requests
    where receipt_id = new.receipt_id and id <> new.id and status in ('approved', 'submitted', 'uncertain', 'finalized');
  if new.status in ('approved', 'submitted', 'uncertain', 'finalized') and claimed + new.amount > paid then
    raise exception 'refunds would exceed the settled amount' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger refund_capacity before insert or update on public.refund_requests for each row execute function private.guard_refund_capacity();

-- ---- RLS ------------------------------------------------------------------------------------

create function private.owns_workspace(ws uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspaces w where w.id = ws and w.owner_user_id = (select auth.uid()));
$$;

create function private.is_seller(seller uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.seller_profiles s where s.id = seller and s.owner_user_id = (select auth.uid()));
$$;

create function private.job_participant(job uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.jobs j
    where j.id = job and (private.owns_workspace(j.buyer_workspace_id) or private.is_seller(j.seller_id))
  );
$$;

grant usage on schema private to authenticated;
grant execute on function private.owns_workspace(uuid), private.is_seller(uuid), private.job_participant(uuid) to authenticated;

do $$
declare t text;
begin
  foreach t in array array['profiles', 'wallet_links', 'workspaces', 'seller_profiles', 'seller_payout_versions', 'runtime_versions',
    'listings', 'listing_versions', 'catalog_entries', 'listing_samples', 'agents', 'agent_policy_proposals', 'schedules',
    'schedule_occurrences', 'jobs', 'quotes', 'job_inputs', 'job_events', 'artifacts', 'payment_operations', 'chain_receipts',
    'refund_requests', 'earnings_events', 'connector_definitions', 'connector_grants']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

grant select on public.catalog_entries, public.listing_samples, public.runtime_versions, public.connector_definitions to anon, authenticated;
grant select on public.profiles, public.wallet_links, public.workspaces, public.seller_profiles, public.seller_payout_versions,
  public.listings, public.listing_versions, public.agents, public.agent_policy_proposals, public.schedules, public.schedule_occurrences,
  public.jobs, public.quotes, public.job_inputs, public.job_events, public.artifacts, public.payment_operations, public.chain_receipts,
  public.refund_requests, public.earnings_events, public.connector_grants to authenticated;

create policy catalog_public on public.catalog_entries for select to anon, authenticated using (true);
create policy samples_public on public.listing_samples for select to anon, authenticated using (published);
create policy runtimes_public on public.runtime_versions for select to anon, authenticated using (true);
create policy connectors_public on public.connector_definitions for select to anon, authenticated using (review_status = 'approved');

create policy profiles_own on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy wallet_links_own on public.wallet_links for select to authenticated using (user_id = (select auth.uid()));
create policy workspaces_own on public.workspaces for select to authenticated using (owner_user_id = (select auth.uid()));
create policy sellers_own on public.seller_profiles for select to authenticated using (owner_user_id = (select auth.uid()));
create policy payouts_own on public.seller_payout_versions for select to authenticated using (private.is_seller(seller_id));
create policy listings_own on public.listings for select to authenticated using (private.is_seller(seller_id));
create policy listing_versions_own on public.listing_versions for select to authenticated using (private.is_seller(seller_id));

create policy agents_own on public.agents for select to authenticated using (private.owns_workspace(workspace_id));
create policy proposals_own on public.agent_policy_proposals for select to authenticated using (private.owns_workspace(workspace_id));
create policy schedules_own on public.schedules for select to authenticated using (private.owns_workspace(workspace_id));
create policy occurrences_own on public.schedule_occurrences for select to authenticated
  using (exists (select 1 from public.schedules s where s.id = schedule_id and private.owns_workspace(s.workspace_id)));
create policy grants_own on public.connector_grants for select to authenticated using (private.owns_workspace(workspace_id));

create policy jobs_participants on public.jobs for select to authenticated
  using (private.owns_workspace(buyer_workspace_id) or private.is_seller(seller_id));
create policy quotes_participants on public.quotes for select to authenticated using (private.job_participant(job_id));
create policy job_inputs_participants on public.job_inputs for select to authenticated using (private.job_participant(job_id));
create policy job_events_participants on public.job_events for select to authenticated using (private.job_participant(job_id));
create policy artifacts_participants on public.artifacts for select to authenticated using (private.job_participant(job_id));
create policy payment_ops_participants on public.payment_operations for select to authenticated using (private.job_participant(job_id));
create policy receipts_participants on public.chain_receipts for select to authenticated using (private.job_participant(job_id));
create policy refunds_participants on public.refund_requests for select to authenticated using (private.job_participant(job_id));
create policy earnings_seller on public.earnings_events for select to authenticated using (private.is_seller(seller_id));

-- Indexes on policy predicates and foreign keys.
create index listings_seller_idx on public.listings (seller_id);
create index listing_versions_seller_idx on public.listing_versions (seller_id);
create index agents_workspace_idx on public.agents (workspace_id);
create index proposals_workspace_idx on public.agent_policy_proposals (workspace_id);
create index schedules_workspace_idx on public.schedules (workspace_id);
create index quotes_job_idx on public.quotes (job_id);
create index job_inputs_job_idx on public.job_inputs (job_id);
create index artifacts_job_idx on public.artifacts (job_id);
create index refunds_job_idx on public.refund_requests (job_id);
create index earnings_seller_idx on public.earnings_events (seller_id, created_at desc);
create index grants_workspace_idx on public.connector_grants (workspace_id);
create index payouts_seller_idx on public.seller_payout_versions (seller_id);

-- ---- storage --------------------------------------------------------------------------------

-- Private job files: no client policies, so only the API (after a participant check) can issue
-- short-lived signed URLs. Public samples are published deliberately into their own bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('job-files', 'job-files', false, 20971520, array['text/markdown', 'application/json', 'text/plain']),
       ('listing-samples', 'listing-samples', true, 1048576, array['text/markdown', 'text/plain'])
on conflict (id) do nothing;

insert into public.runtime_versions (id, kind, template, model_id, max_output_tokens, max_seconds, description) values
  ('managed:research-summary:v1', 'managed_template', 'research-summary', 'mistralai/mistral-nemo', 2000, 600, 'Cited research summary from the brief'),
  ('managed:structured-analysis:v1', 'managed_template', 'structured-analysis', 'mistralai/mistral-nemo', 2000, 600, 'Structured analysis with findings and risks'),
  ('managed:content-package:v1', 'managed_template', 'content-package', 'mistralai/mistral-nemo', 3000, 600, 'Three channel drafts and a seven-day plan'),
  ('remote:seller-protocol:v1', 'remote_endpoint', null, null, null, 600, 'Seller-hosted endpoint implementing the Veilo seller protocol');
