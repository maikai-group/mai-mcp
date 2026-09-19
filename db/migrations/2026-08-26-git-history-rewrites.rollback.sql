-- Safe only before a history remap has written provenance. After remap, the
-- alias/tombstone rows are the only reversible old-SHA lookup layer while
-- code_commits and other SHA fields already contain rewritten values.
DO $$
DECLARE
  has_provenance BOOLEAN := false;
BEGIN
  IF to_regclass('public.git_history_rewrites') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.git_history_rewrites)'
      INTO has_provenance;
  END IF;

  IF has_provenance THEN
    RAISE EXCEPTION
      'Refusing git_history_rewrites rollback: provenance rows exist; restore the verified pre-remap database backup instead';
  END IF;
END
$$;

DROP TABLE IF EXISTS git_history_rewrites;
