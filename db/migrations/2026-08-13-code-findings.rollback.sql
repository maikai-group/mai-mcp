-- One table, no columns added elsewhere, so the rollback is a single drop.
-- Findings are NOT re-derivable: dropping this table destroys review history.
-- That is acceptable only because the forward migration is additive and this
-- rollback exists for a failed apply, not for routine use.
DROP TABLE IF EXISTS code_findings;
