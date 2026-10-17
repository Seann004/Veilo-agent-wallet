-- Marketplace state transitions. Each function runs in one transaction, locks the rows it
-- changes and is executable only by the server role; the API authenticates the actor first.

create table private.job_transition (
  from_state text not null,
  to_state text not null,
  primary key (from_state, to_state)
);
insert into private.job_transition values
  ('created', 'awaiting_approval'), ('created', 'cancelled'), ('created', 'expired'),
  ('awaiting_approval', 'awaiting_payment'), ('awaiting_approval', 'cancelled'), ('awaiting_approval', 'expired'),
  ('awaiting_payment', 'queued'), ('awaiting_payment', 'cancelled'), ('awaiting_payment', 'expired'), ('awaiting_payment', 'failed'),
  ('queued', 'running'), ('queued', 'cancel_requested'), ('queued', 'failed'),
  ('running', 'succeeded'), ('running', 'input_required'), ('running', 'failed'), ('running', 'delivery_uncertain'),
  ('running', 'cancel_requested'), ('running', 'queued'),
  ('input_required', 'running'), ('input_required', 'queued'), ('input_required', 'cancel_requested'), ('input_required', 'expired'),
  ('input_required', 'failed'),
  ('cancel_requested', 'cancelled'), ('cancel_requested', 'succeeded'), ('cancel_requested', 'failed'), ('cancel_requested', 'delivery_uncertain'),
  ('delivery_uncertain', 'succeeded'), ('delivery_uncertain', 'failed');

create function private.raise_code(code text, msg text) returns void language plpgsql set search_path = '' as $$
begin
  raise exception '%: %', code, msg using errcode = 'P0001';
end $$;

create function private.append_event(p_job uuid, p_kind text, p_from text, p_to text, p_actor text, p_payload jsonb)
returns void language plpgsql set search_path = '' as $$
begin
  insert into public.job_events (job_id, seq, kind, from_state, to_state, actor_type, payload)
  values (p_job, coalesce((select max(seq) from public.job_events where job_id = p_job), 0) + 1, p_kind, p_from, p_to, p_actor, coalesce(p_payload, '{}'));
end $$;

-- Moves a locked job; the caller must hold `for update` on the row.
create function private.move_job(p_job public.jobs, p_to text, p_financial text, p_actor text, p_kind text, p_payload jsonb)
returns public.jobs language plpgsql set search_path = '' as $$
declare
  result public.jobs;
begin
  if p_to is not null and p_to <> p_job.state
     and not exists (select 1 from private.job_transition where from_state = p_job.state and to_state = p_to) then
    perform private.raise_code('INVALID_TRANSITION', format('job %s cannot move from %s to %s', p_job.id, p_job.state, p_to));
  end if;
  update public.jobs
     set state = coalesce(p_to, state), financial_state = coalesce(p_financial, financial_state), version = version + 1, updated_at = now()
   where id = p_job.id
  returning * into result;
  perform private.append_event(p_job.id, p_kind, p_job.state, result.state, p_actor, p_payload);
  return result;
end $$;

-- ---- identity --------------------------------------------------------------------------------

create function public.mk_bootstrap_user(p_user uuid, p_address text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
  linked uuid;
begin
  insert into public.profiles (user_id) values (p_user) on conflict do nothing;
  select user_id into linked from public.wallet_links where chain = 'solana' and address = p_address;
  if linked is null then
    insert into public.wallet_links (user_id, chain, address, verified_at) values (p_user, 'solana', p_address, now());
  elsif linked <> p_user then
    perform private.raise_code('FORBIDDEN', 'wallet is linked to another account');
  end if;
  insert into public.workspaces (owner_user_id) values (p_user) on conflict (owner_user_id) do nothing;
  select id into ws from public.workspaces where owner_user_id = p_user;
  return jsonb_build_object('workspaceId', ws);
end $$;

create function public.mk_register_controller(p_user uuid, p_key text, p_key_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.workspaces
     set controller_key = p_key, controller_key_id = p_key_id, controller_registered_at = now()
   where owner_user_id = p_user and status = 'active';
  if not found then perform private.raise_code('NOT_FOUND', 'active workspace not found'); end if;
  insert into private.audit_events (actor_type, actor_id, action, target, metadata)
  values ('buyer', p_user::text, 'controller.registered', p_key_id, jsonb_build_object('key', p_key));
end $$;

-- Returns false when the nonce was already used by this key.
create function public.mk_controller_nonce(p_key_id text, p_nonce text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.controller_nonces where seen_at < now() - interval '1 day';
  insert into private.controller_nonces (key_id, nonce) values (p_key_id, p_nonce);
  update public.workspaces set controller_last_seen_at = now() where controller_key_id = p_key_id;
  return true;
exception when unique_violation then
  return false;
end $$;

-- ---- sellers and listings --------------------------------------------------------------------

create function public.mk_upsert_seller(p_user uuid, p_name text, p_description text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
begin
  insert into public.seller_profiles (owner_user_id, public_name, description) values (p_user, p_name, p_description)
  on conflict (owner_user_id) do update set public_name = excluded.public_name, description = excluded.description
  returning id into sid;
  return sid;
end $$;

create function public.mk_add_payout(p_user uuid, p_network text, p_mint text, p_address text, p_ata text, p_digest text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
  pid uuid;
begin
  select id into sid from public.seller_profiles where owner_user_id = p_user;
  if sid is null then perform private.raise_code('NOT_FOUND', 'seller profile not found'); end if;
  insert into public.seller_payout_versions (seller_id, network, mint, address, ata, proof_message_digest, verified_at)
  values (sid, p_network, p_mint, p_address, p_ata, p_digest, now()) returning id into pid;
  return pid;
end $$;

create function public.mk_create_listing(p_user uuid, p_slug text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
  lid uuid;
begin
  select id into sid from public.seller_profiles where owner_user_id = p_user;
  if sid is null then perform private.raise_code('NOT_FOUND', 'seller profile not found'); end if;
  insert into public.listings (seller_id, slug) values (sid, p_slug) returning id into lid;
  return lid;
exception when unique_violation then
  perform private.raise_code('IDEMPOTENCY_CONFLICT', 'slug already taken');
  return null;
end $$;

create function public.mk_create_listing_version(p_user uuid, p_listing uuid, v jsonb, p_seller_instructions text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
  vid uuid;
  next_no integer;
begin
  select l.seller_id into sid from public.listings l join public.seller_profiles s on s.id = l.seller_id
   where l.id = p_listing and s.owner_user_id = p_user for update of l;
  if sid is null then perform private.raise_code('NOT_FOUND', 'listing not found'); end if;
  select coalesce(max(version_no), 0) + 1 into next_no from public.listing_versions where listing_id = p_listing;
  insert into public.listing_versions (listing_id, seller_id, version_no, title, summary, description, runtime_kind, template,
    remote_origin, runtime_version_id, input_schema, output_schema, price_base_units, network, mint, decimals, payout_version_id,
    turnaround_minutes, refund_terms, data_handling, terms_version)
  values (p_listing, sid, next_no, v->>'title', v->>'summary', v->>'description', v->>'runtimeKind', v->>'template',
    v->>'remoteOrigin', v->>'runtimeVersionId', v->'inputSchema', v->'outputSchema', (v->>'priceBaseUnits')::numeric,
    v->>'network', v->>'mint', (v->>'decimals')::smallint, (v->>'payoutVersionId')::uuid, (v->>'turnaroundMinutes')::integer,
    v->>'refundTerms', v->>'dataHandling', v->>'termsVersion')
  returning id into vid;
  insert into private.listing_runtime (listing_version_id, seller_instructions) values (vid, coalesce(p_seller_instructions, ''));
  update public.listings set status = case when status = 'published' then status else 'draft' end, updated_at = now() where id = p_listing;
  return vid;
end $$;

create function public.mk_submit_review(p_user uuid, p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.listings l set status = case when l.status = 'published' then l.status else 'in_review' end, updated_at = now()
    from public.listing_versions v, public.seller_profiles s
   where v.id = p_version and v.listing_id = l.id and s.id = l.seller_id and s.owner_user_id = p_user and v.review_status = 'pending';
  if not found then perform private.raise_code('NOT_FOUND', 'pending listing version not found'); end if;
end $$;

create function public.mk_set_seller_status(p_seller uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.seller_profiles set status = p_status where id = p_seller;
  if not found then perform private.raise_code('NOT_FOUND', 'seller not found'); end if;
  if p_status = 'suspended' then
    delete from public.catalog_entries c using public.listings l where c.listing_id = l.id and l.seller_id = p_seller;
    update public.listings set status = 'suspended', updated_at = now() where seller_id = p_seller and status = 'published';
  end if;
end $$;

-- Operator review. Approval publishes the version as the listing's current catalogue entry.
create function public.mk_review_version(p_version uuid, p_approve boolean, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.listing_versions;
  s public.seller_profiles;
  p public.seller_payout_versions;
  l public.listings;
begin
  select * into v from public.listing_versions where id = p_version for update;
  if v.id is null then perform private.raise_code('NOT_FOUND', 'listing version not found'); end if;
  if v.review_status <> 'pending' then perform private.raise_code('INVALID_TRANSITION', 'version already reviewed'); end if;
  update public.listing_versions set review_status = case when p_approve then 'approved' else 'rejected' end, review_note = p_note where id = p_version;
  if not p_approve then
    update public.listings set status = case when status = 'published' then status else 'rejected' end, updated_at = now() where id = v.listing_id;
    return;
  end if;
  select * into s from public.seller_profiles where id = v.seller_id;
  if s.status <> 'approved' then perform private.raise_code('POLICY_DENIED', 'seller is not approved'); end if;
  select * into p from public.seller_payout_versions where id = v.payout_version_id;
  update public.listings set status = 'published', current_version_id = v.id, updated_at = now() where id = v.listing_id returning * into l;
  insert into public.catalog_entries (listing_id, listing_version_id, slug, seller_name, title, summary, description, runtime_kind, template,
    price_base_units, network, mint, decimals, recipient, turnaround_minutes, refund_terms, data_handling, input_hint, output_format)
  values (l.id, v.id, l.slug, s.public_name, v.title, v.summary, v.description, v.runtime_kind, v.template, v.price_base_units, v.network,
    v.mint, v.decimals, p.address, v.turnaround_minutes, v.refund_terms, v.data_handling, coalesce(v.input_schema->>'briefHint', ''),
    coalesce(v.output_schema->>'format', 'markdown'))
  on conflict (listing_id) do update set listing_version_id = excluded.listing_version_id, slug = excluded.slug, seller_name = excluded.seller_name,
    title = excluded.title, summary = excluded.summary, description = excluded.description, runtime_kind = excluded.runtime_kind,
    template = excluded.template, price_base_units = excluded.price_base_units, network = excluded.network, mint = excluded.mint,
    decimals = excluded.decimals, recipient = excluded.recipient, turnaround_minutes = excluded.turnaround_minutes,
    refund_terms = excluded.refund_terms, data_handling = excluded.data_handling, input_hint = excluded.input_hint,
    output_format = excluded.output_format, published_at = now();
end $$;

create function public.mk_set_listing_status(p_listing uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.listings set status = p_status, updated_at = now() where id = p_listing;
  if not found then perform private.raise_code('NOT_FOUND', 'listing not found'); end if;
  if p_status <> 'published' then delete from public.catalog_entries where listing_id = p_listing; end if;
end $$;

-- ---- hiring ----------------------------------------------------------------------------------

-- Creates a job and its immutable quote. The same idempotency key with a different brief or
-- listing version is a conflict; with the same content it returns the existing job.
create function public.mk_create_hire(p_workspace uuid, p_job uuid, p_quote uuid, p_operation text, p_idem text, p_agent uuid,
  p_version uuid, p_brief text, p_brief_digest text, p_fields jsonb, p_digest text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  existing public.jobs;
  c public.catalog_entries;
  v public.listing_versions;
  j public.jobs;
begin
  select * into existing from public.jobs where buyer_workspace_id = p_workspace and idempotency_key = p_idem;
  if existing.id is not null then
    if existing.brief_digest <> p_brief_digest or existing.listing_version_id <> p_version then
      perform private.raise_code('IDEMPOTENCY_CONFLICT', 'idempotency key reused with different content');
    end if;
    return jsonb_build_object('jobId', existing.id, 'existing', true);
  end if;
  if not exists (select 1 from public.workspaces where id = p_workspace and status = 'active') then
    perform private.raise_code('ACCOUNT_STOPPED', 'workspace is not active');
  end if;
  select * into c from public.catalog_entries where listing_version_id = p_version;
  if c.listing_id is null then perform private.raise_code('SERVICE_NOT_ALLOWED', 'listing version is not published'); end if;
  select * into v from public.listing_versions where id = p_version;
  if (p_fields->>'totalUnits')::numeric <> v.price_base_units or p_fields->>'recipient' <> c.recipient
     or p_fields->>'mint' <> v.mint or p_fields->>'network' <> v.network then
    perform private.raise_code('PRICE_CHANGED', 'quote does not match the published listing version');
  end if;
  insert into public.jobs (id, buyer_workspace_id, seller_id, listing_version_id, requesting_agent_id, operation_id, idempotency_key,
    state, financial_state, brief_digest)
  values (p_job, p_workspace, v.seller_id, p_version, p_agent, p_operation, p_idem, 'awaiting_approval', 'approval_pending', p_brief_digest)
  returning * into j;
  insert into public.quotes (id, job_id, buyer_workspace_id, listing_version_id, fields, quote_digest, base_units, fee_units, total_units,
    recipient, recipient_ata, network, mint, expires_at)
  values (p_quote, p_job, p_workspace, p_version, p_fields, p_digest, (p_fields->>'baseUnits')::numeric, (p_fields->>'feeUnits')::numeric,
    (p_fields->>'totalUnits')::numeric, p_fields->>'recipient', p_fields->>'recipientAta', p_fields->>'network', p_fields->>'mint',
    (p_fields->>'expiresAt')::timestamptz);
  update public.jobs set current_quote_id = p_quote, version = version + 1 where id = p_job;
  insert into public.job_inputs (job_id, kind, body, created_by) values (p_job, 'brief', p_brief, 'buyer');
  perform private.append_event(p_job, 'job.created', null, 'awaiting_approval', case when p_agent is null then 'buyer' else 'controller' end,
    jsonb_build_object('quoteId', p_quote, 'requestedByAgent', p_agent is not null));
  return jsonb_build_object('jobId', p_job, 'existing', false);
end $$;

-- Owner intent only. Spending still needs the local controller's own authorization.
create function public.mk_owner_approve(p_user uuid, p_job uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  q public.quotes;
begin
  select j2.* into j from public.jobs j2 join public.workspaces w on w.id = j2.buyer_workspace_id
   where j2.id = p_job and w.owner_user_id = p_user for update of j2;
  if j.id is null then perform private.raise_code('NOT_FOUND', 'job not found'); end if;
  if j.state = 'awaiting_payment' then return; end if;
  select * into q from public.quotes where id = j.current_quote_id;
  if q.expires_at <= now() then perform private.raise_code('QUOTE_EXPIRED', 'quote expired; request a new quote'); end if;
  perform private.move_job(j, 'awaiting_payment', 'approval_pending', 'buyer', 'job.owner_approved', '{}');
  insert into public.payment_operations (job_id, quote_id, operation_id) values (j.id, q.id, j.operation_id) on conflict (job_id) do nothing;
end $$;

create function public.mk_controller_decision(p_workspace uuid, p_operation text, p_accept boolean, p_code text, p_ref text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  op public.payment_operations;
begin
  select * into j from public.jobs where operation_id = p_operation and buyer_workspace_id = p_workspace for update;
  if j.id is null then perform private.raise_code('NOT_FOUND', 'operation not found'); end if;
  select * into op from public.payment_operations where operation_id = p_operation for update;
  if op.status not in ('awaiting_controller', 'controller_accepted', 'controller_rejected') then return; end if;
  if p_accept then
    update public.payment_operations set status = 'controller_accepted', controller_ref = p_ref, updated_at = now() where id = op.id;
    if j.financial_state = 'approval_pending' then perform private.move_job(j, null, 'reserved', 'controller', 'payment.accepted', '{}'); end if;
  else
    update public.payment_operations set status = 'controller_rejected', reject_code = p_code, updated_at = now() where id = op.id;
    if j.state in ('awaiting_payment', 'awaiting_approval') then
      perform private.move_job(j, 'cancelled', 'rejected', 'controller', 'payment.rejected', jsonb_build_object('code', p_code));
    end if;
  end if;
end $$;

create function public.mk_controller_status(p_workspace uuid, p_operation text, p_status text, p_detail text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  op public.payment_operations;
begin
  select * into j from public.jobs where operation_id = p_operation and buyer_workspace_id = p_workspace for update;
  if j.id is null then perform private.raise_code('NOT_FOUND', 'operation not found'); end if;
  select * into op from public.payment_operations where operation_id = p_operation for update;
  if op.status in ('settled', 'controller_rejected') then return; end if;
  update public.payment_operations set status = p_status, updated_at = now() where id = op.id;
  if p_status = 'paying' then
    perform private.move_job(j, null, 'funding_pending', 'controller', 'payment.paying', '{}');
  elsif p_status = 'uncertain' then
    perform private.move_job(j, null, 'settlement_uncertain', 'controller', 'payment.uncertain', jsonb_build_object('detail', p_detail));
  elsif p_status = 'failed_unpaid' and j.state = 'awaiting_payment' then
    perform private.move_job(j, 'failed', 'failed_unpaid', 'controller', 'payment.failed_unpaid', jsonb_build_object('detail', p_detail));
  end if;
end $$;

-- Records a chain-verified receipt, the seller's earnings and the execution authorization in
-- one transaction. Replaying the same receipt is a no-op; a signature already used elsewhere fails.
create function public.mk_record_receipt(p_operation text, p_network text, p_signature text, p_ix integer, p_mint text, p_source text,
  p_ata text, p_amount numeric, p_slot bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  q public.quotes;
  op public.payment_operations;
  r public.chain_receipts;
begin
  select * into op from public.payment_operations where operation_id = p_operation for update;
  if op.id is null then perform private.raise_code('NOT_FOUND', 'payment operation not found'); end if;
  select * into j from public.jobs where id = op.job_id for update;
  select * into r from public.chain_receipts where operation_id = p_operation;
  if r.id is not null then
    if r.signature <> p_signature then perform private.raise_code('IDEMPOTENCY_CONFLICT', 'operation already has a different receipt'); end if;
    return jsonb_build_object('receiptId', r.id, 'existing', true);
  end if;
  select * into q from public.quotes where id = op.quote_id;
  if p_network <> q.network or p_mint <> q.mint or p_ata <> q.recipient_ata or p_amount <> q.total_units then
    perform private.raise_code('SERVICE_NOT_ALLOWED', 'receipt does not match the quote');
  end if;
  insert into public.chain_receipts (operation_id, job_id, network, signature, instruction_index, mint, source_owner, recipient_ata, amount, finalized_slot)
  values (p_operation, j.id, p_network, p_signature, p_ix, p_mint, p_source, p_ata, p_amount, p_slot) returning * into r;
  insert into public.earnings_events (seller_id, job_id, receipt_id, event_type, gross, fee, refund, network, mint)
  values (j.seller_id, j.id, r.id, 'payment', p_amount, 0, 0, p_network, p_mint);
  update public.payment_operations set status = 'settled', updated_at = now() where id = op.id;
  if j.state in ('awaiting_payment', 'awaiting_approval', 'expired', 'cancelled') then
    -- A settled payment always becomes runnable work or a visible paid claim; it is never shown unpaid.
    if j.state = 'awaiting_payment' then
      perform private.move_job(j, 'queued', 'settled', 'system', 'payment.settled', jsonb_build_object('signature', p_signature));
    else
      update public.jobs set financial_state = 'settled', version = version + 1, updated_at = now() where id = j.id;
      perform private.append_event(j.id, 'payment.settled_after_close', j.state, j.state, 'system', jsonb_build_object('signature', p_signature));
    end if;
  else
    perform private.move_job(j, null, 'settled', 'system', 'payment.settled', jsonb_build_object('signature', p_signature));
  end if;
  return jsonb_build_object('receiptId', r.id, 'existing', false);
exception when unique_violation then
  perform private.raise_code('IDEMPOTENCY_CONFLICT', 'settlement signature already funds another purchase');
  return null;
end $$;

-- ---- execution leases ------------------------------------------------------------------------

create function public.mk_claim(p_job uuid, p_worker text, p_token_hash text, p_lease_seconds integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  live private.job_attempts;
  gen integer;
  att private.job_attempts;
begin
  select * into j from public.jobs where id = p_job for update;
  if j.id is null then perform private.raise_code('NOT_FOUND', 'job not found'); end if;
  if j.financial_state not in ('settled', 'free', 'partially_refunded') then perform private.raise_code('NOT_READY', 'payment not settled'); end if;
  select * into live from private.job_attempts where job_id = p_job and state = 'running';
  if live.id is not null then
    if live.lease_expires_at > now() then perform private.raise_code('NOT_READY', 'job already has a live lease'); end if;
    update private.job_attempts set state = 'superseded' where id = live.id;
  end if;
  if j.state not in ('queued', 'running') then perform private.raise_code('NOT_READY', format('job is %s', j.state)); end if;
  select coalesce(max(lease_generation), 0) + 1 into gen from private.job_attempts where job_id = p_job;
  insert into private.job_attempts (job_id, attempt_no, lease_generation, lease_token_hash, worker_id, lease_expires_at, heartbeat_at)
  values (p_job, gen, gen, p_token_hash, p_worker, now() + make_interval(secs => p_lease_seconds), now()) returning * into att;
  if j.state = 'queued' then
    perform private.move_job(j, 'running', null, 'worker', 'attempt.claimed', jsonb_build_object('attempt', gen));
  else
    perform private.append_event(p_job, 'attempt.reclaimed', 'running', 'running', 'worker', jsonb_build_object('attempt', gen));
  end if;
  update public.jobs set current_attempt = gen, version = version + 1, updated_at = now() where id = p_job;
  return jsonb_build_object('attemptId', att.id, 'leaseGeneration', gen, 'leaseExpiresAt', att.lease_expires_at);
end $$;

create function private.live_attempt(p_job uuid, p_attempt uuid, p_token_hash text) returns private.job_attempts
language plpgsql set search_path = '' as $$
declare
  att private.job_attempts;
begin
  select * into att from private.job_attempts where id = p_attempt and job_id = p_job for update;
  if att.id is null or att.lease_token_hash <> p_token_hash then perform private.raise_code('FORBIDDEN', 'lease not recognized'); end if;
  if att.state <> 'running' or att.lease_expires_at <= now()
     or att.lease_generation <> (select max(lease_generation) from private.job_attempts where job_id = p_job) then
    perform private.raise_code('LEASE_LOST', 'lease is no longer live');
  end if;
  return att;
end $$;

create function public.mk_heartbeat(p_job uuid, p_attempt uuid, p_token_hash text, p_lease_seconds integer) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  att private.job_attempts;
begin
  att := private.live_attempt(p_job, p_attempt, p_token_hash);
  update private.job_attempts set heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where id = att.id returning lease_expires_at into att.lease_expires_at;
  return att.lease_expires_at;
end $$;

create function public.mk_complete(p_job uuid, p_attempt uuid, p_token_hash text, p_generation integer, p_status text, p_summary text,
  p_artifacts jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  att private.job_attempts;
  j public.jobs;
  a jsonb;
begin
  select * into j from public.jobs where id = p_job for update;
  att := private.live_attempt(p_job, p_attempt, p_token_hash);
  if att.lease_generation <> p_generation then perform private.raise_code('LEASE_LOST', 'stale lease generation'); end if;
  for a in select * from jsonb_array_elements(p_artifacts) loop
    insert into public.artifacts (id, job_id, attempt_id, bucket, object_key, sha256, mime_type, bytes, validation_state)
    values ((a->>'artifactId')::uuid, p_job, att.id, a->>'bucket', a->>'objectKey', a->>'sha256', a->>'mimeType', (a->>'bytes')::integer, 'validated');
  end loop;
  update private.job_attempts set state = 'succeeded' where id = att.id;
  insert into public.job_inputs (job_id, kind, body, created_by) values (p_job, 'response', p_summary, 'runtime');
  perform private.move_job(j, 'succeeded', null, 'worker', 'attempt.completed',
    jsonb_build_object('attempt', att.lease_generation, 'status', p_status, 'artifacts', jsonb_array_length(p_artifacts)));
end $$;

create function public.mk_fail(p_job uuid, p_attempt uuid, p_token_hash text, p_code text, p_uncertain boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  att private.job_attempts;
  j public.jobs;
begin
  select * into j from public.jobs where id = p_job for update;
  att := private.live_attempt(p_job, p_attempt, p_token_hash);
  update private.job_attempts set state = 'failed' where id = att.id;
  perform private.move_job(j, case when p_uncertain then 'delivery_uncertain' else 'failed' end, null, 'worker', 'attempt.failed',
    jsonb_build_object('code', p_code, 'uncertain', p_uncertain));
end $$;

create function public.mk_request_input(p_job uuid, p_attempt uuid, p_token_hash text, p_question text, p_window_seconds integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  att private.job_attempts;
  j public.jobs;
begin
  select * into j from public.jobs where id = p_job for update;
  att := private.live_attempt(p_job, p_attempt, p_token_hash);
  update private.job_attempts set state = 'paused' where id = att.id;
  insert into public.job_inputs (job_id, kind, body, created_by) values (p_job, 'question', p_question, 'seller');
  j := private.move_job(j, 'input_required', null, 'worker', 'input.requested', '{}');
  update public.jobs set input_deadline = now() + make_interval(secs => p_window_seconds), version = version + 1 where id = p_job;
end $$;

create function public.mk_respond_input(p_user uuid, p_job uuid, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
begin
  select j2.* into j from public.jobs j2 join public.workspaces w on w.id = j2.buyer_workspace_id
   where j2.id = p_job and w.owner_user_id = p_user for update of j2;
  if j.id is null then perform private.raise_code('NOT_FOUND', 'job not found'); end if;
  if j.state <> 'input_required' then perform private.raise_code('INVALID_TRANSITION', 'job is not waiting for input'); end if;
  if j.input_deadline is not null and j.input_deadline <= now() then perform private.raise_code('QUOTE_EXPIRED', 'input window closed'); end if;
  insert into public.job_inputs (job_id, kind, body, created_by) values (p_job, 'response', p_body, 'buyer');
  perform private.move_job(j, 'queued', null, 'buyer', 'input.responded', '{}');
end $$;

create function public.mk_cancel(p_user uuid, p_job uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  op public.payment_operations;
begin
  select j2.* into j from public.jobs j2 join public.workspaces w on w.id = j2.buyer_workspace_id
   where j2.id = p_job and w.owner_user_id = p_user for update of j2;
  if j.id is null then perform private.raise_code('NOT_FOUND', 'job not found'); end if;
  select * into op from public.payment_operations where job_id = p_job for update;
  if j.state in ('created', 'awaiting_approval') or (j.state = 'awaiting_payment' and (op.id is null or op.status = 'awaiting_controller')) then
    if op.id is not null then update public.payment_operations set status = 'controller_rejected', reject_code = 'CANCELLED', updated_at = now() where id = op.id; end if;
    perform private.move_job(j, 'cancelled', 'rejected', 'buyer', 'job.cancelled', '{}');
    return 'cancelled';
  end if;
  if j.state in ('awaiting_payment') then
    -- Payment may already be in flight; the controller decides and the receipt is reconciled.
    perform private.raise_code('SETTLEMENT_UNCERTAIN', 'payment already authorized locally; cancel in the local controller');
  end if;
  if j.state in ('queued', 'running', 'input_required') then
    perform private.move_job(j, 'cancel_requested', null, 'buyer', 'job.cancel_requested', '{}');
    return 'cancel_requested';
  end if;
  perform private.raise_code('INVALID_TRANSITION', format('job is %s', j.state));
  return null;
end $$;

-- Expires unapproved or unpaid jobs whose quotes lapsed, unless the controller already accepted
-- the payment (its outcome must be reconciled, never assumed failed).
create function public.mk_expire_sweep() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  n integer := 0;
begin
  for j in
    select j2.* from public.jobs j2 join public.quotes q on q.id = j2.current_quote_id
     left join public.payment_operations op on op.job_id = j2.id
     where j2.state in ('awaiting_approval', 'awaiting_payment') and q.expires_at <= now()
       and (op.id is null or op.status in ('awaiting_controller', 'controller_rejected'))
     for update of j2 skip locked
  loop
    perform private.move_job(j, 'expired', 'expired_unpaid', 'system', 'job.expired', '{}');
    n := n + 1;
  end loop;
  for j in select * from public.jobs where state = 'input_required' and input_deadline <= now() for update skip locked loop
    perform private.move_job(j, 'expired', null, 'system', 'input.expired', '{}');
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---- refunds ---------------------------------------------------------------------------------

create function public.mk_request_refund(p_user uuid, p_job uuid, p_amount numeric, p_return text, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  r public.chain_receipts;
  rid uuid;
begin
  select j2.* into j from public.jobs j2 join public.workspaces w on w.id = j2.buyer_workspace_id
   where j2.id = p_job and w.owner_user_id = p_user for update of j2;
  if j.id is null then perform private.raise_code('NOT_FOUND', 'job not found'); end if;
  select * into r from public.chain_receipts where job_id = p_job;
  if r.id is null then perform private.raise_code('NOT_READY', 'no settled payment to refund'); end if;
  if not exists (select 1 from public.wallet_links where user_id = p_user and chain = 'solana' and address = p_return) then
    perform private.raise_code('FORBIDDEN', 'return address must be a wallet verified on this account');
  end if;
  insert into public.refund_requests (job_id, receipt_id, amount, return_address, reason) values (p_job, r.id, p_amount, p_return, p_reason)
  returning id into rid;
  perform private.move_job(j, null, 'refund_requested', 'buyer', 'refund.requested', jsonb_build_object('refundId', rid, 'amount', p_amount::text));
  return rid;
end $$;

create function public.mk_refund_decision(p_user uuid, p_refund uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  rr public.refund_requests;
begin
  select r.* into rr from public.refund_requests r join public.jobs j on j.id = r.job_id join public.seller_profiles s on s.id = j.seller_id
   where r.id = p_refund and s.owner_user_id = p_user for update of r;
  if rr.id is null then perform private.raise_code('NOT_FOUND', 'refund request not found'); end if;
  if rr.status <> 'requested' then perform private.raise_code('INVALID_TRANSITION', 'refund already decided'); end if;
  update public.refund_requests set status = case when p_approve then 'approved' else 'declined' end, updated_at = now() where id = p_refund;
  perform private.append_event(rr.job_id, case when p_approve then 'refund.approved' else 'refund.declined' end, null, null, 'seller', '{}');
end $$;

create function public.mk_refund_submitted(p_user uuid, p_refund uuid, p_signature text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.refund_requests r set status = 'submitted', refund_signature = p_signature, updated_at = now()
    from public.jobs j, public.seller_profiles s
   where r.id = p_refund and j.id = r.job_id and s.id = j.seller_id and s.owner_user_id = p_user and r.status in ('approved', 'uncertain');
  if not found then perform private.raise_code('NOT_FOUND', 'approved refund not found'); end if;
end $$;

-- Called after the API verified the refund transfer on chain against this exact request.
create function public.mk_record_refund(p_refund uuid, p_signature text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  rr public.refund_requests;
  j public.jobs;
  r public.chain_receipts;
  refunded numeric;
begin
  select * into rr from public.refund_requests where id = p_refund for update;
  if rr.id is null or rr.refund_signature is distinct from p_signature then perform private.raise_code('NOT_FOUND', 'submitted refund not found'); end if;
  if rr.status = 'finalized' then return; end if;
  update public.refund_requests set status = 'finalized', updated_at = now() where id = p_refund;
  select * into j from public.jobs where id = rr.job_id for update;
  select * into r from public.chain_receipts where id = rr.receipt_id;
  insert into public.earnings_events (seller_id, job_id, refund_id, event_type, gross, fee, refund, network, mint)
  values (j.seller_id, j.id, rr.id, 'refund', 0, 0, rr.amount, r.network, r.mint);
  select coalesce(sum(amount), 0) into refunded from public.refund_requests where receipt_id = r.id and status = 'finalized';
  perform private.move_job(j, null, case when refunded >= r.amount then 'refunded' else 'partially_refunded' end, 'system', 'refund.finalized',
    jsonb_build_object('refundId', rr.id, 'signature', p_signature));
end $$;

-- ---- agents and policy proposals ------------------------------------------------------------

create function public.mk_create_agent(p_user uuid, a jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
  aid uuid;
begin
  select id into ws from public.workspaces where owner_user_id = p_user and status = 'active';
  if ws is null then perform private.raise_code('NOT_FOUND', 'active workspace not found'); end if;
  insert into public.agents (workspace_id, name, purpose, instructions, template, tools, discovery_enabled, auto_hire_enabled)
  values (ws, a->>'name', a->>'purpose', coalesce(a->>'instructions', ''), coalesce(a->>'template', 'generic'),
    coalesce(array(select jsonb_array_elements_text(a->'tools')), '{}'), coalesce((a->>'discoveryEnabled')::boolean, false),
    coalesce((a->>'autoHireEnabled')::boolean, false))
  returning id into aid;
  return aid;
end $$;

create function public.mk_propose_policy(p_user uuid, p_agent uuid, p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  ag public.agents;
  next_v integer;
begin
  select a.* into ag from public.agents a join public.workspaces w on w.id = a.workspace_id
   where a.id = p_agent and w.owner_user_id = p_user for update of a;
  if ag.id is null then perform private.raise_code('NOT_FOUND', 'agent not found'); end if;
  update public.agent_policy_proposals set status = 'superseded' where agent_id = p_agent and status = 'proposed';
  select coalesce(max(version), 0) + 1 into next_v from public.agent_policy_proposals where agent_id = p_agent;
  insert into public.agent_policy_proposals (agent_id, workspace_id, version, per_task_cap, per_agent_cap, max_payment, period_hours,
    allowed_listing_ids, allowed_recipients)
  values (p_agent, ag.workspace_id, next_v, (p->>'perTaskCap')::numeric, (p->>'perAgentCap')::numeric, (p->>'maxPayment')::numeric,
    (p->>'periodHours')::integer, coalesce(array(select jsonb_array_elements_text(p->'allowedListingIds'))::uuid[], '{}'),
    coalesce(array(select jsonb_array_elements_text(p->'allowedRecipients')), '{}'));
  -- An agent stays inactive until the controller acknowledges a policy.
  update public.agents set status = case when status = 'active' then 'inactive' else status end, config_version = config_version + 1,
    updated_at = now() where id = p_agent;
  return next_v;
end $$;

create function public.mk_ack_policy(p_workspace uuid, p_agent uuid, p_version integer, p_accept boolean, p_local_version integer, p_local_agent text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.agent_policy_proposals
     set status = case when p_accept then 'acknowledged' else 'rejected' end, acknowledged_at = now(), local_policy_version = p_local_version
   where agent_id = p_agent and workspace_id = p_workspace and version = p_version and status = 'proposed';
  if not found then perform private.raise_code('NOT_FOUND', 'pending proposal not found'); end if;
  if p_accept then
    update public.agents set status = 'active', local_agent_id = coalesce(p_local_agent, local_agent_id), updated_at = now()
     where id = p_agent and status in ('inactive', 'paused');
  end if;
end $$;

create function public.mk_set_agent_status(p_user uuid, p_agent uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('paused', 'revoked', 'archived') then perform private.raise_code('INVALID_REQUEST', 'owners may only pause, revoke or archive'); end if;
  update public.agents a set status = p_status, updated_at = now() from public.workspaces w
   where a.id = p_agent and w.id = a.workspace_id and w.owner_user_id = p_user;
  if not found then perform private.raise_code('NOT_FOUND', 'agent not found'); end if;
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
