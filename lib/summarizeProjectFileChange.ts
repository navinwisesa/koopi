import Groq from "groq-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

// Extracted from app/api/projects/summarize-change/route.ts so
// app/api/chat/route.ts can call the exact same logic in-process — no
// change in behavior for the manual-edit path that route still serves,
// just no longer the ONLY caller. Confirmed live that every AI-assistant
// proposal (scaffold_web_app, the plain-code-block propose path, a
// "Discuss this file" thread's propose path — all 5 project_file_changes
// INSERTs in app/api/chat/route.ts) never got a summary at all: the only
// trigger anywhere in the codebase was requestChangeSummary(), called
// from exactly one place (RoomView.tsx's manual-edit proposeProjectFileChange),
// and a comment on that trigger explicitly said it was never wired into
// the chat route because "that route runs server-side with no browser
// session for /api/projects/summarize-change's own auth.getUser() to
// read" — true for an HTTP self-fetch (cookies aren't auto-forwarded
// server-to-server) but NOT true of the route's own already-authenticated
// `supabase` client, which this function is built to accept directly and
// reuse, sidestepping the HTTP hop (and its auth problem) entirely. This
// hit exactly the changes most in need of a plain-language summary —
// nobody reviewing an AI-authored proposal wrote that code themselves.
const GROQ_EFFICIENT_MODEL = "openai/gpt-oss-20b";

const SUMMARY_PROMPT = `You summarize a proposed code change for a teammate deciding whether to
approve it. You'll be given a file's path, its CURRENT content (may be empty, for a brand-new
file), and the PROPOSED new content that would replace it.

Write 1-2 short sentences describing WHAT the change does and, where it's evident, WHY — e.g.
"Adds email validation using a regex pattern; rejects addresses without a valid domain." or "Fixes
an off-by-one error in the pagination loop that was skipping the last page." Focus on the
functional difference, not a restatement of the code itself — don't just describe syntax
("adds a for loop") when you can describe intent ("retries each failed request up to 3 times").
If the current content is empty, describe it as a new file, not a "change" to nothing.

Respond with ONLY the summary text — no preamble, no quotes, no markdown formatting.`;

export type SummarizeOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Best-effort, never-throws: generates and persists a project_file_changes
 * summary using the caller's own already-authenticated Supabase client (RLS
 * naturally scopes what it can read/write, same as every other query in
 * this app — no service role, no separate authorization check needed here).
 * Every failure mode (no GROQ_API_KEY, change/file not found, generation
 * error, RPC error) degrades to ProjectChanges.tsx's own "Summary
 * pending…" fallback rather than surfacing anywhere — a missing summary
 * was already an accepted, handled state before this existed; this only
 * ever makes it LESS common, never something a caller needs to react to.
 */
export async function summarizeProjectFileChange(
  supabase: SupabaseClient,
  changeId: string
): Promise<SummarizeOutcome> {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return { ok: false, reason: "no GROQ_API_KEY configured" };

  const { data: change } = await supabase
    .from("project_file_changes")
    .select("id, project_file_id, proposed_content")
    .eq("id", changeId)
    .maybeSingle();
  if (!change) return { ok: false, reason: "change not found" };

  const { data: file } = await supabase
    .from("project_files")
    .select("path, content")
    .eq("id", change.project_file_id)
    .maybeSingle();
  if (!file) return { ok: false, reason: "file not found" };

  try {
    const groq = new Groq({ apiKey: groqKey, maxRetries: 0 });
    const completion = await groq.chat.completions.create({
      model: GROQ_EFFICIENT_MODEL,
      max_completion_tokens: 220,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        {
          role: "user",
          content:
            `File: ${file.path}\n\n` +
            `--- current content ---\n${(file.content ?? "").slice(0, 4000) || "(empty — this is a new file)"}\n\n` +
            `--- proposed content ---\n${change.proposed_content.slice(0, 4000)}`,
        },
      ],
    });
    const summary = completion.choices[0]?.message?.content?.trim();
    if (!summary) return { ok: false, reason: "empty completion" };

    // Not a plain table UPDATE — project_file_changes has no client-writable
    // UPDATE policy at all (deliberately, since 20260816: no take-backs on
    // status/review fields from a bare client write), so this narrow
    // SECURITY DEFINER RPC is the sanctioned path, same shape
    // approve/reject_project_file_change already use.
    const { error: rpcError } = await supabase.rpc("set_project_file_change_summary", {
      p_change_id: changeId,
      p_summary: summary,
    });
    if (rpcError) return { ok: false, reason: rpcError.message };

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "generation failed" };
  }
}
