import Groq from "groq-sdk";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Phase 3 of the debugging-tools build (role-aware change notifications):
// generates the plain-language "what and why" shown above the diff in the
// Pending panel, so an Owner/Admin can understand a proposed change without
// reading it line-by-line. Reuses the same Efficient-tier Groq model
// app/api/chat/route.ts's "chat" tier uses — a short summary is exactly the
// kind of small, low-stakes text task that tier exists for, per the task
// spec's own instruction to keep this cheap.
const GROQ_EFFICIENT_MODEL = "llama-3.1-8b-instant";

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

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const changeId = body?.changeId as string | undefined;
  if (!changeId) {
    return NextResponse.json({ error: "changeId is required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    // Best-effort feature — the Pending panel's own "Summary pending…"
    // fallback (see ProjectChanges.tsx) is the honest state here, not an
    // error the proposer needs to see. The change itself already exists
    // and is reviewable without this.
    return NextResponse.json({ ok: true, skipped: "no GROQ_API_KEY configured" });
  }

  // RLS on project_file_changes (own proposals or admin/owner) and
  // project_files (project participant) both apply here automatically —
  // this uses the caller's own session, not a service role, same as every
  // other read in this app. A change this user can't see 404s naturally
  // rather than needing its own explicit authorization check.
  const { data: change } = await supabase
    .from("project_file_changes")
    .select("id, project_file_id, proposed_content")
    .eq("id", changeId)
    .maybeSingle();
  if (!change) {
    return NextResponse.json({ error: "Change not found" }, { status: 404 });
  }

  const { data: file } = await supabase
    .from("project_files")
    .select("path, content")
    .eq("id", change.project_file_id)
    .maybeSingle();
  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const groq = new Groq({ apiKey: groqKey, maxRetries: 0 });
    const completion = await groq.chat.completions.create({
      model: GROQ_EFFICIENT_MODEL,
      max_completion_tokens: 120,
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
    if (!summary) {
      return NextResponse.json({ ok: true, skipped: "empty completion" });
    }

    // Not a plain table UPDATE — project_file_changes has no client-writable
    // UPDATE policy at all (deliberately, since 20260816: no take-backs on
    // status/review fields from a bare client write), so this narrow
    // SECURITY DEFINER RPC is the sanctioned path, same shape
    // approve/reject_project_file_change already use.
    const { error: rpcError } = await supabase.rpc("set_project_file_change_summary", {
      p_change_id: changeId,
      p_summary: summary,
    });
    if (rpcError) {
      console.warn(`/api/projects/summarize-change: failed to persist summary for ${changeId}:`, rpcError);
      return NextResponse.json({ error: rpcError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Best-effort — a summarization hiccup must never be why a proposal
    // doesn't show up for review (it already does, without this).
    console.warn(`/api/projects/summarize-change: generation failed for ${changeId}:`, err);
    return NextResponse.json({ ok: true, skipped: "generation failed" });
  }
}
