-- Settlement and refund state fixes from review.

-- A controller rejection is final; an accepted operation may still be rejected before payment.
create or replace function public.mk_controller_decision(p_workspace uuid, p_operation text, p_accept boolean, p_code text, p_ref text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  op public.payment_operations;
begin
  select * into j from public.jobs where operation_id = p_operation and buyer_workspace_id = p_workspace for update;
  if j.id is null then perform private.raise_code('NOT_FOUND', 'operation not found'); end if;
  select * into op from public.payment_operations where operation_id = p_operation for update;
  if op.status = 'controller_rejected' then
    if p_accept then perform private.raise_code('INVALID_TRANSITION', 'operation was already rejected'); end if;
    return;
  end if;
  if op.status not in ('awaiting_controller', 'controller_accepted') then return; end if;
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

-- Chain evidence wins over an earlier "failed unpaid" report: a finalized, payer-bound transfer
-- re-queues the job instead of leaving a paid job that can never run.
create or replace function public.mk_record_receipt(p_operation text, p_network text, p_signature text, p_ix integer, p_mint text, p_source text,
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
  if op.expected_payer is null then perform private.raise_code('NOT_READY', 'the controller has not reported the payer yet'); end if;
  if p_source is distinct from op.expected_payer then perform private.raise_code('SERVICE_NOT_ALLOWED', 'receipt was not authorized by this operation''s payer'); end if;
  if p_slot <= op.payer_bound_slot then
    perform private.raise_code('SERVICE_NOT_ALLOWED', 'receipt is not later than the payer binding');
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
  if j.state = 'awaiting_payment' then
    perform private.move_job(j, 'queued', 'settled', 'system', 'payment.settled', jsonb_build_object('signature', p_signature));
  elsif j.state = 'failed' and j.financial_state = 'failed_unpaid' then
    update public.jobs set state = 'queued', financial_state = 'settled', version = version + 1, updated_at = now() where id = j.id;
    perform private.append_event(j.id, 'payment.settled_after_unpaid_report', 'failed', 'queued', 'system', jsonb_build_object('signature', p_signature));
  elsif j.state in ('awaiting_approval', 'expired', 'cancelled') then
    update public.jobs set financial_state = 'settled', version = version + 1, updated_at = now() where id = j.id;
    perform private.append_event(j.id, 'payment.settled_after_close', j.state, j.state, 'system', jsonb_build_object('signature', p_signature));
  else
    perform private.move_job(j, null, 'settled', 'system', 'payment.settled', jsonb_build_object('signature', p_signature));
  end if;
  return jsonb_build_object('receiptId', r.id, 'existing', false);
exception when unique_violation then
  perform private.raise_code('IDEMPOTENCY_CONFLICT', 'settlement signature already funds another purchase');
  return null;
end $$;

-- Refunds are claims on finished or abandoned work, so they never block a job that can still run,
-- and the remembered financial state is restored when a request is declined.
alter table public.refund_requests add column prior_financial_state text;

create or replace function public.mk_request_refund(p_user uuid, p_job uuid, p_amount numeric, p_return text, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  r public.chain_receipts;
  committed numeric;
  rid uuid;
begin
  select j2.* into j from public.jobs j2 join public.workspaces w on w.id = j2.buyer_workspace_id
   where j2.id = p_job and w.owner_user_id = p_user for update of j2;
  if j.id is null then perform private.raise_code('NOT_FOUND', 'job not found'); end if;
  if j.state not in ('succeeded', 'failed', 'delivery_uncertain', 'cancelled', 'expired') then
    perform private.raise_code('INVALID_TRANSITION', 'a refund can be requested once the job has finished, failed or been cancelled');
  end if;
  select * into r from public.chain_receipts where job_id = p_job;
  if r.id is null then perform private.raise_code('NOT_READY', 'no settled payment to refund'); end if;
  if not exists (select 1 from public.wallet_links where user_id = p_user and chain = 'solana' and address = p_return) then
    perform private.raise_code('FORBIDDEN', 'return address must be a wallet verified on this account');
  end if;
  select coalesce(sum(amount), 0) into committed from public.refund_requests
   where receipt_id = r.id and status in ('approved', 'submitted', 'uncertain', 'finalized');
  if p_amount <= 0 or committed + p_amount > r.amount then
    perform private.raise_code('INVALID_REQUEST', 'refund exceeds the remaining settled amount');
  end if;
  insert into public.refund_requests (job_id, receipt_id, amount, return_address, reason, prior_financial_state)
  values (p_job, r.id, p_amount, p_return, p_reason, j.financial_state) returning id into rid;
  perform private.move_job(j, null, 'refund_requested', 'buyer', 'refund.requested', jsonb_build_object('refundId', rid, 'amount', p_amount::text));
  return rid;
end $$;

create or replace function public.mk_refund_decision(p_user uuid, p_refund uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  rr public.refund_requests;
  j public.jobs;
begin
  select r.* into rr from public.refund_requests r join public.jobs j2 on j2.id = r.job_id join public.seller_profiles s on s.id = j2.seller_id
   where r.id = p_refund and s.owner_user_id = p_user for update of r;
  if rr.id is null then perform private.raise_code('NOT_FOUND', 'refund request not found'); end if;
  if rr.status <> 'requested' then perform private.raise_code('INVALID_TRANSITION', 'refund already decided'); end if;
  update public.refund_requests set status = case when p_approve then 'approved' else 'declined' end, updated_at = now() where id = p_refund;
  select * into j from public.jobs where id = rr.job_id for update;
  if not p_approve and j.financial_state = 'refund_requested'
     and not exists (select 1 from public.refund_requests where job_id = j.id and id <> rr.id and status in ('requested', 'approved', 'submitted', 'uncertain')) then
    perform private.move_job(j, null, coalesce(rr.prior_financial_state, 'settled'), 'seller', 'refund.declined', '{}');
  else
    perform private.append_event(rr.job_id, case when p_approve then 'refund.approved' else 'refund.declined' end, null, null, 'seller', '{}');
  end if;
end $$;

-- The one-time payer is not shown to clients: a seller must not link it to the buyer before
-- settlement. Clients see payment progress only.
revoke select on public.payment_operations from authenticated;
grant select (id, job_id, quote_id, operation_id, status, reject_code, updated_at, created_at) on public.payment_operations to authenticated;

revoke all on function public.mk_controller_decision(uuid, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.mk_controller_decision(uuid, text, boolean, text, text) to service_role;
revoke all on function public.mk_record_receipt(text, text, text, integer, text, text, text, numeric, bigint) from public, anon, authenticated;
grant execute on function public.mk_record_receipt(text, text, text, integer, text, text, text, numeric, bigint) to service_role;
revoke all on function public.mk_request_refund(uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.mk_request_refund(uuid, uuid, numeric, text, text) to service_role;
revoke all on function public.mk_refund_decision(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.mk_refund_decision(uuid, uuid, boolean) to service_role;
