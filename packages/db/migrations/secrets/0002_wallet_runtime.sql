-- Wallet runtime state. Secret material (note secrets, labels, salts, values, one-time keys)
-- is AEAD ciphertext; plaintext columns hold only public chain data and workflow state.
-- note_secret from 0001 is superseded by wallet_note, which also admits zero-value change notes.

CREATE TABLE wallet_note (
  id TEXT PRIMARY KEY,
  commitment TEXT NOT NULL UNIQUE CHECK (length(commitment) = 64),
  origin TEXT NOT NULL CHECK (origin IN ('deposit', 'change')),
  parent_note_id TEXT REFERENCES wallet_note(id),
  -- HKDF index of the nullifier/note secrets (and salt for deposits); never reused.
  key_index INTEGER NOT NULL UNIQUE CHECK (key_index >= 0),
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  created_at_ms INTEGER NOT NULL,
  CHECK ((origin = 'change') = (parent_note_id IS NOT NULL))
) STRICT;

CREATE TRIGGER wallet_note_immutable BEFORE UPDATE ON wallet_note
BEGIN SELECT RAISE(ABORT, 'wallet notes are immutable'); END;
CREATE TRIGGER wallet_note_no_delete BEFORE DELETE ON wallet_note
BEGIN SELECT RAISE(ABORT, 'wallet notes are retained'); END;

CREATE TABLE wallet_note_status (
  note_id TEXT PRIMARY KEY REFERENCES wallet_note(id),
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'submitted', 'finalized', 'indexed', 'approved', 'spendable',
    'change_prepared', 'pending_change', 'reserved', 'spent', 'exit_prepared', 'exited',
    'refunded', 'void', 'recovery_required')),
  leaf_index INTEGER CHECK (leaf_index IS NULL OR leaf_index >= 0),
  queue_seq INTEGER CHECK (queue_seq IS NULL OR queue_seq >= 0),
  control_registered INTEGER NOT NULL DEFAULT 0 CHECK (control_registered IN (0, 1)),
  spend_purchase_id TEXT,
  reason TEXT,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE deposit_request (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL UNIQUE REFERENCES wallet_note(id),
  owner_pubkey TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  blockhash TEXT NOT NULL,
  last_valid_block_height INTEGER NOT NULL,
  message_base64 TEXT NOT NULL,
  signature TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'finalized', 'expired', 'failed')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER deposit_signature_once BEFORE UPDATE OF signature ON deposit_request
WHEN OLD.signature IS NOT NULL AND NEW.signature IS NOT OLD.signature
BEGIN SELECT RAISE(ABORT, 'deposit signature is immutable'); END;

-- One private funding per purchase. Proof and intent are public material; the change note's
-- secrets live in wallet_note.
CREATE TABLE funding (
  purchase_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  input_note_id TEXT NOT NULL REFERENCES wallet_note(id),
  change_note_id TEXT NOT NULL UNIQUE REFERENCES wallet_note(id),
  fresh_wallet TEXT NOT NULL UNIQUE,
  payout INTEGER NOT NULL CHECK (payout > 0),
  token_fee INTEGER NOT NULL CHECK (token_fee >= 0),
  sponsor_lamport_cap INTEGER NOT NULL CHECK (sponsor_lamport_cap >= 0),
  nullifier_hash TEXT NOT NULL UNIQUE CHECK (length(nullifier_hash) = 64),
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

-- A note feeds at most one live funding.
CREATE UNIQUE INDEX funding_one_live_per_note ON funding (input_note_id) WHERE step NOT IN ('expired_unsettled', 'discarded');

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

-- The single x402 payment a fresh wallet ever signs. Stored before the header is returned.
CREATE TABLE merchant_payment (
  purchase_id TEXT PRIMARY KEY REFERENCES funding(purchase_id),
  fresh_wallet TEXT NOT NULL UNIQUE,
  message_hash TEXT NOT NULL UNIQUE,
  payment_header TEXT NOT NULL,
  recent_blockhash TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  state TEXT NOT NULL CHECK (state IN ('signed', 'finalized', 'expired_unsettled')),
  settlement_signature TEXT UNIQUE,
  signed_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER merchant_payment_immutable BEFORE UPDATE OF purchase_id, fresh_wallet, message_hash, payment_header, recent_blockhash, amount, signed_at_ms
ON merchant_payment
BEGIN SELECT RAISE(ABORT, 'signed merchant payments are immutable'); END;

CREATE TABLE exit_request (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES wallet_note(id),
  owner_pubkey TEXT NOT NULL,
  nullifier_hash TEXT NOT NULL CHECK (length(nullifier_hash) = 64),
  value INTEGER NOT NULL CHECK (value > 0),
  blockhash TEXT NOT NULL,
  last_valid_block_height INTEGER NOT NULL,
  message_base64 TEXT NOT NULL,
  signature TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'finalized', 'expired')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX exit_one_live_per_note ON exit_request (note_id) WHERE state IN ('prepared', 'submitted', 'finalized');

CREATE TABLE recovery_request (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES funding(purchase_id),
  fresh_wallet TEXT NOT NULL,
  destination_owner TEXT NOT NULL,
  destination_ata TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  rent_destination TEXT NOT NULL,
  blockhash TEXT,
  last_valid_block_height INTEGER,
  signature TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'finalized', 'expired')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX recovery_one_live_per_purchase ON recovery_request (purchase_id) WHERE state IN ('prepared', 'submitted', 'finalized');

-- Workflow journal for reconciliation and audit. Never contains secret values.
CREATE TABLE wallet_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER wallet_event_no_update BEFORE UPDATE ON wallet_event
BEGIN SELECT RAISE(ABORT, 'wallet events are append-only'); END;
CREATE TRIGGER wallet_event_no_delete BEFORE DELETE ON wallet_event
BEGIN SELECT RAISE(ABORT, 'wallet events are append-only'); END;

-- Conditions that block new fundings until reconciled (e.g. after a restore).
CREATE TABLE wallet_flag (
  name TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
