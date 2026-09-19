-- Incremental-ingest watermarks (spec §3.4): one row per (project, transcript).
-- Replaces the metadata->>'ingested_mtime_ms' skip check in ingest-codex.
CREATE TABLE IF NOT EXISTS transcript_watermarks (
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  transcript_path   text NOT NULL,
  harness           text NOT NULL,
  open_seq          integer NOT NULL,
  open_start_offset bigint  NOT NULL,
  ingested_mtime_ms bigint  NOT NULL,
  file_size_bytes   bigint  NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, transcript_path)
);
