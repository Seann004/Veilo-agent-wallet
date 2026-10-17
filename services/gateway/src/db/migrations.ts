/**
 * Gateway ledger schema. Financial events are append-only; account counters are a cache
 * that every writer updates in the same transaction and `verifyCounters` re-derives.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "gateway ledger",
    sql: `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  issued INTEGER NOT NULL DEFAULT 0 CHECK (issued >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK (issued - consumed - reserved >= 0)
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  operation_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  sku TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  input_json TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  merchant_ata TEXT NOT NULL,
  fee_payer TEXT NOT NULL,
  facilitator_url TEXT NOT NULL,
  max_timeout_seconds INTEGER NOT NULL,
  max_input_tokens INTEGER,
  max_output_tokens INTEGER,
  delivery TEXT NOT NULL,
  gateway_identity TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  superseded_by TEXT REFERENCES quotes(id),
  UNIQUE (account_id, operation_id, seq)
);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  blockhash TEXT NOT NULL,
  last_valid_block_height INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  UNIQUE (quote_id, blockhash)
);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  operation_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  amount INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending_settlement', 'finalized', 'delivered', 'incomplete', 'paid_no_result', 'unpaid'
  )),
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE payment_attempts (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  message_hash TEXT NOT NULL UNIQUE,
  payer TEXT NOT NULL,
  payment_header TEXT NOT NULL,
  blockhash TEXT NOT NULL,
  last_valid_block_height INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'settle_unknown', 'submitted', 'finalized', 'failed')),
  tx_signature TEXT UNIQUE,
  settle_response_json TEXT,
  failure TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX payment_attempts_one_live ON payment_attempts(purchase_id)
  WHERE state IN ('claimed', 'settle_unknown', 'submitted', 'finalized');

CREATE TABLE payment_events (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES payment_attempts(id),
  tx_signature TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  finalized_slot INTEGER NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE credit_issuances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id),
  payment_event_id TEXT NOT NULL UNIQUE REFERENCES payment_events(id),
  payment_signature TEXT NOT NULL UNIQUE,
  sku TEXT NOT NULL,
  units INTEGER NOT NULL CHECK (units > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE usage_operations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  operation_id TEXT NOT NULL,
  permit_nonce TEXT NOT NULL UNIQUE,
  sku TEXT NOT NULL,
  units INTEGER NOT NULL CHECK (units > 0),
  request_digest TEXT NOT NULL,
  scope TEXT NOT NULL,
  agent_ref TEXT,
  task_ref TEXT,
  permit_expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatched', 'completed', 'incomplete', 'uncertain', 'released')),
  input_json TEXT,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, operation_id)
);

CREATE TABLE credit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'reserve', 'consume', 'release')),
  units INTEGER NOT NULL CHECK (units > 0),
  issuance_id TEXT UNIQUE REFERENCES credit_issuances(id),
  reservation_id TEXT REFERENCES usage_operations(id),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'issue') = (issuance_id IS NOT NULL)),
  CHECK ((kind <> 'issue') = (reservation_id IS NOT NULL)),
  UNIQUE (reservation_id, kind)
);
CREATE TRIGGER credit_events_no_update BEFORE UPDATE ON credit_events
  BEGIN SELECT RAISE(ABORT, 'credit_events is append-only'); END;
CREATE TRIGGER credit_events_no_delete BEFORE DELETE ON credit_events
  BEGIN SELECT RAISE(ABORT, 'credit_events is append-only'); END;
CREATE TRIGGER credit_events_single_terminal BEFORE INSERT ON credit_events
  WHEN NEW.kind IN ('consume', 'release') AND EXISTS (
    SELECT 1 FROM credit_events WHERE reservation_id = NEW.reservation_id AND kind IN ('consume', 'release'))
  BEGIN SELECT RAISE(ABORT, 'reservation already resolved'); END;
CREATE TRIGGER credit_events_terminal_needs_reserve BEFORE INSERT ON credit_events
  WHEN NEW.kind IN ('consume', 'release') AND NOT EXISTS (
    SELECT 1 FROM credit_events WHERE reservation_id = NEW.reservation_id AND kind = 'reserve' AND units = NEW.units)
  BEGIN SELECT RAISE(ABORT, 'no matching reservation'); END;

CREATE TABLE provider_executions (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('purchase', 'usage', 'planning', 'smoke')),
  source_id TEXT NOT NULL,
  model TEXT NOT NULL,
  max_input_tokens INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('started', 'succeeded', 'failed', 'uncertain')),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'fixture')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  http_status INTEGER,
  generation_id TEXT,
  reported_model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  output_text TEXT,
  failure TEXT,
  UNIQUE (source_kind, source_id)
);

CREATE TABLE operator_cost_ledger (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES provider_executions(id),
  model TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('x402', 'prepaid', 'planning', 'smoke')),
  worst_case_micro INTEGER NOT NULL CHECK (worst_case_micro > 0),
  actual_micro INTEGER,
  actual_source TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released', 'uncertain')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE planning_calls (
  id TEXT PRIMARY KEY,
  task_ref TEXT NOT NULL,
  call_index INTEGER NOT NULL CHECK (call_index IN (1, 2)),
  purpose TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (task_ref, call_index)
);

CREATE TABLE pricing_checks (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  prompt_pico INTEGER,
  completion_pico INTEGER,
  request_pico INTEGER,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  detail TEXT,
  fetched_at TEXT NOT NULL
);
`,
  },
];
