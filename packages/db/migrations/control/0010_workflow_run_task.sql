-- A run an agent proposed from a task spends from that task: its budget, deadline and purchase
-- count bound every step purchase. Owner-prepared runs have no task.
ALTER TABLE workflow_run ADD COLUMN task_id TEXT REFERENCES task(id);

CREATE TRIGGER workflow_run_task_immutable BEFORE UPDATE OF task_id ON workflow_run
BEGIN SELECT RAISE(ABORT, 'workflow run task is immutable'); END;
