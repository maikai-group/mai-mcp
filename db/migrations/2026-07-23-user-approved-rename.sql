-- 2026-07-23-user-approved-rename.sql
-- 'matt-approved' was the founder-era literal; the public product's approver
-- is whoever runs it. One-release write-alias maps the old value (see decisions.ts).
UPDATE code_decisions SET source = 'user-approved' WHERE source = 'matt-approved';
