-- A step's payment is attributable only to the one-time payer the buyer's controller bound to that
-- step beforehand, and each settlement signature can back exactly one step anywhere. A run counts
-- as completed only when every step was paid its full maximum.

alter table public.workflow_run_steps add column payer text;
alter table public.workflow_run_steps add column payer_bound_at timestamptz;

create table public.workflow_payment_claims (
  signature text primary key,
  run_id uuid not null references public.workflow_runs (id),
  step_index integer not null,
  created_at timestamptz not null default now()
);
alter table public.workflow_payment_claims enable row level security;
revoke all on public.workflow_payment_claims from anon, authenticated;

-- The API verifies the payer's proof of possession before calling this; the payer is set once.
create function public.mk_bind_workflow_payer(p_workspace uuid, p_run uuid, p_index integer, p_payer text) returns void
language plpgsql security definer set search_path = '' as $$
declare st public.workflow_run_steps;
begin
  select s.* into st from public.workflow_run_steps s join public.workflow_runs r on r.id = s.run_id
   where s.run_id = p_run and s.step_index = p_index and r.buyer_workspace_id = p_workspace for update of s;
  if st.run_id is null then perform private.raise_code('NOT_FOUND', 'workflow step not found'); end if;
  if st.tool_kind <> 'external' then perform private.raise_code('INVALID_REQUEST', 'listing steps bind their payer through the hire'); end if;
  if st.payer is not null then
    if st.payer <> p_payer then perform private.raise_code('IDEMPOTENCY_CONFLICT', 'a different payer is already bound to this step'); end if;
    return;
  end if;
  if exists (select 1 from public.workflow_run_steps where payer = p_payer) then perform private.raise_code('IDEMPOTENCY_CONFLICT', 'payer already bound to another step'); end if;
  update public.workflow_run_steps set payer = p_payer, payer_bound_at = now(), updated_at = now() where run_id = p_run and step_index = p_index;
end $$;

create or replace function public.mk_report_workflow_run(p_workspace uuid, p_run uuid, p_status text, p_stop text, p_steps jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.workflow_runs;
  w public.workflows;
  s jsonb;
  sig text;
  claimed public.workflow_payment_claims;
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
    if s->>'paymentStatus' = 'paid' and jsonb_typeof(s->'merchantSignatures') = 'array' then
      for sig in select jsonb_array_elements_text(s->'merchantSignatures') loop
        select * into claimed from public.workflow_payment_claims where signature = sig for update;
        if claimed.signature is null then
          insert into public.workflow_payment_claims (signature, run_id, step_index) values (sig, r.id, (s->>'index')::integer);
        elsif claimed.run_id <> r.id or claimed.step_index <> (s->>'index')::integer then
          perform private.raise_code('IDEMPOTENCY_CONFLICT', 'a payment already backs another workflow step');
        end if;
      end loop;
    end if;
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
        and (st.payment_status <> 'paid' or cardinality(st.merchant_signatures) = 0 or st.execution_status <> 'delivered'
             or st.paid_base_units is distinct from st.max_base_units)) then
    perform private.raise_code('INVALID_TRANSITION', 'a run completes only when every step is paid in full and delivered');
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
