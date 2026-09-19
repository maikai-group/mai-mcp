-- 2026-07-23-user-approved-rename.rollback.sql
UPDATE code_decisions SET source = 'matt-approved' WHERE source = 'user-approved';
