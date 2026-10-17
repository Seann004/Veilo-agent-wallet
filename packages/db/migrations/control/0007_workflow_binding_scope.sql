-- Bindings installed for a workflow step are usable only by the workflow runner, never through a
-- general purchase intent, so a run approval cannot widen what agents may buy on their own.
ALTER TABLE external_binding ADD COLUMN scope TEXT NOT NULL DEFAULT 'owner' CHECK (scope IN ('owner', 'workflow'));

CREATE TRIGGER external_binding_scope_immutable BEFORE UPDATE OF scope ON external_binding
BEGIN SELECT RAISE(ABORT, 'external binding scope is immutable'); END;
