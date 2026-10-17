-- Tightens workflow transitions: publication always re-checks the tools and refuses a suspended
-- workflow, run status follows an explicit state machine, approval terms must match every step's
-- published facts, and paid_runs counts only runs whose every step was paid.

create or replace function private.publish_workflow_version(p_version uuid) returns void language plpgsql set search_path = '' as $$
declare
  v public.workflow_versions;
  w public.workflows;
  s public.seller_profiles;
begin
  select * into v from public.workflow_versions where id = p_version;
  select * into w from public.workflows where id = v.workflow_id for update;
  if w.status = 'suspended' then perform private.raise_code('POLICY_DENIED', 'workflow is suspended'); end if;
  if v.review_status not in ('not_required', 'approved') then perform private.raise_code('INVALID_TRANSITION', 'version is not approved for publication'); end if;
  if private.workflow_decision(v.steps, v.total_max_base_units, v.safety_promise, v.network, v.mint) <> 'live' then
    perform private.raise_code('SERVICE_NOT_ALLOWED', 'a step tool is not approved and published');
  end if;
  update public.workflows set status = 'live', current_version_id = v.id, updated_at = now() where id = w.id returning * into w;
  select * into s from public.seller_profiles where id = w.seller_id;
  insert into public.workflow_catalog (workflow_id, version_id, slug, creator_name, demo, category, title, summary, description, safety_promise,
    total_base_units, network, mint, decimals, steps, run_inputs, sample_output)
  values (w.id, v.id, w.slug, s.public_name, w.demo, w.category, v.title, v.summary, v.description, v.safety_promise, v.total_max_base_units,
    v.network, v.mint, v.decimals, private.workflow_steps_public(v.steps), v.run_inputs, v.sample_output)
  on conflict (workflow_id) do update set version_id = excluded.version_id, slug = excluded.slug, creator_name = excluded.creator_name,
    demo = excluded.demo, category = excluded.category, title = excluded.title, summary = excluded.summary, description = excluded.description,
    safety_promise = excluded.safety_promise, total_base_units = excluded.total_base_units, network = excluded.network, mint = excluded.mint,
    decimals = excluded.decimals, steps = excluded.steps, run_inputs = excluded.run_inputs, sample_output = excluded.sample_output,
    published_at = now();
end $$;

create or replace function public.mk_review_workflow_version(p_version uuid, p_approve boolean, p_note text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v public.workflow_versions;
  w public.workflows;
begin
  select * into v from public.workflow_versions where id = p_version for update;
  if v.id is null then perform private.raise_code('NOT_FOUND', 'workflow version not found'); end if;
  select * into w from public.workflows where id = v.workflow_id for update;
  if v.review_status <> 'pending' then perform private.raise_code('INVALID_TRANSITION', 'version is not awaiting review'); end if;
  update public.workflow_versions set review_status = case when p_approve then 'approved' else 'rejected' end, review_note = p_note where id = v.id;
  if not p_approve then
    update public.workflows set status = case when status in ('live', 'suspended') then status else 'draft' end, updated_at = now() where id = w.id;
    return 'rejected';
  end if;
  -- An approval never lifts a suspension; the operator restores the workflow separately.
  if w.status = 'suspended' then return 'approved_while_suspended'; end if;
  if private.workflow_decision(v.steps, v.total_max_base_units, v.safety_promise, v.network, v.mint) = 'live' then
    perform private.publish_workflow_version(v.id);
    return 'live';
  end if;
  return 'approved_waiting_for_tools';
end $$;

create or replace function public.mk_set_workflow_status(p_workflow uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  w public.workflows;
begin
  if p_status not in ('suspended', 'live') then perform private.raise_code('INVALID_REQUEST', 'operator may suspend or restore'); end if;
  select * into w from public.workflows where id = p_workflow for update;
  if w.id is null then perform private.raise_code('NOT_FOUND', 'workflow not found'); end if;
  if p_status = 'suspended' then
    update public.workflows set status = 'suspended', updated_at = now() where id = w.id;
    delete from public.workflow_catalog where workflow_id = w.id;
    update public.workflow_runs set status = 'halted', stop_reason = 'workflow suspended by the operator', updated_at = now()
     where workflow_version_id in (select id from public.workflow_versions where workflow_id = w.id) and status in ('awaiting_approval', 'approved', 'running');
  else
    if w.current_version_id is null then perform private.raise_code('INVALID_TRANSITION', 'workflow has no published version'); end if;
    -- Restoring re-runs every publication check against the tools as they are now.
    update public.workflows set status = 'draft', updated_at = now() where id = w.id;
    perform private.publish_workflow_version(w.current_version_id);
  end if;
end $$;

-- Recipient a step pays, from the published tool facts.
create or replace function private.step_recipient(p_kind text, p_tool uuid) returns text language sql stable set search_path = '' as $$
  select case when p_kind = 'listing' then (select c.recipient from public.catalog_entries c where c.listing_version_id = p_tool)
              when p_kind = 'external' then (select e.pay_to from public.external_tools e where e.id = p_tool and e.status = 'approved')
         end;
$$;

create or replace function public.mk_create_workflow_run(p_workspace uuid, p_version uuid, p_agent uuid, p_idem text, p_terms jsonb, p_digest text, p_test boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  existing public.workflow_runs;
  v public.workflow_versions;
  w public.workflows;
  rid uuid;
  s jsonb;
  t jsonb;
  i integer := 0;
begin
  select * into existing from public.workflow_runs where buyer_workspace_id = p_workspace and idempotency_key = p_idem;
  if existing.id is not null then
    if existing.approval_digest is distinct from p_digest then perform private.raise_code('IDEMPOTENCY_CONFLICT', 'idempotency key reused with different terms'); end if;
    return jsonb_build_object('runId', existing.id, 'existing', true);
  end if;
  if not exists (select 1 from public.workspaces where id = p_workspace and status = 'active') then
    perform private.raise_code('ACCOUNT_STOPPED', 'workspace is not active');
  end if;
  select * into v from public.workflow_versions where id = p_version;
  if v.id is null then perform private.raise_code('NOT_FOUND', 'workflow version not found'); end if;
  select * into w from public.workflows where id = v.workflow_id;
  if w.status = 'suspended' then perform private.raise_code('POLICY_DENIED', 'workflow is suspended'); end if;
  if coalesce(p_test, false) then
    if not exists (select 1 from public.workspaces ws where ws.id = p_workspace and ws.owner_user_id = w.creator_user_id) then
      perform private.raise_code('POLICY_DENIED', 'only the creator can test-run an unpublished version');
    end if;
  elsif not exists (select 1 from public.workflow_catalog c where c.version_id = v.id) then
    perform private.raise_code('SERVICE_NOT_ALLOWED', 'workflow version is not live');
  end if;
  if p_agent is not null and not exists (
      select 1 from public.workflow_assignments a where a.agent_id = p_agent and a.workflow_id = w.id and a.status = 'active'
        and a.workspace_id = p_workspace and a.budget_base_units >= v.total_max_base_units) then
    perform private.raise_code('BUDGET_EXCEEDED', 'agent has no assignment covering this workflow total');
  end if;
  if (p_terms->>'workflowVersionId') is distinct from v.id::text
     or (p_terms->>'totalMaxBaseUnits')::numeric is distinct from v.total_max_base_units
     or (p_terms->>'network') is distinct from v.network or (p_terms->>'mint') is distinct from v.mint
     or jsonb_typeof(p_terms->'steps') is distinct from 'array'
     or jsonb_array_length(p_terms->'steps') is distinct from jsonb_array_length(v.steps) then
    perform private.raise_code('PRICE_CHANGED', 'approval terms do not match the workflow version');
  end if;
  insert into public.workflow_runs (workflow_version_id, buyer_workspace_id, requested_by_agent_id, idempotency_key, approval_digest, terms, is_test)
  values (v.id, p_workspace, p_agent, p_idem, p_digest, p_terms, coalesce(p_test, false)) returning id into rid;
  for s in select * from jsonb_array_elements(v.steps) loop
    t := p_terms->'steps'->i;
    if (t->>'toolKind') is distinct from (s->>'toolKind') or (t->>'toolId') is distinct from (s->>'toolId')
       or (t->>'maxBaseUnits')::numeric is distinct from (s->>'maxBaseUnits')::numeric
       or (t->>'recipient') is distinct from private.step_recipient(s->>'toolKind', (s->>'toolId')::uuid) then
      perform private.raise_code('PRICE_CHANGED', 'approval step terms do not match the published tools');
    end if;
    insert into public.workflow_run_steps (run_id, step_index, tool_kind, tool_id, max_base_units)
    values (rid, i, s->>'toolKind', (s->>'toolId')::uuid, (s->>'maxBaseUnits')::numeric);
    i := i + 1;
  end loop;
  return jsonb_build_object('runId', rid, 'existing', false);
end $$;

create or replace function public.mk_report_workflow_run(p_workspace uuid, p_run uuid, p_status text, p_stop text, p_steps jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.workflow_runs;
  s jsonb;
  allowed text[];
begin
  select * into r from public.workflow_runs where id = p_run and buyer_workspace_id = p_workspace for update;
  if r.id is null then perform private.raise_code('NOT_FOUND', 'workflow run not found'); end if;
  allowed := case r.status
    when 'awaiting_approval' then array['awaiting_approval', 'approved', 'rejected', 'halted']
    when 'approved' then array['approved', 'running', 'halted', 'failed']
    when 'running' then array['running', 'halted', 'failed', 'completed']
    when 'halted' then array['halted', 'approved', 'failed']
    else array[r.status]
  end;
  if not (p_status = any (allowed)) then perform private.raise_code('INVALID_TRANSITION', format('run cannot move from %s to %s', r.status, p_status)); end if;
  for s in select * from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb)) loop
    update public.workflow_run_steps set
      payment_status = s->>'paymentStatus',
      execution_status = s->>'executionStatus',
      job_id = coalesce(job_id, nullif(s->>'jobId', '')::uuid),
      paid_base_units = coalesce(nullif(s->>'paidBaseUnits', '')::numeric, paid_base_units),
      funding_signature = coalesce(funding_signature, nullif(s->>'fundingSignature', '')),
      merchant_signatures = case when jsonb_typeof(s->'merchantSignatures') = 'array'
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

revoke all on function private.step_recipient(text, uuid), private.publish_workflow_version(uuid) from public, anon, authenticated;
