import Groq from "groq-sdk";
import OpenAI from "openai";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SandboxRun, type RunResult } from "@/lib/sandbox";
import { classifyIntent } from "@/lib/intentClassifier";
import type { Personality } from "@/components/PersonalitySelector";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Both modes run the same Cerebras model — gpt-oss-120b is the only
// production-supported model there (Gemma and GLM-4.7 are preview-only).
// Efficient mode uses low reasoning effort for quick conversational replies;
// Powerful mode uses high effort for anything that needs real reasoning or
// the run_code tool.
const CEREBRAS_MODEL = "gpt-oss-120b";
const REASONING_EFFORT: Record<"chat" | "build", "low" | "high"> = {
  chat: "low",
  build: "high",
};

// Fallback models, used only when Cerebras itself is unavailable (missing
// key, rate limit, or any other error) — first Groq, then OpenRouter, the
// same tiering Koopi used before Cerebras became the primary provider.
const FALLBACK_GROQ_MODEL: Record<"chat" | "build", string> = {
  chat: "llama-3.1-8b-instant",
  build: "llama-3.3-70b-versatile",
};
const FALLBACK_OPENROUTER_MODEL: Record<"chat" | "build", string> = {
  chat: "meta-llama/llama-3.1-8b-instruct",
  build: "meta-llama/llama-3.3-70b-instruct",
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
examples over long prose.

[EVALUATIVE STANCE — core behavior]
When a message involves a decision, plan, or claim — especially one connected to prior
discussion in this room's memory — do not simply validate or agree by default. Actively
evaluate it:
- If it conflicts with something already decided or stated by someone else in this room's
  history, say so explicitly and cite what conflicts and who said it.
- If it has a real risk, tradeoff, or flaw, name it plainly, even if unprompted and even if
  the person asking sounds confident.
- If multiple teammates have expressed different views on the same topic in this room's
  history, reflect that disagreement back rather than picking a side to please whoever's
  currently asking.
- Agreement should only happen when something genuinely holds up to scrutiny against the
  room's actual history — not by default, and not just because one person asked.
This is a core behavior rule, not a style choice: it holds regardless of any tone or
brevity preference stated elsewhere in this prompt. A short reply is still expected to
surface a real conflict or risk, not omit it for the sake of length.
[END EVALUATIVE STANCE]

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
transcript. Write neutral third-person notes, not addressed to anyone.

Attribute key statements, decisions, and opinions to the specific person who made them,
by name — e.g. "Navin proposed using Postgres; test2 later suggested MongoDB instead" —
never collapse them into an unattributed group statement like "the team discussed
database options." If two participants expressed conflicting views on the same topic,
preserve both positions and who holds each one; do not resolve them into a single
consensus. This attribution is required, not optional — another part of the system
relies on knowing who said what to detect disagreement against this summary later, not
just knowing that a topic came up.`;

// Regenerate the room summary once a summary already exists and this many new
// messages have accrued since — frequent enough to stay useful, far cheaper
// than redoing it on every single message.
const MEMORY_REGEN_THRESHOLD = 20;

// Powers the "🧠 Room memory" / "⚠ Flagged" badges on a reply. Deliberately a
// classification of the FINISHED reply text against what was actually available —
// not "was room memory present in the prompt" (a room accrues a memory_summary almost
// immediately, so that would be true on nearly every message and the badge would stop
// meaning anything) and not a marker embedded in the model's own output (the stream is
// enqueued to the client character-by-character as it arrives, well before there's any
// chance to inspect or strip an inline tag).
const SIGNAL_CLASSIFIER_PROMPT = `You are a strict binary classifier. You will be given optional
room-memory context and a single assistant reply. Decide two independent yes/no facts about
ONLY that reply:

1. used_room_memory: does the reply draw on specific content from the room-memory context below
   — e.g. referencing a decision, statement, or fact that came from another thread — rather than
   just generically continuing the current conversation? If no room-memory context is given
   below, this must be false.
2. flagged: does the reply explicitly push back on something — surfacing a conflict or
   disagreement between named people, or naming a concrete risk/flaw/tradeoff — rather than
   simply agreeing, answering neutrally, or making small talk?

Respond with ONLY a compact JSON object and nothing else: {"used_room_memory": true|false, "flagged": true|false}`;

// Tone/style only — deliberately says nothing about tools, scoping, or what
// Koopi is allowed to do. That's enforced entirely by SYSTEM_PROMPT above and
// must never be reweighted by a personality choice.
const PERSONALITY_PROMPTS: Record<Exclude<Personality, "default">, string> = {
  concise:
    "Be as brief as possible. No preamble, no restating the question, no " +
    "closing summary unless it genuinely adds something. Lead with the direct " +
    "answer or result over explanation.",
  explanatory:
    "Walk through your reasoning, not just the answer. When you run code, " +
    "briefly explain what it does and why, both before and after showing the " +
    "output. Optimize for the person understanding the decision, not just " +
    "receiving a result.",
  casual:
    "Use a relaxed, informal, warm tone. Stay fully competent and accurate — " +
    "this changes wording and warmth, not correctness or effort. No slang that " +
    "obscures meaning, no forced jokes.",
  direct:
    "Be blunt and matter-of-fact. State findings plainly, including " +
    "disagreement or problems with what was asked, without softening. Stay " +
    "respectful, just not diplomatic-by-default.",
};

// Appended after every other section, never before — a personality choice
// must never be positioned where it could compete with or precede the
// tool-use and scoping rules in SYSTEM_PROMPT.
function personalityBlock(personality: Personality): string {
  if (personality === "default") return "";
  return (
    `\n\n[STYLE PREFERENCE — affects tone and phrasing only]\n` +
    `${PERSONALITY_PROMPTS[personality]}\n` +
    `[END STYLE PREFERENCE — the above does not override any instructions ` +
    `elsewhere in this prompt regarding tool use, scoping, or behavior]`
  );
}

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

  const cerebrasKey = process.env.CEREBRAS_API_KEY;
  if (!cerebrasKey) {
    return NextResponse.json(
      { error: "CEREBRAS_API_KEY is not set in .env.local" },
      { status: 500 }
    );
  }

  // Both optional — without either, a Cerebras failure just surfaces the
  // visible failure message instead of failing over to a backup provider.
  const groqKey = process.env.GROQ_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  // maxRetries: 0 — the SDK's default retry-with-backoff would silently eat
  // 30+ seconds retrying a rate-limited call before our own fallback chain
  // ever gets a chance to run. A 429 should surface immediately.
  const cerebras = new OpenAI({
    apiKey: cerebrasKey,
    baseURL: "https://api.cerebras.ai/v1",
    maxRetries: 0,
  });
  const groq = groqKey ? new Groq({ apiKey: groqKey, maxRetries: 0 }) : null;
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
  console.log(
    `/api/chat: trigger=${triggerMessageId} intent=${intent} model=${CEREBRAS_MODEL} ` +
      `reasoning_effort=${REASONING_EFFORT[intent]}` +
      (modelOverride ? " (manual override)" : "")
  );

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
    // Best-effort feature — without a fallback provider configured, there's
    // no cheap model left to spend on background summarization.
    if (!groq) return existingSummary;

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
        model: FALLBACK_GROQ_MODEL.chat,
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

  // Style only — kept independent of getRoomMemory's more involved query so a
  // personality change is never gated on the memory-regeneration logic above.
  async function getRoomPersonality(): Promise<Personality> {
    const { data: room } = await supabase
      .from("rooms")
      .select("personality")
      .eq("id", roomId)
      .maybeSingle();
    return (room?.personality as Personality | null) ?? "default";
  }

  const [roomMemory, personality] = await Promise.all([
    getRoomMemory(),
    getRoomPersonality(),
  ]);

  const effectiveSystemPrompt =
    (roomMemory
      ? `${SYSTEM_PROMPT}\n\nRoom memory (prior activity in this room, across other threads):\n${roomMemory}`
      : SYSTEM_PROMPT) + personalityBlock(personality);

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

  // Best-effort classification for the room-memory/flagged badges — runs after a reply
  // is already fully streamed and saved, so a failure or skip here never affects what the
  // person sees, only whether the badges show up moments later. Same "no fallback model
  // configured" degrade-quietly pattern as getRoomMemory above.
  async function classifySignals(
    replyText: string
  ): Promise<{ usedRoomMemory: boolean; flagged: boolean }> {
    const none = { usedRoomMemory: false, flagged: false };
    if (!groq || !replyText.trim()) return none;

    try {
      const completion = await groq.chat.completions.create({
        model: FALLBACK_GROQ_MODEL.chat,
        max_completion_tokens: 40,
        messages: [
          { role: "system", content: SIGNAL_CLASSIFIER_PROMPT },
          {
            role: "user",
            content:
              `Room-memory context: ${roomMemory ?? "(none provided)"}\n\n` +
              `Assistant reply:\n${replyText}`,
          },
        ],
      });
      const raw = completion.choices[0]?.message?.content?.trim() ?? "";
      const parsed = safeParse<{ used_room_memory?: boolean; flagged?: boolean }>(raw, {});
      return {
        // Belt-and-suspenders: never true if there genuinely was no memory to draw on,
        // regardless of what the classifier says.
        usedRoomMemory: Boolean(parsed.used_room_memory) && Boolean(roomMemory),
        flagged: Boolean(parsed.flagged),
      };
    } catch (err) {
      console.warn(`/api/chat: signal classification skipped for trigger ${triggerMessageId}:`, err);
      return none;
    }
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
    // messageId/text are null/empty when no reply ever reached the chat (e.g. every
    // provider failed before a row was created) — callers use their presence to decide
    // whether there's anything worth classifying for the room-memory/flagged badges.
    | { kind: "text"; messageId: string | null; text: string }
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

    // Cerebras, Groq, and OpenRouter are all cast to the same ChatStream shape —
    // Cerebras and OpenRouter speak OpenAI's wire format natively, and Groq's
    // separately-typed SDK speaks the same format under the hood.
    async function attemptOpenrouterOrFail(prevErr: unknown): Promise<ChatStream | null> {
      if (!openrouter) {
        await postFailureNotice(prevErr);
        return null;
      }
      try {
        console.log(`/api/chat: trigger=${triggerMessageId} failing over to openrouter`);
        return (await openrouter.chat.completions.create({
          model: FALLBACK_OPENROUTER_MODEL[intent],
          max_completion_tokens: 4096,
          stream: true,
          tools: [RUN_CODE_TOOL] as unknown as OpenAI.Chat.ChatCompletionTool[],
          messages: requestMessages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
        })) as ChatStream;
      } catch (fallbackErr) {
        // Every provider failed — this must still surface visibly, same as
        // a single-provider failure would.
        await postFailureNotice(fallbackErr);
        return null;
      }
    }

    let stream: ChatStream;
    // Recorded onto the agent's message row so the UI can show which tier and
    // provider actually answered — the composer's tier choice doesn't always
    // match reality once a fallback kicks in.
    let provider: "cerebras" | "groq" | "openrouter" = "cerebras";
    try {
      stream = (await cerebras.chat.completions.create({
        model: CEREBRAS_MODEL,
        reasoning_effort: REASONING_EFFORT[intent],
        max_completion_tokens: 4096,
        stream: true,
        tools: [RUN_CODE_TOOL] as unknown as OpenAI.Chat.ChatCompletionTool[],
        messages: requestMessages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
      })) as ChatStream;
    } catch (cerebrasErr) {
      // Cerebras is new here — fail over on any error, not just rate limits,
      // straight into the existing Groq/OpenRouter chain below.
      console.log(
        `/api/chat: trigger=${triggerMessageId} cerebras failed, failing over:`,
        cerebrasErr instanceof Error ? cerebrasErr.message : cerebrasErr
      );

      if (!groq) {
        const fallback = await attemptOpenrouterOrFail(cerebrasErr);
        if (!fallback) return { kind: "text", messageId: null, text: "" };
        stream = fallback;
        provider = "openrouter";
      } else {
        try {
          stream = (await groq.chat.completions.create({
            model: FALLBACK_GROQ_MODEL[intent],
            max_completion_tokens: 4096,
            stream: true,
            tools: [RUN_CODE_TOOL],
            messages: requestMessages,
          })) as ChatStream;
          provider = "groq";
        } catch (groqErr) {
          // Only fail over further on a genuine quota/availability problem —
          // anything else would just fail identically on OpenRouter too.
          if (!isRateLimited(groqErr)) {
            await postFailureNotice(groqErr);
            return { kind: "text", messageId: null, text: "" };
          }
          const fallback = await attemptOpenrouterOrFail(groqErr);
          if (!fallback) return { kind: "text", messageId: null, text: "" };
          stream = fallback;
          provider = "openrouter";
        }
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
                model_tier: intent,
                model_provider: provider,
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
      return { kind: "text", messageId: null, text: "" };
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

    return { kind: "text", messageId: textMessageId, text };
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

          // Every completed text reply gets its own classification pass, independent of
          // whichever round produced it — a tool-use round's follow-up text is just as
          // eligible for either badge as a first-round reply.
          if (outcome.kind === "text" && outcome.messageId && outcome.text) {
            const signals = await classifySignals(outcome.text);
            await supabase
              .from("messages")
              .update({ used_room_memory: signals.usedRoomMemory, flagged: signals.flagged })
              .eq("id", outcome.messageId);
          }

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
