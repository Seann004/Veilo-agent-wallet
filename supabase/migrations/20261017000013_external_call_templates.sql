-- External tools declare the exact calls one step makes. A template string "{{name}}" is replaced
-- by that step input as a JSON string value only, so input text can never add calls, methods or
-- structure. A halted run cannot resume while its workflow is suspended or no longer live.

alter table public.external_tools add column call_template jsonb not null default '[]'::jsonb
  check (jsonb_typeof(call_template) = 'array' and jsonb_array_length(call_template) <= 100);

create or replace function private.guard_external_tool() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.id, new.origin, new.resource_path, new.network, new.mint, new.decimals, new.pay_to, new.pay_to_ata, new.unit_price_base_units,
      new.calls_per_step, new.fee_payers, new.rpc_methods, new.io, new.call_template, new.proposed_by, new.created_at)
     is distinct from (old.id, old.origin, old.resource_path, old.network, old.mint, old.decimals, old.pay_to, old.pay_to_ata,
      old.unit_price_base_units, old.calls_per_step, old.fee_payers, old.rpc_methods, old.io, old.call_template, old.proposed_by, old.created_at) then
    raise exception 'external tool terms are immutable; propose a new tool';
  end if;
  return new;
end $$;

create or replace function public.mk_propose_external_tool(p_user uuid, t jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare tid uuid;
begin
  if jsonb_typeof(t->'callTemplate') is distinct from 'array' or jsonb_array_length(t->'callTemplate') <> (t->>'callsPerStep')::integer then
    perform private.raise_code('INVALID_REQUEST', 'the call template must list exactly one call per paid call');
  end if;
  insert into public.external_tools (slug, title, summary, origin, resource_path, network, mint, decimals, pay_to, pay_to_ata, unit_price_base_units,
    calls_per_step, fee_payers, rpc_methods, io, call_template, proposed_by)
  values (t->>'slug', t->>'title', t->>'summary', t->>'origin', t->>'resourcePath', t->>'network', t->>'mint', (t->>'decimals')::smallint,
    t->>'payTo', t->>'payToAta', (t->>'unitPriceBaseUnits')::numeric, (t->>'callsPerStep')::integer,
    array(select jsonb_array_elements_text(t->'feePayers')),
    case when t ? 'rpcMethods' and jsonb_typeof(t->'rpcMethods') = 'array' then array(select jsonb_array_elements_text(t->'rpcMethods')) else null end,
    t->'io', t->'callTemplate', p_user)
  returning id into tid;
  return tid;
end $$;

create or replace function public.mk_report_workflow_run(p_workspace uuid, p_run uuid, p_status text, p_stop text, p_steps jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.workflow_runs;
  w public.workflows;
  s jsonb;
  allowed text[];
begin
  select * into r from public.workflow_runs where id = p_run and buyer_workspace_id = p_workspace for update;
  if r.id is null then perform private.raise_code('NOT_FOUND', 'workflow run not found'); end if;
  select wf.* into w from public.workflows wf join public.workflow_versions v on v.workflow_id = wf.id where v.id = r.workflow_version_id;
  allowed := case r.status
    when 'awaiting_approval' then array['awaiting_approval', 'approved', 'rejected', 'halted']
    when 'approved' then array['approved', 'running', 'halted', 'failed']
    when 'running' then array['running', 'halted', 'failed', 'completed']
    when 'halted' then array['halted', 'approved', 'failed']
    else array[r.status]
  end;
  if not (p_status = any (allowed)) then perform private.raise_code('INVALID_TRANSITION', format('run cannot move from %s to %s', r.status, p_status)); end if;
  if p_status in ('approved', 'running') and r.status in ('halted', 'awaiting_approval') and (
       w.status = 'suspended'
       or (not r.is_test and not exists (select 1 from public.workflow_catalog c where c.version_id = r.workflow_version_id))) then
    perform private.raise_code('POLICY_DENIED', 'the workflow is suspended or no longer live; the run cannot resume');
  end if;
  for s in select * from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb)) loop
    update public.workflow_run_steps set
      payment_status = s->>'paymentStatus',
      execution_status = s->>'executionStatus',
      job_id = coalesce(job_id, nullif(s->>'jobId', '')::uuid),
      paid_base_units = coalesce(nullif(s->>'paidBaseUnits', '')::numeric, paid_base_units),
      funding_signature = coalesce(funding_signature, nullif(s->>'fundingSignature', '')),
      merchant_signatures = case when jsonb_typeof(s->'merchantSignatures') = 'array' and jsonb_array_length(s->'merchantSignatures') > 0
        then array(select jsonb_array_elements_text(s->'merchantSignatures')) else merchant_signatures end,
      artifact_sha256 = coalesce(artifact_sha256, nullif(s->>'artifactSha256', '')),
      stop_reason = nullif(s->>'stopReason', ''),
      updated_at = now()
    where run_id = r.id and step_index = (s->>'index')::integer
      and not (payment_status = 'paid' and s->>'paymentStatus' is distinct from 'paid')
      and coalesce((s->>'paidBaseUnits')::numeric, 0) <= max_base_units;
  end loop;
  if p_status = 'completed' and exists (
      select 1 from public.workflow_run_steps st where st.run_id = r.id
        and (st.payment_status <> 'paid' or cardinality(st.merchant_signatures) = 0 or st.execution_status <> 'delivered')) then
    perform private.raise_code('INVALID_TRANSITION', 'a run completes only when every step is paid and delivered');
  end if;
  update public.workflow_runs set status = p_status, stop_reason = p_stop, updated_at = now() where id = r.id;
  if p_status = 'completed' and r.status <> 'completed' and not r.is_test then
    update public.workflow_catalog c set paid_runs = paid_runs + 1 from public.workflow_versions v
     where v.id = r.workflow_version_id and c.workflow_id = v.workflow_id;
  end if;
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
