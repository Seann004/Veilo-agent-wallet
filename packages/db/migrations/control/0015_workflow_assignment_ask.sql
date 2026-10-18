-- An assignment can offer a workflow to an agent without pre-approving any run: the agent may
-- propose it, and every proposed run waits for the owner.
ALTER TABLE workflow_assignment ADD COLUMN ask_each_run INTEGER NOT NULL DEFAULT 0 CHECK (ask_each_run IN (0, 1));

CREATE TRIGGER workflow_assignment_ask_immutable BEFORE UPDATE OF ask_each_run ON workflow_assignment
BEGIN SELECT RAISE(ABORT, 'assignment terms are immutable; a new budget is a new assignment'); END;
