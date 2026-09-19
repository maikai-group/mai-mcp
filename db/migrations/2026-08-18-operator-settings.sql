-- Operator display preferences (plan 30, spec docs/superpowers/specs/
-- 2026-08-18-roadmap-curation-and-operator-settings-design.md §5).
-- Additive and idempotent. First tenant: roadmap.global_marker (default 🌊,
-- served by src/settings.ts when no row exists — no seed row needed).
CREATE TABLE IF NOT EXISTS operator_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
