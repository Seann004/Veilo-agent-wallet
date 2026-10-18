-- An agent's workflow proposal carries its own idempotency key: a retried proposal with the same
-- inputs returns the same run, and the key cannot be reused for different terms.
ALTER TABLE workflow_run ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX workflow_run_agent_idempotency ON workflow_run (agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER workflow_run_idempotency_immutable BEFORE UPDATE OF idempotency_key ON workflow_run
BEGIN SELECT RAISE(ABORT, 'workflow run idempotency key is immutable'); END;

-- What the agent is shown about an assigned workflow, captured when the owner assigns it. Rows
-- created before this migration have no version and are not offered to agents.
ALTER TABLE workflow_assignment ADD COLUMN version_id TEXT;
ALTER TABLE workflow_assignment ADD COLUMN title TEXT;
ALTER TABLE workflow_assignment ADD COLUMN summary TEXT;
ALTER TABLE workflow_assignment ADD COLUMN run_inputs_json TEXT CHECK (run_inputs_json IS NULL OR json_valid(run_inputs_json));
ALTER TABLE workflow_assignment ADD COLUMN total_usdc INTEGER CHECK (total_usdc IS NULL OR total_usdc > 0);

CREATE TRIGGER workflow_assignment_offer_immutable BEFORE UPDATE OF version_id, title, summary, run_inputs_json, total_usdc ON workflow_assignment
BEGIN SELECT RAISE(ABORT, 'assignment terms are immutable; a new budget is a new assignment'); END;
