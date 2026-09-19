-- Per-model vector tags (plan 14, spec §4): vectors from different models are
-- not comparable; untagged rows were silently zero-scored on provider switches.
ALTER TABLE code_decisions ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE lessons        ADD COLUMN IF NOT EXISTS embedding_model TEXT;
-- Best-effort backfill by dimension for pre-existing vectors.
UPDATE code_decisions SET embedding_model = CASE array_length(embedding, 1)
    WHEN 1536 THEN 'openai:text-embedding-3-small'
    WHEN 1024 THEN 'voyage:voyage-3'
    ELSE NULL END
  WHERE embedding IS NOT NULL AND embedding_model IS NULL;
UPDATE lessons SET embedding_model = CASE array_length(embedding, 1)
    WHEN 1536 THEN 'openai:text-embedding-3-small'
    WHEN 1024 THEN 'voyage:voyage-3'
    ELSE NULL END
  WHERE embedding IS NOT NULL AND embedding_model IS NULL;
