-- Wallet-service secrets database. Physically separate from the control ledger; only the
-- wallet service opens it. Secret columns hold ciphertext; plaintext keys are never stored.

CREATE TABLE note_secret (
  note_id TEXT PRIMARY KEY,
  commitment TEXT NOT NULL UNIQUE CHECK (length(commitment) = 64),
  label TEXT NOT NULL,
  deposit_salt BLOB CHECK (deposit_salt IS NULL OR length(deposit_salt) = 32),
  refund_pubkey TEXT,
  value INTEGER NOT NULL CHECK (value > 0),
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER note_secret_immutable BEFORE UPDATE ON note_secret
BEGIN SELECT RAISE(ABORT, 'note secrets are immutable'); END;

-- One fresh payment signer per purchase; the counter is never reused.
CREATE TABLE fresh_wallet_key (
  purchase_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL UNIQUE,
  derivation_counter INTEGER NOT NULL UNIQUE CHECK (derivation_counter >= 0),
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER fresh_wallet_key_immutable BEFORE UPDATE ON fresh_wallet_key
BEGIN SELECT RAISE(ABORT, 'fresh wallet keys are immutable'); END;
CREATE TRIGGER fresh_wallet_key_no_delete BEFORE DELETE ON fresh_wallet_key
BEGIN SELECT RAISE(ABORT, 'fresh wallet keys are retained for recovery'); END;

CREATE TABLE key_counter (
  name TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL CHECK (next_value >= 0)
) STRICT;

CREATE TRIGGER key_counter_monotonic BEFORE UPDATE OF next_value ON key_counter
WHEN NEW.next_value <= OLD.next_value
BEGIN SELECT RAISE(ABORT, 'key counters only increase'); END;
