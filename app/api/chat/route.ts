import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODEL = "claude-opus-5";
const MAX_HISTORY = 40;
const FLUSH_MS = 120;

const SYSTEM_PROMPT = `You are Koopi, a coding agent in a shared multiplayer session.

Several teammates may be in the room at once. Each human turn is prefixed with the
speaker's username — use it to keep track of who asked what, but never prefix your
own replies with a name.

Any participant can interrupt you mid-response, so lead with the most useful thing
first rather than building up to it. Be concise and concrete; prefer short code
examples over long prose. If teammates disagree, say so plainly instead of quietly
picking one side.`;

type MessageRow = {
  sender_type: "user" | "agent";
  content: string;
  sender_id: string | null;
  profiles: { username: string | null } | { username: string | null }[] | null;
};

function firstOf<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export async function POST(request: Request) {
  // Authenticate before anything else, so an anonymous caller learns nothing
  // about server configuration.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set in .env.local" },
      { status: 500 }
    );
  }

  const { threadId } = (await request.json()) as { threadId?: string };
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }

  // RLS only returns threads in rooms this user participates in, so this
  // doubles as the authorization check for the whole request.
  const { data: thread } = await supabase
    .from("threads")
    .select("id, room_id")
    .eq("id", threadId)
    .maybeSingle();

  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const { data: history, error: historyError } = await supabase
    .from("messages")
    .select("sender_type, content, sender_id, profiles(username)")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(MAX_HISTORY);

  if (historyError) {
    return NextResponse.json({ error: historyError.message }, { status: 403 });
  }

  const turns: Anthropic.MessageParam[] = [];
  for (const row of (history ?? []) as MessageRow[]) {
    const text = row.content?.trim();
    if (!text) continue; // skip interrupted-before-any-output agent rows

    if (row.sender_type === "agent") {
      turns.push({ role: "assistant", content: text });
    } else {
      const name = firstOf(row.profiles)?.username ?? "teammate";
      turns.push({ role: "user", content: `${name}: ${text}` });
    }
  }

  // The API requires the first turn to be from the user.
  while (turns.length > 0 && turns[0].role !== "user") turns.shift();
  if (turns.length === 0) {
    return NextResponse.json({ error: "Nothing to respond to" }, { status: 400 });
  }

  const { data: agentMessage, error: insertError } = await supabase
    .from("messages")
    .insert({
      room_id: thread.room_id,
      thread_id: threadId,
      sender_type: "agent",
      sender_id: null,
      content: "",
      status: "streaming",
    })
    .select("id")
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 403 });
  }

  const messageId = agentMessage.id;
  const anthropic = new Anthropic({ apiKey });

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let text = "";
      let flushed = "";
      let interrupted = false;

      // Writes only while status is still 'streaming'. A zero-row result means
      // someone pressed Stop, which is our signal to abort the model stream.
      async function flush(status: "streaming" | "complete") {
        if (status === "streaming" && text === flushed) return true;

        const { data, error } = await supabase
          .from("messages")
          .update({ content: text, status })
          .eq("id", messageId)
          .eq("status", "streaming")
          .select("id");

        if (error) throw error;
        if (!data || data.length === 0) return false;

        flushed = text;
        return true;
      }

      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "low" },
        system: SYSTEM_PROMPT,
        messages: turns,
      });

      const ticker = setInterval(async () => {
        try {
          if (!(await flush("streaming"))) {
            interrupted = true;
            stream.abort();
          }
        } catch {
          // Transient write failure — the next tick retries.
        }
      }, FLUSH_MS);

      try {
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            text += event.delta.text;
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
      } catch {
        // Aborting the stream throws; an interrupt is the expected cause.
      } finally {
        clearInterval(ticker);
      }

      try {
        if (!interrupted) {
          // Persists whatever streamed; a Stop that landed here leaves the row
          // as 'interrupted' because the status guard rejects the write.
          await flush("complete");
        }
      } catch {
        // Nothing further we can do — the row keeps its last written content.
      }

      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
