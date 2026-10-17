-- Remote sellers authenticate their seller host with an operator-issued credential that is
-- scoped to their own jobs. Only the SHA-256 of the credential is stored.
create table private.seller_host_credentials (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.seller_profiles (id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create function public.mk_issue_seller_host_credential(p_seller uuid, p_token_hash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  cid uuid;
begin
  if not exists (select 1 from public.seller_profiles where id = p_seller and status = 'approved') then
    perform private.raise_code('POLICY_DENIED', 'seller is not approved');
  end if;
  insert into private.seller_host_credentials (seller_id, token_hash) values (p_seller, p_token_hash) returning id into cid;
  return cid;
end $$;

create function public.mk_seller_for_host_credential(p_token_hash text) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.seller_id from private.seller_host_credentials c join public.seller_profiles s on s.id = c.seller_id
   where c.token_hash = p_token_hash and c.revoked_at is null and s.status = 'approved';
$$;

create function public.mk_revoke_seller_host_credential(p_seller uuid) returns void
language sql security definer set search_path = '' as $$
  update private.seller_host_credentials set revoked_at = now() where seller_id = p_seller and revoked_at is null;
$$;

revoke all on function public.mk_issue_seller_host_credential(uuid, text) from public, anon, authenticated;
revoke all on function public.mk_seller_for_host_credential(text) from public, anon, authenticated;
revoke all on function public.mk_revoke_seller_host_credential(uuid) from public, anon, authenticated;
grant execute on function public.mk_issue_seller_host_credential(uuid, text) to service_role;
grant execute on function public.mk_seller_for_host_credential(text) to service_role;
grant execute on function public.mk_revoke_seller_host_credential(uuid) to service_role;
