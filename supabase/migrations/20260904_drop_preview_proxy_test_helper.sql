-- Removes the temporary test-only helper added in
-- 20260903_temp_preview_proxy_test_helper.sql, used once to verify the
-- preview-proxy pipeline end-to-end against a real sandbox and no longer
-- needed — not something that should persist as a standing bypass.
DROP FUNCTION IF EXISTS public._test_set_preview(uuid, text, text);
