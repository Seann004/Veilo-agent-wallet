-- Artifacts start quarantined; only the API marks one validated after checking hash, size and type.
alter table public.artifacts alter column validation_state set default 'quarantined';
