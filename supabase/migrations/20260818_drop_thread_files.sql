-- Confirmed safe to drop (not guessed): only 2 rows, last touched 2026-08-11,
-- and no application code has referenced this table since the Phase 1
-- migration to Project mode (20260815_add_projects.sql) — the old
-- CodePanel UI, /api/thread-files/run route, and Koopi's own auto-save path
-- were all removed/repointed at that same time. Verified via direct query
-- against the live database (not assumed) before writing this.
DROP TABLE IF EXISTS public.thread_files;
