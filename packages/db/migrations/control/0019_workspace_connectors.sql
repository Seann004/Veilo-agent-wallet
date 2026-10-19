-- Personal MCP connections stay in the local workspace; marketplace publication is separate.
CREATE TABLE workspace_connector (
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 id TEXT NOT NULL,
 title TEXT NOT NULL,
 endpoint TEXT NOT NULL,
 tools_json TEXT NOT NULL CHECK(json_valid(tools_json)),
 added_by TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 PRIMARY KEY(workspace_id, id),
 UNIQUE(workspace_id, endpoint)
) STRICT;
