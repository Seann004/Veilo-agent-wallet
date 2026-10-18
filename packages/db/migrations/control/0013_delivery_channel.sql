-- Owner chats that receive agents' finished results. Secrets (bot token, webhook URL) are sealed
-- by control; only the kind, a label and a short hint are readable.
CREATE TABLE delivery_channel (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK (kind IN ('telegram', 'slack', 'discord')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  secret_ciphertext TEXT NOT NULL,
  hint TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

-- At most one destination per agent, set only by the owner.
CREATE TABLE agent_delivery (
  agent_id TEXT PRIMARY KEY REFERENCES agent(id),
  channel_id TEXT NOT NULL REFERENCES delivery_channel(id) ON DELETE CASCADE,
  updated_at_ms INTEGER NOT NULL
) STRICT;

-- One delivery attempt per task, recorded before sending so it is never sent twice.
CREATE TABLE task_delivery (
  task_id TEXT PRIMARY KEY REFERENCES task(id),
  channel_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sending', 'sent', 'failed')),
  detail TEXT,
  at_ms INTEGER NOT NULL
) STRICT;
