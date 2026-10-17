-- Workflow runs are authorized here, not in the cloud. One owner approval binds a run to the
-- workflow version, each step's tool, recipient and maximum, and the total; every step is still
-- its own purchase with its own reservation, payer and receipt.
CREATE TABLE workflow_run (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  workflow_id TEXT NOT NULL,
  workflow_version_id TEXT NOT NULL,
  cloud_run_id TEXT UNIQUE,
  terms_json TEXT NOT NULL CHECK (json_valid(terms_json)),
  approval_digest TEXT NOT NULL CHECK (length(approval_digest) = 64),
  steps_json TEXT NOT NULL CHECK (json_valid(steps_json)),
  total_max_usdc INTEGER NOT NULL CHECK (total_max_usdc > 0),
  run_inputs_json TEXT NOT NULL CHECK (json_valid(run_inputs_json)),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  requested_by TEXT NOT NULL CHECK (requested_by IN ('owner', 'agent')),
  assignment_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'approved', 'running', 'halted', 'failed', 'completed', 'rejected')),
  approved_by TEXT,
  approved_at_ms INTEGER,
  stop_code TEXT,
  stop_reason TEXT,
  reported_status TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (status IN ('awaiting_approval', 'rejected') OR approved_by IS NOT NULL)
) STRICT;

CREATE TRIGGER workflow_run_terms_immutable BEFORE UPDATE OF
  id, workspace_id, agent_id, workflow_id, workflow_version_id, terms_json, approval_digest, steps_json, total_max_usdc, run_inputs_json,
  is_test, requested_by, created_at_ms
ON workflow_run
BEGIN SELECT RAISE(ABORT, 'workflow run terms are immutable; approve a new run'); END;

-- An agent proposal is tied to the assignment that pre-approves it once, before it is approved.
CREATE TRIGGER workflow_run_assignment_once BEFORE UPDATE OF assignment_id ON workflow_run
WHEN OLD.assignment_id IS NOT NULL OR OLD.status <> 'awaiting_approval'
BEGIN SELECT RAISE(ABORT, 'workflow run assignment is set once, before approval'); END;

CREATE TRIGGER workflow_run_terminal BEFORE UPDATE OF status ON workflow_run
WHEN OLD.status IN ('failed', 'completed', 'rejected') AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'workflow run is final'); END;

CREATE TABLE workflow_run_step (
  run_id TEXT NOT NULL REFERENCES workflow_run(id),
  step_index INTEGER NOT NULL CHECK (step_index BETWEEN 0 AND 7),
  tool_kind TEXT NOT NULL CHECK (tool_kind IN ('listing', 'external')),
  tool_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  max_usdc INTEGER NOT NULL CHECK (max_usdc > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'hiring', 'paying', 'paid', 'delivered', 'failed', 'halted', 'not_run')),
  operation_id TEXT UNIQUE,
  quote_digest TEXT CHECK (quote_digest IS NULL OR length(quote_digest) = 64),
  job_id TEXT,
  purchase_id TEXT UNIQUE,
  paid_usdc INTEGER CHECK (paid_usdc IS NULL OR paid_usdc <= max_usdc),
  funding_signature TEXT,
  merchant_signatures_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(merchant_signatures_json)),
  artifact_kind TEXT,
  artifact_text TEXT,
  artifact_sha256 TEXT CHECK (artifact_sha256 IS NULL OR length(artifact_sha256) = 64),
  stop_code TEXT,
  stop_reason TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, step_index)
) STRICT;

CREATE TRIGGER workflow_run_step_identity BEFORE UPDATE OF run_id, step_index, tool_kind, tool_id, recipient, max_usdc ON workflow_run_step
BEGIN SELECT RAISE(ABORT, 'workflow step terms are immutable'); END;

CREATE TRIGGER workflow_run_step_refs_once BEFORE UPDATE OF operation_id, quote_digest, job_id, purchase_id, artifact_sha256 ON workflow_run_step
WHEN (OLD.operation_id IS NOT NULL AND NEW.operation_id IS NOT OLD.operation_id)
  OR (OLD.quote_digest IS NOT NULL AND NEW.quote_digest IS NOT OLD.quote_digest)
  OR (OLD.job_id IS NOT NULL AND NEW.job_id IS NOT OLD.job_id)
  OR (OLD.purchase_id IS NOT NULL AND NEW.purchase_id IS NOT OLD.purchase_id)
  OR (OLD.artifact_sha256 IS NOT NULL AND NEW.artifact_sha256 IS NOT OLD.artifact_sha256)
BEGIN SELECT RAISE(ABORT, 'workflow step references are written once'); END;

-- "Add to agent": the agent may propose runs of this workflow while its committed totals stay within
-- the budget. Only the owner creates or revokes an assignment; agents have no route that changes one.
CREATE TABLE workflow_assignment (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  workflow_id TEXT NOT NULL,
  -- Digest of the approved terms without run inputs; a different version, step or recipient needs the owner again.
  approved_terms_digest TEXT NOT NULL CHECK (length(approved_terms_digest) = 64),
  budget_usdc INTEGER NOT NULL CHECK (budget_usdc > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  owner_pubkey TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX workflow_assignment_active ON workflow_assignment (agent_id, workflow_id) WHERE status = 'active';

CREATE TRIGGER workflow_assignment_terms_immutable BEFORE UPDATE OF id, workspace_id, agent_id, workflow_id, approved_terms_digest, budget_usdc, owner_pubkey, created_at_ms
ON workflow_assignment
BEGIN SELECT RAISE(ABORT, 'assignment terms are immutable; a new budget is a new assignment'); END;

CREATE TRIGGER workflow_assignment_revoke_once BEFORE UPDATE OF status ON workflow_assignment
WHEN OLD.status = 'revoked' AND NEW.status <> 'revoked'
BEGIN SELECT RAISE(ABORT, 'a revoked assignment stays revoked'); END;
