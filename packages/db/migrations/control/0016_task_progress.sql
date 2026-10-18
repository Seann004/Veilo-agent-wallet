-- Short step labels the runner reports while it works a task. Control keeps the newest 20 per task.
CREATE TABLE task_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES task (id),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX task_progress_task ON task_progress (task_id, id);
