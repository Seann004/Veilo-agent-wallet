-- Owner-approved external x402 resources. Each binding is backed by an approved_service row
-- (service_key 'x402:<id>') and one 'external-x402-batch' SKU priced at unit × max_calls.
CREATE TABLE external_binding (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  service_id TEXT NOT NULL UNIQUE REFERENCES approved_service(id),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  origin TEXT NOT NULL,
  resource_path TEXT NOT NULL,
  network TEXT NOT NULL,
  mint TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  pay_to_ata TEXT NOT NULL,
  unit_price_usdc INTEGER NOT NULL CHECK (unit_price_usdc > 0),
  max_calls INTEGER NOT NULL CHECK (max_calls BETWEEN 1 AND 100),
  allowed_fee_payers_json TEXT NOT NULL CHECK (json_valid(allowed_fee_payers_json) AND json_array_length(allowed_fee_payers_json) > 0),
  allowed_rpc_methods_json TEXT CHECK (allowed_rpc_methods_json IS NULL OR json_valid(allowed_rpc_methods_json)),
  status TEXT NOT NULL CHECK (status IN ('approved', 'disabled')),
  approved_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER external_binding_terms_immutable BEFORE UPDATE OF
  id, workspace_id, service_id, origin, resource_path, network, mint, pay_to, pay_to_ata, unit_price_usdc, max_calls,
  allowed_fee_payers_json, allowed_rpc_methods_json, approved_by, created_at_ms
ON external_binding
BEGIN SELECT RAISE(ABORT, 'external binding terms are immutable; approve a new binding'); END;

CREATE TRIGGER external_binding_disable_only BEFORE UPDATE OF status ON external_binding
WHEN OLD.status = 'disabled' AND NEW.status <> 'disabled'
BEGIN SELECT RAISE(ABORT, 'a disabled external binding stays disabled'); END;

-- One row per call of an external batch purchase, written before the payment leaves the wallet.
CREATE TABLE external_call_result (
  purchase_id TEXT NOT NULL REFERENCES purchase(id),
  call_index INTEGER NOT NULL CHECK (call_index >= 0 AND call_index < 100),
  state TEXT NOT NULL CHECK (state IN ('signing', 'sent', 'paid', 'paid_no_result', 'unpaid', 'refused')),
  amount_usdc INTEGER NOT NULL CHECK (amount_usdc > 0),
  message_hash TEXT,
  settlement_signature TEXT UNIQUE,
  http_status INTEGER,
  response_sha256 TEXT CHECK (response_sha256 IS NULL OR length(response_sha256) = 64),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  stop_code TEXT,
  stop_reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (purchase_id, call_index)
) STRICT;

CREATE TRIGGER external_call_result_terminal BEFORE UPDATE OF state ON external_call_result
WHEN OLD.state IN ('paid', 'paid_no_result', 'unpaid', 'refused') AND NEW.state <> OLD.state
BEGIN SELECT RAISE(ABORT, 'external call outcome is final'); END;

CREATE TRIGGER external_call_result_message_once BEFORE UPDATE OF message_hash ON external_call_result
WHEN OLD.message_hash IS NOT NULL AND NEW.message_hash IS NOT OLD.message_hash
BEGIN SELECT RAISE(ABORT, 'external call message is immutable'); END;
