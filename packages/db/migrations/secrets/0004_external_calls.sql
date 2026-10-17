-- Payments of an external x402 batch. One funded payer signs at most one payment per call
-- index; rows are written before the payment leaves the wallet and are never re-signed.
CREATE TABLE external_call (
  purchase_id TEXT NOT NULL REFERENCES funding(purchase_id),
  call_index INTEGER NOT NULL CHECK (call_index >= 0 AND call_index < 100),
  fresh_wallet TEXT NOT NULL,
  message_hash TEXT NOT NULL UNIQUE,
  payment_header TEXT NOT NULL,
  recent_blockhash TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  state TEXT NOT NULL CHECK (state IN ('signed', 'finalized', 'expired_unsettled', 'failed')),
  settlement_signature TEXT UNIQUE,
  signed_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (purchase_id, call_index)
) STRICT;

CREATE TRIGGER external_call_immutable BEFORE UPDATE OF purchase_id, call_index, fresh_wallet, message_hash, payment_header, recent_blockhash, amount, signed_at_ms
ON external_call
BEGIN SELECT RAISE(ABORT, 'signed external calls are immutable'); END;

CREATE TRIGGER external_call_resolved_once BEFORE UPDATE OF state ON external_call
WHEN OLD.state <> 'signed' AND NEW.state <> OLD.state
BEGIN SELECT RAISE(ABORT, 'external call outcome is final'); END;
