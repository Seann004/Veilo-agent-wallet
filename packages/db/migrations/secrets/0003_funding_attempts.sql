-- veilo:table-rebuild
-- A note whose funding attempt was proven expired_unsettled (or discarded before release) may
-- be funded again by a new attempt with a new proof and fresh wallet. Its nullifier is the
-- same, so nullifier uniqueness applies to live attempts only; the program's nullifier
-- account still allows at most one spend on chain. Prior attempt rows are kept unchanged.
CREATE TABLE funding_new (
  purchase_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  input_note_id TEXT NOT NULL REFERENCES wallet_note(id),
  change_note_id TEXT NOT NULL UNIQUE REFERENCES wallet_note(id),
  fresh_wallet TEXT NOT NULL UNIQUE,
  payout INTEGER NOT NULL CHECK (payout > 0),
  token_fee INTEGER NOT NULL CHECK (token_fee >= 0),
  sponsor_lamport_cap INTEGER NOT NULL CHECK (sponsor_lamport_cap >= 0),
  nullifier_hash TEXT NOT NULL CHECK (length(nullifier_hash) = 64),
  valid_until_slot INTEGER NOT NULL,
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  proof_json TEXT NOT NULL CHECK (json_valid(proof_json)),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  step TEXT NOT NULL CHECK (step IN ('prepared', 'released', 'submitted', 'finalized', 'expired_unsettled', 'discarded')),
  released_at_ms INTEGER,
  relayer_withdrawal_id TEXT,
  signature TEXT UNIQUE,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

INSERT INTO funding_new SELECT
  purchase_id, operation_id, input_note_id, change_note_id, fresh_wallet, payout, token_fee, sponsor_lamport_cap,
  nullifier_hash, valid_until_slot, intent_json, proof_json, binding_json, step, released_at_ms,
  relayer_withdrawal_id, signature, evidence_json, created_at_ms, updated_at_ms
FROM funding;

DROP TABLE funding;
ALTER TABLE funding_new RENAME TO funding;

-- A note feeds at most one live funding, and a nullifier belongs to at most one live funding.
CREATE UNIQUE INDEX funding_one_live_per_note ON funding (input_note_id) WHERE step NOT IN ('expired_unsettled', 'discarded');
CREATE UNIQUE INDEX funding_one_live_per_nullifier ON funding (nullifier_hash) WHERE step NOT IN ('expired_unsettled', 'discarded');

CREATE TRIGGER funding_identity_immutable BEFORE UPDATE OF
  purchase_id, operation_id, input_note_id, change_note_id, fresh_wallet, payout, token_fee, nullifier_hash, created_at_ms
ON funding
BEGIN SELECT RAISE(ABORT, 'funding identity is immutable'); END;

-- A proof may be rebuilt (fresh slot bound) only while nothing has left the wallet.
CREATE TRIGGER funding_proof_frozen_after_release BEFORE UPDATE OF valid_until_slot, intent_json, proof_json ON funding
WHEN OLD.step <> 'prepared'
BEGIN SELECT RAISE(ABORT, 'released proof material is immutable'); END;

CREATE TRIGGER funding_step_forward BEFORE UPDATE OF step ON funding
WHEN NEW.step <> OLD.step AND NOT (
     (OLD.step = 'prepared' AND NEW.step IN ('released', 'discarded'))
  OR (OLD.step = 'released' AND NEW.step IN ('submitted', 'finalized', 'expired_unsettled'))
  OR (OLD.step = 'submitted' AND NEW.step IN ('finalized', 'expired_unsettled')))
BEGIN SELECT RAISE(ABORT, 'invalid funding step transition'); END;

-- Expired and discarded attempts are kept as the record of prior attempts.
CREATE TRIGGER funding_no_delete BEFORE DELETE ON funding
BEGIN SELECT RAISE(ABORT, 'funding attempts are retained'); END;
