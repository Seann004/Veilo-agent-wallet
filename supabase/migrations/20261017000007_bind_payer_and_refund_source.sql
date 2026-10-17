-- Identical quotes (same seller, same price) share recipient and amount, so a receipt is bound to
-- the one-time payer the buyer's controller reported for that operation. The payer is set once.
-- The binding happens while the operation is merely accepted, before the controller releases the
-- funding proof, so the payer is not yet public; it is unique so no other operation can claim it.
alter table public.payment_operations
  add column expected_payer text unique check (expected_payer ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  add column payer_bound_at timestamptz;

create or replace function public.mk_controller_status(p_workspace uuid, p_operation text, p_status text, p_detail text, p_payer text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  op public.payment_operations;
begin
  select * into j from public.jobs where operation_id = p_operation and buyer_workspace_id = p_workspace for update;
  if j.id is null then perform private.raise_code('NOT_FOUND', 'operation not found'); end if;
  select * into op from public.payment_operations where operation_id = p_operation for update;
  if p_payer is not null then
    if op.expected_payer is not null then
      if op.expected_payer <> p_payer then perform private.raise_code('IDEMPOTENCY_CONFLICT', 'operation already has a different payer'); end if;
    elsif op.status <> 'controller_accepted' then
      perform private.raise_code('INVALID_TRANSITION', 'a payer can only be bound right after the controller accepts');
    else
      begin
        update public.payment_operations set expected_payer = p_payer, payer_bound_at = now() where id = op.id;
      exception when unique_violation then
        perform private.raise_code('IDEMPOTENCY_CONFLICT', 'payer is already bound to another operation');
      end;
      op.expected_payer := p_payer;
    end if;
  end if;
  if op.status in ('settled', 'controller_rejected') then return; end if;
  if p_status = 'paying' and coalesce(p_payer, op.expected_payer) is null then
    perform private.raise_code('INVALID_REQUEST', 'paying status must name the payer');
  end if;
  update public.payment_operations set status = p_status, updated_at = now() where id = op.id;
  if p_status = 'paying' then
    perform private.move_job(j, null, 'funding_pending', 'controller', 'payment.paying', '{}');
  elsif p_status = 'uncertain' then
    perform private.move_job(j, null, 'settlement_uncertain', 'controller', 'payment.uncertain', jsonb_build_object('detail', p_detail));
  elsif p_status = 'failed_unpaid' and j.state = 'awaiting_payment' then
    perform private.move_job(j, 'failed', 'failed_unpaid', 'controller', 'payment.failed_unpaid', jsonb_build_object('detail', p_detail));
  end if;
end $$;
drop function public.mk_controller_status(uuid, text, text, text);
drop function public.mk_record_receipt(text, text, text, integer, text, text, text, numeric, bigint);

create function public.mk_record_receipt(p_operation text, p_network text, p_signature text, p_ix integer, p_mint text, p_source text,
  p_ata text, p_amount numeric, p_slot bigint, p_block_time timestamptz) returns jsonb
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
  if op.expected_payer is null then perform private.raise_code('NOT_READY', 'the controller has not reported the payer yet'); end if;
  if p_source is distinct from op.expected_payer then perform private.raise_code('SERVICE_NOT_ALLOWED', 'receipt was not authorized by this operation''s payer'); end if;
  if p_block_time is null or p_block_time < op.payer_bound_at - interval '2 minutes' then
    perform private.raise_code('SERVICE_NOT_ALLOWED', 'receipt predates the payer binding');
  end if;
  select * into q from public.quotes where id = op.quote_id;
  if p_network <> q.network or p_mint <> q.mint or p_ata <> q.recipient_ata or p_amount <> q.total_units then
    perform private.raise_code('SERVICE_NOT_ALLOWED', 'receipt does not match the quote');
  end if;
  if exists (select 1 from public.refund_requests where refund_signature = p_signature) then
    perform private.raise_code('IDEMPOTENCY_CONFLICT', 'signature is already recorded as a refund');
  end if;
  insert into public.chain_receipts (operation_id, job_id, network, signature, instruction_index, mint, source_owner, recipient_ata, amount, finalized_slot)
  values (p_operation, j.id, p_network, p_signature, p_ix, p_mint, p_source, p_ata, p_amount, p_slot) returning * into r;
  insert into public.earnings_events (seller_id, job_id, receipt_id, event_type, gross, fee, refund, network, mint)
  values (j.seller_id, j.id, r.id, 'payment', p_amount, 0, 0, p_network, p_mint);
  update public.payment_operations set status = 'settled', updated_at = now() where id = op.id;
  if j.state in ('awaiting_payment', 'awaiting_approval', 'expired', 'cancelled') then
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

-- A refund signature can never double as a payment receipt.
create or replace function public.mk_refund_submitted(p_user uuid, p_refund uuid, p_signature text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.chain_receipts where signature = p_signature) then
    perform private.raise_code('IDEMPOTENCY_CONFLICT', 'signature is already recorded as a payment');
  end if;
  update public.refund_requests r set status = 'submitted', refund_signature = p_signature, updated_at = now()
    from public.jobs j, public.seller_profiles s
   where r.id = p_refund and j.id = r.job_id and s.id = j.seller_id and s.owner_user_id = p_user and r.status in ('approved', 'uncertain');
  if not found then perform private.raise_code('NOT_FOUND', 'approved refund not found'); end if;
end $$;

revoke all on function public.mk_controller_status(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.mk_controller_status(uuid, text, text, text, text) to service_role;
revoke all on function public.mk_record_receipt(text, text, text, integer, text, text, text, numeric, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.mk_record_receipt(text, text, text, integer, text, text, text, numeric, bigint, timestamptz) to service_role;
revoke all on function public.mk_refund_submitted(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mk_refund_submitted(uuid, uuid, text) to service_role;
