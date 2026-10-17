-- One-time payers and settlement signatures are unique across hires and workflow steps, and a
-- workflow step's transfers count only when they landed after its payer was bound.

alter table public.workflow_run_steps add column payer_bound_slot bigint;

-- The slotless binder is retired: every binding must record the finalized slot it happened at.
create or replace function public.mk_bind_workflow_payer(p_workspace uuid, p_run uuid, p_index integer, p_payer text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.raise_code('INVALID_REQUEST', 'payer binding requires the finalized slot');
end $$;

create function public.mk_bind_workflow_payer(p_workspace uuid, p_run uuid, p_index integer, p_payer text, p_bound_slot bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare st public.workflow_run_steps;
begin
  if p_bound_slot is null or p_bound_slot < 0 then perform private.raise_code('INVALID_REQUEST', 'a finalized slot is required'); end if;
  select s.* into st from public.workflow_run_steps s join public.workflow_runs r on r.id = s.run_id
   where s.run_id = p_run and s.step_index = p_index and r.buyer_workspace_id = p_workspace for update of s;
  if st.run_id is null then perform private.raise_code('NOT_FOUND', 'workflow step not found'); end if;
  if st.tool_kind <> 'external' then perform private.raise_code('INVALID_REQUEST', 'listing steps bind their payer through the hire'); end if;
  if st.payer is not null then
    if st.payer <> p_payer then perform private.raise_code('IDEMPOTENCY_CONFLICT', 'a different payer is already bound to this step'); end if;
    return;
  end if;
  if exists (select 1 from public.workflow_run_steps where payer = p_payer)
     or exists (select 1 from public.payment_operations where expected_payer = p_payer) then
    perform private.raise_code('IDEMPOTENCY_CONFLICT', 'payer already bound to another payment');
  end if;
  update public.workflow_run_steps set payer = p_payer, payer_bound_at = now(), payer_bound_slot = p_bound_slot, updated_at = now()
   where run_id = p_run and step_index = p_index;
end $$;

-- A hire cannot adopt a payer already bound to a workflow step.
create function private.guard_hire_payer() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.expected_payer is not null and new.expected_payer is distinct from old.expected_payer
     and exists (select 1 from public.workflow_run_steps where payer = new.expected_payer) then
    raise exception 'IDEMPOTENCY_CONFLICT: payer already bound to a workflow step';
  end if;
  return new;
end $$;
create trigger payment_operations_payer_unique_across before update of expected_payer on public.payment_operations
  for each row execute function private.guard_hire_payer();

-- A hire receipt cannot reuse a signature an external workflow step already claimed.
create function private.guard_receipt_claim() returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.workflow_payment_claims c join public.workflow_run_steps s on s.run_id = c.run_id and s.step_index = c.step_index
             where c.signature = new.signature and s.tool_kind = 'external') then
    raise exception 'IDEMPOTENCY_CONFLICT: signature already backs a workflow step';
  end if;
  return new;
end $$;
create trigger chain_receipts_claim_unique_across before insert on public.chain_receipts
  for each row execute function private.guard_receipt_claim();

-- External step claims: never a hire receipt's signature.
create function private.guard_external_claim() returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.workflow_run_steps s where s.run_id = new.run_id and s.step_index = new.step_index and s.tool_kind = 'external')
     and exists (select 1 from public.chain_receipts where signature = new.signature) then
    raise exception 'IDEMPOTENCY_CONFLICT: signature is already a hire receipt';
  end if;
  return new;
end $$;
create trigger workflow_payment_claims_external_guard before insert on public.workflow_payment_claims
  for each row execute function private.guard_external_claim();

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
