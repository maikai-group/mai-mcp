-- Rollback touches ONLY this build's two tables. No other table was altered.
-- share_events has no FKs by design, so drop order is free; shares first for
-- symmetry with the forward file.
DROP TABLE IF EXISTS project_shares;
DROP TABLE IF EXISTS share_events;
