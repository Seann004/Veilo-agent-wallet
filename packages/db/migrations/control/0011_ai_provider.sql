-- The owner's own model provider (BYOK). The API key is stored only as AES-256-GCM ciphertext
-- under a key file in the control secrets directory; agents and the runner never receive it.
CREATE TABLE ai_provider (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  provider TEXT NOT NULL CHECK (provider IN ('openrouter', 'anthropic', 'openai', 'openai_compatible')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  key_ciphertext TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

-- Model calls a task made on the owner's provider; bounded per task like planning calls.
ALTER TABLE task ADD COLUMN ai_calls INTEGER NOT NULL DEFAULT 0;
