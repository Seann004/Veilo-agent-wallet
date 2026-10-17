-- veilo:table-rebuild
-- Custom agents (owner-named, instruction-driven) and the local side of marketplace hires.
-- agent and job are rebuilt to widen their role/kind CHECKs; rows, triggers and keys are kept.

CREATE TABLE agent_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  role TEXT NOT NULL CHECK (role IN ('credit_manager', 'research', 'content', 'custom')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'revoked', 'archived')),
  policy_version INTEGER NOT NULL DEFAULT 0 CHECK (policy_version >= 0),
  revocation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (revocation_epoch >= 0),
  trigger_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(trigger_json)),
  model_profile TEXT,
  description TEXT,
  target_account_id TEXT,
  template TEXT CHECK (template IS NULL OR template IN ('generalist', 'researcher', 'writer', 'analyst')),
  instructions TEXT CHECK (instructions IS NULL OR length(instructions) BETWEEN 1 AND 8000),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (id, workspace_id),
  CHECK ((role = 'custom') = (instructions IS NOT NULL)),
  CHECK (role = 'custom' OR template IS NULL)
) STRICT;

INSERT INTO agent_new (id, workspace_id, name, role, status, policy_version, revocation_epoch, trigger_json, model_profile,
  description, target_account_id, template, instructions, created_at_ms, updated_at_ms)
SELECT id, workspace_id, name, role, status, policy_version, revocation_epoch, trigger_json, model_profile,
  description, target_account_id, NULL, NULL, created_at_ms, updated_at_ms
FROM agent;

DROP TABLE agent;
ALTER TABLE agent_new RENAME TO agent;

CREATE TRIGGER agent_revoked_is_terminal BEFORE UPDATE OF status ON agent
WHEN OLD.status = 'revoked' AND NEW.status NOT IN ('revoked', 'archived')
BEGIN SELECT RAISE(ABORT, 'revoked agent cannot be reactivated'); END;

CREATE TRIGGER agent_archived_is_terminal BEFORE UPDATE OF status ON agent
WHEN OLD.status = 'archived' AND NEW.status <> 'archived'
BEGIN SELECT RAISE(ABORT, 'archived agent cannot be reactivated'); END;

CREATE TRIGGER agent_epochs_monotonic BEFORE UPDATE OF revocation_epoch ON agent
WHEN NEW.revocation_epoch < OLD.revocation_epoch
BEGIN SELECT RAISE(ABORT, 'revocation epoch cannot decrease'); END;

CREATE TRIGGER agent_role_immutable BEFORE UPDATE OF role ON agent
WHEN NEW.role IS NOT OLD.role
BEGIN SELECT RAISE(ABORT, 'agent role is immutable'); END;

CREATE TABLE job_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('credit_check', 'research', 'content', 'reconcile', 'custom')),
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

INSERT INTO job_new (id, workspace_id, agent_id, task_id, kind, trigger_key, scheduled_at_ms, agent_epoch, state, lease_owner,
  lease_expires_at_ms, heartbeat_at_ms, attempt_count, version, result_json, created_at_ms, updated_at_ms)
SELECT id, workspace_id, agent_id, task_id, kind, trigger_key, scheduled_at_ms, agent_epoch, state, lease_owner,
  lease_expires_at_ms, heartbeat_at_ms, attempt_count, version, result_json, created_at_ms, updated_at_ms
FROM job;

DROP TABLE job;
ALTER TABLE job_new RENAME TO job;

CREATE TRIGGER job_version_increments BEFORE UPDATE ON job
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'job updates must increment version'); END;

-- This controller's marketplace registration as submitted by the owner. Holds public data only;
-- the controller private key stays in a 0600 file under the secrets directory.
CREATE TABLE marketplace_controller (
  key_id TEXT PRIMARY KEY,
  controller_key TEXT NOT NULL,
  cloud_workspace_id TEXT NOT NULL,
  cloud_user_id TEXT NOT NULL,
  registered_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

-- One cloud payment request, persisted before control acts on it. A cloud approval is recorded
-- here as data; spending needs a local owner approval or an owner-installed listing grant.
CREATE TABLE marketplace_hire (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  job_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  listing_version_id TEXT NOT NULL,
  listing_json TEXT NOT NULL CHECK (json_valid(listing_json)),
  quote_digest TEXT NOT NULL CHECK (length(quote_digest) = 64),
  quote_json TEXT NOT NULL CHECK (json_valid(quote_json)),
  brief TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK (requested_by IN ('owner', 'agent')),
  -- Local agent the cloud says proposed the hire; untrusted until matched to a local proposal.
  claimed_agent_id TEXT,
  recipient TEXT NOT NULL,
  total_units INTEGER NOT NULL CHECK (total_units >= 0),
  state TEXT NOT NULL CHECK (state IN ('received', 'awaiting_approval', 'authorized', 'purchasing', 'uncertain', 'paid',
    'failed_unpaid', 'rejected')),
  reject_code TEXT,
  reject_reason TEXT,
  basis TEXT CHECK (basis IS NULL OR basis IN ('owner_approval', 'listing_grant')),
  agent_id TEXT REFERENCES agent(id),
  service_id TEXT REFERENCES approved_service(id),
  purchase_id TEXT UNIQUE REFERENCES purchase(id),
  evidence_signature TEXT,
  -- One-time payer reported to the marketplace; proof release waits until it is bound there.
  payer TEXT,
  payer_state TEXT NOT NULL DEFAULT 'none' CHECK (payer_state IN ('none', 'bound', 'refused')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((state = 'rejected') = (reject_code IS NOT NULL)),
  CHECK (payer_state = 'none' OR payer IS NOT NULL),
  CHECK (state NOT IN ('authorized', 'purchasing', 'uncertain', 'paid') OR (basis IS NOT NULL AND agent_id IS NOT NULL))
) STRICT;

CREATE TRIGGER marketplace_hire_identity_immutable BEFORE UPDATE OF
  operation_id, workspace_id, job_id, listing_id, listing_version_id, quote_digest, quote_json, brief, recipient, total_units, created_at_ms
ON marketplace_hire
BEGIN SELECT RAISE(ABORT, 'marketplace hire identity is immutable'); END;

CREATE TRIGGER marketplace_hire_refs_set_once BEFORE UPDATE OF purchase_id, agent_id, basis, evidence_signature, payer, payer_state ON marketplace_hire
WHEN (OLD.purchase_id IS NOT NULL AND NEW.purchase_id IS NOT OLD.purchase_id)
  OR (OLD.payer IS NOT NULL AND NEW.payer IS NOT OLD.payer)
  OR (OLD.payer_state <> 'none' AND NEW.payer_state IS NOT OLD.payer_state)
  OR (OLD.agent_id IS NOT NULL AND NEW.agent_id IS NOT OLD.agent_id)
  OR (OLD.basis IS NOT NULL AND NEW.basis IS NOT OLD.basis)
  OR (OLD.evidence_signature IS NOT NULL AND NEW.evidence_signature IS NOT OLD.evidence_signature)
BEGIN SELECT RAISE(ABORT, 'marketplace hire references are written once'); END;

CREATE TRIGGER marketplace_hire_terminal BEFORE UPDATE OF state ON marketplace_hire
WHEN OLD.state IN ('paid', 'failed_unpaid', 'rejected') AND NEW.state <> OLD.state
BEGIN SELECT RAISE(ABORT, 'marketplace hire is already final'); END;

-- Local owner approval bound to the exact operation, quote digest, recipient and amount.
CREATE TABLE marketplace_hire_approval (
  operation_id TEXT PRIMARY KEY REFERENCES marketplace_hire(operation_id),
  quote_digest TEXT NOT NULL CHECK (length(quote_digest) = 64),
  recipient TEXT NOT NULL,
  total_units INTEGER NOT NULL CHECK (total_units >= 0),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  owner_pubkey TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER marketplace_hire_approval_immutable BEFORE UPDATE ON marketplace_hire_approval
BEGIN SELECT RAISE(ABORT, 'hire approvals are immutable'); END;

-- Owner-installed grant: this agent may hire this listing, paying only this recipient, up to this price.
CREATE TABLE marketplace_listing_grant (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  listing_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  max_total_units INTEGER NOT NULL CHECK (max_total_units > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  removed_at_ms INTEGER,
  CHECK ((status = 'removed') = (removed_at_ms IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX marketplace_listing_grant_active ON marketplace_listing_grant (agent_id, listing_id) WHERE status = 'active';

CREATE TRIGGER marketplace_listing_grant_terms_immutable BEFORE UPDATE OF agent_id, listing_id, recipient, max_total_units, created_at_ms
ON marketplace_listing_grant
BEGIN SELECT RAISE(ABORT, 'listing grant terms are immutable; remove and re-create'); END;

-- A hire an agent proposed through control. A grant can fund a cloud request only when it
-- matches one of these by agent, listing and brief digest, and each proposal funds at most once.
CREATE TABLE marketplace_proposal (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  task_id TEXT REFERENCES task(id),
  listing_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  brief TEXT NOT NULL CHECK (length(brief) BETWEEN 1 AND 16000),
  brief_digest TEXT NOT NULL CHECK (length(brief_digest) = 64),
  delegation_depth INTEGER NOT NULL CHECK (delegation_depth >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'submitted', 'refused')),
  remote_json TEXT CHECK (remote_json IS NULL OR json_valid(remote_json)),
  operation_id TEXT UNIQUE REFERENCES marketplace_hire(operation_id),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (agent_id, idempotency_key)
) STRICT;

CREATE TRIGGER marketplace_proposal_identity_immutable BEFORE UPDATE OF agent_id, task_id, listing_id, idempotency_key, brief, brief_digest, delegation_depth
ON marketplace_proposal
BEGIN SELECT RAISE(ABORT, 'proposal identity is immutable'); END;

CREATE TRIGGER marketplace_proposal_funds_once BEFORE UPDATE OF operation_id ON marketplace_proposal
WHEN OLD.operation_id IS NOT NULL AND NEW.operation_id IS NOT OLD.operation_id
BEGIN SELECT RAISE(ABORT, 'a proposal funds at most one payment request'); END;
