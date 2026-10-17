-- Owner sessions and scoped worker credentials. Only SHA-256 digests of bearer values are stored.

CREATE TABLE owner_session_challenge (
  nonce TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  domain TEXT NOT NULL,
  message TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > issued_at_ms),
  consumed_at_ms INTEGER
) STRICT;

CREATE TRIGGER owner_session_challenge_consume_once BEFORE UPDATE OF consumed_at_ms ON owner_session_challenge
WHEN OLD.consumed_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'challenge already consumed'); END;

CREATE TABLE owner_session (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  owner_pubkey TEXT NOT NULL,
  challenge_nonce TEXT NOT NULL UNIQUE REFERENCES owner_session_challenge(nonce),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  revoked_at_ms INTEGER
) STRICT;

CREATE TABLE worker_credential (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_epoch INTEGER NOT NULL CHECK (agent_epoch >= 0),
  created_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agent (id, workspace_id)
) STRICT;

CREATE INDEX worker_credential_agent ON worker_credential (agent_id) WHERE revoked_at_ms IS NULL;
