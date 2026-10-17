-- Purchase execution across control, wallet and gateway; Shawn top-up episodes; task run bounds.

ALTER TABLE task ADD COLUMN started_at_ms INTEGER;
ALTER TABLE task ADD COLUMN max_duration_ms INTEGER NOT NULL DEFAULT 600000;

-- Exact SKU input bound to the purchase's request digest. Written once.
CREATE TABLE purchase_input (
  purchase_id TEXT PRIMARY KEY REFERENCES purchase(id),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER purchase_input_immutable BEFORE UPDATE ON purchase_input
BEGIN SELECT RAISE(ABORT, 'purchase input is immutable'); END;

-- Every gateway quote received for one logical operation, in order. Quotes are immutable;
-- a re-quote appends a row and never replaces an earlier one.
CREATE TABLE purchase_quote (
  purchase_id TEXT NOT NULL REFERENCES purchase(id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  quote_id TEXT NOT NULL UNIQUE,
  charge_usdc INTEGER NOT NULL CHECK (charge_usdc >= 0),
  quote_json TEXT NOT NULL CHECK (json_valid(quote_json)),
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (purchase_id, seq)
) STRICT;

CREATE TRIGGER purchase_quote_immutable BEFORE UPDATE ON purchase_quote
BEGIN SELECT RAISE(ABORT, 'quotes are immutable'); END;

-- Cross-service execution state for one purchase. One usage permit nonce and one gateway
-- reservation ID per operation, carried across reserve/execute/commit/release.
CREATE TABLE purchase_execution (
  purchase_id TEXT PRIMARY KEY REFERENCES purchase(id),
  path TEXT NOT NULL CHECK (path IN ('x402', 'usage')),
  funding_ref TEXT,
  merchant_payer TEXT,
  merchant_message_hash TEXT,
  funding_token_fees INTEGER CHECK (funding_token_fees IS NULL OR funding_token_fees >= 0),
  sponsor_lamports_spent INTEGER CHECK (sponsor_lamports_spent IS NULL OR sponsor_lamports_spent >= 0),
  usage_permit TEXT,
  usage_permit_nonce TEXT UNIQUE,
  usage_permit_expires_at_ms INTEGER,
  usage_reservation_id TEXT UNIQUE,
  gateway_state TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  last_error_code TEXT,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (path = 'usage' OR usage_permit IS NULL)
) STRICT;

CREATE TRIGGER purchase_execution_refs_set_once BEFORE UPDATE OF
  funding_ref, usage_permit, usage_permit_nonce, usage_reservation_id, merchant_message_hash, path
ON purchase_execution
WHEN (OLD.funding_ref IS NOT NULL AND NEW.funding_ref IS NOT OLD.funding_ref)
  OR (OLD.usage_permit IS NOT NULL AND NEW.usage_permit IS NOT OLD.usage_permit)
  OR (OLD.usage_permit_nonce IS NOT NULL AND NEW.usage_permit_nonce IS NOT OLD.usage_permit_nonce)
  OR (OLD.usage_reservation_id IS NOT NULL AND NEW.usage_reservation_id IS NOT OLD.usage_reservation_id)
  OR (OLD.merchant_message_hash IS NOT NULL AND NEW.merchant_message_hash IS NOT OLD.merchant_message_hash)
  OR NEW.path IS NOT OLD.path
BEGIN SELECT RAISE(ABORT, 'execution references are written once'); END;

-- A low-credit top-up episode. At most one unresolved episode per gateway account.
CREATE TABLE credit_episode (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  account_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'completed', 'rejected', 'failed')),
  trigger_usable INTEGER NOT NULL CHECK (trigger_usable >= 0),
  trigger_version TEXT NOT NULL,
  trigger_as_of TEXT NOT NULL,
  purchase_id TEXT UNIQUE REFERENCES purchase(id),
  sequence INTEGER CHECK (sequence IS NULL OR sequence >= 1),
  reason_code TEXT,
  reason TEXT,
  agent_policy_version INTEGER NOT NULL,
  workspace_policy_version INTEGER NOT NULL,
  stop_epoch INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  CHECK ((state = 'open') = (closed_at_ms IS NULL)),
  CHECK ((state = 'completed') = (sequence IS NOT NULL)),
  UNIQUE (account_id, sequence)
) STRICT;

CREATE UNIQUE INDEX credit_episode_one_open ON credit_episode (account_id) WHERE state = 'open';

CREATE TRIGGER credit_episode_close_once BEFORE UPDATE OF state ON credit_episode
WHEN OLD.state <> 'open' AND NEW.state <> OLD.state
BEGIN SELECT RAISE(ABORT, 'credit episode is already closed'); END;

-- Monotonic replenishment sequence per account; advanced only when an episode completes.
CREATE TABLE credit_replenishment (
  account_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  last_episode_id TEXT REFERENCES credit_episode(id),
  last_completed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER credit_replenishment_monotonic BEFORE UPDATE OF sequence ON credit_replenishment
WHEN NEW.sequence <> OLD.sequence + 1
BEGIN SELECT RAISE(ABORT, 'replenishment sequence advances by exactly one'); END;

-- Owner-approved handoff produces a reserved receiving task; data is copied locally.
CREATE TABLE handoff_task (
  handoff_id TEXT PRIMARY KEY REFERENCES handoff_request(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES task(id),
  created_at_ms INTEGER NOT NULL
) STRICT;
