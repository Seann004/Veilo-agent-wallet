-- Owner-supplied files for one task, kept out of task.input_json so worker task reads never carry them.
CREATE TABLE task_attachment (
  task_id TEXT NOT NULL REFERENCES task (id),
  kind TEXT NOT NULL CHECK (kind IN ('reference_image')),
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 1572864),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind)
) STRICT;
