import Groq from "groq-sdk";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Cheap tier, same reasoning /api/projects/summarize-change already gives:
// a short catch-up summary is exactly the kind of low-stakes text task that
// tier exists for. Switched from llama-3.1-8b-instant to openai/gpt-oss-20b
// 2026-08-16 (the llama models were being deprecated) — see app/api/chat/
// route.ts's GROQ_MODEL comment for why the "openai/" prefix is required
// and why this needed a real token-budget bump, not just a name swap:
// gpt-oss is a reasoning model, and its reasoning tokens count against
// max_completion_tokens same as visible output.
const GROQ_EFFICIENT_MODEL = "openai/gpt-oss-20b";
const MAX_MESSAGES = 60;

const CATCH_UP_PROMPT = `You summarize what a team chat thread's participants said and did while
someone was away, so they can catch up in a few seconds instead of scrolling. You'll be given a
list of messages (username: text) and tool activity, oldest first.

Write 2-4 short sentences covering: what was decided or built, any unresolved question left
hanging, and anything a reasonable person would want to know before jumping back in. Skip small
talk. Do not repeat verbatim what's already obvious from a single message — synthesize.

Respond with ONLY the summary text — no preamble, no markdown headers, no quotes.`;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const threadId = body?.threadId as string | undefined;
  const since = body?.since as string | undefined; // ISO timestamp; absent = "last N messages"
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // RLS (is_thread_participant, via whatever policy already gates messages)
  // naturally 404s/empties this for anyone not actually in the thread — no
  // separate membership check needed, same trust-RLS pattern every other
  // route in this app already follows.
  const { data: threadRow } = await supabase
    .from("threads")
    .select("room_id")
    .eq("id", threadId)
    .maybeSingle();
  if (!threadRow) {
    return NextResponse.json({ error: "thread not found" }, { status: 404 });
  }

  let messagesQuery = supabase
    .from("messages")
    .select("sender_type, sender_id, content, type, created_at, profiles!sender_id(username)")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(MAX_MESSAGES);
  if (since) messagesQuery = messagesQuery.gt("created_at", since);
  const { data: messageRows } = await messagesQuery;
  const rows = (messageRows ?? []).slice().reverse();

  // Judgment calls (20260829_add_judgment_calls.sql) are ALWAYS surfaced in
  // full, never left to the summarizer's discretion to trim — a genuinely
  // flagged conflict/risk, or a resolved change, must never quietly vanish
  // into "a few sentences" just because a lot else also happened. This is
  // the actual mechanism behind "always-on override for conflicts": not a
  // separate cross-team system (this app has no cross-room/cross-team
  // concept to hang that on), but a guarantee that THIS catch-up never
  // summarizes away what the judgment log already exists to preserve.
  let flaggedQuery = supabase
    .from("judgment_calls")
    .select("id, kind, summary, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (since) flaggedQuery = flaggedQuery.gt("created_at", since);
  const { data: flaggedRows } = await flaggedQuery;
  const flaggedItems = (flaggedRows ?? []).map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    summary: r.summary as string,
    createdAt: r.created_at as string,
  }));

  if (rows.length === 0) {
    return NextResponse.json({ summary: "Nothing new here.", flaggedItems, messageCount: 0 });
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    // Best-effort feature, same fallback shape summarize-change already
    // uses — the raw message count and flagged items are still real and
    // useful without an AI summary on top.
    return NextResponse.json({
      summary: `${rows.length} new message${rows.length === 1 ? "" : "s"} since you were last here.`,
      flaggedItems,
      messageCount: rows.length,
    });
  }

  function firstOf<T>(value: T | T[] | null): T | null {
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  }

  const transcript = rows
    .map((r) => {
      const name =
        r.sender_type === "agent" ? "Koopi" : (firstOf(r.profiles as { username: string | null } | { username: string | null }[] | null)?.username ?? "someone");
      if (r.type === "tool_call" || r.type === "tool_result") return `${name}: [ran/executed code]`;
      const text = (r.content ?? "").trim();
      return text ? `${name}: ${text}` : null;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");

  try {
    const groq = new Groq({ apiKey: groqKey, maxRetries: 0 });
    const completion = await groq.chat.completions.create({
      model: GROQ_EFFICIENT_MODEL,
      max_completion_tokens: 320, // was 200; see GROQ_EFFICIENT_MODEL's comment
      reasoning_effort: "low",
      messages: [
        { role: "system", content: CATCH_UP_PROMPT },
        { role: "user", content: transcript },
      ],
    });
    const summary =
      completion.choices[0]?.message?.content?.trim() ||
      `${rows.length} new message${rows.length === 1 ? "" : "s"} since you were last here.`;
    return NextResponse.json({ summary, flaggedItems, messageCount: rows.length });
  } catch (err) {
    // A summarization hiccup must never be why catching up doesn't work at
    // all — the raw count + flagged items degrade gracefully on their own.
    console.warn(`/api/threads/catch-up: generation failed for thread ${threadId}:`, err);
    return NextResponse.json({
      summary: `${rows.length} new message${rows.length === 1 ? "" : "s"} since you were last here.`,
      flaggedItems,
      messageCount: rows.length,
    });
  }
}
