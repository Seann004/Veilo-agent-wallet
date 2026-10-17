-- The quote stored for a hire must agree with the published listing version and its payout
-- version on every money and identity field, not only the ones the API happens to compute.
create or replace function public.mk_create_hire(p_workspace uuid, p_job uuid, p_quote uuid, p_operation text, p_idem text, p_agent uuid,
  p_version uuid, p_brief text, p_brief_digest text, p_fields jsonb, p_digest text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  existing public.jobs;
  c public.catalog_entries;
  v public.listing_versions;
  pv public.seller_payout_versions;
  expires timestamptz;
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
  select * into pv from public.seller_payout_versions where id = v.payout_version_id;
  expires := (p_fields->>'expiresAt')::timestamptz;
  if (p_fields->>'baseUnits')::numeric <> v.price_base_units
     or (p_fields->>'feeUnits')::numeric <> 0
     or (p_fields->>'feeBps')::integer <> 0
     or (p_fields->>'totalUnits')::numeric <> v.price_base_units
     or p_fields->>'recipient' is distinct from pv.address
     or p_fields->>'recipient' is distinct from c.recipient
     or p_fields->>'recipientAta' is distinct from pv.ata
     or p_fields->>'mint' is distinct from v.mint
     or p_fields->>'network' is distinct from v.network
     or (p_fields->>'decimals')::smallint <> v.decimals then
    perform private.raise_code('PRICE_CHANGED', 'quote does not match the published listing version');
  end if;
  if p_fields->>'id' is distinct from p_quote::text or p_fields->>'jobId' is distinct from p_job::text
     or p_fields->>'listingVersionId' is distinct from p_version::text or p_fields->>'buyerWorkspaceId' is distinct from p_workspace::text
     or p_fields->>'operationId' is distinct from p_operation or p_fields->>'inputDigest' is distinct from p_brief_digest
     or p_fields->>'runtimeVersion' is distinct from v.runtime_version_id or p_fields->>'termsVersion' is distinct from v.terms_version then
    perform private.raise_code('INVALID_REQUEST', 'quote identity fields do not match the hire');
  end if;
  if expires <= now() or expires > now() + interval '15 minutes' then
    perform private.raise_code('INVALID_REQUEST', 'quote expiry outside the allowed window');
  end if;
  insert into public.jobs (id, buyer_workspace_id, seller_id, listing_version_id, requesting_agent_id, operation_id, idempotency_key,
    state, financial_state, brief_digest)
  values (p_job, p_workspace, v.seller_id, p_version, p_agent, p_operation, p_idem, 'awaiting_approval', 'approval_pending', p_brief_digest);
  insert into public.quotes (id, job_id, buyer_workspace_id, listing_version_id, fields, quote_digest, base_units, fee_units, total_units,
    recipient, recipient_ata, network, mint, expires_at)
  values (p_quote, p_job, p_workspace, p_version, p_fields, p_digest, v.price_base_units, 0, v.price_base_units,
    pv.address, pv.ata, v.network, v.mint, expires);
  update public.jobs set current_quote_id = p_quote, version = version + 1 where id = p_job;
  insert into public.job_inputs (job_id, kind, body, created_by) values (p_job, 'brief', p_brief, 'buyer');
  perform private.append_event(p_job, 'job.created', null, 'awaiting_approval', case when p_agent is null then 'buyer' else 'controller' end,
    jsonb_build_object('quoteId', p_quote, 'requestedByAgent', p_agent is not null));
  return jsonb_build_object('jobId', p_job, 'existing', false);
end $$;

revoke all on function public.mk_create_hire(uuid, uuid, uuid, text, text, uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.mk_create_hire(uuid, uuid, uuid, text, text, uuid, uuid, text, text, jsonb, text) to service_role;
