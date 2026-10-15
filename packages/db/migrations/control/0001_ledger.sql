-- Authoritative owner/control ledger. Amounts are INTEGER base units (never REAL);
-- timestamps are UTC epoch milliseconds. Note secrets live in the separate wallet secrets database.

CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  owner_pubkey TEXT NOT NULL UNIQUE,
  network TEXT NOT NULL,
  mint TEXT NOT NULL,
  mint_decimals INTEGER NOT NULL CHECK (mint_decimals BETWEEN 0 AND 18),
  policy_version INTEGER NOT NULL DEFAULT 0 CHECK (policy_version >= 0),
  emergency_stop_epoch INTEGER NOT NULL DEFAULT 0 CHECK (emergency_stop_epoch >= 0),
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  timezone TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  role TEXT NOT NULL CHECK (role IN ('credit_manager', 'research', 'content')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'revoked', 'archived')),
  policy_version INTEGER NOT NULL DEFAULT 0 CHECK (policy_version >= 0),
  revocation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (revocation_epoch >= 0),
  trigger_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(trigger_json)),
  model_profile TEXT,
  description TEXT,
  target_account_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (id, workspace_id)
) STRICT;

-- Revocation is permanent; a revoked agent may only be archived.
CREATE TRIGGER agent_revoked_is_terminal BEFORE UPDATE OF status ON agent
WHEN OLD.status = 'revoked' AND NEW.status NOT IN ('revoked', 'archived')
BEGIN SELECT RAISE(ABORT, 'revoked agent cannot be reactivated'); END;

CREATE TRIGGER agent_archived_is_terminal BEFORE UPDATE OF status ON agent
WHEN OLD.status = 'archived' AND NEW.status <> 'archived'
BEGIN SELECT RAISE(ABORT, 'archived agent cannot be reactivated'); END;

CREATE TRIGGER agent_epochs_monotonic BEFORE UPDATE OF revocation_epoch ON agent
WHEN NEW.revocation_epoch < OLD.revocation_epoch
BEGIN SELECT RAISE(ABORT, 'revocation epoch cannot decrease'); END;

CREATE TRIGGER workspace_epochs_monotonic BEFORE UPDATE OF emergency_stop_epoch ON workspace
WHEN NEW.emergency_stop_epoch < OLD.emergency_stop_epoch
BEGIN SELECT RAISE(ABORT, 'stop epoch cannot decrease'); END;

CREATE TABLE policy (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace', 'agent')),
  agent_id TEXT REFERENCES agent(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded', 'discarded')),
  tier TEXT NOT NULL CHECK (tier IN ('observe', 'bounded_automatic', 'approval_required', 'stopped')),
  lifetime_limit_usdc INTEGER NOT NULL CHECK (lifetime_limit_usdc >= 0),
  rolling_24h_limit_usdc INTEGER NOT NULL CHECK (rolling_24h_limit_usdc >= 0),
  per_purchase_limit_usdc INTEGER CHECK (per_purchase_limit_usdc >= 0),
  task_limit_usdc INTEGER CHECK (task_limit_usdc >= 0),
  sponsor_lamport_limit INTEGER CHECK (sponsor_lamport_limit >= 0),
  usage_allowance_units INTEGER CHECK (usage_allowance_units >= 0),
  task_usage_limit_units INTEGER CHECK (task_usage_limit_units >= 0),
  approval_threshold_usdc INTEGER CHECK (approval_threshold_usdc >= 0),
  permissions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(permissions_json)),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  expires_at_ms INTEGER,
  created_by TEXT NOT NULL CHECK (created_by IN ('owner', 'seed')),
  created_at_ms INTEGER NOT NULL,
  activated_at_ms INTEGER,
  superseded_at_ms INTEGER,
  CHECK ((scope_type = 'workspace' AND agent_id IS NULL AND sponsor_lamport_limit IS NOT NULL)
      OR (scope_type = 'agent' AND agent_id IS NOT NULL AND per_purchase_limit_usdc IS NOT NULL
          AND task_limit_usdc IS NOT NULL AND usage_allowance_units IS NOT NULL
          AND task_usage_limit_units IS NOT NULL)),
  CHECK (status <> 'active' OR activated_at_ms IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX policy_version_unique ON policy (workspace_id, scope_type, ifnull(agent_id, ''), version);
CREATE UNIQUE INDEX policy_single_active ON policy (workspace_id, scope_type, ifnull(agent_id, '')) WHERE status = 'active';

-- A policy version's limits never change; a new limit is a new version.
CREATE TRIGGER policy_version_immutable BEFORE UPDATE OF
  workspace_id, scope_type, agent_id, version, tier, lifetime_limit_usdc, rolling_24h_limit_usdc,
  per_purchase_limit_usdc, task_limit_usdc, sponsor_lamport_limit, usage_allowance_units,
  task_usage_limit_units, approval_threshold_usdc, permissions_json, config_json, expires_at_ms, created_by
ON policy
BEGIN SELECT RAISE(ABORT, 'policy versions are immutable'); END;

CREATE TRIGGER policy_status_forward BEFORE UPDATE OF status ON policy
WHEN NOT ((OLD.status = 'draft' AND NEW.status IN ('active', 'discarded'))
       OR (OLD.status = 'active' AND NEW.status = 'superseded')
       OR OLD.status = NEW.status)
BEGIN SELECT RAISE(ABORT, 'invalid policy status transition'); END;

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_json)),
  limit_usdc INTEGER NOT NULL CHECK (limit_usdc >= 0),
  usage_limit_units INTEGER NOT NULL CHECK (usage_limit_units >= 0),
  deadline_at_ms INTEGER,
  max_tool_calls INTEGER NOT NULL DEFAULT 8 CHECK (max_tool_calls >= 0),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0 AND tool_calls <= max_tool_calls),
  max_purchases INTEGER NOT NULL DEFAULT 3 CHECK (max_purchases >= 0),
  purchase_count INTEGER NOT NULL DEFAULT 0 CHECK (purchase_count >= 0 AND purchase_count <= max_purchases),
  max_planning_calls INTEGER NOT NULL DEFAULT 2 CHECK (max_planning_calls >= 0),
  planning_calls INTEGER NOT NULL DEFAULT 0 CHECK (planning_calls >= 0 AND planning_calls <= max_planning_calls),
  plan_json TEXT CHECK (plan_json IS NULL OR json_valid(plan_json)),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'incomplete', 'failed', 'cancelled')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agent (id, workspace_id),
  UNIQUE (id, agent_id)
) STRICT;

CREATE TABLE approved_service (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  service_key TEXT NOT NULL,
  origin TEXT NOT NULL,
  gateway_identity TEXT,
  recipient TEXT,
  recipient_ata TEXT,
  network TEXT NOT NULL,
  mint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unbound', 'approved', 'disabled')),
  description TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (workspace_id, service_key),
  -- An approved binding names the gateway identity and exact recipient.
  CHECK (status <> 'approved' OR (gateway_identity IS NOT NULL AND recipient IS NOT NULL AND recipient_ata IS NOT NULL))
) STRICT;

CREATE TABLE service_sku (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES approved_service(id),
  sku TEXT NOT NULL,
  payment_path TEXT NOT NULL CHECK (payment_path IN ('private_x402', 'prepaid_credits')),
  price_usdc INTEGER NOT NULL CHECK (price_usdc >= 0),
  max_fee_usdc INTEGER NOT NULL CHECK (max_fee_usdc >= 0),
  usage_units INTEGER NOT NULL CHECK (usage_units >= 0),
  sponsor_lamports INTEGER NOT NULL CHECK (sponsor_lamports >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  UNIQUE (service_id, sku, payment_path),
  -- A direct USDC purchase never also consumes prepaid units, and vice versa.
  CHECK ((payment_path = 'private_x402' AND price_usdc > 0 AND usage_units = 0)
      OR (payment_path = 'prepaid_credits' AND price_usdc = 0 AND max_fee_usdc = 0 AND usage_units > 0))
) STRICT;

CREATE TABLE job (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('credit_check', 'research', 'content', 'reconcile')),
  trigger_key TEXT NOT NULL UNIQUE,
  scheduled_at_ms INTEGER NOT NULL,
  agent_epoch INTEGER NOT NULL CHECK (agent_epoch >= 0),
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'completed', 'failed', 'reconciling', 'cancelled')),
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  heartbeat_at_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agent (id, workspace_id),
  FOREIGN KEY (task_id, agent_id) REFERENCES task (id, agent_id),
  CHECK (state <> 'leased' OR (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL))
) STRICT;

CREATE TRIGGER job_version_increments BEFORE UPDATE ON job
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'job updates must increment version'); END;

CREATE TABLE purchase (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  job_id TEXT REFERENCES job(id),
  service_id TEXT NOT NULL REFERENCES approved_service(id),
  sku TEXT NOT NULL,
  payment_path TEXT NOT NULL CHECK (payment_path IN ('private_x402', 'prepaid_credits')),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  price_usdc INTEGER NOT NULL CHECK (price_usdc >= 0),
  fee_cap_usdc INTEGER NOT NULL CHECK (fee_cap_usdc >= 0),
  sponsor_lamports INTEGER NOT NULL CHECK (sponsor_lamports >= 0),
  usage_units INTEGER NOT NULL CHECK (usage_units >= 0),
  quote_id TEXT UNIQUE,
  quote_json TEXT CHECK (quote_json IS NULL OR json_valid(quote_json)),
  policy_snapshot_json TEXT NOT NULL CHECK (json_valid(policy_snapshot_json)),
  workspace_policy_version INTEGER NOT NULL,
  agent_policy_version INTEGER NOT NULL,
  agent_epoch INTEGER NOT NULL,
  stop_epoch INTEGER NOT NULL,
  rationale TEXT,
  authorization_state TEXT NOT NULL,
  funding_state TEXT NOT NULL,
  merchant_state TEXT NOT NULL,
  fulfilment_state TEXT NOT NULL,
  recovery_state TEXT NOT NULL,
  state_reason TEXT,
  settled_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (workspace_id, operation_id),
  UNIQUE (workspace_id, agent_id, idempotency_key),
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agent (id, workspace_id),
  FOREIGN KEY (task_id, agent_id) REFERENCES task (id, agent_id),
  CHECK (authorization_state IN ('proposed', 'awaiting_approval', 'reserved', 'released', 'rejected')),
  CHECK (funding_state IN ('not_required', 'not_started', 'proof_prepared', 'proof_released', 'submitted',
                           'finalized', 'uncertain', 'expired_unsettled', 'abandoned')),
  CHECK (merchant_state IN ('not_required', 'not_started', 'signed', 'submitted', 'finalized', 'uncertain',
                            'expired_unsettled', 'abandoned')),
  CHECK (fulfilment_state IN ('not_started', 'in_progress', 'delivered', 'uncertain', 'paid_without_result', 'abandoned')),
  CHECK (recovery_state IN ('none', 'recoverable', 'recovery_submitted', 'uncertain', 'recovered')),
  CHECK ((payment_path = 'private_x402' AND usage_units = 0)
      OR (payment_path = 'prepaid_credits' AND price_usdc = 0 AND fee_cap_usdc = 0
          AND funding_state = 'not_required' AND merchant_state = 'not_required'))
) STRICT;

CREATE INDEX purchase_agent ON purchase (agent_id, created_at_ms);

CREATE TRIGGER purchase_identity_immutable BEFORE UPDATE OF
  id, workspace_id, operation_id, idempotency_key, agent_id, task_id, service_id, sku, payment_path,
  request_digest, price_usdc, fee_cap_usdc, sponsor_lamports, usage_units, policy_snapshot_json,
  workspace_policy_version, agent_policy_version, agent_epoch, stop_epoch, created_at_ms
ON purchase
BEGIN SELECT RAISE(ABORT, 'purchase identity fields are immutable'); END;

CREATE TRIGGER purchase_quote_set_once BEFORE UPDATE OF quote_id, quote_json ON purchase
WHEN (OLD.quote_id IS NOT NULL AND NEW.quote_id IS NOT OLD.quote_id)
  OR (OLD.quote_json IS NOT NULL AND NEW.quote_json IS NOT OLD.quote_json)
BEGIN SELECT RAISE(ABORT, 'quote is immutable once recorded'); END;

-- Settlement time is the service-observed finalized time, written once.
CREATE TRIGGER purchase_settled_at_set_once BEFORE UPDATE OF settled_at_ms ON purchase
WHEN OLD.settled_at_ms IS NOT NULL AND NEW.settled_at_ms IS NOT OLD.settled_at_ms
BEGIN SELECT RAISE(ABORT, 'settled timestamp is immutable'); END;

CREATE TABLE payment_transition (
  field TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  PRIMARY KEY (field, from_state, to_state)
) STRICT, WITHOUT ROWID;

INSERT INTO payment_transition (field, from_state, to_state) VALUES
  ('authorization', 'proposed', 'awaiting_approval'),
  ('authorization', 'proposed', 'reserved'),
  ('authorization', 'proposed', 'rejected'),
  ('authorization', 'awaiting_approval', 'reserved'),
  ('authorization', 'awaiting_approval', 'rejected'),
  ('authorization', 'reserved', 'released'),
  ('authorization', 'reserved', 'rejected'),
  ('funding', 'not_started', 'proof_prepared'),
  ('funding', 'not_started', 'abandoned'),
  ('funding', 'proof_prepared', 'proof_released'),
  ('funding', 'proof_prepared', 'abandoned'),
  ('funding', 'proof_released', 'submitted'),
  ('funding', 'proof_released', 'uncertain'),
  ('funding', 'proof_released', 'finalized'),
  ('funding', 'proof_released', 'expired_unsettled'),
  ('funding', 'submitted', 'finalized'),
  ('funding', 'submitted', 'uncertain'),
  ('funding', 'submitted', 'expired_unsettled'),
  ('funding', 'uncertain', 'finalized'),
  ('funding', 'uncertain', 'expired_unsettled'),
  ('merchant', 'not_started', 'signed'),
  ('merchant', 'not_started', 'abandoned'),
  ('merchant', 'signed', 'submitted'),
  ('merchant', 'signed', 'uncertain'),
  ('merchant', 'signed', 'finalized'),
  ('merchant', 'signed', 'expired_unsettled'),
  ('merchant', 'submitted', 'finalized'),
  ('merchant', 'submitted', 'uncertain'),
  ('merchant', 'submitted', 'expired_unsettled'),
  ('merchant', 'uncertain', 'finalized'),
  ('merchant', 'uncertain', 'expired_unsettled'),
  ('fulfilment', 'not_started', 'in_progress'),
  ('fulfilment', 'not_started', 'abandoned'),
  ('fulfilment', 'in_progress', 'delivered'),
  ('fulfilment', 'in_progress', 'uncertain'),
  ('fulfilment', 'in_progress', 'paid_without_result'),
  ('fulfilment', 'uncertain', 'delivered'),
  ('fulfilment', 'uncertain', 'paid_without_result'),
  ('recovery', 'none', 'recoverable'),
  ('recovery', 'recoverable', 'recovery_submitted'),
  ('recovery', 'recovery_submitted', 'recovered'),
  ('recovery', 'recovery_submitted', 'uncertain'),
  ('recovery', 'uncertain', 'recovered'),
  ('recovery', 'uncertain', 'recoverable');

CREATE TRIGGER payment_transition_readonly_u BEFORE UPDATE ON payment_transition
BEGIN SELECT RAISE(ABORT, 'payment transitions are fixed by migration'); END;
CREATE TRIGGER payment_transition_readonly_d BEFORE DELETE ON payment_transition
BEGIN SELECT RAISE(ABORT, 'payment transitions are fixed by migration'); END;
CREATE TRIGGER payment_transition_readonly_i BEFORE INSERT ON payment_transition
BEGIN SELECT RAISE(ABORT, 'payment transitions are fixed by migration'); END;

CREATE TRIGGER purchase_authorization_transition BEFORE UPDATE OF authorization_state ON purchase
WHEN NEW.authorization_state <> OLD.authorization_state AND NOT EXISTS (
  SELECT 1 FROM payment_transition WHERE field = 'authorization' AND from_state = OLD.authorization_state AND to_state = NEW.authorization_state)
BEGIN SELECT RAISE(ABORT, 'invalid authorization state transition'); END;

CREATE TRIGGER purchase_funding_transition BEFORE UPDATE OF funding_state ON purchase
WHEN NEW.funding_state <> OLD.funding_state AND NOT EXISTS (
  SELECT 1 FROM payment_transition WHERE field = 'funding' AND from_state = OLD.funding_state AND to_state = NEW.funding_state)
BEGIN SELECT RAISE(ABORT, 'invalid funding state transition'); END;

CREATE TRIGGER purchase_merchant_transition BEFORE UPDATE OF merchant_state ON purchase
WHEN NEW.merchant_state <> OLD.merchant_state AND NOT EXISTS (
  SELECT 1 FROM payment_transition WHERE field = 'merchant' AND from_state = OLD.merchant_state AND to_state = NEW.merchant_state)
BEGIN SELECT RAISE(ABORT, 'invalid merchant state transition'); END;

CREATE TRIGGER purchase_fulfilment_transition BEFORE UPDATE OF fulfilment_state ON purchase
WHEN NEW.fulfilment_state <> OLD.fulfilment_state AND NOT EXISTS (
  SELECT 1 FROM payment_transition WHERE field = 'fulfilment' AND from_state = OLD.fulfilment_state AND to_state = NEW.fulfilment_state)
BEGIN SELECT RAISE(ABORT, 'invalid fulfilment state transition'); END;

CREATE TRIGGER purchase_recovery_transition BEFORE UPDATE OF recovery_state ON purchase
WHEN NEW.recovery_state <> OLD.recovery_state AND NOT EXISTS (
  SELECT 1 FROM payment_transition WHERE field = 'recovery' AND from_state = OLD.recovery_state AND to_state = NEW.recovery_state)
BEGIN SELECT RAISE(ABORT, 'invalid recovery state transition'); END;

CREATE TABLE reservation (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL UNIQUE REFERENCES purchase(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  task_id TEXT REFERENCES task(id),
  reserved_usdc INTEGER NOT NULL CHECK (reserved_usdc >= 0),
  reserved_lamports INTEGER NOT NULL CHECK (reserved_lamports >= 0),
  reserved_usage_units INTEGER NOT NULL CHECK (reserved_usage_units >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'released')),
  close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN
    ('settled', 'rejected', 'authority_stopped', 'proven_unsettled', 'recovered', 'pre_dispatch_failure')),
  created_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  CHECK ((status = 'active') = (closed_at_ms IS NULL AND close_reason IS NULL))
) STRICT;

CREATE INDEX reservation_active_agent ON reservation (agent_id) WHERE status = 'active';
CREATE INDEX reservation_active_workspace ON reservation (workspace_id) WHERE status = 'active';

CREATE TRIGGER reservation_amounts_immutable BEFORE UPDATE OF
  purchase_id, workspace_id, agent_id, task_id, reserved_usdc, reserved_lamports, reserved_usage_units, created_at_ms
ON reservation
BEGIN SELECT RAISE(ABORT, 'reservation amounts are immutable'); END;

CREATE TRIGGER reservation_close_once BEFORE UPDATE OF status ON reservation
WHEN OLD.status <> 'active'
BEGIN SELECT RAISE(ABORT, 'reservation is already closed'); END;

-- Policy accounting events. Append-only: balances are derived from these rows and reservations.
CREATE TABLE financial_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  agent_id TEXT REFERENCES agent(id),
  task_id TEXT REFERENCES task(id),
  purchase_id TEXT REFERENCES purchase(id),
  kind TEXT NOT NULL CHECK (kind IN ('reservation_opened', 'reservation_released', 'reservation_settled',
                                     'expense_settled', 'expense_adjusted')),
  asset TEXT NOT NULL CHECK (asset IN ('usdc', 'lamports', 'usage_units')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  principal_amount INTEGER CHECK (principal_amount >= 0),
  fee_amount INTEGER CHECK (fee_amount >= 0),
  linked_event_id TEXT REFERENCES financial_event(event_id),
  reason TEXT,
  occurred_at_ms INTEGER NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  CHECK (kind <> 'expense_settled' OR (principal_amount IS NOT NULL AND fee_amount IS NOT NULL
                                       AND amount = principal_amount + fee_amount AND linked_event_id IS NULL)),
  CHECK (kind <> 'expense_adjusted' OR (linked_event_id IS NOT NULL AND amount > 0
                                        AND reason IN ('merchant_refund', 'external_recovery', 'rent_recovered')))
) STRICT;

CREATE UNIQUE INDEX financial_event_one_expense ON financial_event (purchase_id, asset) WHERE kind = 'expense_settled';
CREATE INDEX financial_event_scope ON financial_event (workspace_id, agent_id, kind, occurred_at_ms);
CREATE INDEX financial_event_linked ON financial_event (linked_event_id) WHERE linked_event_id IS NOT NULL;

CREATE TRIGGER financial_event_no_update BEFORE UPDATE ON financial_event
BEGIN SELECT RAISE(ABORT, 'financial events are append-only'); END;
CREATE TRIGGER financial_event_no_delete BEFORE DELETE ON financial_event
BEGIN SELECT RAISE(ABORT, 'financial events are append-only'); END;

-- Adjustments link to one expense of the same asset and never exceed its principal; fees are not restorable.
CREATE TRIGGER financial_event_adjustment_bound BEFORE INSERT ON financial_event
WHEN NEW.kind = 'expense_adjusted' AND (
  NOT EXISTS (SELECT 1 FROM financial_event e WHERE e.event_id = NEW.linked_event_id
              AND e.kind = 'expense_settled' AND e.asset = NEW.asset AND e.purchase_id IS NEW.purchase_id)
  OR (SELECT e.principal_amount FROM financial_event e WHERE e.event_id = NEW.linked_event_id)
     < NEW.amount + ifnull((SELECT sum(a.amount) FROM financial_event a
                            WHERE a.linked_event_id = NEW.linked_event_id AND a.kind = 'expense_adjusted'), 0))
BEGIN SELECT RAISE(ABORT, 'adjustment exceeds the linked expense principal'); END;

-- Non-secret note references. Encrypted note secrets, labels and salts live in the wallet secrets database.
CREATE TABLE note (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  commitment TEXT NOT NULL UNIQUE CHECK (length(commitment) = 64),
  value INTEGER NOT NULL CHECK (value > 0),
  origin TEXT NOT NULL CHECK (origin IN ('deposit', 'change')),
  parent_purchase_id TEXT REFERENCES purchase(id),
  state TEXT NOT NULL CHECK (state IN ('pending_deposit', 'approved', 'reserved', 'consumed', 'pending_change',
                                       'spendable_change', 'exited')),
  reserved_purchase_id TEXT UNIQUE REFERENCES purchase(id),
  consumed_by_purchase_id TEXT UNIQUE REFERENCES purchase(id),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((state = 'reserved') = (reserved_purchase_id IS NOT NULL)),
  CHECK ((origin = 'change') = (parent_purchase_id IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX note_one_change_per_purchase ON note (parent_purchase_id) WHERE origin = 'change';

CREATE TRIGGER note_value_immutable BEFORE UPDATE OF value, commitment, origin, parent_purchase_id, workspace_id ON note
BEGIN SELECT RAISE(ABORT, 'note identity is immutable'); END;

CREATE TRIGGER note_consumed_terminal BEFORE UPDATE OF state ON note
WHEN OLD.state IN ('consumed', 'exited') AND NEW.state <> OLD.state
BEGIN SELECT RAISE(ABORT, 'consumed or exited note cannot change state'); END;

-- Physical token movements between buckets (base units of the pool mint). Append-only.
CREATE TABLE token_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  note_id TEXT REFERENCES note(id),
  purchase_id TEXT REFERENCES purchase(id),
  from_bucket TEXT CHECK (from_bucket IS NULL OR from_bucket IN ('approved_unreserved', 'reserved_input', 'consumed',
    'pending_change', 'confirmed_change', 'payout_balance', 'merchant_outflow', 'fee_outflow', 'external_recovered')),
  to_bucket TEXT CHECK (to_bucket IS NULL OR to_bucket IN ('approved_unreserved', 'reserved_input', 'consumed',
    'pending_change', 'confirmed_change', 'payout_balance', 'merchant_outflow', 'fee_outflow', 'external_recovered')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  CHECK (from_bucket IS NOT NULL OR to_bucket IS NOT NULL),
  CHECK (from_bucket IS NOT to_bucket)
) STRICT;

CREATE TRIGGER token_event_no_update BEFORE UPDATE ON token_event
BEGIN SELECT RAISE(ABORT, 'token events are append-only'); END;
CREATE TRIGGER token_event_no_delete BEFORE DELETE ON token_event
BEGIN SELECT RAISE(ABORT, 'token events are append-only'); END;

CREATE TABLE chain_attempt (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchase(id),
  leg TEXT NOT NULL CHECK (leg IN ('funding', 'merchant', 'recovery', 'ata_create', 'ata_close', 'insert_change')),
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  signature TEXT UNIQUE,
  blockhash TEXT,
  last_valid_block_height INTEGER,
  valid_until_slot INTEGER,
  observed_commitment TEXT NOT NULL CHECK (observed_commitment IN
    ('unknown', 'not_found', 'processed', 'confirmed', 'finalized', 'failed', 'expired')),
  observed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (purchase_id, leg, attempt_no)
) STRICT;

CREATE TRIGGER chain_attempt_identity_immutable BEFORE UPDATE OF
  purchase_id, leg, attempt_no, blockhash, last_valid_block_height, valid_until_slot, created_at_ms
ON chain_attempt
BEGIN SELECT RAISE(ABORT, 'chain attempt identity is immutable'); END;

CREATE TRIGGER chain_attempt_signature_once BEFORE UPDATE OF signature ON chain_attempt
WHEN OLD.signature IS NOT NULL AND NEW.signature IS NOT OLD.signature
BEGIN SELECT RAISE(ABORT, 'chain attempt signature is immutable'); END;

CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  kind TEXT NOT NULL CHECK (kind IN ('research_brief', 'content_draft', 'content_calendar')),
  title TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  review_state TEXT NOT NULL CHECK (review_state IN ('draft', 'needs_review', 'approved_for_export', 'archived')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE artifact_revision (
  artifact_id TEXT NOT NULL REFERENCES artifact(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations_json)),
  source_purchase_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_purchase_ids_json)),
  author TEXT NOT NULL CHECK (author IN ('agent', 'owner')),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, revision)
) STRICT;

CREATE TRIGGER artifact_revision_no_update BEFORE UPDATE ON artifact_revision
BEGIN SELECT RAISE(ABORT, 'artifact revisions are immutable'); END;

CREATE TABLE handoff_request (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  artifact_id TEXT NOT NULL REFERENCES artifact(id),
  from_agent_id TEXT NOT NULL REFERENCES agent(id),
  to_agent_id TEXT NOT NULL REFERENCES agent(id),
  note TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending_owner', 'approved', 'rejected')),
  created_at_ms INTEGER NOT NULL,
  decided_at_ms INTEGER,
  CHECK (from_agent_id <> to_agent_id),
  UNIQUE (artifact_id, to_agent_id)
) STRICT;

-- Never stores raw secret values; writers pass details through a redacting sanitizer.
CREATE TABLE audit_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT REFERENCES workspace(id),
  scope TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'worker', 'service', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  policy_result TEXT NOT NULL CHECK (policy_result IN ('allowed', 'denied', 'not_applicable')),
  reason_code TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at_ms INTEGER NOT NULL,
  published_at_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
) STRICT;

CREATE INDEX outbox_unpublished ON outbox (seq) WHERE published_at_ms IS NULL;

CREATE TRIGGER outbox_payload_immutable BEFORE UPDATE OF event_id, topic, aggregate_id, payload_json, created_at_ms ON outbox
BEGIN SELECT RAISE(ABORT, 'outbox events are immutable'); END;

CREATE TABLE inbox (
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  processed_at_ms INTEGER
) STRICT;

CREATE TRIGGER inbox_identity_immutable BEFORE UPDATE OF event_id, source, topic, payload_digest, received_at_ms ON inbox
BEGIN SELECT RAISE(ABORT, 'inbox events are immutable'); END;
