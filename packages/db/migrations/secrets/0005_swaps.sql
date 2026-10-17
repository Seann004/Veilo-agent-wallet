-- One devnet swap per funded fresh wallet. The row is written before the signed transaction
-- leaves the wallet, so a swap is never signed twice.
CREATE TABLE swap (
  purchase_id TEXT PRIMARY KEY REFERENCES funding(purchase_id),
  swap_id TEXT NOT NULL UNIQUE,
  fresh_wallet TEXT NOT NULL,
  destination TEXT NOT NULL,
  input_amount INTEGER NOT NULL CHECK (input_amount > 0),
  min_out INTEGER NOT NULL CHECK (min_out > 0),
  est_out INTEGER NOT NULL CHECK (est_out >= min_out),
  transaction_b64 TEXT NOT NULL,
  last_valid_block_height INTEGER NOT NULL,
  signature TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('signed', 'submitted', 'finalized', 'failed', 'expired')),
  sponsor_lamports INTEGER NOT NULL DEFAULT 0,
  signed_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER swap_immutable BEFORE UPDATE OF purchase_id, swap_id, fresh_wallet, destination, input_amount, min_out, est_out, transaction_b64, last_valid_block_height
ON swap
BEGIN SELECT RAISE(ABORT, 'signed swaps are immutable'); END;
