-- Rollback for 2026-08-18-operator-settings.sql. Drops stored preferences;
-- the dashboard falls back to the defaults in src/settings.ts.
DROP TABLE IF EXISTS operator_settings;
