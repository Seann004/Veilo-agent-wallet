-- Over-cap refunds are a definite client error, not an internal failure, and a request that can
-- never fit the remaining settled amount is refused when it is made rather than when approved.
create or replace function private.guard_refund_capacity() returns trigger language plpgsql set search_path = '' as $$
declare
  paid numeric;
  claimed numeric;
begin
  select amount into paid from public.chain_receipts where id = new.receipt_id for update;
  select coalesce(sum(amount), 0) into claimed from public.refund_requests
    where receipt_id = new.receipt_id and id <> new.id and status in ('approved', 'submitted', 'uncertain', 'finalized');
  if new.status in ('approved', 'submitted', 'uncertain', 'finalized') and claimed + new.amount > paid then
    raise exception 'INVALID_REQUEST: refunds would exceed the settled amount' using errcode = 'P0001';
  end if;
  return new;
end $$;

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
  insert into public.refund_requests (job_id, receipt_id, amount, return_address, reason) values (p_job, r.id, p_amount, p_return, p_reason)
  returning id into rid;
  perform private.move_job(j, null, 'refund_requested', 'buyer', 'refund.requested', jsonb_build_object('refundId', rid, 'amount', p_amount::text));
  return rid;
end $$;

revoke all on function public.mk_request_refund(uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.mk_request_refund(uuid, uuid, numeric, text, text) to service_role;
