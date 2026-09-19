-- Dropping the column strands nothing: the agent_messages rows it points at are
-- ordinary board messages that remain readable via mai_board_read, and no
-- memory_edges reference them. Re-applying the migration simply restarts thread
-- tracking — the next verdict opens a new thread.
ALTER TABLE plans DROP COLUMN IF EXISTS board_thread_id;
