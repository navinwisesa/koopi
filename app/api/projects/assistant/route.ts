import OpenAI from "openai";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Same model app/api/chat/route.ts uses for code replies (see that file's
// header comment for the routing rationale) — reused here rather than
// picked independently, since this assistant's whole job is code.
const OPENROUTER_CODE_MODEL = "cohere/north-mini-code:free";

// Deliberately stateless server-side: this assistant's conversation is
// "private to the user until a change is proposed" per spec, and the
// simplest way to guarantee that is to never persist it anywhere at all —
// the client holds the running turns in memory and resends them each call
// (same shape the room chat uses for its own turns array). Refreshing the
// page loses the conversation; only an explicitly *accepted* suggestion
// (a direct, RLS-checked project_file_changes insert from the client — see
// ProjectAssistant.tsx) ever reaches a shared table. If persistent per-user
// history is wanted later, the
// straightforward addition is a project_assistant_messages table scoped by
// (project_id, user_id), not a change to this route's shape.
type Turn = { role: "user" | "assistant"; content: string };

const SYSTEM_PROMPT = `You are a coding assistant embedded in a collaborative
project workspace. You are talking to exactly one teammate, privately — your
suggestions are never visible to the rest of the room unless this person
explicitly accepts one, and even then it only becomes a PROPOSED change that
an Owner or Admin must approve before it touches the real file.

When you want to propose a concrete replacement for the file you were shown,
respond with a short explanation followed by a line containing exactly
"FILE: <path>" and then a single fenced code block with the file's COMPLETE
new content (not a diff, not a snippet — the whole file as it should read
after your change). Only do this when you're confident in a specific change;
otherwise just answer in plain prose with no fenced block.`;

function extractProposal(text: string): { path: string; code: string; language: string } | null {
  const match = text.match(/FILE:\s*(\S+)\s*\n```(\w*)\n([\s\S]*?)```/);
  if (!match) return null;
  return { path: match[1], language: match[2] || "python", code: match[3] };
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const projectId = body?.projectId as string | undefined;
  const filePath = body?.filePath as string | undefined;
  const fileContent = (body?.fileContent as string | undefined) ?? "";
  const otherPaths = (body?.otherPaths as string[] | undefined) ?? [];
  const turns = (body?.turns as Turn[] | undefined) ?? [];
  if (!projectId || !turns.length) {
    return NextResponse.json({ error: "projectId and turns required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // RLS (is_project_participant) is what actually enforces membership — this
  // is just the existence/404 check, same shape as /api/projects/run.
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) {
    return NextResponse.json(
      { error: "OPENROUTER_API_KEY is not set — the assistant has no provider to call." },
      { status: 503 }
    );
  }
  const openrouter = new OpenAI({ apiKey: openrouterKey, baseURL: "https://openrouter.ai/api/v1" });

  const contextLines = [
    filePath ? `Currently open file: ${filePath}` : "No file is currently open.",
    otherPaths.length ? `Other files in this project: ${otherPaths.join(", ")}` : null,
    filePath ? `--- ${filePath} ---\n${fileContent}` : null,
  ].filter(Boolean);

  try {
    const completion = await openrouter.chat.completions.create({
      model: OPENROUTER_CODE_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: contextLines.join("\n\n") },
        ...turns.map((t) => ({ role: t.role, content: t.content })),
      ],
    });
    const reply = completion.choices[0]?.message?.content ?? "";
    const proposal = extractProposal(reply);
    return NextResponse.json({ reply, proposal });
  } catch (err) {
    console.error(`/api/projects/assistant: model call failed for project ${projectId}:`, err);
    return NextResponse.json(
      { error: "the assistant is unavailable right now — try again in a bit." },
      { status: 502 }
    );
  }
}
