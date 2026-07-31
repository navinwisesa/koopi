import Groq from "groq-sdk";
import OpenAI from "openai";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SandboxRun, type RunResult } from "@/lib/sandbox";
import { classifyIntent } from "@/lib/intentClassifier";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Chat Mode: casual conversation, opinions, general knowledge — a small model
// on its own Groq quota so it never competes with Build Mode's budget.
// Build Mode: anything that needs real reasoning or the run_code tool.
const MODEL_CHAT = "llama-3.1-8b-instant";
const MODEL_BUILD = "llama-3.3-70b-versatile";

// Same-tier equivalents on OpenRouter, used only when Groq itself is
// unavailable for that tier (e.g. its daily quota is exhausted).
const OPENROUTER_MODEL: Record<string, string> = {
  [MODEL_CHAT]: "meta-llama/llama-3.1-8b-instruct",
  [MODEL_BUILD]: "meta-llama/llama-3.3-70b-instruct",
};

const MAX_HISTORY = 40;
const FLUSH_MS = 120;
const MAX_TOOL_ROUNDS = 4;

const SYSTEM_PROMPT = `You are Koopi, a coding agent in a shared multiplayer session.

Several teammates may be in the room at once. Each human turn is prefixed with the
speaker's username — use it to keep track of who asked what. Always start your own
reply by tagging whoever you're responding to, like "@Navin ...", so it's obvious
who the answer is for even when others are talking in the same thread.

Several people may tag you with separate, unrelated questions close together. Always
respond only to the single most recent message addressed to you — never combine
multiple pending questions into one reply, even if an earlier message never got a
response.

Any participant can interrupt you mid-response, so lead with the most useful thing
first rather than building up to it. Be concise and concrete; prefer short code
examples over long prose. If teammates disagree, say so plainly instead of quietly
picking one side.

You have a run_code tool that actually executes code in an isolated sandbox and
returns its stdout, stderr, and exit code. Only call it when the task genuinely
requires computation, data transformation, running an algorithm, or testing logic
that can't be reliably answered through reasoning alone. Do NOT call it just to
format, organize, or "print out" a text answer — opinions, explanations,
comparisons, and general-knowledge questions should be answered directly as plain
text, never wrapped in a code execution. If you're unsure whether a question needs
code, default to answering as plain text. Supported languages: python, javascript,
typescript, bash. The sandbox is fresh and stateless for every call — it has no
files or state from earlier in the conversation, so include everything the snippet
needs to run standalone.

After a tool result, only add a follow-up message if it genuinely adds something
the output didn't already convey (e.g. tying it back to what was asked). Don't
restate the raw stdout/stderr verbatim — if the output already speaks for itself,
a short reply or none at all is better than repeating it.`;

const MEMORY_SYSTEM_PROMPT = `You maintain a short rolling summary of a shared team chat
room's activity across all its threads. Given the existing summary (if any) and new
messages since then, write an updated summary. Focus only on: key decisions made, what
was built or changed, and notable constraints or preferences any participant stated.
Skip small talk and routine back-and-forth. Keep it tight — a few sentences, not a
transcript. Write neutral third-person notes, not addressed to anyone.`;

// Regenerate the room summary once a summary already exists and this many new
// messages have accrued since — frequent enough to stay useful, far cheaper
// than redoing it on every single message.
const MEMORY_REGEN_THRESHOLD = 20;

const RUN_CODE_TOOL: Groq.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_code",
    description:
      "Execute a code snippet in an isolated sandbox and return its stdout, stderr, " +
      "and exit code. Use ONLY for genuine computation, data transformation, running " +
      "an algorithm, or testing logic — never to format or present a plain-text answer " +
      "(opinions, explanations, comparisons, general knowledge) that doesn't need code " +
      "to actually run. The sandbox is stateless — nothing persists between calls, so " +
      "the snippet must be self-contained.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The full source code to execute." },
        language: {
          type: "string",
          enum: ["python", "javascript", "typescript", "bash"],
          description: "The language to run the code as.",
        },
      },
      required: ["code", "language"],
    },
  },
};

// Groq and OpenRouter both speak the same OpenAI-compatible chunk format,
// so the streaming/interrupt logic below can treat either provider's
// response identically once cast to this shape.
type ChatStream = AsyncIterable<Groq.Chat.ChatCompletionChunk> & { controller: AbortController };

type MessageRow = {
  id: string;
  sender_type: "user" | "agent";
  content: string;
  sender_id: string | null;
  type: "text" | "tool_call" | "tool_result";
  profiles: { username: string | null } | { username: string | null }[] | null;
};

function firstOf<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function historyToTurns(
  rows: MessageRow[],
  triggerMessageId: string
): Groq.Chat.ChatCompletionMessageParam[] {
  const turns: Groq.Chat.ChatCompletionMessageParam[] = [];

  for (const row of rows) {
    if (row.sender_type === "agent") {
      if (row.type === "tool_call") {
        const { code, language } = safeParse(row.content, { code: "", language: "bash" });
        turns.push({
          role: "assistant",
          content: `[Ran ${language} code]\n${code}`,
        });
        continue;
      }
      if (row.type === "tool_result") {
        const { stdout, stderr, exit_code } = safeParse<RunResult>(row.content, {
          stdout: "",
          stderr: "",
          exit_code: 0,
        });
        const parts = [];
        if (stdout) parts.push(`stdout:\n${stdout}`);
        if (stderr) parts.push(`stderr:\n${stderr}`);
        parts.push(`exit code: ${exit_code}`);
        turns.push({ role: "user", content: `[Code output]\n${parts.join("\n")}` });
        continue;
      }
      const text = row.content?.trim();
      if (!text) continue; // skip interrupted-before-any-output agent rows
      turns.push({ role: "assistant", content: text });
    } else {
      const text = row.content?.trim();
      if (!text) continue;
      const name = firstOf(row.profiles)?.username ?? "teammate";
      const content =
        row.id === triggerMessageId
          ? `${name}: ${text}\n\n[Respond to this message only. Any earlier messages above ` +
            `that never got a reply are separate questions someone else asked — they're being ` +
            `answered independently, so don't address them here. Start your reply with ` +
            `"@${name} " to tag them.]`
          : `${name}: ${text}`;
      turns.push({ role: "user", content });
    }
  }

  // Groq expects the conversation (after the system prompt) to open on a user turn.
  while (turns.length > 0 && turns[0].role !== "user") turns.shift();
  return turns;
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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY is not set in .env.local" },
      { status: 500 }
    );
  }

  // Optional — without it, a Groq quota/outage just surfaces the visible
  // failure message instead of failing over to a second provider.
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const openrouter = openrouterKey
    ? new OpenAI({ apiKey: openrouterKey, baseURL: "https://openrouter.ai/api/v1" })
    : null;

  const { threadId, triggerMessageId, modelOverride } = (await request.json()) as {
    threadId?: string;
    triggerMessageId?: string;
    modelOverride?: "chat" | "build";
  };
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }
  if (!triggerMessageId) {
    return NextResponse.json({ error: "triggerMessageId is required" }, { status: 400 });
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
  const roomId = thread.room_id;

  // Anchor history to the message that triggered this call, not "everything in
  // the thread right now" — two people tagging Koopi close together each fire
  // their own request, and without this a slower request could see the other
  // person's message land first and try to answer both in one reply.
  const { data: triggerRow } = await supabase
    .from("messages")
    .select("created_at, profiles!sender_id(username)")
    .eq("id", triggerMessageId)
    .eq("thread_id", threadId)
    .maybeSingle();

  if (!triggerRow) {
    return NextResponse.json({ error: "Triggering message not found" }, { status: 404 });
  }
  const triggerUsername = firstOf(triggerRow.profiles)?.username ?? "there";
  const triggerCreatedAt = triggerRow.created_at;

  const { data: history, error: historyError } = await supabase
    .from("messages")
    .select("id, sender_type, content, sender_id, type, profiles!sender_id(username)")
    .eq("thread_id", threadId)
    .lte("created_at", triggerCreatedAt)
    .order("created_at", { ascending: true })
    .limit(MAX_HISTORY);

  if (historyError) {
    return NextResponse.json({ error: historyError.message }, { status: 403 });
  }

  const turns = historyToTurns((history ?? []) as MessageRow[], triggerMessageId);
  if (turns.length === 0) {
    return NextResponse.json({ error: "Nothing to respond to" }, { status: 400 });
  }

  // Route on the raw trigger text, not the annotated turn — casual chatter
  // stays on the cheap model, anything build/code-shaped gets the real one.
  // A manual override from the composer's model switcher always wins over
  // the heuristic — the person sending the message knows better than a guess.
  const triggerText = (history ?? []).find((row) => row.id === triggerMessageId)?.content ?? "";
  const intent = modelOverride ?? classifyIntent(triggerText);
  const routedModel = intent === "build" ? MODEL_BUILD : MODEL_CHAT;
  console.log(
    `/api/chat: trigger=${triggerMessageId} intent=${intent} model=${routedModel}` +
      (modelOverride ? " (manual override)" : "")
  );

  // maxRetries: 0 — the SDK's default retry-with-backoff would silently eat
  // 30+ seconds retrying a rate-limited Groq call before our own OpenRouter
  // fallback ever gets a chance to run. A 429 should surface immediately.
  const groq = new Groq({ apiKey, maxRetries: 0 });
  const encoder = new TextEncoder();

  // Room-level memory: a rolling summary of everything that's happened in this
  // room across ALL its threads, so a brand-new thread isn't starting blind.
  // Regenerated lazily — only when there's no summary yet, or enough new
  // activity has piled up — never on every message.
  async function getRoomMemory(): Promise<string | null> {
    const { data: room } = await supabase
      .from("rooms")
      .select("memory_summary, memory_summarized_until")
      .eq("id", roomId)
      .maybeSingle();

    const existingSummary = room?.memory_summary ?? null;
    const since = room?.memory_summarized_until ?? null;

    // RLS on `messages` only allows a user to read threads they're a
    // participant of — a plain query here would silently drop every other
    // thread's messages for anyone not in all of them. This RPC runs with
    // elevated privileges but still gates on room (not per-thread) membership.
    const { data: newMessages } = (await supabase.rpc("get_room_memory_messages", {
      p_room_id: roomId,
      p_since: since,
      p_until: triggerCreatedAt,
    })) as {
      data: {
        thread_id: string;
        sender_type: "user" | "agent";
        username: string | null;
        content: string;
        created_at: string;
      }[] | null;
    };
    const rows = (newMessages ?? []).filter((r) => r.content?.trim());

    if (rows.length === 0) return existingSummary;

    // The current thread already sees its own history via normal turn context,
    // so same-thread chatter can wait for the batch threshold. But activity in
    // OTHER threads is exactly the gap this feature exists to close — refresh
    // right away so it doesn't take 20 messages before a teammate's decision
    // in another thread becomes visible here.
    const otherThreadActivity = rows.some((r) => r.thread_id !== threadId);
    if (existingSummary && !otherThreadActivity && rows.length < MEMORY_REGEN_THRESHOLD) {
      return existingSummary;
    }

    const formatted = rows
      .map((r) => {
        const name = r.sender_type === "agent" ? "Koopi" : (r.username ?? "teammate");
        return `${name}: ${r.content.trim()}`;
      })
      .join("\n");

    try {
      const completion = await groq.chat.completions.create({
        model: MODEL_CHAT,
        max_completion_tokens: 400,
        messages: [
          { role: "system", content: MEMORY_SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Existing summary: ${existingSummary ?? "(none yet)"}\n\n` +
              `New activity since then:\n${formatted}\n\nProduce the updated summary.`,
          },
        ],
      });
      const updated = completion.choices[0]?.message?.content?.trim();
      if (!updated) return existingSummary;

      const until = rows[rows.length - 1].created_at as string;
      const { error: rpcError } = await supabase.rpc("update_room_memory", {
        p_room_id: roomId,
        p_summary: updated,
        p_until: until,
      });
      if (rpcError) throw rpcError;

      return updated;
    } catch (err) {
      // Best-effort — a summarization hiccup should never block or degrade
      // the actual chat response.
      console.warn(`/api/chat: room memory update skipped for room ${roomId}:`, err);
      return existingSummary;
    }
  }

  const roomMemory = await getRoomMemory();
  const effectiveSystemPrompt = roomMemory
    ? `${SYSTEM_PROMPT}\n\nRoom memory (prior activity in this room, across other threads):\n${roomMemory}`
    : SYSTEM_PROMPT;

  const isRateLimited = (err: unknown) =>
    err instanceof Groq.RateLimitError || err instanceof OpenAI.RateLimitError;

  // A genuine API failure (rate limit, network blip, etc.) must never just
  // vanish — the person who tagged Koopi should always see *something*
  // rather than silence that looks like they were ignored.
  async function postFailureNotice(err: unknown) {
    const reason = isRateLimited(err)
      ? "we've hit today's usage limit for the model — try again a bit later."
      : "I hit an error trying to respond — try asking again.";
    console.error(`/api/chat: model call failed for trigger ${triggerMessageId}:`, err);
    await supabase.from("messages").insert({
      room_id: roomId,
      thread_id: threadId,
      sender_type: "agent",
      sender_id: null,
      type: "text",
      content: `@${triggerUsername} ${reason}`,
      status: "complete",
    });
  }

  // A no-op update guarded on `status = 'streaming'` — 0 rows affected means
  // someone else (Stop) already flipped it, same trick the text flush uses.
  async function isStillStreaming(messageId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from("messages")
      .update({ status: "streaming" })
      .eq("id", messageId)
      .eq("status", "streaming")
      .select("id");
    if (error) return true; // transient failure — don't abort on a hiccup
    return Boolean(data && data.length > 0);
  }

  type PendingToolCall = { id: string; name: string; arguments: string };

  type TurnOutcome =
    | { kind: "interrupted" }
    | { kind: "text" }
    | { kind: "tool_use"; calls: PendingToolCall[] };

  async function runModelTurn(
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<TurnOutcome> {
    let textMessageId: string | null = null;
    let text = "";
    let flushed = "";
    let interrupted = false;
    let finishReason: string | null = null;
    let streamError: unknown = null;
    const toolCallAcc = new Map<number, PendingToolCall>();

    async function flush(status: "streaming" | "complete") {
      if (!textMessageId) return true;
      if (status === "streaming" && text === flushed) return true;

      const { data, error } = await supabase
        .from("messages")
        .update({ content: text, status })
        .eq("id", textMessageId)
        .eq("status", "streaming")
        .select("id");

      if (error) throw error;
      if (!data || data.length === 0) return false;

      flushed = text;
      return true;
    }

    const requestMessages = [{ role: "system" as const, content: effectiveSystemPrompt }, ...turns];

    let stream: ChatStream;
    try {
      stream = (await groq.chat.completions.create({
        model: routedModel,
        max_completion_tokens: 4096,
        stream: true,
        tools: [RUN_CODE_TOOL],
        messages: requestMessages,
      })) as ChatStream;
    } catch (groqErr) {
      // Only fail over on a genuine quota/availability problem, and only if
      // a second provider is actually configured — anything else (a bad
      // request, an auth error) would just fail identically on OpenRouter.
      if (!isRateLimited(groqErr) || !openrouter) {
        await postFailureNotice(groqErr);
        return { kind: "text" };
      }
      try {
        console.log(`/api/chat: trigger=${triggerMessageId} groq rate-limited, failing over to openrouter`);
        // Groq's and OpenRouter's SDKs are separately typed but both speak
        // the same OpenAI-compatible wire format — safe to reuse the same
        // request shape across the provider boundary.
        stream = (await openrouter.chat.completions.create({
          model: OPENROUTER_MODEL[routedModel],
          max_completion_tokens: 4096,
          stream: true,
          tools: [RUN_CODE_TOOL] as unknown as OpenAI.Chat.ChatCompletionTool[],
          messages: requestMessages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
        })) as ChatStream;
      } catch (fallbackErr) {
        // Both providers failed — this must still surface visibly, same as
        // a single-provider failure would.
        await postFailureNotice(fallbackErr);
        return { kind: "text" };
      }
    }

    const ticker = setInterval(async () => {
      try {
        if (!(await flush("streaming"))) {
          interrupted = true;
          stream.controller.abort();
        }
      } catch {
        // Transient write failure — the next tick retries.
      }
    }, FLUSH_MS);

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta.content;
        if (delta) {
          text += delta;
          controller.enqueue(encoder.encode(delta));

          if (!textMessageId) {
            const { data, error } = await supabase
              .from("messages")
              .insert({
                room_id: roomId,
                thread_id: threadId,
                sender_type: "agent",
                sender_id: null,
                type: "text",
                content: "",
                status: "streaming",
              })
              .select("id")
              .single();
            if (!error && data) textMessageId = data.id;
          }
        }

        for (const tc of choice.delta.tool_calls ?? []) {
          const entry = toolCallAcc.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          toolCallAcc.set(tc.index, entry);
        }
      }
    } catch (err) {
      // Aborting the stream throws — that's the expected shape of a Stop-button
      // interrupt (`interrupted` is already true by the time it happens). Any
      // other error here is a genuine failure (network blip, provider outage)
      // that must not be treated the same way.
      if (!interrupted) streamError = err;
    } finally {
      clearInterval(ticker);
    }

    if (interrupted) {
      return { kind: "interrupted" };
    }

    if (streamError && !textMessageId) {
      // Nothing ever reached the chat — the person who tagged Koopi would
      // otherwise see total silence, indistinguishable from being ignored.
      await postFailureNotice(streamError);
      return { kind: "text" };
    }

    try {
      await flush("complete");
    } catch {
      // Nothing further we can do — the row keeps its last written content.
    }

    const calls = [...toolCallAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call)
      .filter((call) => call.id && call.name);

    if (finishReason === "tool_calls" && calls.length > 0) {
      turns.push({
        role: "assistant",
        content: text || null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      return { kind: "tool_use", calls };
    }

    return { kind: "text" };
  }

  async function runToolCall(call: PendingToolCall): Promise<"interrupted" | "done"> {
    const { code, language } = safeParse(call.arguments, { code: "", language: "bash" });

    const { data: toolCallRow, error: toolCallErr } = await supabase
      .from("messages")
      .insert({
        room_id: roomId,
        thread_id: threadId,
        sender_type: "agent",
        sender_id: null,
        type: "tool_call",
        content: JSON.stringify({ code, language }),
        status: "streaming",
      })
      .select("id")
      .single();

    if (toolCallErr || !toolCallRow) return "done";
    const toolCallId = toolCallRow.id;

    const sandboxRun = new SandboxRun(code, language);
    let interruptedTool = false;

    const ticker = setInterval(async () => {
      if (!(await isStillStreaming(toolCallId))) {
        interruptedTool = true;
        clearInterval(ticker);
        void sandboxRun.cancel();
      }
    }, FLUSH_MS);

    let result: RunResult;
    try {
      result = await sandboxRun.run();
    } catch (err) {
      result = {
        stdout: "",
        stderr: err instanceof Error ? err.message : "Sandbox execution failed.",
        exit_code: -1,
      };
    } finally {
      clearInterval(ticker);
    }

    if (interruptedTool || !(await isStillStreaming(toolCallId))) {
      return "interrupted";
    }

    await supabase
      .from("messages")
      .update({ status: "complete" })
      .eq("id", toolCallId)
      .eq("status", "streaming");

    await supabase.from("messages").insert({
      room_id: roomId,
      thread_id: threadId,
      sender_type: "agent",
      sender_id: null,
      type: "tool_result",
      content: JSON.stringify(result),
      status: "complete",
    });

    turns.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });

    return "done";
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          const outcome = await runModelTurn(controller);

          if (outcome.kind !== "tool_use") break;
          if (round === MAX_TOOL_ROUNDS) break;

          let stoppedEarly = false;
          for (const call of outcome.calls) {
            const toolOutcome = await runToolCall(call);
            if (toolOutcome === "interrupted") {
              stoppedEarly = true;
              break;
            }
          }
          if (stoppedEarly) break;
        }
      } catch (err) {
        console.error(`/api/chat: unhandled error for trigger ${triggerMessageId}:`, err);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
