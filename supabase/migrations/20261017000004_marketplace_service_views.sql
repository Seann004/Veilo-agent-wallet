-- Server-role helpers for data the REST API must not expose directly.

-- The seller host's view of one job, including seller-only runtime instructions.
create function public.mk_seller_host_job(p_job uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  q public.quotes;
  v public.listing_versions;
  rt public.runtime_versions;
  instr text;
begin
  select * into j from public.jobs where id = p_job;
  if j.id is null then perform private.raise_code('NOT_FOUND', 'job not found'); end if;
  select * into q from public.quotes where id = j.current_quote_id;
  select * into v from public.listing_versions where id = j.listing_version_id;
  select * into rt from public.runtime_versions where id = v.runtime_version_id;
  select seller_instructions into instr from private.listing_runtime where listing_version_id = v.id;
  return jsonb_build_object(
    'jobId', j.id,
    'state', j.state,
    'listingVersionId', v.id,
    'quote', q.fields || jsonb_build_object('quoteDigest', q.quote_digest),
    'runtime', jsonb_build_object(
      'kind', v.runtime_kind,
      'template', v.template,
      'runtimeVersionId', v.runtime_version_id,
      'modelId', rt.model_id,
      'maxOutputTokens', coalesce(rt.max_output_tokens, 2000),
      'sellerInstructions', coalesce(instr, ''),
      'outputFormat', coalesce(v.output_schema->>'format', 'markdown'),
      'sections', coalesce(v.output_schema->'sections', '[]'::jsonb)),
    'inputs', coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'body', i.body, 'createdAt', i.created_at) order by i.created_at)
                        from public.job_inputs i where i.job_id = j.id), '[]'::jsonb));
end $$;

-- A hire proposed through the controller is opened for payment directly: the controller is the
-- local authority and still decides acceptance by local grant or local owner approval.
create function public.mk_controller_open_payment(p_workspace uuid, p_job uuid, p_local_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  q public.quotes;
begin
  select * into j from public.jobs where id = p_job and buyer_workspace_id = p_workspace for update;
  if j.id is null then perform private.raise_code('NOT_FOUND', 'job not found'); end if;
  if j.state = 'awaiting_payment' then return; end if;
  select * into q from public.quotes where id = j.current_quote_id;
  perform private.move_job(j, 'awaiting_payment', 'approval_pending', 'controller', 'job.controller_opened', jsonb_build_object('localAgentId', p_local_agent));
  insert into public.payment_operations (job_id, quote_id, operation_id) values (j.id, q.id, j.operation_id) on conflict (job_id) do nothing;
end $$;

-- Payment requests the controller still has to decide or reconcile.
create function public.mk_controller_requests(p_workspace uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'operationId', j.operation_id,
    'jobId', j.id,
    'quote', q.fields || jsonb_build_object('quoteDigest', q.quote_digest),
    'brief', (select i.body from public.job_inputs i where i.job_id = j.id and i.kind = 'brief' order by i.created_at limit 1),
    'briefDigest', j.brief_digest,
    'listing', jsonb_build_object('listingId', l.id, 'slug', l.slug, 'title', v.title, 'sellerName', s.public_name),
    'requestedBy', jsonb_build_object(
      'kind', case when opened.payload is null then 'owner' else 'agent' end,
      'agentId', j.requesting_agent_id,
      'localAgentId', opened.payload->>'localAgentId'),
    'ownerApprovedAt', (select e.created_at from public.job_events e where e.job_id = j.id and e.kind = 'job.owner_approved' limit 1)
  ) order by j.created_at), '[]'::jsonb)
  from public.jobs j
  join public.payment_operations op on op.job_id = j.id
  join public.quotes q on q.id = op.quote_id
  join public.listing_versions v on v.id = j.listing_version_id
  join public.listings l on l.id = v.listing_id
  join public.seller_profiles s on s.id = j.seller_id
  left join lateral (select e.payload from public.job_events e where e.job_id = j.id and e.kind = 'job.controller_opened' limit 1) opened on true
  where j.buyer_workspace_id = p_workspace and op.status in ('awaiting_controller', 'controller_accepted', 'paying', 'uncertain');
$$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('mk_seller_host_job', 'mk_controller_open_payment', 'mk_controller_requests')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
