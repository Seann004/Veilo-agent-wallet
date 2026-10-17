-- Owner-attached read-only MCP connectors. Each attached tool is pinned by the digest of its
-- name, description and input schema as approved in the marketplace; a call refuses on drift and
-- marks the attachment 'changed' until the owner attaches it again.
CREATE TABLE agent_connector (
  agent_id TEXT NOT NULL REFERENCES agent(id),
  connector_id TEXT NOT NULL CHECK (length(connector_id) BETWEEN 3 AND 63),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  endpoint TEXT NOT NULL CHECK (substr(endpoint, 1, 8) = 'https://'),
  tools_json TEXT NOT NULL CHECK (json_valid(tools_json) AND json_array_length(tools_json) BETWEEN 1 AND 32),
  status TEXT NOT NULL CHECK (status IN ('active', 'changed')),
  attached_by TEXT NOT NULL,
  attached_at_ms INTEGER NOT NULL,
  changed_at_ms INTEGER,
  PRIMARY KEY (agent_id, connector_id),
  CHECK ((status = 'changed') = (changed_at_ms IS NOT NULL))
) STRICT;

-- One row per tool call, written before the request leaves control so caps count calls in flight.
-- Arguments and replies are kept only as digests.
CREATE TABLE agent_connector_call (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  connector_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_sha256 TEXT NOT NULL CHECK (length(args_sha256) = 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'ok', 'tool_error', 'changed', 'failed')),
  result_sha256 TEXT CHECK (result_sha256 IS NULL OR length(result_sha256) = 64),
  result_chars INTEGER,
  created_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER
) STRICT;

CREATE INDEX agent_connector_call_task ON agent_connector_call (task_id);
CREATE INDEX agent_connector_call_agent ON agent_connector_call (agent_id, created_at_ms);
