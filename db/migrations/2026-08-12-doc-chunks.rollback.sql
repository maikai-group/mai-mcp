-- doc_chunks is derived content with no memory_edges references (chunks are
-- never edge endpoints — spec §8: they assert nothing), so a bare drop is
-- complete; nothing strands (contrast: the plan-findings rollback must delete
-- edges first). Regenerate any time via mai_plan registration + the docs sweep.
DROP TABLE IF EXISTS doc_chunks;
